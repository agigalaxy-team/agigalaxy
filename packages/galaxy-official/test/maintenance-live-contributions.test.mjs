import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {xml} from '@xmpp/component';
import {serviceFixture} from './service-fixture.mjs';
import {approveFixtureDeletion} from './deletion-execute-workflow.mjs';
import {executeDeletion} from '../src/operations/deletion-execute.mjs';
import {captureDeletionLedger} from '../src/operations/deletion-ledger.mjs';
import {ProsodyChatTransport} from '../src/infrastructure/prosody-chat.mjs';
import {ChatService} from "../src/chat/service.mjs";
import {verifyMaintenanceSignature} from "../src/operations/maintenance/native.mjs";
import {createMaintenanceProsodyProbe} from '../deploy/maintenance-agent/prosody-live-client.mjs';
import {executedObjectDeletionSubjects,attachmentPointersWithin,attachmentPointerCaptureSql,attachmentPointersFromRows,buildObjectDeletionPlan,reconcileExactOwnedObjects,MaintenanceObjectDeletion,objectReceiptArguments} from '../deploy/maintenance-agent/object-deletion.mjs';
import {createProductionRestoreAdapters} from '../deploy/maintenance-agent/production-restore.mjs';
import {runCommand} from '../deploy/operations-stack/host.mjs';

const stamp=n=>new Date(n*1000).toISOString(),hash='a'.repeat(64);
const linux={skip:process.platform!=='linux'?'Private native recovery artifacts require Linux file ownership.':false};
const success=()=>({authenticatedGateway:true,roomsDomain:'rooms.galaxy.internal',roundTrip:true,readOnly:true,bodyReturned:false});

test('maintenance live Prosody probe uses only the already authenticated XMPP stream and fixed signed loopback metadata contract',async()=>{
 const transport=new ProsodyChatTransport({service:'xmpp://127.0.0.1:5347',domain:'gateway.galaxy.internal',roomsDomain:'rooms.galaxy.internal',secret:'synthetic-component-secret-not-production',timeoutMs:20});
 await assert.rejects(transport.probe(),{code:'chat_transport_unavailable'});
 let sent=0;transport.client.emit('online');
 transport.client.send=async stanza=>{sent++;assert.equal(stanza.attrs.type,'get');assert.equal(stanza.attrs.to,'rooms.galaxy.internal');assert.equal(stanza.attrs.from,'gateway.galaxy.internal');assert(stanza.getChild('query','http://jabber.org/protocol/disco#info'));assert.equal(stanza.children.length,1);
  transport.client.emit('stanza',xml('iq',{id:stanza.attrs.id,type:'result',from:'rooms.galaxy.internal',to:'gateway.galaxy.internal'},xml('query',{xmlns:'http://jabber.org/protocol/disco#info'},xml('identity',{category:'conference',type:'text'}),xml('feature',{var:'http://jabber.org/protocol/muc'}))));};
 assert.deepEqual(await new ChatService({transport}).maintenanceReadiness(),success());assert.equal(sent,1);assert.equal(transport.pending.size,0);
 for(const change of ['foreign-from','foreign-to','body','error']){
  transport.client.send=async stanza=>{const attrs={id:stanza.attrs.id,type:change==='error'?'error':'result',from:change==='foreign-from'?'another.galaxy.internal':'rooms.galaxy.internal',to:change==='foreign-to'?'another.galaxy.internal':'gateway.galaxy.internal'};
   transport.client.emit('stanza',xml('iq',attrs,...(change==='body'?[xml('body',{},'synthetic-content-not-permitted')]:[])));};
  await assert.rejects(transport.probe(),{code:change==='foreign-from'?'chat_delivery_unknown':'chat_transport_invalid_reply'});assert.equal(transport.pending.size,0);
 }
 transport.client.send=async()=>transport.client.emit('offline');await assert.rejects(transport.probe(),{code:'chat_delivery_unknown'});
 const serviceKey='synthetic-private-service-key-only',configuration={authorizationUrl:'http://127.0.0.1:3201/v1/internal/maintenance/authorize',serviceKey};
 let calls=0;const probe=createMaintenanceProsodyProbe({configuration,now:()=>2000000000,fetchImpl:async(url,request)=>{calls++;assert.equal(url,'http://127.0.0.1:3201/v1/internal/maintenance/chat-probe');assert.equal(request.redirect,'error');assert.equal(request.headers['x-forwarded-for'],'127.0.0.1');assert.equal(request.headers['x-galaxy-service-key'],serviceKey);
  assert(verifyMaintenanceSignature(serviceKey,request.headers['x-galaxy-service-signature'],{id:request.headers['x-galaxy-request-id'],at:request.headers['x-galaxy-request-at'],body:request.body}));
  assert.deepEqual(JSON.parse(request.body),{version:1,kind:'prosody-current-state',operationId:null});return new Response(JSON.stringify(success()),{status:200});}});
 assert.deepEqual(await probe(),success());assert.equal(calls,1);
 await assert.rejects(probe({operationId:'arbitrary-room-or-command'}),{code:'maintenance_prosody_live_component_readiness_unconfirmed'});assert.equal(calls,1);
 for(const response of [new Response('{}',{status:403}),new Response(JSON.stringify({...success(),body:'not-permitted'}),{status:200})])await assert.rejects(createMaintenanceProsodyProbe({configuration,fetchImpl:async()=>response})(),{code:'maintenance_prosody_live_component_readiness_unconfirmed'});
 // This leaf doubles the authenticated stream/HTTP transport. The actual
 // production API-owned connection is deliberately not opened/replaced here.
});

test('maintenance exact Garage contribution uses executed signed identity scope and current PG references, resolves exact lost ACK and never expires unrelated objects',linux,async t=>{
 const fixtureContainer=process.env.GALAXY_TEST_POSTGRES_CONTAINER;
 assert.match(fixtureContainer??'',/^galaxy-recovery-test-[a-z0-9-]+$/,'Environment not configured: GALAXY_TEST_POSTGRES_CONTAINER must name this run\'s isolated galaxy-recovery-test-* PostgreSQL container; no production default exists.');
 const directory=await mkdtemp(join(tmpdir(),'galaxy-maintenance-objects-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=await serviceFixture(['binding','consent','data-delete']);t.after(()=>f.db.close());const other=await serviceFixture(['binding'],f.db,{migrateDatabase:false,now:f.now});
 const operationId=randomUUID(),room=randomUUID(),account=randomUUID(),created=stamp(f.now),future=stamp(f.now+3600);
 await f.db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://fixture.invalid','object-owner','email',$3,$3)",[account,f.access.endpoint,created]);
 await f.db.query("INSERT INTO chat_participants_v3(actor_ref,kind,account_id) VALUES($1,'official-account',$2)",['account:'+account,account]);
 await f.db.query("INSERT INTO chat_rooms(room_id,creator_subject_id,operation_id,request_hash,title,mode,state,had_multiple,created_at,updated_at) VALUES($1,$2,$3,'fixture','Synthetic','ownerless','active',true,$4,$4)",[room,f.actor.subjectId,randomUUID(),created]);
 const records=[];const add=async(table,subject,{author=null,accountId=account,prefix='attachments',expired=false}={})=>{
  const id=randomUUID(),storageKey=prefix+'/'+id;records.push({table,id,storageKey});
  const common=[id,subject,storageKey,hash,created,expired?stamp(f.now-1):future];
  if(table==='chat_attachments')await f.db.query("INSERT INTO chat_attachments(id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,expires_at,purge_pending) VALUES($1,$7,$2,'fixture','Synthetic name','text/plain',4,$4,$3,'synthetic-sse','available',$5,$6,$6,$8)",[...common,room,expired]);
  if(table==='forum_attachments_v1')await f.db.query("INSERT INTO forum_attachments_v1(id,account_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,expires_at) VALUES($1,$7,$2,'fixture','Synthetic name','text/plain',4,$4,$3,'synthetic-sse','available',$5,$6,$6)",[...common,accountId]);
  if(table==='outcome_materials_v2')await f.db.query("INSERT INTO outcome_materials_v2(id,subject_id,author_id,case_id,source,source_kind,request_id,revision,state,created_at,request_expires_at,byte_size,sha256,storage_key,encryption_key_id) VALUES($1,$2,$7,$8,'{}','attachment',$9,1,'available',$5,$6,4,$4,$3,'synthetic-sse')",[...common,author,randomUUID(),randomUUID()]);
  if(table==='feedback_attachments_v1')await f.db.query("INSERT INTO feedback_attachments_v1(id,endpoint,account_id,submission_operation_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at) VALUES($1,$6,$7,$8,$3,'Synthetic','text/plain',4,$3,$2,'synthetic-sse','available',$4,$5)",[id,storageKey,hash,created,future,f.access.endpoint,accountId,randomUUID()]);
  return records.at(-1);
 };
 const owned=await add('chat_attachments',f.actor.subjectId),foreign=await add('chat_attachments',other.actor.subjectId,{expired:true});
 const accountOwned=await add('chat_attachments','account:'+account),forumOwned=await add('forum_attachments_v1',f.actor.subjectId),forumCookie=await add('forum_attachments_v1',null);
 const outcome=await add('outcome_materials_v2',other.actor.subjectId,{author:f.actor.subjectId,prefix:'outcome-materials'}),feedback=await add('feedback_attachments_v1',null,{prefix:'feedback-attachments'});
 const point=await attachmentPointersWithin(f.db);assert.equal(point.length,7);
 const command=await approveFixtureDeletion(f,f.db),approved=await captureDeletionLedger(f.db,{endpoint:f.access.endpoint,now:()=>f.now});
 assert.deepEqual(await executedObjectDeletionSubjects(JSON.parse(approved.payloadJson),f.access.endpoint),[]);
 await executeDeletion(f.db,command,{now:()=>f.now});const captured=await captureDeletionLedger(f.db,{endpoint:f.access.endpoint,now:()=>f.now+1}),ledger=JSON.parse(captured.payloadJson);
 const deletedSubjects=await executedObjectDeletionSubjects(ledger,f.access.endpoint);assert.deepEqual(deletedSubjects,[{subjectId:f.actor.subjectId,requestId:command.requestId}]);
 const altered=structuredClone(ledger);altered.tables.deletion_requests[0].subject_id=other.actor.subjectId;await assert.rejects(executedObjectDeletionSubjects(altered,f.access.endpoint),{code:'maintenance_object_deletion_ledger_invalid'});
 const sqlRaw=await f.db.exec(attachmentPointerCaptureSql),json=sqlRaw.find(x=>x.rows?.[0]?.json_build_object).rows[0].json_build_object;
 assert.deepEqual(attachmentPointersFromRows(json),await attachmentPointersWithin(f.db));
 const canonical=await attachmentPointersWithin(f.db),plan=buildObjectDeletionPlan({current:canonical,point,canonical,deletedSubjects,now:f.now});
 assert.deepEqual(new Set(plan.targets.map(x=>x.storageKey)),new Set([owned,forumOwned,outcome].map(x=>x.storageKey)));
 const leased=structuredClone(point),busy=leased.find(x=>x.id===owned.id);busy.leaseId=randomUUID();busy.leaseUntil=future;
 assert.throws(()=>buildObjectDeletionPlan({current:[],point:leased,canonical:[],deletedSubjects,now:f.now}),{code:'maintenance_object_processing_busy'});
 const conflict=structuredClone(point[0]);conflict.id=randomUUID();conflict.table='feedback_attachments_v1';conflict.subjectId=null;
 assert.throws(()=>buildObjectDeletionPlan({current:point,point:[conflict],canonical:[],deletedSubjects,now:f.now}),{code:'maintenance_object_independent_reference_conflict'});
 const objects=new Map(records.map(x=>[x.storageKey,{size:4,sha256:hash}])),erased=[];let lost=true;
 const store={keyId:'synthetic-sse',close(){},async request(Command){assert.equal(Command.name,'ListObjectsV2Command');return{Contents:[...objects.keys()].map(Key=>({Key})),IsTruncated:false};},async head({key}){return objects.get(key)??null;},async erase({key}){erased.push(key);objects.delete(key);if(lost){lost=false;throw Error('synthetic lost delete ACK');}return{objectRemoved:true};}};
 const unknown='attachments/'+randomUUID();objects.set(unknown,{size:4,sha256:hash});await assert.rejects(reconcileExactOwnedObjects({store,plan}),{code:'maintenance_object_native_owner_unknown'});assert.equal(erased.length,0);objects.delete(unknown);
 const target=plan.targets[0];objects.set(target.storageKey,{size:8,sha256:hash});await assert.rejects(reconcileExactOwnedObjects({store,plan}),{code:'maintenance_object_content_changed'});objects.set(target.storageKey,{size:4,sha256:hash});
 await f.db.query("INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')",[operationId,'b'.repeat(64)]);
 const cluster={id:'business',container:'synthetic-pg',socketPath:'/tmp',administrator:'postgres',database:'galaxy_pilot'},context={intent:{operationId,moduleIds:['objects','business']},authority:{endpoint:f.access.endpoint},currentFacts:{},artifacts:{},containment:{operationId,publicActivation:false,activeWriters:[],stopped:[]},footprint:{containers:[]}};
 const adapter=new MaintenanceObjectDeletion({config:{tools:{docker:'synthetic-docker'},postgres:[cluster]},controlDirectory:directory,now:()=>f.now,storeFactory:async()=>({store,binding:'synthetic-current-protected-binding'}),run:async(_tool,args,options)=>{
  if(options?.input){assert(args.includes('--interactive'),'docker exec must actually forward psql stdin');assert(args.includes('--quiet'),'per-object UPDATE status output must not overflow bounded stdout');assert.deepEqual(args.slice(-2),['--file','-']);}
  const sql=options?.input??args.at(-1);if(sql.startsWith('SELECT recovery_id'))return{stdout:(await f.db.query(sql)).rows[0]['?column?']};
  const values=await f.db.exec(sql);const found=values.find(x=>x.rows?.[0]?.json_build_object);return{stdout:found?JSON.stringify(found.rows[0].json_build_object):''};}});
 context.currentFacts.deletion={...await adapter.save(context,'deletion',ledger),signatureValidated:true};context.currentFacts.objects=await adapter.capture(context);
 context.artifacts.objectDeletionPlan=await adapter.prepare(f.db,context,point);context.artifacts.deletion={quarantined:true};
 await assert.rejects(adapter.reconcile(context),{code:'maintenance_object_containment_required'});assert.equal(erased.length,0);
 context.artifacts.garageSecurity={currentBucketPermissionsPreserved:true};await f.db.query("UPDATE recovery_state SET status='ready'");
 const result=await adapter.reconcile(context);context.artifacts.objectDeletion=result;assert.equal(result.confirmedAbsent,3);assert.equal(result.serviceWideDeletionComplete,false);assert.equal(result.physicalMediaErasureProven,false);
 assert.deepEqual(new Set(erased),new Set([owned,forumOwned,outcome].map(x=>x.storageKey)));
 assert.deepEqual(new Set(objects.keys()),new Set([foreign,accountOwned,forumCookie,feedback].map(x=>x.storageKey)),'unrelated expiry/pending and account-owned sources are not deletion scope');
 for(const row of[owned,forumOwned,outcome]){const current=(await f.db.query('SELECT state,purge_pending,purged_at FROM '+row.table+' WHERE id=$1',[row.id])).rows[0];assert.equal(current.state,'erased');assert.equal(current.purge_pending,false);assert(current.purged_at);}
 assert.equal((await f.db.query('SELECT state FROM chat_attachments WHERE id=$1',[foreign.id])).rows[0].state,'available');
 assert.equal((await adapter.verify(context)).confirmedAbsent,3);
 // Exercise the actual docker/psql stdin route with a literal read-only
 // statement, never the synthetic mutation script or any current object ID.
 const args=objectReceiptArguments({id:'business',container:fixtureContainer,socketPath:'/var/run/postgresql',administrator:'postgres',database:'postgres'});
 const native=await runCommand('/usr/bin/docker',args,{input:"BEGIN READ ONLY; SELECT 'fixed-stdin-roundtrip'; COMMIT;",timeout:15000,maxOutput:1024});
 assert.equal(native.stdout.trim(),'fixed-stdin-roundtrip');
 // This is real signed deletion + PG source/receipt behavior. S3 is an explicit
 // in-memory transport double: no current Garage object is changed or erased.
});

test('maintenance production candidate reconciles exact object contribution before resuming any application writer and keeps readiness failure contained',async()=>{
 const names={objects:'synthetic-garage',api:'galaxy-api@pilot.service',worker:'galaxy-worker@pilot.service'},events=[];
 const writers=[{kind:'container',name:names.objects},{kind:'systemd',name:names.api},{kind:'systemd',name:names.worker}];
 const context={intent:{operationId:randomUUID(),moduleIds:['objects','business']},containment:{operationId:null,publicActivation:false,activeWriters:writers,stopped:[...writers]},footprint:{containers:[{id:'objects',name:names.objects}]},artifacts:{},currentFacts:{engines:{}}};context.containment.operationId=context.intent.operationId;
 // Avoid durable host checkpoint writes by supplying only this isolated temp.
 const directory=await mkdtemp(join(tmpdir(),'galaxy-maintenance-order-'));
 let unavailable=false;
 const patched=createProductionRestoreAdapters({config:{tools:{systemctl:'synthetic-systemctl',docker:'synthetic-docker'},postgres:[]},controlDirectory:directory,run:async(_tool,args)=>{events.push(args[0]+':'+args[1]);return{stdout:''};},databases:{activate:async()=>{}},files:{activate:async()=>{}},engines:{restoreGarage:async()=>{events.push('garage-current-authority');return{currentBucketPermissionsPreserved:true};}},objects:{reconcile:async()=>{events.push('objects-exact-contribution');assert(!events.includes('start:'+names.api));assert(!events.includes('start:'+names.worker));if(unavailable)throw Object.assign(Error('maintenance_object_delete_result_unknown'),{code:'maintenance_object_delete_result_unknown'});return{nativeOwnedObjectsReconciled:true};}},discovery:{reconcile:async()=>({})}});
 try{await patched.activate(context);assert(events.indexOf('garage-current-authority')<events.indexOf('objects-exact-contribution'));assert(events.indexOf('objects-exact-contribution')<events.indexOf('start:'+names.api));assert(events.indexOf('objects-exact-contribution')<events.indexOf('start:'+names.worker));assert.equal(context.activated,true);
  unavailable=true;events.length=0;context.activated=false;await assert.rejects(patched.activate(context),{code:'maintenance_object_delete_result_unknown'});assert.equal(context.activated,false);assert(!events.includes('start:'+names.api));assert(!events.includes('start:'+names.worker));assert.equal(context.containment.publicActivation,false);
 }finally{await rm(directory,{recursive:true,force:true});}
 assert.equal(patched.version,'galaxy-current-authority-host-restore-v5');
});
