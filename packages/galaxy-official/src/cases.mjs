import { caseRepository } from './infrastructure/case-repository.mjs';
import * as z from 'zod/v4';
import { digest } from './shared/digest.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { assertCaseReview, projectCaseReviews } from './domain/case-review.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { projectCaseFacts, factAt, latestFact, publicFactView } from './domain/intervention.mjs';

import { caseEventSchema, caseEventV2Schema, caseTaskLinkSchema, factReferenceSchema } from './shared/cases-schema.mjs';
export { caseEventSchema, caseEventV2Schema } from './shared/cases-schema.mjs';

function parseFact(payloadJson) {
  try {
    if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>24000) throw new Error('size');
    return caseEventV2Schema.parse(JSON.parse(payloadJson));
  } catch { throw new ServiceError('invalid_case_v2_payload'); }
}
function rule(condition,code,status=409) { if(!condition)throw new ServiceError(code,status); }

export class CaseService {
  constructor(access, consents) { this.access = access; this.consents = consents; this.endpoint = access.endpoint; }

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

  async get(actor, caseId) {
    if (!z.uuid().safeParse(caseId).success) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'case-teaser', async db => {
      const records = caseRepository(db);
      const parent = await records.lockForRead(caseId, actor.subjectId);
      if (!parent) throw new ServiceError('not_found', 404);
      const events = await records.events(caseId);
      if(events.some(row=>!['case','attempt','result','revision','withdrawal'].includes(row.kind)))
        throw new ServiceError('unsupported_semantics',409);
      if (events.length > 1000) throw new ServiceError('case_event_limit', 413);
      // No partial disclosure: one withdrawn authorization prevents returning an
      // aggregate that could retain its content or infer it from related events.
      for (const event of events) await this.consents.require(db, { id: event.consent_id, subjectId: actor.subjectId,
        action: 'case.teaser.publish', objectId: event.id, recipient: this.endpoint, payloadJson: event.payload_text });
      const capsuleUses = this.capsules ? await this.capsules.usesWithin(db, actor, {caseId,limit:20}) : null;
      return { caseId, version: parent.version, state: parent.state, verification: 'unverified',
        ...(capsuleUses?.items.length ? { capsuleUses } : {}),
        reviews: projectCaseReviews(events.map(event => event.payload)),
        events: events.map(event => ({ version: event.version, ...event.payload })) };
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

  async requireEventVisibleWithin(db,actor,row) {
    rule(row,'case_event_unavailable',404);
    rule(typeof row.payload_text==='string'&&row.payload_text.length>0,'case_event_unavailable',404);
    const intent=await this.consents.require(db,{id:row.consent_id,subjectId:row.subject_id,action:'case.teaser.publish',
      objectId:row.id,recipient:this.endpoint,payloadJson:row.payload_text});
    rule(canReadProjection(intent,{viewerId:actor.subjectId,now:this.consents.now(),hubEndpoint:this.endpoint}),
      'origin_not_authorized',403);
    return intent;
  }

  async requireFactWithin(db,actor,rows,facts,kind,ref,{own=false,latest=false,visited=new Set(),readEventWithin=null}={}) {
    const found=factAt(facts,kind,ref);
    rule(found,'invalid_result_origin',422);
    if(own)rule(found.actorId===actor.subjectId,'origin_not_authorized',403);
    if(latest)rule(latestFact(facts,kind,ref.id)?.version===ref.version,'fact_version_conflict');
    const key=`${kind}:${ref.id}:${ref.version}`;
    if(visited.has(key))return found;
    visited.add(key);
    for(const id of new Set(found.recordEventIds)){
      const row=rows.find(item=>item.id===id);rule(row,'invalid_result_origin',422);
      if(readEventWithin)await readEventWithin(row);else await this.requireEventVisibleWithin(db,actor,row);
      for(const source of [...(row.payload.sourceRefs??[]),...(row.payload.deliverableRefs??[])])
        await this.requireSourceWithin(db,actor,rows,facts,source,visited,readEventWithin);
    }
    return found;
  }

  async requireSourceWithin(db,actor,rows,facts,ref,visited=new Set(),readEventWithin=null) {
    if(['attempt','intervention','result'].includes(ref.kind))
      return this.requireFactWithin(db,actor,rows,facts,ref.kind,ref,{visited,readEventWithin});
    // Context/chat/evidence access is delegated to its owning module. No caller
    // field or syntactically valid UUID can substitute for actual read permission.
    rule(this.sources?.requireReferenceWithin,'source_access_unavailable',503);
    return this.sources.requireReferenceWithin(db,actor,ref,{caseId:facts.caseId,visited});
  }

  async submitV2Within(db,actor,{consentId,payloadJson},authorization,{allowTaskRoot=false}={}) {
    const event=parseFact(payloadJson),records=caseRepository(db),caseId=event.caseId;
    rule(event.actorId===actor.subjectId,'actor_mismatch',403);
    if(event.kind==='case-created'){
      rule(event.eventId===caseId,'case_root_id_mismatch',422);
      rule(!event.participationId,'requester_required',403);
      rule(!event.taskId||allowTaskRoot,'task_case_link_required');
      await records.ensureCase(caseId,actor.subjectId,event.localRef,event.source.reference);
    }
    const parent=await records.lockAnyForWrite(caseId);
    rule(parent,'case_conflict_or_not_found');
    const owner=parent.subject_id===actor.subjectId;
    let participation=null;
    if(!owner||event.participationId){
      rule(this.tasks&&event.taskId&&event.participationId,'participation_required',403);
      const task=await this.tasks.requireTaskWithin(db,actor,event.taskId,{write:false});
      rule(task.caseId===caseId,'task_case_link_required');
      participation=await this.tasks.requireParticipationWithin(db,actor,{taskId:event.taskId,participationId:event.participationId});
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
    if(event.kind==='case-created')rule(owner&&rows.length===0,'case_conflict_or_not_found');
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

  factReceipt(event,version){
    const objectId=event.supersedes?.id??event.attemptRef?.id??event.eventId;
    const objectVersion=(event.supersedes?.version??event.attemptRef?.version??0)+1;
    return {caseId:event.caseId,eventId:event.eventId,version,caseVersion:version,objectRef:{id:objectId,version:objectVersion},
      claimAuthority:'participant-reported',verification:'not-provided',acceptance:'not-provided',resolution:'separate'};
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
      rule(task.requesterId===actor.subjectId,'requester_required',403);
      const hash=digest(JSON.stringify(command)),prior=await records.operationLink(command.operationId);
      if(prior){
        rule(prior.subject_id===actor.subjectId&&prior.task_id===command.taskId&&prior.payload_hash===hash,'event_conflict');
        await this.requireEventVisibleWithin(db,actor,await records.event(root.eventId));
        await this.requireEventVisibleWithin(db,actor,await records.event(initial.eventId));
        return prior.receipt;
      }
      rule(!task.caseId&&!(await records.taskLink(command.taskId)),'task_case_link_conflict');
      rule(task.row.version===command.expectedTaskVersion,'task_version_conflict');
      await this.submitV2Within(db,actor,command.case,authorization,{allowTaskRoot:true});
      const linkedTask=await this.tasks.attachCaseWithin(db,{taskId:command.taskId,caseId:root.caseId,requesterId:actor.subjectId});
      const fact=await this.submitV2Within(db,actor,command.initialFact,authorization);
      const receipt={caseId:root.caseId,taskId:command.taskId,caseVersion:fact.caseVersion,
        taskVersion:linkedTask.version,taskCaseLinkVersion:1,synthetic:root.synthetic,failedAttemptsCreated:0,initialFact:fact.objectRef};
      await records.insertTaskLink({taskId:command.taskId,caseId:root.caseId,operationId:command.operationId,
        subjectId:actor.subjectId,hash,receipt});
      return receipt;
    });
  }

  async getV2(actor,caseId,{taskId=null}={}){
    rule(z.uuid().safeParse(caseId).success,'not_found',404);
    return this.access.runAuthorized(actor,'case-teaser',db=>this.readV2Within(db,actor,caseId,{taskId}));
  }

  async readV2Within(db,actor,caseId,{taskId=null}={}){
      rule(z.uuid().safeParse(caseId).success,'not_found',404);
      const records=caseRepository(db);
      let task=null;if(taskId){rule(this.tasks,'task_service_unavailable',503);task=await this.tasks.requireTaskWithin(db,actor,taskId,{write:false});}
      const parent=await records.lockAnyForRead(caseId);
      rule(parent&&(parent.subject_id===actor.subjectId||task?.caseId===caseId),'not_found',404);
      rule(parent.state!=='withdrawn','case_withdrawn');
      const rows=await records.events(caseId);
      return (await this.projectAuthorizedWithin(db,actor,parent,rows)).view;
  }

  // Internal same-transaction reader for History. Callers decide their own
  // entry authorization; every returned row still passes its exact source grant.
  async projectAuthorizedWithin(db,actor,parent,rows){
      actor=actor??{subjectId:null};
      const caseId=parent.id,visible=[];
      rule(rows.length<=1000,'case_event_limit',413);
      for(const row of rows){try{await this.requireEventVisibleWithin(db,actor,row);visible.push(row);}
        catch(error){if(!(error instanceof ServiceError)||!['consent_required','origin_not_authorized','case_event_unavailable'].includes(error.code))throw error;}}
      // Dependencies must also be visible; otherwise an authorized result could
      // disclose data derived from a revoked origin or private selected message.
      const all=projectCaseFacts(rows.filter(row=>row.payload_text),parent),safe=[],unavailableReasons=new Set();
      for(const row of visible){
        const available=projectCaseFacts(safe,parent);
        const e=row.payload,refs=[...(e.sourceRefs??[]),...(e.deliverableRefs??[])];
        if(e.origin)refs.push(e.origin);
        if(e.attemptRef)refs.push({kind:'attempt',...e.attemptRef});
        if(e.interventionRef)refs.push({kind:'intervention',...e.interventionRef});
        if(e.kind==='intervention')for(const id of e.affectsAttemptIds){
          const prior=projectCaseFacts(rows.filter(candidate=>candidate.version<row.version),parent),a=latestFact(prior,'attempt',id);
          // A removed source cannot turn a previously dependent intervention
          // into an independent fact. Version zero deliberately fails lookup.
          refs.push({kind:'attempt',id,version:a?.version??0});
        }
        if(e.kind==='resolution-recorded')for(const ref of e.resultRefs)refs.push({kind:'result',...ref});
        try{
          for(const ref of refs)await this.requireSourceWithin(db,actor,rows,available,ref);
          if(e.kind==='resolution-recorded')for(const ref of e.verificationRefs){
            rule(this.verifications?.requireReferenceWithin,'verification_access_unavailable',503);
            await this.verifications.requireReferenceWithin(db,actor,ref,{caseId,scopeVersion:e.taskScopeVersion});}
          safe.push(row);
        }catch(error){if(!(error instanceof ServiceError))throw error;unavailableReasons.add(error.code);}
      }
      const facts=publicFactView(projectCaseFacts(safe,parent));
      // Conditions are optional comparison metadata. Losing this permission
      // cannot erase otherwise independent Attempt/Result facts. Explicit
      // sourceRefs/deliverableRefs above remain real content dependencies.
      for(const attempt of facts.attempts??[]) attempt.configurationCondition = this.configurations
        ? await this.configurations.conditionWithin(db,actor,attempt.configurationRef)
        : {reference:attempt.configurationRef??null,sourceStatus:'unavailable',record:null,conditionsKnown:false};
      const view={...facts,synthetic:all.synthetic,legacyState:parent.state,coverage:{mode:'authorized-events',visibleEvents:safe.length,
        complete:safe.length===rows.length,unavailableReasons:[...unavailableReasons]},events:safe.map(row=>({caseVersion:row.version,...row.payload}))};
      return {view,rows:safe,unavailableReasons:[...unavailableReasons]};
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
