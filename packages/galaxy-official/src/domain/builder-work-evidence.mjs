import { ServiceError } from '../shared/service-error.mjs';
import { canReadProjection } from './consent-policy.mjs';

// Reuse the original Case grants and live Proof verifier; a Node signature
// associates sources but does not turn a CI fact into independent execution attribution.
export async function readBuilderWorkSources(service,db,actor,payload){
  const parent=(await db.query('SELECT id,subject_id,state FROM cases WHERE id=$1 FOR SHARE',[payload.caseId])).rows[0];
  if(!parent||parent.state==='withdrawn')throw new ServiceError('builder_work_source_unavailable',404);
  const events=(await db.query('SELECT * FROM case_events WHERE case_id=$1 AND id=ANY($2::uuid[]) ORDER BY version',[payload.caseId,[payload.caseId,payload.attemptId,payload.resultId]])).rows;
  if(events.length!==3)throw new ServiceError('builder_work_source_mismatch',409);
  const root=events.find(row=>row.id===payload.caseId),attempt=events.find(row=>row.id===payload.attemptId),result=events.find(row=>row.id===payload.resultId);
  if(root.kind!=='case'||attempt.kind!=='attempt'||result.kind!=='result'||result.payload.attemptId!==attempt.id)throw new ServiceError('builder_work_source_mismatch',409);
  for(const row of events){
    const grant=await service.consents.require(db,{id:row.consent_id,subjectId:parent.subject_id,objectId:row.id,action:'case.teaser.publish',recipient:service.access.endpoint,payloadJson:row.payload_text});
    if(!canReadProjection(grant,{viewerId:actor?.subjectId??null,now:service.access.now()}))throw new ServiceError('builder_work_source_unavailable',404);
  }
  const items=[];
  for(const proofId of payload.proofIds){
    const proof=await service.proofs.readWithin(db,actor,proofId);
    const source=(await db.query('SELECT e.id,e.case_id,e.result_id,p.observation_id FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE p.id=$1',[proofId])).rows[0];
    if(!source||source.case_id!==payload.caseId||source.result_id!==payload.resultId)throw new ServiceError('builder_work_source_mismatch',409);
    items.push({proofId,evidenceId:source.id,observationId:source.observation_id,verification:'ci-execution-fact',
      ...(proof.caseContext?{caseContext:proof.caseContext}:{}),...(proof.moderationContext?{moderationContext:proof.moderationContext}:{})});
  }
  return {caseId:payload.caseId,attemptId:payload.attemptId,resultId:payload.resultId,reportedOutcome:result.payload.outcome,
    outcomeAuthority:'case-owner-reported',proofs:items,executionAttributionVerified:false};
}

export async function readBuilderWorkEvidence(service,db,actor,loaded,current,nodeControl){
  const items=[],latest=new Map(),group=event=>JSON.stringify([event.declarationId,event.controlId,event.caseId,event.attemptId,event.resultId]);
  for(const row of loaded.rows)if(row.kind==='work-evidence')latest.set(group(JSON.parse(row.payload_text)),row.id);
  for(const row of loaded.rows){
    if(row.kind!=='work-evidence')continue;
    try{if(!service.visible(await service.grant(db,row),actor))continue;}catch(error){if(error instanceof ServiceError)continue;throw error;}
    const event=JSON.parse(row.payload_text),revoked=loaded.rows.some(item=>item.kind==='work-evidence-revoke'&&JSON.parse(item.payload_text).workEventId===row.id);
    let state=revoked?'revoked':latest.get(group(event))!==row.id?'superseded':event.declarationId!==current.row.id||event.declarationHash!==current.row.payload_hash?'stale-declaration'
      :nodeControl.state!=='node-authorized-owner'||nodeControl.controlId!==event.controlId?'node-authorization-unavailable':'current',source;
    if(state==='current')try{source=await readBuilderWorkSources(service,db,actor,event);}catch(error){if(!(error instanceof ServiceError))throw error;state='source-unavailable';}
    // A reader who cannot currently read all linked sources receives no task IDs
    // or copied source context, even if an earlier association was public.
    items.push({eventId:row.id,nodeId:row.subject_id,declarationId:event.declarationId,controlId:event.controlId,state,
      ...(source?{summary:event.summary,source,...(event.task?{task:{...event.task,authority:'node-declared-task-reference',endpointProbed:false}}:{})}:{}),
      authority:'node-signed-source-association',nodeConsentVerified:true,executionAttributionVerified:false,capabilityVerified:false});
  }
  return {items,currentCount:items.filter(item=>item.state==='current').length,countMeaning:'current-node-associations; not independent evidence count',scope:'exact-declaration-and-node-authorization',executionAttributionVerified:false};
}
