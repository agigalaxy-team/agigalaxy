import {randomUUID} from 'node:crypto';
import {ciSourceMetadata} from '../src/shared/ci-observation-v2-schema.mjs';
import {inspectGithubRun} from '../src/github-evidence.mjs';
export async function createPeeringProof(f,root,intervention){
  const result={schemaVersion:2,eventId:randomUUID(),caseId:root.caseId,expectedVersion:2,actorId:f.actor.subjectId,kind:'result-recorded',
    origin:{kind:'intervention',id:intervention.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'partial',summary:'Private report',limitations:'Only observed synthetic CI',supersedes:null};
  await f.cases.submitV2(f.actor,await f.authorize(result,'case.teaser.publish',{objectId:result.eventId}));
  const source={provider:'github-actions',owner:'synthetic',repository:'sample',runId:73,attempt:1,commit:'a'.repeat(40)};
  const evidence={id:randomUUID(),operationId:randomUUID(),kind:'evidence',expectedVersion:0,caseId:root.caseId,reportedBy:f.actor.subjectId,
    synthetic:true,evidenceType:'ci-result',source:{...ciSourceMetadata(source),originalAt:new Date(f.now*1000).toISOString(),issuer:'GitHub Actions'},
    observedAt:new Date(f.now*1000).toISOString(),reportedSourceState:'available',summary:'PRIVATE_SOURCE_BODY'};
  const evidenceAuth=await f.authorize(evidence,'evidence.submit',{objectId:evidence.operationId});await f.verificationRecords.submit(f.actor,evidenceAuth);
  const request={id:randomUUID(),schemaVersion:2,kind:'observe',purpose:'observe-selected-ci-source-and-prepare-bounded-proof',
    caseId:root.caseId,evidenceRef:{id:evidence.id,version:1},resultRef:{id:result.eventId,version:1},source};
  await f.ciV2.submit(f.actor,await f.authorize(request,'ci.observe'));
  await f.ciV2.processNext((ref,now)=>inspectGithubRun(ref,{id:ref.runId,run_attempt:ref.attempt,head_sha:ref.commit,status:'completed',conclusion:'success',
    repository:{id:789,full_name:'synthetic/sample',private:false},updated_at:new Date(now*1000).toISOString()},now));
  const preview=await f.ciV2.preview(f.actor,{id:randomUUID(),requestId:request.id});
  const published=await f.ciV2.publish(f.actor,await f.authorize(JSON.parse(preview.payloadJson),'proof.publish',{visibility:'Public',purpose:'public-profile'}));
  const row=(await f.db.query('SELECT id,payload_hash FROM ci_proofs_v2 WHERE id=$1',[published.proofId])).rows[0];
  return{source:{kind:'ci-proof-v2',id:row.id,payloadHash:row.payload_hash},published,evidenceAuth};
}
