import {caseRepository} from "../infrastructure/case-repository.mjs";
import * as z from "zod/v4";
import {ServiceError} from "../shared/service-error.mjs";
import {projectCaseReviews} from "../domain/case-review.mjs";
import {projectCaseFacts,factAt,latestFact,publicFactView,currentResolutionView} from "../domain/intervention.mjs";
import {caseEventReceiptSchema,caseTaskLinkReceiptSchema} from "../shared/cases-schema.mjs";
import {rule} from './helpers.mjs';
import {CaseAuthority} from './authority.mjs';

// Unchanged legacy/v2 authorized projections and exact caller receipts. Withheld changes never revive earlier facts or current support.
export class CaseReadModel extends CaseAuthority{

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

  factReceipt(event,version){
    const objectId=event.supersedes?.id??event.attemptRef?.id??event.eventId;
    const objectVersion=(event.supersedes?.version??event.attemptRef?.version??0)+1;
    return {caseId:event.caseId,eventId:event.eventId,version,caseVersion:version,objectRef:{id:objectId,version:objectVersion},
      claimAuthority:'participant-reported',verification:'not-provided',acceptance:'not-provided',resolution:'separate'};
  }

  // A receipt proves acceptance of the caller's exact operation only. It does
  // not read the Case projection, revive Consent, or expose retained fact text.
  receipt(actor,input){
    const parsed=caseEventReceiptSchema.safeParse(input);
    rule(parsed.success,'invalid_case_receipt',400);
    const query=parsed.data;
    return this.access.runAuthorized(actor,'case-teaser',async db=>{
      const row=await caseRepository(db).eventReceipt(query.eventId,actor.subjectId);
      const state=!row?'absent':row.case_id!==query.caseId||row.payload_hash!==query.payloadHash?'conflict':'acknowledged';
      return {...query,state,checkedAt:new Date(this.access.now()*1000).toISOString(),authority:'accepted-operation-only',currentAccessGranted:false,
        ...(state==='acknowledged'?{caseVersion:row.version,verification:'not-provided',acceptance:'not-provided',resolution:'separate'}:{})};
    });
  }

  taskLinkReceipt(actor,input){
    const parsed=caseTaskLinkReceiptSchema.safeParse(input);
    rule(parsed.success,'invalid_case_receipt',400);
    const query=parsed.data;
    return this.access.runAuthorized(actor,'case-teaser',async db=>{
      const row=await caseRepository(db).operationReceipt(query.operationId,actor.subjectId);
      const state=!row?'absent':row.task_id!==query.taskId||row.payload_hash!==query.payloadHash?'conflict':'acknowledged';
      const prior=state==='acknowledged'?row.receipt:null;
      return {...query,state,checkedAt:new Date(this.access.now()*1000).toISOString(),authority:'accepted-operation-only',currentAccessGranted:false,
        ...(prior?{caseId:row.case_id,caseVersion:prior.caseVersion,taskVersion:prior.taskVersion,taskCaseLinkVersion:prior.taskCaseLinkVersion}:{})};
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
      const projected=projectCaseFacts(safe,parent);
      // Select current opinions from the whole original sequence before applying
      // read permission. A newer private/revoked reply cannot revive an older one.
      const latestResponses=new Map(),erasedResponseVersions=new Map(),safeIds=new Set(safe.map(row=>row.id));
      const responseKey=(ref,subjectId)=>`${ref.id}:${ref.version}:${subjectId}`;
      for(const row of rows.filter(row=>row.kind==='intervention-response').sort((a,b)=>a.version-b.version)){
        if(!row.payload_text){
          erasedResponseVersions.set(row.subject_id,row.version);
          continue;
        }
        latestResponses.set(responseKey(row.payload.interventionRef,row.subject_id),row);
      }
      for(const intervention of projected.interventions){
        const currentIds=new Set();let complete=true;
        for(const row of latestResponses.values()){
          const ref=row.payload.interventionRef;
          if(ref.id!==intervention.id||ref.version!==intervention.version)continue;
          // A retained reply without its body cannot identify its target. It
          // makes only this author's earlier opinions uncertain, never a new
          // inferred answer. A later explicit readable reply can restore them.
          if(safeIds.has(row.id)&&row.version>(erasedResponseVersions.get(row.subject_id)??0))currentIds.add(row.id);
          else complete=false;
        }
        for(const [subjectId,version] of erasedResponseVersions){
          if(version<=intervention.caseVersion)continue;
          const later=latestResponses.get(responseKey(intervention,subjectId));
          if(!later||later.version<=version||!safeIds.has(later.id))complete=false;
        }
        intervention.responses=intervention.responses.filter(response=>currentIds.has(response.id));
        const others=intervention.responses.filter(response=>response.relationship!=='self');
        intervention.confirmation=others.some(response=>response.state==='disputed')?'disputed':others.some(response=>response.state==='partial')
          ?'partially-confirmed':others.some(response=>response.state==='accepted')?'confirmed':'unconfirmed';
        intervention.responseCoverage={mode:'currently-authorized-latest-per-actor',complete};
        if(!complete)unavailableReasons.add('intervention_response_currentness_unavailable');
      }
      // A hidden or withdrawn correction cannot restore an older Result as
      // current support. The view reveals no private correction ID or version.
      projected.resolution=currentResolutionView(projected,all);
      const decision=projected.resolution;
      if(decision.status!=='unrecorded'&&decision.resultRefs.some(ref=>{
        const result=factAt(all,'result',ref);
        // An erased newer result body no longer identifies what it corrected.
        // Its original author/kind/sequence can only make support uncertain;
        // they cannot establish a replacement version or revive old support.
        return result&&rows.some(row=>row.kind==='result-recorded'&&!row.payload_text
          &&row.subject_id===result.actorId&&row.version>decision.caseVersion);
      }))projected.resolution={status:'unrecorded',scopeVersion:projected.scopeVersion,priorResolutionId:decision.id,
        currentSupport:'referenced-result-currentness-unavailable',currentDecisionAvailable:false,reconfirmationRequired:true,
        summary:'结果当前版本资料不完整，当前解决程度需要重新确认。'};
      const facts=publicFactView(projected);
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
}
