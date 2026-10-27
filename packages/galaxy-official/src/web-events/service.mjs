import {createWebEventAuthorization} from './authorization.mjs';
import {ServiceError} from '../shared/service-error.mjs';
import {transaction} from '../infrastructure/database.mjs';
import {webEventAuthorizationDependencies,operationsAuthorityEventSources} from './topics.mjs';

const hubs=new WeakMap();
const integer=value=>typeof value==='string'&&/^(0|[1-9]\d{0,18})$/.test(value);
const maximumReplay=256;

// A process shares one LISTEN connection, regardless of browser count. NOTIFY
// contains no data. The durable outbox/log recovers notifications lost at restart.
function sharedHub(pool){
 let hub=hubs.get(pool);if(hub)return hub;
 const listeners=new Set(),disposed=new WeakSet();let client,opening,running,closed=false,reconnect,maintenance;
 const dispose=value=>{if(!value||disposed.has(value))return;disposed.add(value);value.removeAllListeners('error');value.removeAllListeners('end');value.removeAllListeners('notification');value.release(true);};
 const wake=()=>{for(const listener of listeners)listener();};
 const drain=()=>{
  if(running)return running;
  running=(async()=>{
   const count=Number((await pool.query('SELECT galaxy_web_events_promote_v1($1) AS count',[maximumReplay])).rows[0].count);
   if(count)wake();
   if(count===maximumReplay&&!closed){const continuation=setTimeout(()=>{if(!closed)void drain().catch(fail);},0);continuation.unref?.();}
  })().finally(()=>{running=null;});
  return running;
 };
 const fail=()=>{
  const previous=client;client=null;dispose(previous);
  if(!closed&&listeners.size){clearTimeout(reconnect);reconnect=setTimeout(()=>void open().catch(fail),1500);wake();}
 };
 const open=()=>{
  if(client)return Promise.resolve();if(opening)return opening;
  opening=(async()=>{
   const next=await pool.connect();
   try{
    next.on('error',fail);next.on('end',fail);
    next.on('notification',message=>{
     if(message.channel==='galaxy_web_event_pending_v1')void drain().catch(fail);
     if(message.channel==='galaxy_web_event_ready_v1')wake();
    });
    await next.query('LISTEN galaxy_web_event_pending_v1');
    await next.query('LISTEN galaxy_web_event_ready_v1');client=next;
    await drain();wake();
   }catch(error){if(client===next)client=null;dispose(next);throw error;}
  })().finally(()=>{opening=null;});
  return opening;
 };
 hub={async start(){closed=false;await drain();if(!maintenance){maintenance=setInterval(()=>void drain().catch(()=>{}),60000);maintenance.unref?.();}},
 stop(){closed=true;clearInterval(maintenance);maintenance=null;clearTimeout(reconnect);listeners.clear();const previous=client;client=null;dispose(previous);},
 async subscribe(listener){closed=false;listeners.add(listener);try{await open();}catch(error){listeners.delete(listener);fail();throw error;}return()=>{
  listeners.delete(listener);
  if(!listeners.size){closed=!maintenance;clearTimeout(reconnect);const previous=client;client=null;dispose(previous);}
 };},drain};
 hubs.set(pool,hub);return hub;
}

export function createWebEventService(options){
 const {pool}=options,authority=createWebEventAuthorization(options),hub=sharedHub(pool);
 async function connect(context){
  const connection=await authority.authorizeConnection(context);
  const allowed=authority.modules(context.surface);
  const topics=context.topics?.length?context.topics:allowed;
  if(topics.length>32||new Set(topics).size!==topics.length||topics.some(topic=>!allowed.includes(topic)))throw new ServiceError('invalid_web_events_topics',400);
  const modules=[];for(const topic of topics)if(await authority.authorizeModule(connection,topic))modules.push(topic);
  return {...connection,modules,context};
 }
 async function read(connection,cursor){
  if(cursor!==null&&!integer(cursor))throw new ServiceError('invalid_web_events_cursor',400);
  // Promotion observes only committed transactions and serializes allocation.
  await hub.drain();
  const fresh=await connect(connection.context);
  if(fresh.identity!==connection.identity||fresh.endpoint!==connection.endpoint)throw new ServiceError('web_events_identity_changed',409);
  // Bounds and replay rows share one MVCC snapshot, including retention races.
  const {bounds,rows}=await transaction(pool,async db=>{
   const bounds=(await db.query('SELECT cursor::text AS high,(SELECT min(cursor)::text FROM web_event_log_v1) AS low FROM web_event_sequence_v1 WHERE singleton')).rows[0];
   const rows=cursor===null?[]:(await db.query(`SELECT cursor::text,module,source_table,source_ref,endpoint,operation_id
    FROM web_event_log_v1 WHERE cursor>$1 AND cursor<=$2 ORDER BY cursor LIMIT $3`,[cursor,bounds.high,maximumReplay+1])).rows;
   return {bounds,rows};
  },{isolation:'repeatable read'});
  const high=bounds.high,frames=[];
  const lost=connection.modules.filter(module=>!fresh.modules.includes(module));
  if(lost.length)frames.push({type:'reset',cursor:cursor??high,modules:lost});
  connection.modules=fresh.modules;connection.actor=fresh.actor;
  if(cursor===null||BigInt(cursor)>BigInt(high)||bounds.low&&BigInt(cursor)<BigInt(bounds.low)-1n||!bounds.low&&BigInt(cursor)<BigInt(high)){
   return [...frames,{type:'reset',cursor:high,modules:fresh.modules},{type:'snapshot',cursor:high,modules:fresh.modules}];
  }
  if(rows.length>maximumReplay)return [...frames,{type:'reset',cursor:high,modules:fresh.modules},{type:'snapshot',cursor:high,modules:fresh.modules}];
  const resets=new Set();
  for(const event of rows){
   // Qualification dependencies do not have one encompassing source version.
   // Expiry/session is additionally checked by heartbeat authorization below.
   if(event.module==='authorization'||connection.surface==='admin'&&operationsAuthorityEventSources.has(event.source_table)){
    const ref=event.source_ref;
    const account=connection.actor?.accountId,subject=connection.actor?.subjectId;
    const dependencies=webEventAuthorizationDependencies[event.source_table];
    const relevant=connection.surface==='admin'?event.module!=='authorization':dependencies&&
      (event.source_table!=='contacts_v2'||subject&&[ref.initiator_id,ref.recipient_id].includes(subject))
      ||account&&ref.account_id===account||subject&&ref.subject_id===subject;
    if(relevant&&(!event.endpoint||event.endpoint===connection.endpoint)){
     const affected=dependencies??fresh.modules;
     for(const module of affected)if(fresh.modules.includes(module))resets.add(module);
    }
   }
   if(!fresh.modules.includes(event.module))continue;
   const authorized=await authority.authorizeSource(connection,event);
   if(authorized==='reset'||authorized&&event.source_ref._operation==='DELETE'){resets.add(event.module);continue;}
   if(authorized){
    const ref=event.source_ref;
    // Only stable source locators are included after current source authorization.
    const objectId=event.module==='builders'?ref.builder_id??(event.source_table==='builders'?ref.id:null):
     event.module==='choice-sync'?ref.snapshot_id:event.module==='information'?ref.watch_id??ref.id:
     event.module==='tasks'?ref.task_id??ref.id:event.module==='capsules'?ref.capsule_id??ref.id:
     ref.message_id??ref.id??ref.work_id??ref.room_id??ref.task_id??ref.project_id??null;
    frames.push({type:'change',cursor:event.cursor,module:event.module,operationId:event.operation_id??null,
     ...(objectId?{objectId}:{}),...(ref._version!==null&&ref._version!==undefined?{version:ref._version}:{}),
     ...(ref.room_id&&ref.room_id!==objectId?{parentId:ref.room_id}:ref.task_id&&ref.task_id!==objectId?{parentId:ref.task_id}:ref.post_id&&ref.post_id!==objectId?{parentId:ref.post_id}:{} )});
   }
  }
  if(resets.size)frames.push({type:'reset',cursor:high,modules:[...resets]});
  frames.push({type:'snapshot',cursor:high,modules:fresh.modules});return frames;
 }
 async function position(){await hub.drain();return (await pool.query('SELECT cursor::text FROM web_event_sequence_v1 WHERE singleton')).rows[0].cursor;}
 return {connect,read,position,start:hub.start,stop:hub.stop,subscribe:hub.subscribe,modules:authority.modules};
}
