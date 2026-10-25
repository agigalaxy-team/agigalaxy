import {caseRepository} from "../infrastructure/case-repository.mjs";
import {digest} from "../shared/digest.mjs";
import {ServiceError} from "../shared/service-error.mjs";
import {assertCaseReview} from "../domain/case-review.mjs";
import {projectCaseFacts,latestFact,publicFactView} from "../domain/intervention.mjs";
import {caseEventSchema,caseTaskLinkSchema,factReferenceSchema,taskCaseContainerSummary,taskMaterialCaseContainerTitle} from "../shared/cases-schema.mjs";
import {hasTaskMaterials,hasTaskText} from "../shared/task-material-v1-schema.mjs";
import {caseTaskLinkPayloadHash,legacyCaseTaskLinkPayloadHash} from "../shared/case-operation-hash.mjs";
import {parseFact,rule} from './helpers.mjs';
import {CaseReadModel} from './read-model.mjs';

// Original v1 bytes and append-only v2 commands, transaction/CAS control and atomic Task-to-Case work/delivery qualification.
export class CaseService extends CaseReadModel{
  constructor(access,consents){super(access,consents);}


  async submit(actor, { consentId, payloadJson }) {
    let event;
    try {
      if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 12000) throw new Error('size');
      event = caseEventSchema.parse(JSON.parse(payloadJson));
    } catch { throw new ServiceError('invalid_case_payload'); }
    const caseId = event.kind === 'case' ? event.id : event.caseId;
    return this.access.runResourceWrite(actor,'case-teaser',{control:event.kind==='withdrawal'}, async (db, authorization) => {
      const records = caseRepository(db);
      if (event.kind === 'case') {
        if (!event.participants.some(p => p.subjectId === actor.subjectId && p.role === 'requester'))
          throw new ServiceError('requester_required', 403);
        await records.ensureCase(caseId, actor.subjectId, event.localRef, event.source.reference);
      }
      const parent = await records.lockForWrite(caseId, actor.subjectId);
      if (!parent) throw new ServiceError('case_conflict_or_not_found', 409);
      // Use the same parent-before-consent lock order as aggregate reads.
      // A rejected consent rolls back any provisional case insert above.
      await this.consents.require(db, { id: consentId, subjectId: actor.subjectId, action: 'case.teaser.publish',
        objectId: event.id, recipient: this.endpoint, payloadJson });
      const existing = await records.event(event.id);
      const hash = digest(payloadJson);
      if (existing) {
        if (existing.subject_id !== actor.subjectId || existing.case_id !== caseId || existing.payload_hash !== hash
          || existing.consent_id !== consentId) throw new ServiceError('event_conflict', 409);
        return { caseId, eventId: event.id, version: existing.version, verification: 'unverified' };
      }
      if (await records.hasV2(caseId)) throw new ServiceError('unsupported_semantics',409);
      if (parent.state === 'withdrawn') throw new ServiceError('case_withdrawn', 409);
      let version = 1;
      if (event.kind !== 'case') {
        if (parent.version !== event.expectedVersion) throw new ServiceError('version_conflict', 409);
        if (parent.version >= 1000) throw new ServiceError('case_event_limit', 413);
        version = parent.version + 1;
      }
      if (event.kind === 'attempt') {
        const count = await records.attemptCount(caseId);
        if (event.sequence !== count + 1) throw new ServiceError('attempt_order_conflict', 409);
      }
      if (event.kind === 'result' || event.kind === 'revision') {
        const reference = event.kind === 'result' ? event.attemptId : event.correctsEventId;
        const referenced = await records.reference(reference, caseId);
        if (!referenced || (event.kind === 'result' && referenced.kind !== 'attempt')) throw new ServiceError('invalid_case_reference');
        if (event.kind === 'result' && event.outcome === 'failed' && !event.failureReason.trim()) throw new ServiceError('failure_reason_required');
      }
      if (event.kind === 'revision' && event.review)
        assertCaseReview(event, (await records.events(caseId)).map(row => row.payload));
      await records.insertEvent({ event, caseId, subjectId: actor.subjectId, version, consentId, payloadJson, hash });
      const state = event.kind === 'withdrawal' ? 'withdrawn' : event.kind === 'result' && event.outcome === 'succeeded'
        ? 'resolution-proposed' : parent.state;
      await records.updateState(caseId, version, state);
      await records.audit(actor.subjectId, event.kind, caseId, event.id, actor.httpRequestId ?? null, authorization.credentialScopes, authorization.callerBindingId);
      return { caseId, eventId: event.id, version, verification: 'unverified' };
    });
  }

  async submitV2(actor, request) {
    const event=parseFact(request.payloadJson);
    return this.access.runResourceWrite(actor,'case-teaser',{control:event.kind==='case-withdrawn'},async(db,authorization)=>{
      if(event.taskId){
        rule(this.tasks,'task_service_unavailable',503);
        const task=await this.tasks.requireTaskWithin(db,actor,event.taskId,{write:true});
        rule(task.caseId===event.caseId,'task_case_link_required');
      }
      return this.submitV2Within(db,actor,request,authorization);
    });
  }

  async submitV2Within(db,actor,{consentId,payloadJson},authorization,{allowTaskRoot=false,taskRootContext=null}={}) {
    const event=parseFact(payloadJson),records=caseRepository(db),caseId=event.caseId;
    rule(event.actorId===actor.subjectId,'actor_mismatch',403);
    if(event.kind==='case-created'){
      rule(event.eventId===caseId,'case_root_id_mismatch',422);
      rule(!event.participationId||allowTaskRoot&&taskRootContext?.participation,'requester_required',403);
      rule(!event.taskId||allowTaskRoot,'task_case_link_required');
      await records.ensureCase(caseId,taskRootContext?.ownerId??actor.subjectId,event.localRef,event.source.reference);
    }
    const parent=await records.lockAnyForWrite(caseId);
    rule(parent,'case_conflict_or_not_found');
    const owner=parent.subject_id===actor.subjectId;
    let participation=event.kind==='case-created'&&allowTaskRoot?taskRootContext?.participation??null:null;
    if(!owner||event.participationId){
      rule(this.tasks&&event.taskId&&event.participationId,'participation_required',403);
      if(!participation){const task=await this.tasks.requireTaskWithin(db,actor,event.taskId,{write:false});
       rule(task.caseId===caseId,'task_case_link_required');
       participation=await this.tasks.requireParticipationWithin(db,actor,{taskId:event.taskId,participationId:event.participationId});}
      rule(participation.subjectId===actor.subjectId,'participation_required',403);
    }
    const intent=await this.consents.require(db,{id:consentId,subjectId:actor.subjectId,action:'case.teaser.publish',
      objectId:event.eventId,recipient:this.endpoint,payloadJson});
    rule(intent.visibility!=='Proof-only','disclosure_mismatch',403);
    const existing=await records.event(event.eventId),hash=digest(payloadJson);
    if(existing){
      rule(existing.subject_id===actor.subjectId&&existing.case_id===caseId&&existing.payload_hash===hash&&existing.consent_id===consentId,'event_conflict');
      return this.factReceipt(event,existing.version);
    }
    rule(parent.state!=='withdrawn','case_withdrawn');
    const rows=await records.events(caseId),facts=projectCaseFacts(rows,parent);
    rule(rows.length<1000,'case_event_limit',413);
    if(event.kind==='case-created')rule((owner||allowTaskRoot&&!!taskRootContext?.participation)&&rows.length===0,'case_conflict_or_not_found');
    else rule(parent.version===event.expectedVersion,'version_conflict');
    const scopeVersion=event.scopeVersion??event.taskScopeVersion??facts.scopeVersion;
    if(event.kind!=='case-created'&&event.kind!=='case-scope-revised')
      rule(scopeVersion<=facts.scopeVersion,'invalid_scope_version',422);
    if(participation){
      rule(!participation.paused&&!['canceled','closed'].includes(participation.taskState),'participation_paused',403);
      rule(['active','delivered','accepted','disputed'].includes(participation.state),'participation_required',403);
      rule(participation.scopeVersion===(event.participationScopeVersion??1),'participation_scope_changed');
    }
    const ownRef=(kind,ref,options={})=>this.requireFactWithin(db,actor,rows,facts,kind,ref,{own:true,...options});
    if(event.kind==='attempt-start'&&event.configurationRef)
      await this.requireSourceWithin(db,actor,rows,facts,{kind:'configuration',...event.configurationRef});
    if(event.kind==='attempt-end'||event.kind==='attempt-correct'){
      const attempt=await ownRef('attempt',event.attemptRef,{latest:true});
      rule(event.kind==='attempt-end'?attempt.status==='running':attempt.status!=='running','attempt_transition_denied');
      rule(attempt.scopeVersion===scopeVersion,'invalid_scope_version',422);
      if(event.endedAt&&attempt.startedAt)rule(Date.parse(event.endedAt)>=Date.parse(attempt.startedAt),'invalid_attempt_time',422);
    }
    if(event.kind==='intervention'){
      if(event.supersedes)await ownRef('intervention',event.supersedes,{latest:true});
      for(const id of event.affectsAttemptIds){
        const attempt=latestFact(facts,'attempt',id);rule(attempt,'invalid_case_reference',422);
        await this.requireFactWithin(db,actor,rows,facts,'attempt',attempt);
      }
      for(const ref of event.sourceRefs)await this.requireSourceWithin(db,actor,rows,facts,ref);
    }
    if(event.kind==='intervention-response')
      await this.requireFactWithin(db,actor,rows,facts,'intervention',event.interventionRef,{latest:true});
    if(event.kind==='result-recorded'){
      const origin=await ownRef(event.origin.kind,event.origin);
      rule(origin.scopeVersion===event.scopeVersion,'invalid_result_origin',422);
      rule(origin.taskId===(event.taskId??null),'invalid_result_origin',422);
      rule((event.participationId??null)===origin.participationId,'origin_not_authorized',403);
      rule(origin.participationScopeVersion===(event.participationScopeVersion??(event.participationId?1:null)),'participation_scope_changed');
      if(event.supersedes)await ownRef('result',event.supersedes,{latest:true});
      for(const ref of event.deliverableRefs)await this.requireSourceWithin(db,actor,rows,facts,ref);
    }
    if(event.kind==='resolution-recorded'){
      rule(owner,'resolution_authority_required',403);
      rule(event.taskScopeVersion===facts.scopeVersion,'invalid_scope_version',422);
      const previous=facts.resolutions.at(-1);
      rule((previous?.id??null)===event.supersedesResolutionId,'resolution_version_conflict');
      for(const ref of event.resultRefs){
        const result=await this.requireFactWithin(db,actor,rows,facts,'result',ref,{latest:true});
        rule(result.scopeVersion===event.taskScopeVersion,'invalid_scope_version',422);
      }
      for(const ref of event.verificationRefs){
        rule(this.verifications?.requireReferenceWithin,'verification_access_unavailable',503);
        await this.verifications.requireReferenceWithin(db,actor,ref,{caseId,scopeVersion:event.taskScopeVersion});
      }
    }
    if(event.kind==='case-scope-revised'){
      rule(owner,'requester_required',403);rule(event.taskScopeVersion===facts.scopeVersion+1,'invalid_scope_version',422);
      if(event.taskId){
        const task=await this.tasks.requireTaskWithin(db,actor,event.taskId,{write:false});
        rule(task.snapshot.scopeVersion===event.taskScopeVersion,'task_scope_not_confirmed');
      }
    }
    if(event.kind==='case-withdrawn')rule(owner,'requester_required',403);
    const version=event.kind==='case-created'?1:parent.version+1;
    await records.insertEvent({event,caseId,subjectId:actor.subjectId,version,consentId,payloadJson,hash});
    await records.updateState(caseId,version,event.kind==='case-withdrawn'?'withdrawn':parent.state);
    await records.audit(actor.subjectId,event.kind,caseId,event.eventId,actor.httpRequestId??null,authorization.credentialScopes,authorization.callerBindingId);
    return this.factReceipt(event,version);
  }

  async respondBatch(actor,requests){
    rule(Array.isArray(requests)&&requests.length>0&&requests.length<=32,'invalid_response_batch',422);
    const results=[];
    for(const request of requests){
      try{
        rule(parseFact(request.payloadJson).kind==='intervention-response','invalid_response_batch',422);
        results.push({status:'accepted',receipt:await this.submitV2(actor,request)});
      }catch(error){if(!(error instanceof ServiceError))throw error;results.push({status:'rejected',code:error.code});}
    }
    return {results,allAccepted:results.every(row=>row.status==='accepted')};
  }

  async createAndLinkTask(actor,input){
    let command;try{command=caseTaskLinkSchema.parse(input);}catch{throw new ServiceError('invalid_case_task_link');}
    rule(this.tasks?.attachCaseWithin,'task_service_unavailable',503);
    const root=parseFact(command.case.payloadJson),initial=parseFact(command.initialFact.payloadJson);
    rule(root.kind==='case-created'&&root.taskId===command.taskId&&root.source.kind==='active-task'
      &&root.source.reference===command.taskId&&root.actorId===actor.subjectId,'invalid_task_case_root',422);
    rule(['attempt-start','intervention'].includes(initial.kind)&&initial.caseId===root.caseId&&initial.taskId===command.taskId
      &&initial.expectedVersion===1,'initial_work_fact_required',422);
    return this.access.runResourceWrite(actor,'case-teaser',{},async(db,authorization)=>{
      const task=await this.tasks.requireTaskWithin(db,actor,command.taskId,{write:true}),records=caseRepository(db);
      const hash=caseTaskLinkPayloadHash(command),prior=await records.operationLink(command.operationId);
      if(prior){
        rule(prior.subject_id===actor.subjectId&&prior.task_id===command.taskId
          &&[hash,legacyCaseTaskLinkPayloadHash(command)].includes(prior.payload_hash),'event_conflict');
        await this.requireEventVisibleWithin(db,actor,await records.event(root.eventId));
        await this.requireEventVisibleWithin(db,actor,await records.event(initial.eventId));
        return {...prior.receipt,operationId:command.operationId,payloadHash:prior.payload_hash};
      }
      rule(!task.caseId&&!(await records.taskLink(command.taskId)),'task_case_link_conflict');
      rule(task.row.version===command.expectedTaskVersion,'task_version_conflict');
      let participation=null;
      if(task.requesterId!==actor.subjectId){
        rule(root.participationId&&root.participationId===initial.participationId&&root.actorId===initial.actorId,'participation_required',403);
        participation=await this.tasks.requireParticipationWithin(db,actor,{taskId:command.taskId,participationId:root.participationId});
        rule(participation.subjectId===actor.subjectId&&['active','delivered','accepted','disputed'].includes(participation.state),'participation_required',403);
        rule(!participation.paused&&!['canceled','closed'].includes(participation.taskState),'participation_paused',403);
        rule(root.participationScopeVersion===participation.scopeVersion&&initial.participationScopeVersion===participation.scopeVersion,'participation_scope_changed');
        rule(root.taskScopeVersion===task.snapshot.scopeVersion&&initial.taskScopeVersion===task.snapshot.scopeVersion,'invalid_scope_version',422);
        const containerTitle=hasTaskMaterials(task.snapshot.request)||hasTaskText(task.snapshot.request)
          ?taskMaterialCaseContainerTitle:task.snapshot.request.title;
        rule(root.title===containerTitle&&root.summary===taskCaseContainerSummary,'invalid_task_case_root',422);
        const rootGrant=await this.consents.require(db,{id:command.case.consentId,subjectId:actor.subjectId,action:'case.teaser.publish',objectId:root.eventId,recipient:this.endpoint,payloadJson:command.case.payloadJson}),
          initialGrant=await this.consents.require(db,{id:command.initialFact.consentId,subjectId:actor.subjectId,action:'case.teaser.publish',objectId:initial.eventId,recipient:this.endpoint,payloadJson:command.initialFact.payloadJson});
        rule(rootGrant.visibility==='Private'&&initialGrant.visibility==='Private'
          &&JSON.stringify([...rootGrant.viewers].sort((left,right)=>left<right?-1:left>right?1:0))===JSON.stringify([...initialGrant.viewers].sort((left,right)=>left<right?-1:left>right?1:0)),'disclosure_mismatch',403);
      }
      await this.submitV2Within(db,actor,command.case,authorization,{allowTaskRoot:true,taskRootContext:{ownerId:task.requesterId,participation}});
      const linkedTask=await this.tasks.attachCaseWithin(db,{taskId:command.taskId,caseId:root.caseId,requesterId:task.requesterId});
      const fact=await this.submitV2Within(db,actor,command.initialFact,authorization);
      const receipt={operationId:command.operationId,payloadHash:hash,caseId:root.caseId,taskId:command.taskId,caseVersion:fact.caseVersion,
        taskVersion:linkedTask.version,taskCaseLinkVersion:1,synthetic:root.synthetic,failedAttemptsCreated:0,initialFact:fact.objectRef};
      await records.insertTaskLink({taskId:command.taskId,caseId:root.caseId,operationId:command.operationId,
        subjectId:actor.subjectId,hash,receipt});
      return receipt;
    });
  }

  async validateTaskContextWithin(db,actor,{caseId,attemptRefs=[]}){
    const records=caseRepository(db),parent=await records.lockAnyForRead(caseId);
    rule(parent&&parent.state!=='withdrawn','case_unavailable',409);
    const rows=await records.events(caseId),facts=projectCaseFacts(rows,parent),attempts=[];
    for(const ref of attemptRefs){rule(factReferenceSchema.safeParse(ref).success,'invalid_attempt_reference',422);
      attempts.push(await this.requireFactWithin(db,actor,rows,facts,'attempt',ref));}
    return publicFactView({attempts,coverage:'specified-references-only'});
  }

  async validateDeliveryWithin(db,actor,{taskId,caseId,participationId,subjectId=actor.subjectId,scopeVersion,
    resultRef,interventionRefs=[],evidenceRefs=[]}){
    rule(factReferenceSchema.safeParse(resultRef).success,'invalid_result_reference',422);
    const records=caseRepository(db),parent=await records.lockAnyForRead(caseId);
    rule(parent&&parent.state!=='withdrawn','case_unavailable',409);
    const rows=await records.events(caseId),facts=projectCaseFacts(rows,parent);
    rule(actor.subjectId===subjectId||actor.subjectId===parent.subject_id,'origin_not_authorized',403);
    const result=await this.requireFactWithin(db,actor,rows,facts,'result',resultRef);
    rule(result.actorId===subjectId,'origin_not_authorized',403);
    rule(result.taskId===taskId&&result.participationId===participationId,'origin_not_authorized',403);
    if(scopeVersion!==undefined)rule(result.participationScopeVersion===scopeVersion,'participation_scope_changed');
    const interventions=[];
    for(const ref of interventionRefs)interventions.push(await this.requireFactWithin(db,actor,rows,facts,'intervention',ref));
    for(const reference of evidenceRefs){rule(this.sources?.requireReferenceWithin,'source_access_unavailable',503);
      const ref=typeof reference==='string'?{id:reference,version:1}:reference;
      rule(factReferenceSchema.safeParse(ref).success,'invalid_evidence_reference',422);
      await this.sources.requireReferenceWithin(db,actor,{kind:'evidence',...ref},{caseId,resultRef});}
    return {result:publicFactView(result),interventions:publicFactView(interventions),evidenceRefs};
  }
}
