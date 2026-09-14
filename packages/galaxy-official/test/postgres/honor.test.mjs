import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/database.mjs';
import { apiReads } from '../../src/infrastructure/api-reads.mjs';
import { workerReads } from '../../src/infrastructure/worker-reads.mjs';
import { serviceFixture } from '../service-fixture.mjs';
import { HonorService } from '../../src/honor.mjs';
import { EvidenceService } from '../../src/evidence.mjs';
import { ConsentReader } from '../../src/consent-reader.mjs';
import { inspectGithubRun } from '../../src/github-evidence.mjs';
import { createHonorClient } from '../../src/honor-client.mjs';
import { createApi } from '../../src/http.mjs';

test('PostgreSQL Honor scans all source pages and retries a concurrent withdrawal without mixed totals',async()=>{
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED,'1');
  const admin=new pg.Pool(),db=new pg.Pool({max:6,options:'-c role=galaxy_api',statement_timeout:10000}),workerDb=new pg.Pool({max:2,options:'-c role=galaxy_evidence_worker'});
  let api;
  try{
    await migrate(admin);await admin.query(await readFile(new URL('../../src/infrastructure/api-role.sql',import.meta.url),'utf8'));
    await admin.query(await readFile(new URL('../../src/infrastructure/worker-role.sql',import.meta.url),'utf8'));
    const endpoint='https://large-honor.example.org',scopes=['binding','consent','case-teaser','assistance','history','evidence','proof'];
    const setup={endpoint,repositories:apiReads,migrateDatabase:false},f=await serviceFixture(scopes,db,setup),providers=[];
    for(let i=0;i<5;i++)providers.push(await serviceFixture(scopes,db,setup));
    const rule={id:'large',version:'1',title:'Large synthetic cohort',kind:'open-contributor',capabilityId:'compiler',communityId:'fixture',members:[f,...providers].map(w=>w.actor.subjectId),
      notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-100,windowUntil:f.now+1,minAcceptedCases:1,minProofs:0,repositories:[{owner:'fixture',repository:'example'},{owner:'fixture',repository:'renamed'}],rankingEnabled:true,privacyReview:'approved',minimumCohort:5,minimumCasesPerMember:3};
    f.honor=new HonorService(f.access,f.assistance,f.proofs,[rule]);
    const worker=new EvidenceService(null,new ConsentReader({now:()=>f.now,readGrant:workerReads.readGrant}),{db:workerDb,endpoint,now:()=>f.now,readCase:workerReads.readCase});
    const publicGrant={visibility:'Public',purpose:'public-profile'},records=[],proofIds=[];
    async function root(){
      const value={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Large Honor fixture',summary:'Synthetic data',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
      await f.cases.submit(f.actor,await f.authorize(value,'case.teaser.publish',publicGrant));
      const attempt={id:randomUUID(),kind:'attempt',caseId:value.id,expectedVersion:1,sequence:1,approach:'Inspect',configuration:{environment:'test',version:'1',tools:[]}};
      await f.cases.submit(f.actor,await f.authorize(attempt,'case.teaser.publish',publicGrant));return {value,attempt,evidenceIds:[]};
    }
    const firstCase=await root();
    const result={id:randomUUID(),kind:'result',caseId:firstCase.value.id,expectedVersion:2,attemptId:firstCase.attempt.id,outcome:'succeeded',summary:'Synthetic',failureReason:'',limitations:[]};
    await f.cases.submit(f.actor,await f.authorize(result,'case.teaser.publish',publicGrant));
    async function evidence(runId,conclusion='success',copies=1){
      const repository=conclusion==='failure'?'renamed':'example';
      const submission={id:randomUUID(),caseId:firstCase.value.id,resultId:result.id,source:{provider:'github-actions',owner:'fixture',repository,runId,attempt:1,commit:'a'.repeat(40)}};
      await f.evidence.submit(f.actor,await f.authorize(submission,'evidence.submit',publicGrant));firstCase.evidenceIds.push(submission.id);
      await worker.processNext((source,now)=>inspectGithubRun(source,{id:runId,run_attempt:1,head_sha:source.commit,repository:{full_name:`fixture/${repository}`,private:false,id:123},updated_at:new Date(now*1000).toISOString(),status:'completed',conclusion},now));
      for(let i=0;i<copies;i++){
        const id=conclusion==='failure'?'ffffffff-ffff-4fff-bfff-ffffffffffff':randomUUID();
        const preview=await f.proofs.preview(f.actor,{id,evidenceId:submission.id});
        await f.proofs.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',publicGrant));proofIds.push(id);
      }
    }
    await evidence(1,'success',52);for(let i=2;i<=10;i++)await evidence(i);
    await evidence(1,'failure'); // This conflicting source sorts after the first 50 Proofs.
    async function collaborate(provider,source){
      const parent=source??await root(),request={id:randomUUID(),caseId:parent.value.id,title:'Compiler help',problem:'Synthetic',attemptedApproaches:[],scope:'Inspect',visibility:'Public',collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
      await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',publicGrant));let version=1;
      async function event(who,kind,fields={},visible=true){const value={id:randomUUID(),expectedVersion:version,kind,...fields};
        const grant=await who.authorize({assistanceId:request.id,event:value},'assistance.publish',{objectId:value.id,...(visible?publicGrant:{viewers:[f.actor.subjectId,provider.actor.subjectId]})});
        const receipt=await f.assistance.submit(who.actor,request.id,grant);version=receipt.version;return {value,grant};}
      const offer=await event(provider,'offer',{proposal:'Inspect',scope:'Inspect'},false);await event(f,'select',{offerId:offer.value.id},false);
      await event(provider,'confirm');const delivery=await event(provider,'deliver',{attemptId:parent.attempt.id,evidenceIds:parent.evidenceIds,summary:'Synthetic result'});
      const accepted=await event(f,'accept',{deliveryId:delivery.value.id,summary:'Reported acceptance'});
      const record={request,parent,accepted,provider};records.push(record);return record;
    }
    const withProofs=await collaborate(providers[0],firstCase);
    for(let i=1;i<202;i++)await collaborate(providers[0]);
    for(const provider of providers.slice(1))for(let i=0;i<3;i++)await collaborate(provider);
    await collaborate(providers[0],records[1].parent); // A duplicate Case must not increase the score.
    f.access.now=()=>f.now+2;
    console.log(JSON.stringify({event:'large_honor_seeded',collaborations:records.length,proofs:proofIds.length}));
    api=createApi({...f,rateLimit:10000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    let maxBytes=0;
    const client=createHonorClient({endpoint,send:async(url,input)=>{
      const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:input.bodyJson});
      const body=await response.text();maxBytes=Math.max(maxBytes,Buffer.byteLength(body));assert.equal(response.status,200,body);assert.ok(Buffer.byteLength(body)<=1048576);return JSON.parse(body);
    }});
    const query={ruleId:rule.id,ruleVersion:'1',subjectId:providers[0].actor.subjectId,limit:20};
    const started=performance.now(),first=await client.publicQuery(query),firstReadMs=Math.round(performance.now()-started);
    assert.equal(first.card.acceptedCases,202);assert.equal(first.complete,true);assert.equal(first.pagination.contributions.total,203);
    assert.equal(first.card.proofCount,9);assert.ok(!first.card.proofs.some(proof=>proof.sourceKey.endsWith(':run:1:attempt:1')));
    const all=[...first.contributions];let after=first.pagination.contributions.nextAfter;
    while(after){const page=await client.publicQuery({...query,after,expectedFingerprint:first.card.sourceFingerprint});assert.equal(page.card.acceptedCases,202);all.push(...page.contributions);after=page.pagination.contributions.nextAfter;}
    assert.equal(all.length,203);assert.equal(new Set(all.map(c=>c.assistanceId)).size,203);assert.deepEqual(new Set(all.map(c=>c.assistanceId)),new Set(records.filter(r=>r.provider===providers[0]).map(r=>r.request.id)));
    const sourceRefs=[];let sourceAfter=0;
    do{const page=await client.publicQuery({...query,sourceId:withProofs.request.id,sourceAfter,expectedFingerprint:first.card.sourceFingerprint});sourceRefs.push(...page.sourceDetail.items);sourceAfter=page.sourceDetail.nextAfter;}while(sourceAfter!==null);
    assert.equal(sourceRefs.filter(x=>x.kind==='observations').length,62);assert.deepEqual(new Set(sourceRefs.filter(x=>x.kind==='observations').map(x=>x.value.proofId)),new Set(proofIds));
    const proofPage=await client.publicQuery({...query,limit:8});const proofNext=await client.publicQuery({...query,limit:8,proofAfter:proofPage.pagination.proofs.nextAfter});assert.equal(proofPage.card.proofs.length,8);assert.equal(proofNext.card.proofs.length,1);
    const risk=first.riskAssessment.flags.find(x=>x.code==='concentrated-participation');assert.equal(risk.referenceCounts.assistanceIds,203);assert.equal(risk.assistanceIds.length,20);assert.equal(risk.referencesComplete,false);
    const ranked=await client.ranking({ruleId:rule.id,ruleVersion:'1'});assert.equal(ranked.status,'published');assert.equal(ranked.statistics.acceptedCases,214);assert.deepEqual(ranked.items.map(x=>x.rank),[1,2,2,2,2]);
    // Withdraw a not-yet-visited row after the first internal SQL page. A new
    // snapshot must retry the whole read, rather than mix pre/post-change facts.
    const target=records.filter(r=>r.provider===providers[0]&&r!==withProofs&&r.parent!==records[1].parent).sort((a,b)=>a.request.id.localeCompare(b.request.id)).at(-1);
    let intercepted=false,begins=0;
    const wrapped={connect:async()=>{const connection=await db.connect();return {release:error=>connection.release(error),query:async(sql,params)=>{
      if(sql==='BEGIN ISOLATION LEVEL REPEATABLE READ')begins++;
      if(!intercepted&&sql.includes('SELECT a.id FROM assistance_requests')&&params[4]){intercepted=true;await f.consents.revoke(f.actor,target.accepted.grant.consentId);}
      return connection.query(sql,params);
    }};}};
    f.access.db=wrapped;
    const changed=await f.honor.query(null,query),snapshotAttempts=begins;assert.equal(intercepted,true);assert.equal(snapshotAttempts,2);assert.equal(changed.card.acceptedCases,201);assert.equal(changed.pagination.contributions.total,202);
    await assert.rejects(f.honor.query(null,{...query,after:first.pagination.contributions.nextAfter,expectedFingerprint:first.card.sourceFingerprint}),/projection_changed_refresh/);
    f.access.db=db;
    await f.proofs.revoke(f.actor,'ffffffff-ffff-4fff-bfff-ffffffffffff');const restored=await client.publicQuery(query);assert.equal(restored.card.proofCount,10);
    console.log(JSON.stringify({event:'large_honor_verified',collaborations:215,distinctCases:214,providerContributions:203,proofWrappers:62,deduplicatedCiBefore:9,deduplicatedCiAfter:10,allSourcePages:true,allProofPages:true,allSourceReferences:true,concurrentSnapshotAttempts:snapshotAttempts,refreshRejectsStaleCursor:true,maxResponseBytes:maxBytes,firstReadMs}));
  }finally{if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await workerDb.end();await db.end();await admin.end();}
});
