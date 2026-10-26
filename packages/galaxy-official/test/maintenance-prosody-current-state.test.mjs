import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {serviceFixture} from './service-fixture.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {captureDeletionLedger} from '../src/operations/deletion-ledger.mjs';
import {executedProsodyDeletionSubjects,prosodyProjectionWithin,prosodyProjectionCaptureSql,prosodyProjectionFromRows,
 reconcileProsodySqlCandidate,verifyProsodyState,MaintenanceProsodyCurrentState} from '../deploy/maintenance-agent/prosody-current-state.mjs';
import {createProductionRestoreAdapters,maintenanceNativeAuthorityGaps} from '../deploy/maintenance-agent/production-restore.mjs';
import {runCommand} from '../deploy/operations-stack/host.mjs';

const linux={skip:process.platform!=='linux'?'The native private candidate uses Linux/Docker.':false};
const uuid=()=>randomUUID();
const identity='GUID'+'A'.repeat(28),other='GUID'+'B'.repeat(28);
const emptySecurity=()=>Object.fromEntries(['galaxy.internal','gateway.galaxy.internal'].map(h=>[h,{accounts:{users:[]},roles:{users:[]}}]));

test('Prosody restore contribution validates actual signed executed deletion, current withdrawal and expiry before consuming native receipts on exact PG quarantine',async t=>{
 const f=await serviceFixture(['binding','consent','data-delete']);t.after(()=>f.db.close());
 const independent=await serviceFixture(['binding'],f.db,{migrateDatabase:false,now:f.now});
 const room=uuid(),operationId=uuid(),stamp=new Date(f.now*1000),future=new Date((f.now+3600)*1000);
 await f.db.query("INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,mode,state,had_multiple,created_at,updated_at) VALUES($1,$2,$3,'synthetic-only','Original shared room','ownerless','active',true,$4,$4)",[room,f.actor.subjectId,uuid(),stamp]);
 for(const subject of[f.actor.subjectId,independent.actor.subjectId])await f.db.query('INSERT INTO chat_memberships(room_id,subject_id,controller_ref,joined_at) VALUES($1,$2,$3,$4)',[room,subject,'subject:'+subject,stamp]);
 const records=[{id:uuid(),subject:f.actor.subjectId,state:'accepted',expires:future},{id:uuid(),subject:independent.actor.subjectId,state:'accepted',expires:future},
  {id:uuid(),subject:independent.actor.subjectId,state:'retracted',expires:future},{id:uuid(),subject:independent.actor.subjectId,state:'accepted',expires:new Date((f.now-1)*1000)}];
 for(const r of records)await f.db.query('INSERT INTO chat_message_refs(message_id,room_id,subject_id,client_message_id,payload_hash,actor_kind,archive_id,state,sent_at,expires_at,purge_pending,content_bytes) VALUES($1,$2,$3,$4,$5,\'human\',$6,$7,$8,$9,false,9)',[r.id,room,r.subject,uuid(),'a'.repeat(64),r.id,r.state,stamp,r.expires]);
 const command=await approveFixtureDeletion(f,f.db),beforeExecution=await captureDeletionLedger(f.db,{endpoint:f.access.endpoint,now:()=>f.now});
 assert.deepEqual(await executedProsodyDeletionSubjects(JSON.parse(beforeExecution.payloadJson),f.access.endpoint),[],'approval alone is not execution');
 await executeDeletion(f.db,command,{now:()=>f.now});
 const capture=await captureDeletionLedger(f.db,{endpoint:f.access.endpoint,now:()=>f.now+1}),ledger=JSON.parse(capture.payloadJson);
 const deletedSubjects=await executedProsodyDeletionSubjects(ledger,f.access.endpoint);assert.deepEqual(deletedSubjects,[{subjectId:f.actor.subjectId,requestId:command.requestId}]);
 const altered=structuredClone(ledger);altered.tables.deletion_requests[0].subject_id=independent.actor.subjectId;
 await assert.rejects(executedProsodyDeletionSubjects(altered,f.access.endpoint),{code:'maintenance_prosody_deletion_ledger_invalid'});
 const projection=await prosodyProjectionWithin(f.db,{now:f.now,deletedSubjects});assert.equal(projection.messages.filter(x=>x.erase).length,3);assert.deepEqual(projection.rooms[0].members,[independent.actor.subjectId]);
 const query=await f.db.exec(prosodyProjectionCaptureSql),raw=query.find(x=>x.rows?.[0]?.json_build_object).rows[0].json_build_object;
 assert.deepEqual(prosodyProjectionFromRows(raw,{now:f.now,deletedSubjects}),projection);
 const receipts=projection.messages.filter(x=>x.erase).map(x=>({roomId:x.roomId,messageId:x.messageId,archiveDeleted:true}));
 await assert.rejects(reconcileProsodySqlCandidate(f.db,{operationId,projection,receipts,now:f.now}),{code:'maintenance_exact_quarantine_required'});
 await f.db.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')",[operationId,'a'.repeat(64)]);
 await assert.rejects(reconcileProsodySqlCandidate(f.db,{operationId,projection,receipts:receipts.slice(1),now:f.now}),{code:'maintenance_prosody_archive_delete_unconfirmed'});
 const result=await reconcileProsodySqlCandidate(f.db,{operationId,projection,receipts,now:f.now});assert.equal(result.serviceWideDeletionComplete,false);
 const rows=(await f.db.query('SELECT message_id,state,purge_pending,content_bytes FROM chat_message_refs')).rows;
 for(const id of[records[0].id,records[2].id,records[3].id]){const r=rows.find(x=>x.message_id===id);assert(['retracted','expired'].includes(r.state));assert.equal(r.purge_pending,false);assert.equal(r.content_bytes,0);}
 assert.equal(rows.find(x=>x.message_id===records[1].id).state,'accepted');assert.equal(rows.find(x=>x.message_id===records[1].id).content_bytes,9);
 const after=await prosodyProjectionWithin(f.db,{now:f.now,deletedSubjects});assert.equal(after.rooms[0].state,'single-member-decision');assert.equal(after.rooms[0].revision,2);
 assert.deepEqual(after.rooms[0].members,[independent.actor.subjectId]);
});

test('Prosody 13.0.6 native internal driver merges current native identities and MUC ACLs, erases only eligible keys and proves native absence without exporting bodies',linux,async()=>{
 // This is a single short-lived native process from the CURRENT fixed image.
 // It has no network, production mount, configuration, credential or daemon.
 const image=(await runCommand('/usr/bin/docker',['inspect','--format','{{.Image}}','galaxy-chat-pilot-chat-1'],{timeout:10000,maxOutput:1024})).stdout.trim();assert.match(image,/^sha256:[a-f0-9]{64}$/);
 const source=await readFile(new URL('../deploy/maintenance-agent/prosody-storage.lua',import.meta.url),'utf8');assert(!source.includes(']====]'));
 const room=uuid(),ids=Array.from({length:7},uuid),now=2000000000,op=uuid();
 const data={room,ids,now,op,identity,other,requestId:uuid()};
 const program=`package.path='/usr/local/lib/prosody/?.lua;'..package.path;package.cpath='/usr/local/lib/prosody/?.so;'..package.cpath;dofile('/usr/local/lib/prosody/loader.lua');prosody={paths={data='/galaxy-candidate'}};
 local json=require'prosody.util.json';local dm=require'prosody.util.datamanager';local st=require'prosody.util.stanza';local x=json.decode(io.read('*a'));local host='rooms.galaxy.internal';
 local loader=assert(load([====[${source}]====],'@galaxy-maintenance-prosody','t',_ENV));local adapter=loader();
 assert(dm.store('current','galaxy.internal','accounts',{stored_key='OLD-PASSWORD'}));assert(dm.store('revoked','galaxy.internal','accounts',{stored_key='REVOKED-PASSWORD'}));
 assert(dm.store('current','galaxy.internal','roles',{role='prosody:admin'}));
 assert(dm.store(x.room,host,'config',{_jid=x.room..'@'..host,_data={galaxy_v2={revision=1,state='active',members={[x.identity]=true,[x.other]=true}}},[x.identity:lower()..'@gateway.galaxy.internal']='owner',[x.other:lower()..'@gateway.galaxy.internal']='member'}));
 assert(dm.store(x.room,host,'state',{_last_message={body='OLD-OCCUPANT-HISTORY'}}));
 local function append(id,subject,expiry,revision)
  local m={subject=subject,revision=revision or 1,expires_at=expiry,payload_hash=string.rep('a',64),sent_at=x.now-20};
  local v=st.preserialize(st.message({type='groupchat',from=x.room..'@'..host,id=id}):tag('body'):text('SYNTHETIC-BODY-NEVER-EXPORTED'):up():tag('metadata',{xmlns='urn:galaxy:rooms:2'}):text(json.encode(m)):up());
  v.key=id;v.when=x.now-20;v.with='message<groupchat';assert(dm.list_append(x.room,host,'muc_log',v));
 end
 append(x.ids[1],x.identity,x.now+100);append(x.ids[2],x.other,x.now+100);append(x.ids[3],x.other,x.now+100);append(x.ids[4],x.other,x.now-1);append(x.ids[5],x.identity,x.now+100);append(x.ids[6],x.other,x.now+100);
 local inspect=adapter({action='inspect',candidate=true,privateCandidate=true,operationId=x.op});assert(inspect.nativeMessages==6 and inspect.changed==false and inspect.liveComponentRoundTrip==false);
 local rows={};for i=1,6 do if i~=5 then rows[#rows+1]={roomId=x.room,messageId=x.ids[i],subjectId=i==1 and x.identity or x.other,erase=i==1 or i==3 or i==4,expiresAt=i==4 and x.now-1 or x.now+100,revision=i==6 and 2 or 1,archiveId=i==6 and json.null or x.ids[i]};end end
 local projection={rooms={{roomId=x.room,title='Current canonical title',state='active',revision=3,members={x.other}}},messages=rows,deletedSubjects={{subjectId=x.identity,requestId=x.requestId}}};
 local args={action='reconcile',candidate=true,privateCandidate=true,operationId=x.op,now=x.now,projection=projection,stage='erase'};local removed=adapter(args);assert(#removed.receipts==4);
 local security={['galaxy.internal']={accounts={users={{node='current',value={stored_key='CURRENT-PASSWORD'}}}},roles={users={{node='current',value={role='prosody:member'}}}}},['gateway.galaxy.internal']={accounts={users={}},roles={users={}}}};
 args.stage=nil;args.security=security;args.tombstones={{roomId=x.room,records={[x.ids[1]]=x.now+500}}};local merged=adapter(args);
 assert(#merged.messages==2 and merged.occupantStates==0 and #merged.rooms[1].members==1 and merged.rooms[1].members[1]==x.other);assert(merged.rooms[1].affiliations[x.identity:lower()..'@gateway.galaxy.internal']==nil);
 assert(dm.load('revoked','galaxy.internal','accounts')==nil);assert(dm.load('current','galaxy.internal','accounts').stored_key=='CURRENT-PASSWORD');assert(dm.load('current','galaxy.internal','roles').role=='prosody:member');
 assert(dm.load(x.room,host,'galaxy_erased')[x.ids[1]]==x.now+500);assert(dm.load(x.room,host,'galaxy_erased')[x.ids[2]]==nil);
 local list=dm.list_load(x.room,host,'muc_log');assert(#list==2);for _,v in ipairs(list)do assert(v.key==x.ids[2]or v.key==x.ids[6]);end
 local raw_write=dm.store;dm.store=function()error('read-only inspection tried to write')end;assert(adapter({action='inspect',candidate=true,privateCandidate=true,operationId=x.op}).nativeMessages==2);dm.store=raw_write;
 append(x.ids[7],x.other,x.now+100);local ok,err=pcall(adapter,args);assert(not ok and err=='maintenance_prosody_native_source_unknown');
 print(json.encode({nativeVersion='13.0.6',eligibleErased=4,independentRetained=2,currentAccountAndRolesPreserved=true,revokedNativeUserAbsent=true,oldRoomOwnerRemoved=true,oldOccupantsCleared=true,unknownOrphanBlocked=true,readOnlyInspectDidNotWrite=true,bodyReturned=false,productionMounted=false}));`;
 const executed=spawnSync('/usr/bin/docker',['run','--rm','--interactive','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','256m',
  '--tmpfs','/galaxy-candidate:rw,nosuid,noexec,size=32m','--tmpfs','/tmp:rw,nosuid,noexec,size=16m','--entrypoint','/usr/bin/lua',image,'-e',program],{input:JSON.stringify(data),timeout:120000,maxOutput:8192});
 // This process has synthetic input and no production mounts. Keep even its
 // diagnostics to the code/line; never dump command arguments or data values.
 const stderr=executed.stderr?.toString()??'',line=stderr.match(/:\s*(\d+):/),code=stderr.match(/maintenance_prosody_[a-z_]+/);
 const syntheticDiagnostic=stderr.split('\n')[0].slice(0,400).replace(/(?:OLD|REVOKED|CURRENT)-PASSWORD|SYNTHETIC-BODY-NEVER-EXPORTED/g,'[synthetic-value]');
 assert.equal(executed.status,0,'native fixture exit='+executed.status+' line='+(line?.[1]??'not-reported')+' code='+(code?.[0]??'native-fixture-failed')+' diagnostic='+syntheticDiagnostic);
 const response={stdout:executed.stdout.toString()};
 const result=JSON.parse(response.stdout);assert.equal(result.eligibleErased,4);assert.equal(result.independentRetained,2);assert.equal(result.bodyReturned,false);assert(!response.stdout.includes('PASSWORD'));assert(!response.stdout.includes('SYNTHETIC-BODY'));
});

test('Prosody current-state integration fails closed for process-only readiness, stale permissions and missing exact native receipts before production effects',async()=>{
 const probe=new MaintenanceProsodyCurrentState();await assert.rejects(probe.requireLiveComponent({intent:{}}),{code:'maintenance_prosody_live_component_probe_not_connected'});
 probe.probe=async()=>({roundTrip:true,processRunning:true});await assert.rejects(probe.requireLiveComponent({intent:{}}),{code:'maintenance_prosody_live_component_readiness_unconfirmed'});
 probe.probe=async()=>({authenticatedGateway:true,roomsDomain:'rooms.galaxy.internal',bodyReturned:false,readOnly:true,roundTrip:true});assert.deepEqual(await probe.requireLiveComponent({intent:{}}),{liveComponentRoundTrip:true,bodyReturned:false});
 const room=uuid(),id=uuid(),projection={rooms:[{roomId:room,revision:2,state:'active',members:[other]}],messages:[{roomId:room,messageId:id,subjectId:other,revision:2,archiveId:null,erase:false}],deletedSubjects:[]};
 const native={version:1,rooms:[{roomId:room,revision:2,state:'active',members:[other],affiliations:{[other.toLowerCase()+'@gateway.galaxy.internal']:'member'}}],messages:[{roomId:room,messageId:id,subjectId:other,revision:1,expiresAt:3000000000}],security:emptySecurity(),occupantStates:0};
 assert.equal(verifyProsodyState(native,projection,emptySecurity(),{now:2000000000}).withheldOlderRevisions,1);
 assert.throws(()=>verifyProsodyState({...native,rooms:[{...native.rooms[0],affiliations:{[identity.toLowerCase()+'@gateway.galaxy.internal']:'owner'}}]},projection,emptySecurity()),{code:'maintenance_prosody_current_authority_unconfirmed'});
 assert.throws(()=>verifyProsodyState(native,{...projection,messages:[{...projection.messages[0],archiveId:id}]},emptySecurity()),{code:'maintenance_prosody_native_revision_unconfirmed'});
 let calls=0;const closed=createProductionRestoreAdapters({config:{},run:async()=>{calls++;throw Error('no effects permitted');},controlDirectory:'/not-used'});
 await assert.rejects(closed.contain({intent:{moduleIds:['business','chat']}}),{code:'maintenance_current_chat_native_readiness_not_proven'});assert.equal(calls,0);
 assert.deepEqual(maintenanceNativeAuthorityGaps(['business','chat'],{chatProbeConnected:true}),[]);assert.deepEqual(maintenanceNativeAuthorityGaps(['chat'],{chatProbeConnected:true}),['maintenance_prosody_current_database_scope_required']);
 const objects=createProductionRestoreAdapters({config:{tools:{docker:'synthetic-read-only-transport'},postgres:[{id:'business',container:'synthetic-pg',socketPath:'/tmp',administrator:'postgres',database:'galaxy_pilot'}]},controlDirectory:'/not-used',
  run:async(_file,args)=>{assert.equal(args.at(-1),'SELECT count(*) FROM deletion_requests WHERE execution_result IS NOT NULL');return{stdout:'1\n'};},gate:{contain:async()=>{throw Error('must not contain or restore when native owned-object contribution is missing');}}});
 await assert.rejects(objects.contain({intent:{moduleIds:['objects']}}),{code:'maintenance_object_current_database_scope_required'});
});
