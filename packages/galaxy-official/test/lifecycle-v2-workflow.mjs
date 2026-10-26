import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion, lockDeletionTables } from '../src/operations/deletion-execute.mjs';
import { cleanupProductV2Retention } from '../src/operations/lifecycle-retention-v2.mjs';
import { productV2ExportDatasets } from '../src/infrastructure/lifecycle-export-v2.mjs';
import { digest } from '../src/shared/digest.mjs';
import { transaction } from "../src/infrastructure/database.mjs";
import { SearchIndex } from "../src/discovery/search-index.mjs";
import { executeDeletionWithTransports } from '../src/operations/deletion-transports.mjs';

const scopes=['binding','consent','case-teaser','assistance','evidence','data-export','data-delete'];
const ag=(f,p,viewers=[])=>f.authorize(p,'assistance.publish',{objectId:p.operationId??p.eventId,viewers});
const cg=(f,p,viewers=[])=>f.authorize(p,'case.teaser.publish',{objectId:p.eventId,viewers});
const iso=seconds=>new Date(seconds*1000).toISOString();
function taskInput(f){return{operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',title:'Synthetic lifecycle task',summary:'No manufactured failure',
  workContext:{goal:'Review',currentSituation:'Ready',attemptRefs:[]},visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};}
async function deletionIntent(f,extra){const payload={version:1,id:randomUUID(),endpoint:f.access.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,
  issuedAt:f.now,expiresAt:f.now+300,...extra};return f.deletion.submit(f.actor,await f.signForTest(JSON.stringify(payload),'galaxy-deletion-intent+jws'));}
async function bootstrap(f){
  const request={operationId:randomUUID(),subjectId:f.actor.subjectId,kind:'bootstrap',expectedEpoch:0,previousEventHash:null,signerKeyId:'pending-public-key',
    genesisProof:f.genesis.genesisProof,newDevice:{deviceId:randomUUID(),publicKeyPem: 'pending-public-key',scopes:['manage-identity',...scopes]}};
  // The fixture exposes the real registered public key; no user keys are read.
  const subject=(await f.db.query('SELECT public_key FROM subjects WHERE id=$1',[f.actor.subjectId])).rows[0];
  request.signerKeyId=digest(subject.public_key);request.newDevice.publicKeyPem=subject.public_key;
  const challenge=await f.identityControl.challenge(request),signature=await f.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');
  await f.identityControl.commit({operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature});
  f.actor=await f.access.authenticate(f.credential);
}

export async function verifyPendingDeletionV2(database=null,options={}){
  const f=await serviceFixture(scopes,database,options),p=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const admin=options.adminDatabase??f.db;
  try{
    const input=taskInput(f),grant=await f.authorize(input,'assistance.publish',{objectId:input.operationId,visibility:'Public',purpose:'public-profile'});
    await f.assistance.createTask(f.actor,grant);
    const selected=await p.dataExport.create(p.actor,{id:randomUUID(),datasets:['authorized-views'],views:[{kind:'task',id:input.taskId}]});
    assert.equal((await f.assistance.queryPublicTasks()).items.length,1);
    const legacy={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Pending public search',summary:'Case visible only while current',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(legacy,'case.teaser.publish',{visibility:'Public',purpose:'public-profile'}));
    const index=new SearchIndex({db:admin,endpoint:f.access.endpoint,now:()=>f.now});await index.configure({enabled:true});
    await admin.query('SELECT public.galaxy_queue_search_source($1,$2,$3)',['case',legacy.id,f.actor.subjectId]);
    for(let n=0;n<20;n++)if(!(await index.processNext()).processed)break;
    assert.equal((await index.candidates('case',{subjectId:f.actor.subjectId})).items.length,1);
    const receipt=await deletionIntent(f,{action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'});
    await assert.rejects(f.assistance.getPublicTask(input.taskId),/not_found/);
    assert.equal((await f.assistance.queryPublicTasks()).items.length,0);
    assert.equal((await index.candidates('case',{subjectId:f.actor.subjectId})).items.length,0);
    await assert.rejects(p.dataExport.page(p.actor,{id:selected.id,dataset:'authorized-views'}),/export_view_unavailable/);
    assert.equal((await f.assistance.getTask(f.actor,input.taskId)).taskId,input.taskId);
    const owner=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:productV2ExportDatasets});
    for(const dataset of productV2ExportDatasets) await f.dataExport.page(f.actor,{id:owner.id,dataset});
    const exact=(await f.dataExport.page(f.actor,{id:owner.id,dataset:'task-events'})).items[0];
    assert.equal(exact.payload_text,grant.payloadJson);
    assert.equal((await admin.query('SELECT revoked_at FROM consents WHERE id=$1',[grant.consentId])).rows[0].revoked_at,null);
    await deletionIntent(f,{action:'cancel',requestId:receipt.id,expectedRevision:1});
    assert.equal((await f.assistance.queryPublicTasks()).items.length,1);
    assert.equal((await p.dataExport.page(p.actor,{id:selected.id,dataset:'authorized-views'})).items[0].view.taskId,input.taskId);
    assert.equal((await index.candidates('case',{subjectId:f.actor.subjectId})).items.length,1);
    await f.consents.revoke(f.actor,grant.consentId);
    await assert.rejects(f.assistance.getPublicTask(input.taskId),/consent_required/);
  }finally{if(!database)await f.db.close();}
}

export async function verifyProductV2Deletion(database=null,options={}){
  const f=await serviceFixture(scopes,database,options),p=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const admin=options.adminDatabase??f.db;
  try{
    await bootstrap(p);
    const task=taskInput(f);await f.assistance.createTask(f.actor,await f.authorize(task,'assistance.publish',{objectId:task.operationId,visibility:'Public',purpose:'public-profile'}));
    const application={eventId:randomUUID(),expectedTaskVersion:1,kind:'apply',proposal:'PARTICIPANT_PRIVATE_BODY',scope:'Investigate'};
    await f.assistance.submitTaskEvent(p.actor,task.taskId,await p.authorize({taskId:task.taskId,event:application},'assistance.publish',{objectId:application.eventId,viewers:[f.actor.subjectId]}));
    const proposal={eventId:randomUUID(),expectedTaskVersion:2,kind:'propose',participationId:randomUUID(),subjectId:p.actor.subjectId,role:'verification',scopeVersion:1,agreedScope:'OWNER_INDEPENDENT_AGREEMENT'};
    await f.assistance.proposeParticipation(f.actor,task.taskId,await ag(f,proposal,[p.actor.subjectId]));
    const confirm={eventId:randomUUID(),kind:'confirm',expectedParticipationVersion:1,scopeVersion:1};
    await f.assistance.submitParticipationEvent(p.actor,proposal.participationId,await ag(p,confirm,[f.actor.subjectId]));
    const caseId=randomUUID(),root={schemaVersion:2,eventId:caseId,caseId,kind:'case-created',expectedVersion:0,actorId:f.actor.subjectId,taskId:task.taskId,
      localRef:randomUUID(),title:'Synthetic source',summary:'Owner source',source:{kind:'active-task',reference:task.taskId},synthetic:true};
    const initial={schemaVersion:2,eventId:randomUUID(),caseId,kind:'intervention',expectedVersion:1,actorId:f.actor.subjectId,taskId:task.taskId,
      types:['diagnosis'],affectsAttemptIds:[],description:'OWNER_INDEPENDENT_DIAGNOSIS',sourceRefs:[],observedEffect:'unknown'};
    await f.cases.createAndLinkTask(f.actor,{operationId:randomUUID(),taskId:task.taskId,expectedTaskVersion:4,case:await cg(f,root,[p.actor.subjectId]),initialFact:await cg(f,initial,[p.actor.subjectId])});
    const evidence={id:randomUUID(),operationId:randomUUID(),kind:'evidence',expectedVersion:0,caseId,reportedBy:p.actor.subjectId,taskId:task.taskId,
      participationId:proposal.participationId,participationScopeVersion:1,synthetic:true,observedAt:iso(p.now),evidenceType:'test-result',
      source:{originSystem:'synthetic',externalStableId:randomUUID(),contentVersion:'1',issuer:p.actor.subjectId,originalAt:iso(p.now)},
      reportedSourceState:'available',summary:'PARTICIPANT_EVIDENCE_BODY'};
    await p.verificationRecords.submit(p.actor,await p.authorize(evidence,'evidence.submit',{objectId:evidence.operationId,viewers:[f.actor.subjectId]}));
    const ownerView=await f.dataExport.create(f.actor,{id:randomUUID(),datasets:['tasks','authorized-views'],views:[{kind:'evidence',id:evidence.id,version:1}]});
    assert.equal('snapshot' in (await f.dataExport.page(f.actor,{id:ownerView.id,dataset:'tasks'})).items[0],false);
    assert.ok(JSON.stringify(await f.dataExport.page(f.actor,{id:ownerView.id,dataset:'authorized-views'})).includes('PARTICIPANT_EVIDENCE_BODY'));
    const original=(await admin.query('SELECT * FROM task_events WHERE id=$1',[proposal.eventId])).rows[0];
    // Synthetic stored account linkage checks lifecycle ownership only. This is
    // not evidence for an OIDC/email login or public-write verification.
    const accountId=randomUUID();
    await admin.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://synthetic.example','lifecycle-account','external-account',$3,$3)",[accountId,f.access.endpoint,iso(f.now)]);
    for(const who of [f,p]){
      const linkId=randomUUID();
      await admin.query("INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature) VALUES($1,$2,$3,$4,'synthetic','https://synthetic.example','lifecycle-account','synthetic','{}',$5,'synthetic-not-authentication')",
        [linkId,who.actor.subjectId,who.actor.bindingId,f.access.endpoint,'a'.repeat(64)]);
      await admin.query('INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)',[linkId,accountId,who.actor.subjectId,iso(f.now)]);
    }
    await admin.query("INSERT INTO community_daily_usage(account_id,day,category,used) VALUES($1,$2,'task',2)",[accountId,iso(f.now)]);
    await admin.query("INSERT INTO community_interactions(account_id,source_id,source_kind,counterparty_id,created_at) VALUES($1,$2,'accepted-participation',$3,$4)",[accountId,confirm.eventId,f.actor.subjectId,iso(f.now)]);
    await admin.query("INSERT INTO community_write_receipts(account_id,operation_id,category,subject_id,payload_hash,created_at) VALUES($1,$2,'task',$3,$4,$5)",[accountId,randomUUID(),p.actor.subjectId,'a'.repeat(64),iso(f.now)]);
    const command=await approveFixtureDeletion(p,admin,{auditUntil:p.now+60});
    const result=await executeDeletion(admin,command,{now:()=>p.now});
    assert.equal(result.state,'partial');assert.equal(result.serviceWideDeletionComplete,false);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM community_accounts WHERE id=$1',[accountId])).rows[0].n,1);
    assert.equal((await admin.query('SELECT used FROM community_daily_usage WHERE account_id=$1',[accountId])).rows[0].used,2);
    assert.deepEqual((await admin.query('SELECT subject_id FROM community_account_links WHERE account_id=$1',[accountId])).rows.map(r=>r.subject_id),[f.actor.subjectId]);
    assert.ok((await admin.query('SELECT invalidated_at FROM community_interactions WHERE account_id=$1',[accountId])).rows[0].invalidated_at);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM community_write_receipts WHERE subject_id=$1',[p.actor.subjectId])).rows[0].n,0);
    let erased=0;
    const pending=await executeDeletionWithTransports(admin,command,{now:()=>p.now,chat:{eraseSubject:async()=>{erased++;throw new Error('synthetic transport offline');}}});
    assert.equal(pending.transport.chat.complete,false);assert.equal(erased,1);
    const resumed=await executeDeletionWithTransports(admin,command,{now:()=>p.now,chat:{eraseSubject:async subjectId=>{assert.equal(subjectId,p.actor.subjectId);return{archiveDeleted:1,pendingArchiveDeletes:0,complete:true};}}});
    assert.equal(resumed.transport.chat.complete,true);assert.equal(resumed.serviceWideDeletionComplete,false);
    await assert.rejects(executeDeletionWithTransports(admin,{...command,id:randomUUID(),expectedRevision:1},{chat:{eraseSubject:async()=>{erased++;}}}));assert.equal(erased,1);
    assert.deepEqual((await admin.query('SELECT * FROM task_events WHERE id=$1',[proposal.eventId])).rows[0],original);
    for(const table of ['task_events','verification_objects'])assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE subject_id=$1`,[p.actor.subjectId])).rows[0].n,0);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM verification_events WHERE operation_id=$1',[evidence.operationId])).rows[0].n,0);
    const persisted=JSON.stringify((await admin.query('SELECT snapshot FROM task_requests UNION ALL SELECT snapshot FROM task_participations')).rows);
    assert.ok(!persisted.includes('PARTICIPANT_PRIVATE_BODY'));assert.ok(persisted.includes('OWNER_INDEPENDENT_AGREEMENT'));
    const view=await f.assistance.getTask(f.actor,task.taskId);assert.ok(!JSON.stringify(view).includes('PARTICIPANT_PRIVATE_BODY'));
    await assert.rejects(f.dataExport.page(f.actor,{id:ownerView.id,dataset:'authorized-views'}),/export_view_unavailable/);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM subject_control_heads WHERE subject_id=$1',[p.actor.subjectId])).rows[0].n,1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM device_authorizations WHERE subject_id=$1 AND status='active'",[p.actor.subjectId])).rows[0].n,0);
    assert.ok((await admin.query('SELECT original_payload_hash FROM lifecycle_erasure_records WHERE object_key=$1',[evidence.operationId])).rows.length);
    assert.ok(JSON.stringify(await f.cases.getV2(f.actor,caseId,{taskId:task.taskId})).includes('OWNER_INDEPENDENT_DIAGNOSIS'));
    const ownerCommand=await approveFixtureDeletion(f,admin,{auditUntil:f.now+60});
    await executeDeletion(admin,ownerCommand,{now:()=>f.now});
    await assert.rejects(f.assistance.getPublicTask(task.taskId),/not_found/);
    const remainingCase=(await admin.query('SELECT local_ref,source_ref FROM cases WHERE id=$1',[caseId])).rows[0];
    if(remainingCase){assert.equal(remainingCase.local_ref,'erased:'+caseId);assert.equal(remainingCase.source_ref,'erased:'+caseId);}
    await admin.query('CREATE TABLE synthetic_unmapped_private(id text PRIMARY KEY)');
    await assert.rejects(transaction(admin,lockDeletionTables),/inventory does not cover/);
    await admin.query('DROP TABLE synthetic_unmapped_private');
  }finally{if(!database)await f.db.close();}
}

export async function verifyProductV2Retention(database=null,options={}){
  const f=await serviceFixture(scopes,database,options),p=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const admin=options.adminDatabase??f.db;
  try{
    const task=taskInput(f);await f.assistance.createTask(f.actor,await f.authorize(task,'assistance.publish',{objectId:task.operationId,visibility:'Public',purpose:'public-profile'}));
    const event={eventId:randomUUID(),expectedTaskVersion:1,kind:'apply',proposal:'TEMPORARY_90_DAY_BODY',scope:'limited'};
    await f.assistance.submitTaskEvent(p.actor,task.taskId,await p.authorize({taskId:task.taskId,event},'assistance.publish',{objectId:event.eventId,viewers:[f.actor.subjectId]}));
    await admin.query('UPDATE task_events SET created_at=$2 WHERE id=$1',[event.eventId,iso(Math.min(f.now,Math.floor(Date.now()/1000))-90*86400)]);
    assert.ok(!JSON.stringify(await f.assistance.getTask(f.actor,task.taskId)).includes('TEMPORARY_90_DAY_BODY'));
    const ticket=await p.dataExport.create(p.actor,{id:randomUUID(),datasets:['task-events']});
    const expired=(await p.dataExport.page(p.actor,{id:ticket.id,dataset:'task-events'})).items[0];assert.equal(expired.content_expired,true);assert.equal(expired.payload_text,'');
    const operationId=randomUUID();await admin.query("INSERT INTO identity_control_operations(id,subject_id,request_hash,request,challenge_text,expires_at,state) VALUES($1,$2,$3,'{}','SYNTHETIC_TEMP_CHALLENGE',$4,'requested')",
      [operationId,p.actor.subjectId,'a'.repeat(64),iso(f.now-86400)]);
    const accountId=randomUUID();
    await admin.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,'https://synthetic.example',$4,'external-account',$3,$3)",[accountId,f.access.endpoint,iso(f.now),accountId]);
    await admin.query("INSERT INTO community_daily_usage(account_id,day,category,used) VALUES($1,$2,'task',1),($1,$3,'task',1)",[accountId,iso(f.now-31*86400),iso(f.now)]);
    await admin.query("INSERT INTO community_write_receipts(account_id,operation_id,category,subject_id,payload_hash,created_at) VALUES($1,$2,'task',$3,$4,$5),($1,$6,'task',$3,$4,$7)",[accountId,randomUUID(),p.actor.subjectId,'a'.repeat(64),iso(f.now-180*86400),randomUUID(),iso(f.now)]);
    const clean=await cleanupProductV2Retention(options.workerDatabase??admin,{now:()=>f.now});
    assert.equal(clean.removed.dailyUsage,1);assert.equal(clean.removed.writeReceipts,1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM community_daily_usage WHERE account_id=$1',[accountId])).rows[0].n,1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM community_write_receipts WHERE account_id=$1',[accountId])).rows[0].n,1);
    assert.equal(clean.removed.temporaryTaskBodies,1);assert.equal(clean.removed.identityOperations,1);assert.equal(clean.backupStarted,false);
    assert.equal((await admin.query('SELECT payload_text FROM task_events WHERE id=$1',[event.eventId])).rows[0].payload_text,'');
    assert.ok(!JSON.stringify((await admin.query('SELECT snapshot FROM task_requests')).rows).includes('TEMPORARY_90_DAY_BODY'));
    assert.ok((await admin.query('SELECT payload_text FROM task_events WHERE id=$1',[task.operationId])).rows[0].payload_text.includes('No manufactured failure'));
    assert.equal((await cleanupProductV2Retention(options.workerDatabase??admin,{now:()=>f.now})).removed.temporaryTaskBodies,0);
  }finally{if(!database)await f.db.close();}
}
