import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';
import { reviewDeletionRequest } from '../src/operations/deletion-review.mjs';
import { createDeletionStatusClient } from "../src/clients/deletion.mjs";
import { createApi } from '../src/http.mjs';
import { EvidenceService } from "../src/evidence/evidence.mjs";
import { ConsentReader } from "../src/consents/consent-reader.mjs";
import { workerReads } from '../src/infrastructure/worker-reads.mjs';
import { SearchIndex } from "../src/discovery/search-index.mjs";

export async function approveFixtureDeletion(f,db,{auditUntil=f.now}={}) {
  const intent={version:1,id:randomUUID(),endpoint:f.access.endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,
    issuedAt:f.now,expiresAt:f.now+300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
  const receipt=await f.deletion.submit(f.actor,await f.signForTest(JSON.stringify(intent),'galaxy-deletion-intent+jws'));
  const approval={version:1,id:randomUUID(),requestId:receipt.id,endpoint:f.access.endpoint,expectedRevision:1,reviewerRef:'synthetic-reviewer',decision:'approve',explanation:'Synthetic execution exercise',
    plan:{policyId:'synthetic',policyVersion:'1',primary:{action:'delete-owned-data',notBefore:f.now,basis:'Synthetic only'},
      audit:{action:'retain-minimum',until:auditUntil,basis:'Synthetic only'},backups:{action:'expire-snapshots-and-replay-deletions',until:f.now+3600,basis:'Synthetic only'},externalCopies:'outside-service-control'}};
  await reviewDeletionRequest(db,approval);
  return {version:1,id:randomUUID(),requestId:receipt.id,approvalId:approval.id,endpoint:f.access.endpoint,expectedRevision:2,executorRef:'synthetic-executor'};
}
export async function verifyDeletionExecution(database=null,options={}) {
  const f=await serviceFixture(['binding','consent','case-teaser','history','data-delete'],database,options),admin=options.adminDatabase??f.db;
  const other=await serviceFixture(['binding'],f.db,{...options,migrateDatabase:false});
  const api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`;
  try{
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Delete fixture',summary:'Owned content',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root,'case.teaser.publish',{visibility:'Public',purpose:'public-profile'}));
    const searchIndex=new SearchIndex({db:admin,endpoint:f.access.endpoint,now:()=>f.now});
    await searchIndex.configure({enabled:true});
    await admin.query('SELECT public.galaxy_queue_search_source($1,$2,$3)',['case',root.id,f.actor.subjectId]);
    for(let i=0;i<100;i++)if(!(await searchIndex.processNext()).processed)break;
    assert.equal((await searchIndex.candidates('case',{subjectId:f.actor.subjectId})).items.length,1);
    const profile={id:randomUUID(),expectedRevision:0,selfDeclared:{about:'Owner text to erase'}};
    await f.profiles.publish(f.actor,await f.authorize(profile,'profile.publish'));
    const pending=await f.bindings.challenge({subjectId:f.genesis.id,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes:['binding']});
    const command=await approveFixtureDeletion(f,admin,{auditUntil:f.now+60});
    await admin.query("INSERT INTO audit_events(actor,action,object_id,request_id,outcome,binding_id) VALUES('synthetic-worker','synthetic', $1,$1,'ok',$2)",[root.id,f.actor.bindingId]);
    await assert.rejects(executeDeletion(admin,command,{now:()=>f.now-1}),/not due/);
    assert.equal((await f.cases.get(f.actor,root.id)).caseId,root.id);
    const result=await executeDeletion(admin,command,{now:()=>f.now});
    assert.equal((await admin.query('SELECT * FROM search_documents WHERE subject_id=$1',[f.actor.subjectId])).rows.length,0);
    assert.equal((await admin.query("SELECT * FROM jobs WHERE kind='search-index' AND payload->>'subjectId'=$1",[f.actor.subjectId])).rows.length,0);
    assert.equal((await searchIndex.candidates('case',{subjectId:f.actor.subjectId})).items.length,0);
    assert.equal(result.deletedCounts.cases,1);assert.ok(result.deletedCounts.case_events>0);assert.equal(result.audit.state,'retained-until-policy');
    assert.equal(result.serviceWideDeletionComplete,false);assert.ok(result.physicalDeletionPerformed);
    assert.deepEqual(await executeDeletion(admin,command,{now:()=>f.now+120}),result);
    await assert.rejects(executeDeletion(admin,{...command,executorRef:'changed'},{now:()=>f.now}),/conflict/);
    await assert.rejects(f.access.authenticate(f.credential));
    assert.equal((await f.db.query('SELECT id FROM subjects WHERE id=$1',[other.actor.subjectId])).rows.length,1);
    const resumed=await executeDeletion(admin,{...command,id:randomUUID(),expectedRevision:result.revision},{now:()=>f.now+60});
    assert.equal(resumed.state,'primary-erased');assert.equal(resumed.audit.state,'erased');
    assert.equal((await f.db.query('SELECT sequence FROM audit_events WHERE binding_id=$1',[f.actor.bindingId])).rows.length,0);
    assert.equal((await f.db.query('SELECT id FROM subjects WHERE id=$1',[f.actor.subjectId])).rows.length,0);
    assert.equal((await f.db.query('SELECT id FROM profile_statements WHERE subject_id=$1',[f.actor.subjectId])).rows.length,0);
    assert.equal((await f.db.query('SELECT id FROM deletion_executions WHERE request_id=$1',[command.requestId])).rows.length,2);
    let signed,signCalls=0;
    const client=createDeletionStatusClient({endpoint:f.access.endpoint,readSubjectId:async()=>f.actor.subjectId,now:()=>f.now,
      signIntent:async(payload,typ)=>{signCalls++;signed=await f.signForTest(payload,typ);return signed;},
      send:async(url,input)=>{assert.equal(input.credential,undefined);const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:input.bodyJson});assert.equal(response.status,200);return response.json();}});
    const cancel=await client.prepare({requestId:command.requestId});client.cancel(cancel);await assert.rejects(client.execute(cancel,cancel.confirmation));assert.equal(signCalls,0);
    const preview=await client.prepare({requestId:command.requestId});await assert.rejects(client.execute(preview,'wrong'));assert.equal(signCalls,0);
    const status=await client.execute(preview,preview.confirmation);assert.equal(status.state,'primary-erased');assert.equal(status.execution.revision,resumed.revision);
    const payload=Buffer.from(signed.split('.')[1],'base64url').toString('utf8');
    await assert.rejects(f.deletion.statusWithProof(await other.signForTest(payload,'galaxy-deletion-status+jws')),/unavailable/);
    f.access.now=()=>f.now+301;await assert.rejects(f.deletion.statusWithProof(signed),/unavailable/);f.access.now=()=>f.now;
    await assert.rejects(f.bindings.challenge({subjectId:f.genesis.id,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes:['binding']}),/deletion_recorded/);
    await assert.rejects(f.bindings.bind({...pending,signature:await f.signForTest(pending.challenge,'galaxy-binding-response+jws')}));
    return {primaryErased:true,retentionResumed:true,idempotent:true,credentialRemoved:true,ownerStatusAfterDeletion:true,rebindingBlocked:true,serviceWideDeletionComplete:false};
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!database)await f.db.close();}
}

export async function verifySharedDeletionRace(database=null,options={}){
  const scopes=['binding','consent','case-teaser','assistance','evidence','data-delete'];
  const f=await serviceFixture(scopes,database,options),admin=options.adminDatabase??f.db;
  const other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  let release,processing;
  try{
    // This workflow also runs alone; do not inherit index setup from another test.
    await new SearchIndex({db:admin,endpoint:f.access.endpoint,now:()=>f.now}).configure({enabled:true});
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Shared deletion',summary:'Owned case with foreign offer',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const attempt={id:randomUUID(),kind:'attempt',caseId:root.id,expectedVersion:1,sequence:1,approach:'Synthetic attempt',configuration:{environment:'test',version:'1',tools:[]}};
    await f.cases.submit(f.actor,await f.authorize(attempt));
    const result={id:randomUUID(),kind:'result',caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Synthetic result',failureReason:'',limitations:['Synthetic']};
    await f.cases.submit(f.actor,await f.authorize(result));
    const evidence={id:randomUUID(),caseId:root.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository:'example',runId:1,attempt:1,commit:'a'.repeat(40)}};
    await f.evidence.submit(f.actor,await f.authorize(evidence,'evidence.submit'));
    const request={id:randomUUID(),caseId:root.id,title:'Shared request',problem:'Synthetic problem',attemptedApproaches:[],scope:'Investigate',visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
    await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));
    const event={id:randomUUID(),expectedVersion:1,kind:'offer',proposal:'Another owner content',scope:'Investigate'};
    await f.assistance.submit(other.actor,request.id,await other.authorize({assistanceId:request.id,event},'assistance.publish',{objectId:event.id,viewers:[f.actor.subjectId]}));
    const foreign=(await f.db.query('SELECT * FROM assistance_events WHERE id=$1',[event.id])).rows[0];
    const ownedJobs=(await admin.query("SELECT id,kind,payload FROM jobs WHERE payload->>'evidenceId'=$1 OR payload->>'subjectId'=$2",[evidence.id,f.actor.subjectId])).rows;
    assert.equal(ownedJobs.filter(job=>job.payload.evidenceId===evidence.id).length,1);
    assert.ok(ownedJobs.some(job=>job.kind==='search-index'),'deletion includes the owner index jobs');
    const command=await approveFixtureDeletion(f,admin);
    // Other suites may share this isolated PG database; only our job is due.
    await admin.query("UPDATE jobs SET available_at=$1 WHERE state='pending' AND payload->>'evidenceId'<>$2",[new Date((f.now+10000)*1000).toISOString(),evidence.id]);
    let started;const entered=new Promise(resolve=>{started=resolve;}),held=new Promise(resolve=>{release=resolve;});
    const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:options.workerDatabase?workerReads.readGrant:undefined}),
      {db:options.workerDatabase??f.db,endpoint:f.access.endpoint,now:()=>f.now,readCase:options.workerDatabase?workerReads.readCase:undefined});
    processing=worker.processNext(async()=>{started();await held;return{status:'unavailable',capabilitiesVerified:false,collectedAt:f.now,reason:'source_unavailable_or_invalid'};});
    await Promise.race([entered,processing.then(()=>{throw new Error('Expected held verification');})]);
    const partial=await executeDeletion(admin,command,{now:()=>f.now});
    assert.equal(partial.state,'partial');assert.equal(partial.remainingCounts.assistance_requests,1);assert.equal(partial.remainingCounts.cases,1);
    assert.equal(partial.deletedCounts.evidence_submissions,1);assert.equal(partial.deletedCounts.jobs,ownedJobs.length);
    assert.equal((await admin.query('SELECT id FROM jobs WHERE id=ANY($1::uuid[])',[ownedJobs.map(job=>job.id)])).rows.length,0);
    assert.deepEqual((await f.db.query('SELECT * FROM assistance_events WHERE id=$1',[event.id])).rows[0],foreign);
    release();assert.deepEqual(await processing,{processed:false,leaseLost:true});
    assert.equal((await f.db.query('SELECT id FROM verification_attempts WHERE evidence_id=$1',[evidence.id])).rows.length,0);
    const otherCommand=await approveFixtureDeletion(other,admin);
    assert.equal((await executeDeletion(admin,otherCommand,{now:()=>f.now})).state,'primary-erased');
    const resumed=await executeDeletion(admin,{...command,id:randomUUID(),expectedRevision:partial.revision},{now:()=>f.now});
    assert.equal(resumed.state,'primary-erased');assert.equal(resumed.deletedCounts.assistance_requests,1);assert.equal(resumed.deletedCounts.cases,1);
    return {foreignAuthorPreserved:true,partialResumed:true,inFlightWorkerDoesNotResurrect:true};
  }finally{release?.();await processing?.catch(()=>{});if(!database)await f.db.close();}
}
