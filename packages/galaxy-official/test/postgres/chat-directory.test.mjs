import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import canonicalize from 'canonicalize';
import {migrate,transaction} from '../../src/database.mjs';
import {migrations} from '../../src/infrastructure/migrations.mjs';
import {chatSendSchema} from '../../src/shared/chat-schema.mjs';
import {digest} from '../../src/shared/digest.mjs';
import {chatFixture,invite} from '../chat-workflow.mjs';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{resolve,promise};}
async function eventually(read){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await read())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Expected database wait was not observed');}

test('actual PostgreSQL upgrade preserves original bytes and cursors; committed delivery ordering covers delayed acceptance',{timeout:300000},async()=>{
 assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
 const password=process.env.GALAXY_TEST_PG_PASSWORD_FILE?(await readFile(process.env.GALAXY_TEST_PG_PASSWORD_FILE,'utf8')).trim():undefined;
 const options={...(password?{password}:{}),max:8,statement_timeout:12000},pool=new pg.Pool(options);let runtimeDb;
 const started=Date.now(),phases=[];const mark=name=>{phases.push({name,elapsedMs:Date.now()-started});};
 const bodies=new Map();let blockRead=null,delayed=null,unknown=true,upgradeAlreadyApplied=false,oldMessageHash;
 const transport={available:true,project:async()=>{},send:async input=>{
  bodies.set(input.messageId,{archiveId:input.messageId,text:input.text,revision:1});
  if(input.text==='Delayed original delivery'&&unknown){unknown=false;throw Error('synthetic MAM acknowledgement unknown');}
  if(input.text==='Delayed original delivery'&&delayed){delayed.entered.resolve();await delayed.release.promise;}
  return{archiveId:input.messageId};},read:async input=>{if(blockRead){blockRead.entered.resolve();await blockRead.release.promise;}return input.ids.flatMap(id=>bodies.has(id)?[bodies.get(id)]:[]);}};
 try{
  const version=Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);assert.ok(version>=170000);
  const tables=(await pool.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count;
  if(tables===0){
   await transaction(pool,async db=>{await db.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const migration of migrations.filter(item=>item.version<=80)){await db.query(migration.sql);await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);}});
  }else{
   // A failed preparation may leave this isolated schema80 prefix. Preserve
   // every prior row and verify the exact prefix before continuing the upgrade.
   const current=(await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version);
   upgradeAlreadyApplied=current.at(-1)===81;
   assert.deepEqual(current,migrations.filter(item=>item.version<=(upgradeAlreadyApplied?81:80)).map(item=>item.version));
   if(!upgradeAlreadyApplied)assert.equal((await pool.query("SELECT to_regclass('public.chat_directory_clock') AS table_name")).rows[0].table_name,null);
  }
  if(!upgradeAlreadyApplied){
  const legacy=await chatFixture({database:pool,migrateDatabase:false,transport}),[oldAuthor,oldReader]=legacy.people,oldRoom=randomUUID();
  await legacy.chat.create(oldAuthor,{roomId:oldRoom,operationId:randomUUID(),title:'Synthetic schema80 conversation'});await invite(legacy.chat,oldAuthor,oldRoom,oldReader);
  const legacyInput=chatSendSchema.parse({clientMessageId:randomUUID(),text:'Retained original schema80 message'}),messageId=randomUUID(),payloadHash=digest(canonicalize(legacyInput)),sentAt=new Date(legacy.now()*1000).toISOString();
  bodies.set(messageId,{archiveId:messageId,text:legacyInput.text,revision:1});
  const original=(await pool.query(`INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,sent_at,expires_at,content_bytes,state,archive_id)
   VALUES($1::uuid,$2,$3,$4,$5,'human',$6,$7,$8,'accepted',$1::text) RETURNING *`,[messageId,oldRoom,oldAuthor.subjectId,legacyInput.clientMessageId,payloadHash,sentAt,new Date((legacy.now()+86400)*1000).toISOString(),Buffer.byteLength(legacyInput.text)])).rows[0];
  await pool.query("INSERT INTO chat_cursors(room_id,subject_id,cursor_kind,agent_ref,sequence,updated_at) VALUES($1,$2,'human','',$3,$4),($1,$2,'agent',$5,$3,$4)",[oldRoom,oldReader.subjectId,String(original.sequence),sentAt,randomUUID()]);
  const before={rooms:(await pool.query('SELECT to_jsonb(r) AS value FROM chat_rooms r ORDER BY room_id')).rows,
   members:(await pool.query('SELECT to_jsonb(m) AS value FROM chat_memberships m ORDER BY room_id,subject_id')).rows,
   messages:(await pool.query('SELECT to_jsonb(m) AS value FROM chat_message_refs m ORDER BY sequence')).rows,
   cursors:(await pool.query('SELECT to_jsonb(c) AS value FROM chat_cursors c ORDER BY room_id,subject_id,cursor_kind,agent_ref')).rows};
  assert.equal(await migrate(pool,{roles:['api']}),81);
  const after={rooms:(await pool.query("SELECT to_jsonb(r)-'created_order' AS value FROM chat_rooms r ORDER BY room_id")).rows,
   members:(await pool.query("SELECT to_jsonb(m)-'joined_order' AS value FROM chat_memberships m ORDER BY room_id,subject_id")).rows,
   messages:(await pool.query("SELECT to_jsonb(m)-'accepted_order'-'accepted_at' AS value FROM chat_message_refs m ORDER BY sequence")).rows,
   cursors:(await pool.query("SELECT to_jsonb(c)-'accepted_order' AS value FROM chat_cursors c ORDER BY room_id,subject_id,cursor_kind,agent_ref")).rows};
  assert.deepEqual(after,before);const upgraded=(await pool.query('SELECT payload_hash,accepted_order::text,accepted_at FROM chat_message_refs WHERE message_id=$1',[messageId])).rows[0];
  assert.equal(upgraded.payload_hash,payloadHash);assert.equal(upgraded.accepted_at,null);assert.ok(BigInt(upgraded.accepted_order)>0n);
  const legacyDirectory=await legacy.chat.directory(oldReader);assert.equal(legacyDirectory.rooms[0].activityTimeBasis,'legacy-sent-time');assert.equal(legacyDirectory.rooms[0].unreadHumanCount,0);
  assert.equal((await pool.query("SELECT accepted_order::text FROM chat_cursors WHERE cursor_kind='agent'")).rows[0].accepted_order,'0');
  oldMessageHash=payloadHash;mark('schema80-to81-original-facts-checked');
  }else{
   // The earlier isolated run can finish its assertions after node:test's
   // deadline. Do not erase or pretend to repeat that upgrade. Verify its
   // retained anchor, then exercise the current delivery/concurrency paths.
   assert.ok(process.env.GALAXY_CHAT_PG_UPGRADE_EVIDENCE,'Prior exact upgrade evidence required to continue an already-upgraded database');
   const prior=JSON.parse(await readFile(process.env.GALAXY_CHAT_PG_UPGRADE_EVIDENCE,'utf8'));
   assert.equal(prior.migration,81);assert.equal(prior.originalRowsAndHashesUnchanged,true);assert.equal(prior.legacyAcceptedTime,null);
   const retained=(await pool.query('SELECT payload_hash,accepted_at FROM chat_message_refs WHERE payload_hash=$1',[prior.oldMessageHash])).rows;
   assert.equal(retained.length,1);assert.equal(retained[0].accepted_at,null);oldMessageHash=retained[0].payload_hash;
   mark('already-upgraded81-original-anchor-checked');
  }
  runtimeDb=new pg.Pool({...options,options:'-c role=galaxy_api'});
  const f=await chatFixture({database:pool,runtimeDb,migrateDatabase:false,transport}),[a,b]=f.people,rooms=[];
  for(let index=0;index<3;index++){const roomId=randomUUID();await f.chat.create(a,{roomId,operationId:randomUUID(),title:'Synthetic parallel room '+index});await invite(f.chat,a,roomId,b);rooms.push(roomId);}
  mark('current-api-role-actors-and-rooms-created');
  const delayedInput={clientMessageId:randomUUID(),text:'Delayed original delivery'};
  await assert.rejects(f.chat.send(a,rooms[0],delayedInput),/synthetic MAM acknowledgement unknown/);
  const later=await f.chat.send(a,rooms[0],{clientMessageId:randomUUID(),text:'Later reserved, earlier accepted'});
  const laterHistory=await f.chat.history(b,rooms[0]);const readSequence=laterHistory.messages[0].sequence;
  await f.chat.cursor(b,rooms[0],{kind:'human',sequence:readSequence});
  for(const roomId of rooms.slice(1))await f.chat.send(a,roomId,{clientMessageId:randomUUID(),text:'Prior directory activity'});
  const firstPage=await f.chat.directory(b,{limit:1});assert.ok(firstPage.nextCursor);
  delayed={entered:deferred(),release:deferred()};const pending=f.chat.send(a,rooms[0],delayedInput);await delayed.entered.promise;
  // An unrelated send and creation commit before this MAM wait finishes:
  // the global ordering row is not held across external transport I/O.
  await f.chat.send(a,rooms[1],{clientMessageId:randomUUID(),text:'Independent delivery while MAM waits'});
  const newRoom=randomUUID();await f.chat.create(a,{roomId:newRoom,operationId:randomUUID(),title:'Created after directory page'});await invite(f.chat,a,newRoom,b);
  delayed.release.resolve();const acceptedLate=await pending;delayed=null;
  const continuation=[...firstPage.rooms];let cursor=firstPage.nextCursor;
  while(cursor){const page=await f.chat.directory(b,{limit:1,cursor});continuation.push(...page.rooms);cursor=page.nextCursor;}
  assert.equal(new Set(continuation.map(item=>item.roomId)).size,3);assert.equal(continuation.length,3);assert.equal(continuation.some(item=>item.roomId===newRoom),false);
  assert.equal(continuation.find(item=>item.roomId===rooms[0]).latestMessage.messageId,later.messageId);
  const refreshed=await f.chat.directory(b),lateRoom=refreshed.rooms.find(item=>item.roomId===rooms[0]);
  assert.equal(lateRoom.latestMessage.messageId,acceptedLate.messageId);assert.equal(lateRoom.unreadHumanCount,1,'A lower sequence accepted after the old human waterline remains unread');
  const history=await f.chat.history(b,rooms[0]),late=history.messages.find(item=>item.messageId===acceptedLate.messageId);
  assert.ok(BigInt(late.sequence)<BigInt(readSequence));
  await f.chat.cursor(b,rooms[0],{kind:'human',sequence:readSequence,visibleMessageIds:[late.messageId]});
  assert.equal((await f.chat.directory(b)).rooms.find(item=>item.roomId===rooms[0]).unreadHumanCount,0);
  mark('delayed-delivery-and-fixed-directory-pages-checked');
  blockRead={entered:deferred(),release:deferred()};const reading=f.chat.history(b,rooms[0]);await blockRead.entered.promise;
  await f.chat.hide(b,rooms[0],late.messageId);blockRead.release.resolve();const current=await reading;blockRead=null;
  assert.equal(current.messages.some(item=>item.messageId===late.messageId),false,'A late archive read cannot restore personally hidden body');
  mark('hide-during-archive-read-checked');
  const first=await pool.connect(),second=await pool.connect(),observer=await pool.connect();let secondValue;
  try{
   const clockBefore=String((await observer.query('SELECT value FROM chat_directory_clock WHERE singleton=true')).rows[0].value);
   await first.query('BEGIN');const firstValue=String((await first.query('SELECT public.galaxy_chat_next_directory_order() AS value')).rows[0].value);
   await second.query('BEGIN');const pid=(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const allocating=second.query('SELECT public.galaxy_chat_next_directory_order() AS value');
   await eventually(async()=>(await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock');
   assert.equal(String((await observer.query('SELECT value FROM chat_directory_clock WHERE singleton=true')).rows[0].value),clockBefore);
   await first.query('COMMIT');secondValue=String((await allocating).rows[0].value);await second.query('COMMIT');assert.equal(BigInt(secondValue),BigInt(firstValue)+1n);
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();observer.release();}
  mark('transactional-counter-commit-order-checked');
  const evidence={checkedAt:new Date().toISOString(),database:'explicit-isolated-PostgreSQL',serverVersion:version,migration:81,initialTables:tables,originalRowsAndHashesUnchanged:true,
   upgradeAlreadyApplied,upgradeEvidence:upgradeAlreadyApplied?process.env.GALAXY_CHAT_PG_UPGRADE_EVIDENCE:null,phases,
   oldMessageHash,legacyAcceptedTime:null,legacyHumanCursorCompatible:true,agentCursorNotReused:true,
   directoryPagesUnique:true,newRoomDeferredUntilRefresh:true,delayedLowSequenceUnread:true,actualVisibleReadCleared:true,
   unrelatedWriteCommittedBeforeMAMRelease:true,hiddenDuringArchiveReadRemoved:true,transactionalCounterLockObserved:true,
   transport:'explicit-contract-double for concurrency; independent real-Prosody browser scene is separate'};
  if(process.env.GALAXY_CHAT_PG_EVIDENCE)await writeFile(process.env.GALAXY_CHAT_PG_EVIDENCE,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
 }finally{if(delayed)delayed.release.resolve();if(blockRead)blockRead.release.resolve();await runtimeDb?.end();await pool.end();}
});
