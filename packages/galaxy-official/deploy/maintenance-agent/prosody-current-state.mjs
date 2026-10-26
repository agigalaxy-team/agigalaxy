import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {transaction} from "../../src/infrastructure/database.mjs";
import {validateDeletionLedger} from '../../src/operations/deletion-ledger.mjs';
import {noSymlinkPath,runCommand,postgresSqlArguments} from '../operations-stack/host.mjs';

const fail=code=>Object.assign(Error(code),{code});
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const guid=/^GUID[A-Z0-9]{28}$/;
const participant=value=>guid.test(value??'')||typeof value==='string'&&value.startsWith('account:')&&uuid.test(value.slice(8));
const key=row=>row.roomId+':'+row.messageId;
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const seconds=value=>{const v=Date.parse(value)/1000;if(!Number.isFinite(v)||v<0)throw fail('maintenance_prosody_source_facts_invalid');return v;};
const limit=100000,maximumBytes=20*1024*1024;
const shellSource=fileURLToPath(new URL('./prosody-storage.lua',import.meta.url));
export const prosodyProjectionCaptureSql=`BEGIN; LOCK TABLE chat_rooms,chat_memberships,chat_message_refs IN SHARE MODE;
 SELECT json_build_object('rooms',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT room_id,title,state,revision FROM chat_rooms ORDER BY room_id LIMIT 100001)t),
 'members',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT room_id,subject_id FROM chat_memberships WHERE left_at IS NULL ORDER BY room_id,subject_id LIMIT 100001)t),
 'messages',(SELECT coalesce(json_agg(t),'[]') FROM (SELECT message_id,room_id,subject_id,state,revision,archive_id,expires_at,purge_pending,payload_hash FROM chat_message_refs ORDER BY message_id LIMIT 100001)t));COMMIT;`;

// The original signed intent is all-owned-service-data. An unexecuted approval,
// account linkage, subject status or submitted deletion is not this authority.
export async function executedProsodyDeletionSubjects(ledger,endpoint){
 try{await validateDeletionLedger(ledger);}catch{throw fail('maintenance_prosody_deletion_ledger_invalid');}
 if(ledger.endpoint!==endpoint)throw fail('maintenance_prosody_deletion_endpoint_changed');
 return ledger.tables.deletion_requests.filter(x=>x.execution_result).map(row=>({subjectId:row.subject_id,requestId:row.id}));
}

export function prosodyProjectionFromRows({rooms,members,messages},{now=Math.floor(Date.now()/1000),deletedSubjects=[]}={}){
 if(!Number.isSafeInteger(now)||now<0||deletedSubjects.some(x=>!guid.test(x.subjectId??'')||!uuid.test(x.requestId??'')))throw fail('maintenance_prosody_source_facts_invalid');
  if([rooms,members,messages].some(rows=>!Array.isArray(rows)||rows.length>limit))throw fail('maintenance_prosody_inventory_limit');
  const deleted=new Set(deletedSubjects.map(x=>x.subjectId));
  const result={rooms:rooms.map(row=>({roomId:row.room_id,title:row.title,state:row.state,revision:row.revision,members:members.filter(m=>m.room_id===row.room_id&&!deleted.has(m.subject_id)).map(m=>m.subject_id)})),
   messages:messages.map(row=>({roomId:row.room_id,messageId:row.message_id,subjectId:row.subject_id,state:row.state,revision:row.revision,archiveId:row.archive_id,expiresAt:seconds(row.expires_at),payloadHash:row.payload_hash,
    erase:['retracted','expired'].includes(row.state)||seconds(row.expires_at)<=now||deleted.has(row.subject_id)})),deletedSubjects};
  if(result.rooms.some(r=>!uuid.test(r.roomId)||!Number.isSafeInteger(r.revision)||r.revision<1||typeof r.title!=='string'||r.members.some(v=>!participant(v)))||result.messages.some(m=>!uuid.test(m.roomId)||!uuid.test(m.messageId)||!participant(m.subjectId)||!Number.isSafeInteger(m.revision)||m.archiveId!==null&&m.archiveId!==m.messageId)||Buffer.byteLength(JSON.stringify(result))>maximumBytes)throw fail('maintenance_prosody_source_facts_invalid');
  return result;
}
export async function prosodyProjectionWithin(database,options={}){
 return transaction(database,async db=>{
  await db.query('LOCK TABLE chat_rooms,chat_memberships,chat_message_refs IN SHARE MODE');
  const rooms=(await db.query('SELECT room_id,title,state,revision FROM chat_rooms ORDER BY room_id LIMIT 100001')).rows;
  const members=(await db.query('SELECT room_id,subject_id FROM chat_memberships WHERE left_at IS NULL ORDER BY room_id,subject_id LIMIT 100001')).rows;
  const messages=(await db.query('SELECT message_id,room_id,subject_id,state,revision,archive_id,expires_at,purge_pending,payload_hash FROM chat_message_refs ORDER BY message_id LIMIT 100001')).rows;
  return prosodyProjectionFromRows({rooms,members,messages},options);
 });
}

export function verifyProsodyState(native,projection,security,{now=Math.floor(Date.now()/1000)}={}){
 if(native?.version!==1||!Array.isArray(native.rooms)||!Array.isArray(native.messages)||native.occupantStates!==0||canonical(native.security)!==canonical(security))throw fail('maintenance_prosody_current_authority_unconfirmed');
 const expected=new Map(projection.rooms.map(x=>[x.roomId,x])),seen=new Set();
 const node=ref=>guid.test(ref)?ref.toLowerCase():'account-'+ref.slice(8);
 for(const room of native.rooms){
  if(seen.has(room.roomId))throw fail('maintenance_prosody_current_authority_unconfirmed');seen.add(room.roomId);
  const source=expected.get(room.roomId),wanted=source?.members??[];
  if(source?(room.revision!==source.revision||room.state!==source.state):room.state!=='archived')throw fail('maintenance_prosody_current_authority_unconfirmed');
  if(canonical([...room.members].sort((a,b)=>a<b?-1:a>b?1:0))!==canonical([...wanted].sort((a,b)=>a<b?-1:a>b?1:0))||canonical(room.affiliations)!==canonical(Object.fromEntries(wanted.map(ref=>[node(ref)+'@gateway.galaxy.internal','member']))))throw fail('maintenance_prosody_current_authority_unconfirmed');
 }
 if([...expected.keys()].some(id=>!seen.has(id)))throw fail('maintenance_prosody_current_authority_unconfirmed');
 const messages=new Map(projection.messages.map(x=>[key(x),x])),deleted=new Set(projection.deletedSubjects.map(x=>x.subjectId));let withheld=0;
 for(const row of native.messages){const source=messages.get(key(row));
  if(deleted.has(row.subjectId)||row.expiresAt<=now||!source||source.erase||source.subjectId!==row.subjectId)throw fail('maintenance_prosody_native_lifecycle_unconfirmed');
  // A newer revision not present at the chosen point keeps its source pointer
  // null. Do not relabel old MAM text as the newer revision or fetch new text.
  if(row.revision!==source.revision){if(source.archiveId!==null)throw fail('maintenance_prosody_native_revision_unconfirmed');withheld++;}
 }
 return{currentNativeAccountsPreserved:true,currentRoomPermissionsPreserved:true,oldOccupantsInvalidated:true,nativeLifecycleReconciled:true,
  nativeMessageRows:native.messages.length,withheldOlderRevisions:withheld,bodyReturned:false,physicalMediaErasureProven:false};
}

// This reuses the existing ChatService erasure and room-transition rules, but
// only on the exact quarantine and only after the native driver has positively
// acknowledged each key. A retry target alone never becomes authorization.
export async function reconcileProsodySqlCandidate(database,{operationId,projection,receipts,now=Math.floor(Date.now()/1000)}={}){
 const state=(await database.query('SELECT recovery_id,status FROM recovery_state WHERE singleton=true')).rows[0];
 if(!uuid.test(operationId??'')||state?.status!=='quarantined'||state.recovery_id!==operationId)throw fail('maintenance_exact_quarantine_required');
 const erased=new Set();for(const row of receipts??[]){if(!uuid.test(row.roomId??'')||!uuid.test(row.messageId??'')||row.archiveDeleted!==true||erased.has(key(row)))throw fail('maintenance_prosody_archive_delete_unconfirmed');erased.add(key(row));}
 if(projection.messages.some(row=>row.erase&&!erased.has(key(row))))throw fail('maintenance_prosody_archive_delete_unconfirmed');
 const transport={erase:async row=>{if(!erased.has(key(row)))throw fail('maintenance_prosody_archive_delete_unconfirmed');return{archiveDeleted:true};}};
 // Native metadata reads must not initialize the complete chat/business kernel
 // (its schema imports are cyclic when this adapter is the process entry).
 const {ChatService}=await import("../../src/chat/service.mjs");
 const chat=new ChatService({db:database,transport,now:()=>now});
 for(const target of projection.deletedSubjects){let result;
  for(let i=0;i<=Math.ceil(limit/1000);i++){result=await chat.eraseSubject(target.subjectId,{limit:1000});if(result.complete)break;}
  if(!result?.complete)throw fail('maintenance_prosody_native_lifecycle_unconfirmed');
 }
 // Already completed purges have purge_pending=false in the current database.
 // The point's native copy can still contain that key, so mark only these exact
 // source-withdrawn/expired rows for the original positive-receipt consumer.
 for(const row of projection.messages.filter(x=>x.erase)){
  await database.query("UPDATE chat_message_refs SET state=CASE WHEN state IN ('pending','accepted') AND expires_at<=$2 THEN 'expired' ELSE state END,purge_pending=true WHERE message_id=$1 AND room_id=$3 AND (state IN ('retracted','expired') OR expires_at<=$2)",[row.messageId,new Date(now*1000),row.roomId]);
  await chat.purgeOne(row.messageId);
 }
 return{currentRoomTransitionsApplied:true,actualNativeReceipts:erased.size,serviceWideDeletionComplete:false};
}

export class MaintenanceProsodyCurrentState{
 constructor({config,run=runCommand,controlDirectory,probe=null,now=()=>Math.floor(Date.now()/1000)}={}){Object.assign(this,{config,run,controlDirectory,probe,now});}
 binding(context){
  const row=context.footprint.containers.find(x=>x.id==='chat'&&x.state==='available'),mount=row?.mounts.find(x=>x.writable&&x.target==='/var/lib/prosody');
  if(row?.name!=='galaxy-chat-pilot-chat-1'||!/^sha256:[a-f0-9]{64}$/.test(row.image??'')||!mount?.path?.startsWith('/var/lib/galaxy/'))throw fail('maintenance_prosody_current_binding_unknown');
  return{row,mount};
 }
 async stopped(context){const {row}=this.binding(context);
  if(!uuid.test(context.intent.operationId??'')||context.containment?.operationId!==context.intent.operationId||context.containment.publicActivation!==false||!context.containment.stopped?.some(x=>x.kind==='container'&&x.name===row.name))throw fail('maintenance_prosody_containment_required');
  if((await this.run(this.config.tools.docker,['inspect','--format','{{.State.Running}}',row.name],{timeout:10000,maxOutput:1024})).stdout.trim()!=='false')throw fail('maintenance_prosody_containment_required');
 }
 async command(context,request,{candidate=false,writable=false}={}){
  const {row,mount}=this.binding(context),transfer=candidate?context.artifacts.fileTransfers.find(x=>x.owner===row.name&&x.path===mount.path):null;
  if(candidate&&(!transfer||transfer.candidate!==mount.path+'.galaxy-next-'+context.intent.operationId))throw fail('maintenance_prosody_private_candidate_required');
  const path=candidate?transfer.candidate:mount.path;await noSymlinkPath(path);const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw fail('maintenance_prosody_volume_binding_changed');
  const source=await readFile(shellSource,'utf8');if(source.includes(']====]'))throw fail('maintenance_prosody_source_invalid');
  const program="package.path='/usr/local/lib/prosody/?.lua;'..package.path;package.cpath='/usr/local/lib/prosody/?.so;'..package.cpath;dofile('/usr/local/lib/prosody/loader.lua');prosody={paths={data='"+(candidate?'/galaxy-candidate':'/var/lib/prosody')+"'}};local json=require'prosody.util.json';local adapter=assert(load([====["+source+"]====],'@galaxy-maintenance-prosody','t',_ENV))();local ok,value=pcall(adapter,json.decode(io.read('*a')));if not ok then local code=type(value)=='string'and value:match('^maintenance_[a-z_]+$');print(json.encode({error=code or'maintenance_prosody_native_failed'}));os.exit(1);end;print(json.encode(value));";
  const payload=JSON.stringify({...request,...(candidate?{candidate:true,privateCandidate:true,operationId:context.intent.operationId}:{})});if(Buffer.byteLength(payload)>maximumBytes)throw fail('maintenance_prosody_inventory_limit');
  try{
   const result=await this.run(this.config.tools.docker,['run','--rm','--interactive','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','256m','--user',info.uid+':'+info.gid,
    '--tmpfs','/tmp:rw,nosuid,noexec,size=16m','--mount','type=bind,src='+path+',dst='+(candidate?'/galaxy-candidate':'/var/lib/prosody')+(writable?'':',readonly'),
    '--entrypoint','/usr/bin/lua',row.image,'-e',program],{input:payload,timeout:120000,maxOutput:maximumBytes,accepted:[0,1]});
   const value=JSON.parse(result.stdout.trim());if(value.error)throw fail(value.error);return value;
  }catch(error){if(/^maintenance_prosody_[a-z_]+$/.test(error.code??''))throw error;throw fail('maintenance_prosody_native_read_or_write_unconfirmed');}
 }
 async inspect(context){return this.command(context,{action:'inspect'});}
 async requireLiveComponent(context){
  if(typeof this.probe!=='function')throw fail('maintenance_prosody_live_component_probe_not_connected');
  const value=await this.probe({operationId:context.intent.operationId??null});
  if(value?.authenticatedGateway!==true||value.roomsDomain!=='rooms.galaxy.internal'||value.bodyReturned!==false||value.readOnly!==true||value.roundTrip!==true)throw fail('maintenance_prosody_live_component_readiness_unconfirmed');
  return{liveComponentRoundTrip:true,bodyReturned:false};
 }
 async capture(context){
  await this.stopped(context);const native=await this.command(context,{action:'capture'}),directory=this.controlDirectory+'/recovery-facts';
  const payload=JSON.stringify({version:1,operationId:context.intent.operationId,...native});if(Buffer.byteLength(payload)>maximumBytes)throw fail('maintenance_prosody_inventory_limit');
  await noSymlinkPath(directory);await mkdir(directory,{recursive:true,mode:0o700});const path=directory+'/'+context.intent.operationId+'-prosody.json';await writeFile(path,payload,{flag:'wx',mode:0o600});
  return{kind:'current-prosody-native-authority',operationId:context.intent.operationId,artifactPath:path,sha256:sha(payload),nativeRooms:native.rooms.length,bodyReturned:false};
 }
 async facts(context){
  const contribution=context.currentFacts.prosody,path=this.controlDirectory+'/recovery-facts/'+context.intent.operationId+'-prosody.json';
  if(contribution?.operationId!==context.intent.operationId||contribution.artifactPath!==path)throw fail('maintenance_prosody_current_facts_invalid');
  await noSymlinkPath(path);const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>maximumBytes)throw fail('maintenance_prosody_private_facts_required');
  const raw=await readFile(path,'utf8');if(sha(raw)!==contribution.sha256)throw fail('maintenance_prosody_current_facts_changed');return JSON.parse(raw);
 }
 async deletedSubjects(context){
  const c=context.currentFacts.deletion,path=this.controlDirectory+'/recovery-facts/'+context.intent.operationId+'-deletion.json';
  if(c?.operationId!==context.intent.operationId||c.artifactPath!==path||c.signatureValidated!==true)throw fail('maintenance_prosody_deletion_ledger_invalid');await noSymlinkPath(path);
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)||info.size>maximumBytes)throw fail('maintenance_prosody_private_facts_required');
  const raw=await readFile(path,'utf8');if(sha(raw)!==c.sha256)throw fail('maintenance_prosody_current_facts_changed');return executedProsodyDeletionSubjects(JSON.parse(raw),context.authority.endpoint);
 }
 async prepare(database,context){
  await this.stopped(context);
  const state=(await database.query('SELECT recovery_id,status FROM recovery_state WHERE singleton=true')).rows[0];if(state?.status!=='quarantined'||state.recovery_id!==context.intent.operationId)throw fail('maintenance_exact_quarantine_required');
  const current=await this.facts(context),deletedSubjects=await this.deletedSubjects(context),now=this.now(),before=await prosodyProjectionWithin(database,{now,deletedSubjects});
  const native=await this.command(context,{action:'reconcile',stage:'erase',now,projection:before},{candidate:true,writable:true});
  await reconcileProsodySqlCandidate(database,{operationId:context.intent.operationId,projection:before,receipts:native.receipts,now});
  const projection=await prosodyProjectionWithin(database,{now,deletedSubjects});
  const merged=await this.command(context,{action:'reconcile',now,projection,security:current.security,tombstones:current.tombstones},{candidate:true,writable:true});
  return{required:true,...verifyProsodyState(merged,projection,current.security,{now}),basis:'original-Prosody-13.0.6-internal-storage-and-verified-current-deletion-ledger',serviceWideDeletionComplete:false};
 }
 async verify(database,context){
  const current=await this.facts(context),deletedSubjects=await this.deletedSubjects(context),now=this.now(),projection=await prosodyProjectionWithin(database,{now,deletedSubjects});
  const native=await this.command(context,{action:'verify'});const result=verifyProsodyState(native,projection,current.security,{now});await this.requireLiveComponent(context);return{required:true,...result,liveComponentRoundTrip:true};
 }
 async verifyLive(context){
  const current=await this.facts(context),deletedSubjects=await this.deletedSubjects(context),now=this.now(),cluster=this.config.postgres.find(x=>x.id==='business');
  if(!cluster)throw fail('maintenance_business_cluster_unknown');const args=postgresSqlArguments(cluster,prosodyProjectionCaptureSql);args.splice(args.length-2,0,'--quiet');
  const raw=(await this.run(this.config.tools.docker,args,{timeout:60000,maxOutput:maximumBytes})).stdout.trim();
  let rows;try{rows=JSON.parse(raw);}catch{throw fail('maintenance_prosody_source_facts_invalid');}
  const projection=prosodyProjectionFromRows(rows,{now,deletedSubjects}),native=await this.command(context,{action:'verify'});
  const result=verifyProsodyState(native,projection,current.security,{now});await this.requireLiveComponent(context);return{required:true,...result,liveComponentRoundTrip:true};
 }
}
