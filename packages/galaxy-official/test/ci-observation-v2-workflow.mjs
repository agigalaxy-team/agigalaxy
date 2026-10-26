import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {nativeWork,ag} from './qualification-v2-workflow.mjs';
import {ciSourceMetadata} from '../src/shared/ci-observation-v2-schema.mjs';
import {inspectGithubRun} from "../src/evidence/github-evidence.mjs";
import {createCiWorkerV2} from "../src/evidence/ci-worker-v2.mjs";
import {createApi} from '../src/http.mjs';
import {ciToolDefinitions} from '../src/adapters/mcp/personal/tools/ci-v2.mjs';
import {HonorService} from "../src/records/honor.mjs";
import {HonorV2Service} from "../src/records/honor-v2.mjs";
import {deletionTargets} from '../src/operations/deletion-execute.mjs';
import {contributionProofs} from '../src/domain/contribution-risk.mjs';
import {checkChoiceSource} from './choice-source-check.mjs';
const scopes=['binding','consent','case-teaser','assistance','evidence','proof','history','data-export','data-delete'];
export async function verifyCiV2(database=null,{workerDb=null,testHttp=false,...options}={}){
  const f=await serviceFixture(scopes,database,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false,...options});
  try{const p=await serviceFixture(scopes,f.db,{now:f.now,syntheticCommunityQuota:false,...options,migrateDatabase:false}),work=await nativeWork(f,p);
    const source={provider:'github-actions',owner:'synthetic',repository:'sample',runId:42,attempt:1,commit:'a'.repeat(40)};
    const evidence={id:randomUUID(),operationId:randomUUID(),kind:'evidence',expectedVersion:0,caseId:work.cid,reportedBy:p.actor.subjectId,
      taskId:work.open.taskId,participationId:work.proposal.participationId,participationScopeVersion:1,synthetic:true,evidenceType:'ci-result',
      source:{...ciSourceMetadata(source),originalAt:new Date(f.now*1000).toISOString(),issuer:'GitHub Actions'},
      observedAt:new Date(f.now*1000).toISOString(),reportedSourceState:'available',summary:'private source report; never implicitly public'};
    const esign=await p.authorize(evidence,'evidence.submit',{objectId:evidence.operationId,viewers:[f.actor.subjectId]});
    await f.verificationRecords.submit(p.actor,esign);
    const request={id:randomUUID(),schemaVersion:2,kind:'observe',purpose:'observe-selected-ci-source-and-prepare-bounded-proof',
      caseId:work.cid,evidenceRef:{id:evidence.id,version:1},resultRef:{id:work.result.eventId,version:1},source};
    const signed=await p.authorize(request,'ci.observe');await f.ciV2.submit(p.actor,signed);await f.ciV2.submit(p.actor,signed);
    const bad={...request,id:randomUUID(),source:{...source,commit:'b'.repeat(40)}};
    await assert.rejects(f.ciV2.submit(p.actor,await p.authorize(bad,'ci.observe')),/ci_profile_mismatch/);
    await assert.rejects(f.ciV2.submit(f.actor,await f.authorize({...request,id:randomUUID()},'ci.observe')),/ci_source_author_required/);
    assert.equal((await f.ciV2.get(p.actor,{id:request.id})).state,'pending');
    const worker=workerDb?createCiWorkerV2({db:workerDb,endpoint:f.access.endpoint,now:f.access.now}):f.ciV2;
    const observation=(ref,now)=>inspectGithubRun(ref,{id:ref.runId,run_attempt:ref.attempt,head_sha:ref.commit,status:'completed',conclusion:'success',
      repository:{id:123,full_name:`${ref.owner}/${ref.repository}`,private:false},updated_at:new Date(now*1000).toISOString()},now);
    assert.equal((await worker.processNext(observation)).state,'observed');assert.equal((await worker.processNext(observation)).processed,false);
    assert.equal((await f.ciV2.get(p.actor,{id:request.id})).observation.independence,'repository-controlled');
    const proofId=randomUUID(),preview=await f.ciV2.preview(p.actor,{id:proofId,requestId:request.id});
    for(const hidden of [work.cid,work.open.taskId,evidence.id,work.result.eventId,evidence.summary])assert.equal(preview.payloadJson.includes(hidden),false);
    const publication=await p.authorize(JSON.parse(preview.payloadJson),'proof.publish',{visibility:'Public',purpose:'public-profile'});
    const published=await f.ciV2.publish(p.actor,publication);assert.ok(published.signed);
    const view=await f.ciV2.getProof(null,{id:proofId});assert.equal(view.status,'active');assert.equal(view.provenance.profile,'github-actions-provenance/2');
    assert.equal(view.provenance.sourceKey,'github-actions:repository:123:run:42:attempt:1');assert.equal(view.data.synthetic,true);
    assert.equal(view.capabilityVerified,false);assert.equal(view.independentExecutionVerified,false);
    const found=await f.search.v2.query(null,{type:'proof',query:{query:'synthetic',conclusion:'success'}});
    assert.equal(found.items[0].id,proofId);assert.equal(found.items[0].record.capabilityVerified,false);
    await checkChoiceSource(f,f.actor,{type:'proof',query:{query:'synthetic'}},proofId);
    for(const privateValue of [work.cid,work.open.taskId,evidence.id,work.result.eventId,evidence.summary])assert.equal(JSON.stringify(found).includes(privateValue),false);
    const policy={repositories:[{owner:'synthetic',repository:'sample'}]};
    const bound={subjectId:p.actor.subjectId,caseId:work.cid,resultRef:request.resultRef,evidenceRefs:[request.evidenceRef],policy};
    assert.equal((await f.ciV2.proofsForWithin(f.db,null,bound)).length,1);
    assert.equal((await f.ciV2.proofsForWithin(f.db,null,{...bound,resultRef:{id:randomUUID(),version:1}})).length,0);
    assert.equal((await ciToolDefinitions(f,p.actor).galaxy_ci_v2_read.run({id:request.id})).state,'observed');
    const delivered={...work.delivery,eventId:randomUUID(),expectedParticipationVersion:4,evidenceRefs:[request.evidenceRef]};
    await f.assistance.submitParticipationEvent(p.actor,work.proposal.participationId,await ag(p,delivered,[f.actor.subjectId]));
    await f.assistance.submitParticipationEvent(f.actor,work.proposal.participationId,await ag(f,{...work.acceptance,eventId:randomUUID(),expectedParticipationVersion:5,deliveryId:delivered.eventId},[p.actor.subjectId]));
    for(const who of [f,p]){const refs=[];
      for(const[kind,table,parent]of[['case-event','case_events','case_id'],['task-event','task_events','task_id']]){
        const rows=(await f.db.query(`SELECT id,payload_hash FROM ${table} WHERE ${parent}=$1 AND subject_id=$2`,[parent==='case_id'?work.cid:work.open.taskId,who.actor.subjectId])).rows;
        refs.push(...rows.map(row=>({kind,id:row.id,eventVersion:1,payloadHash:row.payload_hash,fields:['eventType','actorId']})));}
      const publication={id:randomUUID(),kind:'publish',sourceRefs:refs,purposes:['honor'],purpose:'public-contribution-projections-only',
        expiresAt:new Date((f.now+500)*1000).toISOString(),redactionConfirmed:true,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
      await f.contributionSharing.submit(who.actor,await who.authorize(publication,'contribution.publish',{visibility:'Public',purpose:'public-profile'}));}
    const honorRule={...policy,id:'synthetic-ci-native',version:'1',title:'CI native synthetic rule',communityId:'test',capabilityId:'software-debugging',sourceProfile:'facts-v2',
      kind:'ci-backed-contributor',members:[f.actor.subjectId,p.actor.subjectId],notBefore:f.now-1,notAfter:f.now+1000,windowFrom:f.now-1000,windowUntil:f.now+1,minAcceptedCases:1,minProofs:1};
    const honor=new HonorService(f.access,f.assistance,f.proofs,[honorRule]);honor.v2=new HonorV2Service(honor,{qualification:f.qualification.v2,sharing:f.contributionSharing,ciV2:f.ciV2});
    const honorQuery={ruleId:honorRule.id,ruleVersion:'1',subjectId:p.actor.subjectId,includeSimulation:true};
    const publicHonor=await honor.v2.query(null,honorQuery);assert.equal(publicHonor.items.length,1);assert.equal(publicHonor.items[0].proofs.length,1);
    assert.equal(publicHonor.card.status,'insufficient-evidence');assert.equal(publicHonor.card.acceptedCases,0);assert.equal(publicHonor.counts.policyMatchedCiSources,0);
    assert.equal(publicHonor.ciEvidenceSupport.state,'native-v2-current-proof-binding');
    for(const secret of [evidence.summary,evidence.id,work.cid,work.open.taskId])assert.equal(JSON.stringify(publicHonor).includes(secret),false);
    const conflicting={...request,id:randomUUID()},cs=await p.authorize(conflicting,'ci.observe');await f.ciV2.submit(p.actor,cs);
    assert.equal((await worker.processNext((ref,now)=>({...observation(ref,now),conclusion:'failure'}))).state,'observed');
    const conflictingPreview=await f.ciV2.preview(p.actor,{id:randomUUID(),requestId:conflicting.id});
    await f.ciV2.publish(p.actor,await p.authorize(JSON.parse(conflictingPreview.payloadJson),'proof.publish',{visibility:'Public',purpose:'public-profile'}));
    const conflicted=await honor.v2.query(null,honorQuery);assert.equal(conflicted.items[0].observations.length,2);assert.equal(conflicted.items[0].proofs.length,1);
    assert.equal(contributionProofs(conflicted.items).length,0,'a visible current failure for the same numeric source prevents success-only source counting');
    if(testHttp){const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));try{
      const call=async(path,input,who=p,status=200)=>{const response=await fetch(`http://127.0.0.1:${api.address().port}${path}`,{
        method:'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:`Bearer ${who.credential}`}:{})},body:JSON.stringify(input)});
        const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
      assert.equal((await call('/v2/ci/requests',signed)).state,'observed');
      assert.equal((await call('/v2/ci/requests/read',{id:request.id})).state,'observed');
      assert.equal((await call('/v2/ci/proofs/preview',{id:randomUUID(),requestId:request.id})).published,false);
      assert.equal((await call('/v2/ci/proofs/publish',publication)).proofId,proofId);
      assert.equal((await call('/v2/ci/proofs/read',{id:proofId},null)).status,'active');
      assert.equal((await call('/v2/ci/receipts',{type:'proof',id:proofId})).state,'recorded');
      assert.equal((await call('/v2/ci/receipts',{type:'proof',id:proofId},f)).state,'absent');
      assert.equal((await call('/v2/verification-records/status',{refs:[{type:'ci-proof-v2',id:proofId}]})).items[0].status,'active');
      await call('/v2/ci/proofs/read',{id:proofId},{credential:'invalid'},401);
      const status=await fetch(`http://127.0.0.1:${api.address().port}/v2/ci/proofs/${proofId}/status`);assert.equal(status.status,200);
    }finally{await new Promise(resolve=>api.close(resolve));}}
    // A corrected Evidence version invalidates exact old bindings, never retargets.
    const corrected={...evidence,operationId:randomUUID(),expectedVersion:1,reason:'source report corrected'};
    await f.verificationRecords.submit(p.actor,await p.authorize(corrected,'evidence.submit',{objectId:corrected.operationId,viewers:[f.actor.subjectId]}));
    await assert.rejects(f.ciV2.getProof(null,{id:proofId}),/evidence_version_changed/);
    assert.equal((await f.ciV2.proofsForWithin(f.db,null,bound)).length,0);
    assert.equal((await f.search.v2.query(null,{type:'proof',query:{query:'synthetic'}})).pageCount,0);
    assert.equal((await honor.v2.query(null,honorQuery)).items[0].proofs.length,0);
    const second={...request,id:randomUUID(),evidenceRef:{id:evidence.id,version:2}};
    const ss=await p.authorize(second,'ci.observe');await f.ciV2.submit(p.actor,ss);
    assert.equal((await worker.processNext(async(ref,now)=>{await p.consents.revoke(p.actor,ss.consentId);return observation(ref,now);})).state,'revoked');
    await assert.rejects(f.ciV2.preview(p.actor,{id:randomUUID(),requestId:second.id}),/ci_source_unavailable/);
    const third={...second,id:randomUUID()},ts=await p.authorize(third,'ci.observe');await f.ciV2.submit(p.actor,ts);
    await f.ciV2.revokeRequest(p.actor,{id:third.id});let called=false;
    assert.equal((await worker.processNext(()=>{called=true;throw new Error();})).state,'revoked');assert.equal(called,false);
    await f.ciV2.revokeProof(p.actor,{id:proofId});await assert.rejects(f.ciV2.getProof(null,{id:proofId}),/ci_proof_unavailable/);
    const takeout=await p.dataExport.create(p.actor,{id:randomUUID(),datasets:['ci-requests-v2','ci-observations-v2','ci-proofs-v2']});
    assert.equal((await p.dataExport.page(p.actor,{id:takeout.id,dataset:'ci-proofs-v2'})).items.length,2);
    const ownedJobs=(await f.db.query(`SELECT t.id FROM jobs t WHERE ${deletionTargets.jobs}`,[p.actor.subjectId])).rows;
    assert.equal(ownedJobs.length,4);
    return{work,proofId};
  }finally{if(!database)await f.db.close();}
}
