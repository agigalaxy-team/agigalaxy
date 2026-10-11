import {qualificationQueryV2Schema} from './shared/qualification-v2-schema.mjs';
import {qualificationCandidates} from './qualification-candidates-v2.mjs';
import {qualificationDecisionV2} from './domain/qualification-v2.mjs';
import {caseRepository} from './infrastructure/case-repository.mjs';
import {projectCaseFacts} from './domain/intervention.mjs';
import {qualificationDefinitionHash} from './infrastructure/qualification-policy-registry.mjs';
import {ServiceError} from './shared/service-error.mjs';
const rule=(ok,code,status=409)=>{if(!ok)throw new ServiceError(code,status);};
const unavailable=e=>e instanceof ServiceError&&[403,404,409,422,503].includes(e.status);
export class QualificationV2Service{
  candidates(actor,input){return qualificationCandidates(this,actor,input);}
  constructor(legacy,{cases,assistance,experienceReviews,capsules,calculations}={}){Object.assign(this,{legacy,cases,assistance,experienceReviews,capsules,calculations});this.access=legacy.access;}
  async participationWithin(db,actor,id,subjectId,policy,calculation=null){
    const row=(await db.query('SELECT task_id,subject_id FROM task_participations WHERE id=$1',[id])).rows[0];rule(row&&row.subject_id===subjectId,'qualification_source_unavailable',404);
    let task,p;
    if(calculation){
      const t=await this.assistance.taskRepository.get(db,row.task_id),pr=await this.assistance.taskRepository.getParticipation(db,id);
      rule(t&&!t.snapshot?.contentDeleted&&pr&&!pr.snapshot?.contentDeleted,'qualification_source_unavailable');
      await calculation.readEventWithin('task-event',await this.assistance.taskRepository.event(db,t.root_event_id));
      p=pr.snapshot;
      for(const eventId of new Set([p.proposalEventId,p.scopeEventId]))await calculation.readEventWithin('task-event',await this.assistance.taskRepository.event(db,eventId));
      task={taskId:t.id,caseId:t.case_id,request:t.snapshot.request,requesterId:t.requester_id,
        paused:t.case_id?(await db.query('SELECT id FROM moderation_reports WHERE case_id=$1 AND paused=true LIMIT 1',[t.case_id])).rows.length>0:false};
    }else{task=await this.assistance.readTaskWithin(db,actor,row.task_id);p=task.participations?.find(p=>p.participationId===id);}
    rule(p&&task.caseId&&task.request.capabilityId===policy.capabilityId,'qualification_source_scope_mismatch');
    rule(p.events.some(e=>e.event.kind==='confirm'&&e.actorId===subjectId),'qualification_confirmation_unavailable');
    if(calculation)for(const e of p.events.filter(e=>e.event.kind==='confirm'&&e.actorId===subjectId))await calculation.readEventWithin('task-event',await this.assistance.taskRepository.event(db,e.event.eventId));
    // An unresolved dispute affects support from this work, not all unrelated
    // capabilities or an automatic permanent punishment of the participant.
    if(task.paused||p.state==='disputed')return{kind:'participation',id,usable:false,reason:'source-under-review',group:`case:${task.caseId}`};
    const repo=caseRepository(db),parent=await repo.lockAnyForRead(task.caseId);rule(parent&&parent.state!=='withdrawn','qualification_source_unavailable');
    const rows=await repo.events(task.caseId),facts=projectCaseFacts(rows.filter(row=>row.payload_text),parent);
    if(calculation)await calculation.readEventWithin('case-event',rows.find(r=>['case','case-created'].includes(r.kind)));
    for(const delivery of [...p.deliveries].reverse()){
      const acceptance=delivery.acceptance;if(!acceptance||acceptance.actorId!==task.requesterId||acceptance.at<this.access.now()-policy.historyWindowSeconds)continue;
      if(calculation)for(const eventId of [delivery.deliveryId,acceptance.eventId])await calculation.readEventWithin('task-event',await this.assistance.taskRepository.event(db,eventId));
      const readEventWithin=calculation?(row=>calculation.readEventWithin('case-event',row)):null;
      const result=await this.cases.requireFactWithin(db,actor,rows,facts,'result',delivery.resultRef,{latest:true,readEventWithin});
      rule(result.actorId===subjectId&&result.taskId===task.taskId&&result.participationId===id,'qualification_actual_participation_mismatch');
      rule(result.participationScopeVersion===delivery.scopeVersion,'qualification_source_scope_mismatch');
      const origin=await this.cases.requireFactWithin(db,actor,rows,facts,result.origin.kind,result.origin,{readEventWithin});
      rule(origin.actorId===subjectId,'qualification_actual_participation_mismatch');
      for(const reference of delivery.evidenceRefs??[]) {
        rule(this.cases.sources?.requireReferenceWithin,'source_access_unavailable',503);
        const ref=typeof reference==='string'?{id:reference,version:1}:reference;
        if(calculation?.readEvidenceWithin)await calculation.readEvidenceWithin(ref,{caseId:task.caseId,resultRef:delivery.resultRef});
        else await this.cases.sources.requireReferenceWithin(db,actor,{kind:'evidence',...ref},{caseId:task.caseId});
      }
      return{kind:'participation',id,group:`case:${task.caseId}`,caseId:task.caseId,taskId:task.taskId,usable:true,synthetic:facts.synthetic,
        role:p.role,participatedAt:p.confirmedAt,
        resultRef:delivery.resultRef,evidenceRefs:(delivery.evidenceRefs??[]).map(ref=>typeof ref==='string'?{id:ref,version:1}:ref),origin:result.origin,acceptanceRef:acceptance.eventId,scopeVersion:delivery.scopeVersion,scope:p.agreedScope,
        reportedOutcome:result.reportedOutcome,review:'requester-accepted-delivery-in-scope',independentVerification:false};
    }
    return{kind:'participation',id,group:`case:${task.caseId}`,usable:false,reason:'no-current-visible-accepted-delivery'};
  }
  async evaluateWithin(db,actor,input,collaboration){
    const parsed=qualificationQueryV2Schema.safeParse(input);rule(parsed.success,'invalid_qualification_v2_query',400);const q=parsed.data;
    const target=await this.assistance.requireTaskWithin(db,actor,q.taskId),request=target.snapshot.request;
    rule(!collaboration||request.collaboration===collaboration,'qualification_task_mismatch');
    const base={schemaVersion:2,subjectId:q.subjectId,taskId:q.taskId,decisionScope:'current task eligibility only',issuer:this.access.endpoint,
      checkedAt:this.access.now(),cacheable:false,capabilityVerified:false,expertiseCertified:false,automaticSelection:false,
      paths:['open-assistance','scoped-external-work-review','scoped-challenge','authorized-real-capsule-application'],
      sourceCoverage:'explicitly-selected-current-authorized-evidence',restrictionsCoverage:'current-task-operational-pause; no-inferred-global-ban'};
    base.taskEligibilityProfile=request.qualification?.profile??(request.qualification?'legacy':'open-without-history');
    base.appliesToTaskSelection=!request.qualification||request.qualification.profile==='facts-v2';
    if(!request.qualification){rule(request.collaboration==='open-assistance','qualification_policy_unavailable');return{...base,state:target.paused?'not-satisfied':'satisfied',missing:[],satisfiedBy:[],
      effectiveRestrictions:target.paused?[{kind:'task-paused',taskId:q.taskId,scope:'new-participation'}]:[],basis:'this-open-task-has-no-history-requirement'};}
    rule((!q.policyId||q.policyId===request.qualification.policyId)&&(!q.policyVersion||q.policyVersion===request.qualification.policyVersion)
      &&(!q.capabilityId||q.capabilityId===request.capabilityId),'qualification_task_policy_mismatch');
    const policy=await this.legacy.policyWithin(db,request.qualification.policyId,request.qualification.policyVersion,request.capabilityId,request.collaboration);
    const sources=[],observations=[];let calculation=null;
    if(q.evidence.calculationGrantId){rule(this.calculations,'qualification_calculation_unavailable',503);calculation=await this.calculations.contextWithin(db,actor,q);}
    for(const id of [...new Set(q.evidence.participationIds)].sort())try{sources.push(await this.participationWithin(db,actor,id,q.subjectId,policy,calculation));}
      catch(error){if(!unavailable(error))throw error;observations.push({kind:'participation',id,state:'unavailable',reason:error.code});}
    for(const ref of q.evidence.externalReviewRefs)try{
      sources.push(await this.externalReviewWithin(db,actor,ref,q.subjectId,policy,calculation));
    }catch(error){if(!unavailable(error))throw error;observations.push({kind:'external-review',id:ref.id,state:'unavailable',reason:error.code});}
    for(const id of q.evidence.capsuleUseIds)try{
      const row=(await db.query('SELECT * FROM capsule_uses_v2 WHERE id=$1',[id])).rows[0];const use=await this.capsules.v2.useWithin(db,actor,row);
      rule(use.record&&use.kind!=='reference'&&use.sourceStatus==='current','qualification_capsule_source_unavailable');
      // Reading/publishing and the user's self-test do not create a reviewed
      // professional history. The actual participation or external review is
      // evaluated separately, deduplicated with this target Case.
      observations.push({kind:'capsule-use',id,caseId:use.caseId,state:'actual-application-requires-scoped-review',synthetic:use.synthetic,
        reportedOutcome:use.reportedOutcome,capabilityVerified:false});
    }catch(error){if(!unavailable(error))throw error;observations.push({kind:'capsule-use',id,state:'unavailable',reason:error.code});}
    const legacy=await this.legacy.evaluateWithin(db,actor,{policyId:policy.id,policyVersion:policy.version,capabilityId:policy.capabilityId,subjectId:q.subjectId,
      evidence:{proofIds:q.evidence.proofIds,assistanceIds:q.evidence.assistanceIds}},request.collaboration);
    // Old sources remain visible with their original provenance; absence of a
    // synthetic flag or actual v2 origin is not evidence of real execution.
    observations.push(...legacy.acceptedCollaborations.map(x=>({kind:'legacy-assistance',id:x.assistanceId,state:'legacy-source-profile; v2-scope-review-required'})));
    const decision=qualificationDecisionV2({policy,sources,proofs:legacy.proofs,effectiveRestrictions:target.paused?[{kind:'task-paused',taskId:q.taskId,scope:'new-participation'}]:[],includeSimulation:q.includeSimulation});
    if(calculation)return{...base,...decision,satisfiedBy:decision.satisfiedBy.map(()=>({condition:'relevant-reviewed-experience',scope:'selected-task-related-work',sourceDetailsDisclosed:false})),
      observations:observations.map(o=>({kind:o.kind,state:o.state,reason:o.reason})),sourceStatuses:sources.filter(s=>!s.usable||s.synthetic!==false).map(s=>({reason:s.synthetic?'synthetic-excluded':s.reason??'source-unavailable'})),
      calculation:{grantId:calculation.grantId,taskId:q.taskId,recipientId:calculation.payload.recipientId,purpose:calculation.payload.purpose},
      capabilityId:policy.capabilityId,policyId:policy.id,policyVersion:policy.version,policyDefinitionHash:qualificationDefinitionHash(policy),sourceCoverage:'selected-licensed-materials; no-original-text-or-third-party-identity'};
    return{...base,...decision,capabilityId:policy.capabilityId,policyId:policy.id,policyVersion:policy.version,policyDefinitionHash:qualificationDefinitionHash(policy),
      registeredPolicyVersion:!!this.legacy.registryEnabled,evaluationRule:{id:'task-related-facts',version:2,counting:'distinct-case-or-stable-external-source; real-material-only'},
      observations,sourceStatuses:sources.filter(s=>!s.usable||s.synthetic!==false).map(s=>({kind:s.kind,id:s.id,reason:s.synthetic?'synthetic-excluded':s.reason??'real-source-status-unknown'})),
      proofMeaning:'policy-matched-ci-observations; not-individual-capability-or-independent-work'};
  }
  evaluate(actor,input){return this.access.runAuthorized(actor,'assistance',db=>this.evaluateWithin(db,actor,input));}
  async externalReviewWithin(db,actor,ref,subjectId,policy,calculation=null){
    const reviewed=await this.experienceReviews.readWithin(db,actor,ref,new Set(),calculation?.readEventWithin??null),r=reviewed.record;
    rule(reviewed.referenceStatus==='current'&&r&&reviewed.type==='review','qualification_review_unavailable');
    rule(reviewed.experienceSubjectId===subjectId&&r.capabilityId===policy.capabilityId,'qualification_source_scope_mismatch');
    rule(Date.parse(r.observedAt)>=1000*(this.access.now()-policy.historyWindowSeconds),'qualification_source_outside_window');
    return{kind:'external-review',id:ref.id,version:ref.version,group:`external:${reviewed.sourceGroup}`,usable:r.state==='verified-in-scope',
      reason:r.state==='verified-in-scope'?null:r.state,synthetic:reviewed.synthetic,experienceKind:reviewed.experienceKind,scope:r.scope,
      reviewerId:reviewed.subjectId,review:'registered-reviewer-scoped-attestation',productionExperienceInferred:reviewed.experienceKind!=='challenge'};
  }
}
