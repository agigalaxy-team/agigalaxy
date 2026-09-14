import * as z from 'zod/v4';
import { moderationReportSchema,moderationEventSchema,moderatorIdsSchema } from './shared/moderation-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import { readModerationCaseTarget } from './domain/moderation-case-target.mjs';
import { currentVerificationJob } from './domain/verification-current.mjs';
import { randomUUID } from 'node:crypto';
import { projectModerationVerifiers,moderationParties,verifierEventKinds,verifierTransition } from './domain/moderation-verifier.mjs';
function parse(payloadJson,schema){try{if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>16000)throw new Error();return schema.parse(JSON.parse(payloadJson));}catch{throw new ServiceError('invalid_moderation_payload');}}
export class ModerationService {
  constructor(access,consents,assistance,moderatorIds=[],evidence=null){Object.assign(this,{access,consents,assistance,evidence});this.moderatorIds=moderatorIdsSchema.parse(moderatorIds);}
  isModerator(id){return this.moderatorIds.includes(id);}
  config(actor){return this.access.runAuthorized(actor,'moderation',async()=>({moderatorIds:[...this.moderatorIds],canModerate:this.isModerator(actor.subjectId),reportTargets:['assistance','case'],evidenceRevalidation:Boolean(this.evidence),verifierParticipation:1,guaranteesResolution:false}));}
  async loadReport(db,id,write=false){
    const row=(await db.query(`SELECT * FROM moderation_reports WHERE id=$1${write?' FOR UPDATE':''}`,[id])).rows[0];
    if(!row)return null;
    const recorded=(await db.query('SELECT * FROM moderation_events WHERE report_id=$1 ORDER BY version LIMIT 100',[id])).rows;
    return {...row,recorded,verifiers:projectModerationVerifiers(recorded)};
  }
  independentModerator(actor,row){return this.isModerator(actor.subjectId)&&!moderationParties(row).includes(actor.subjectId)&&!row.verifiers.some(v=>v.subjectId===actor.subjectId);}
  async liveVerifierInvitation(db,row,actorId,invitationId){
    const invitation=row.recorded.find(event=>event.id===invitationId);
    if(!invitation)throw new ServiceError('verifier_invitation_required',403);
    const grant=await this.grant(db,invitation.subject_id,invitation.consent_id,invitation.id,invitation.payload_text);
    if(!canReadProjection(grant,{viewerId:actorId,now:this.access.now()}))throw new ServiceError('verifier_invitation_unavailable',403);
    return JSON.parse(invitation.payload_text);
  }
  async verifierSource(db,row,actorId){
    const report=JSON.parse(row.payload_text);
    if(row.case_id){
      await readModerationCaseTarget(db,{caseId:row.case_id,viewerId:actorId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now()});
      if(report.evidenceId)await this.evidenceTarget(db,actorId,row.case_id,report.targetEventId,report.evidenceId);
    }else{
      const {row:source,grants}=await this.assistance.load(db,row.assistance_id);
      if(!this.assistance.visible(grants.get(source.id),actorId))throw new ServiceError('not_found',404);
      for(const event of source.snapshot.events)if(!this.assistance.visible(grants.get(event.event.id),actorId))throw new ServiceError('not_found',404);
    }
  }
  async evidenceTarget(db,actorId,caseId,targetEventId,evidenceId){
    if(!this.evidence)throw new ServiceError('evidence_revalidation_unavailable',409);
    const source=(await db.query('SELECT * FROM evidence_submissions WHERE id=$1 AND case_id=$2 AND result_id=$3',[evidenceId,caseId,targetEventId])).rows[0];
    if(!source)throw new ServiceError('not_found',404);
    await this.evidence.live(db,source);
    const grant=await this.consents.require(db,{id:source.consent_id,subjectId:source.subject_id,action:'evidence.submit',objectId:source.id,recipient:this.access.endpoint,payloadJson:source.payload_text});
    if(!canReadProjection(grant,{viewerId:actorId,projection:'proof',now:this.access.now()}))throw new ServiceError('not_found',404);
    return source;
  }
  async grant(db,actorId,consentId,id,payloadJson){return this.consents.require(db,{id:consentId,subjectId:actorId,objectId:id,action:'moderation.publish',recipient:this.access.endpoint,payloadJson});}
  checkRecipients(grant,actorId,recipients){const expected=[...new Set(recipients)].filter(id=>id!==actorId).sort((a,b)=>a.localeCompare(b));
    if(!expected.length||grant.visibility!=='Private'||JSON.stringify([...grant.viewers].sort((a,b)=>a.localeCompare(b)))!==JSON.stringify(expected))throw new ServiceError('moderation_recipient_mismatch',403);}
  async report(actor,{consentId,payloadJson}){
    const payload=parse(payloadJson,moderationReportSchema);
    return this.access.runResourceWrite(actor,'moderation',{},async(db,authorization)=>{
      if(!this.moderatorIds.length)throw new ServiceError('moderation_not_configured',409);
      let targetId,participants;
      if(payload.caseId){
        const source=await readModerationCaseTarget(db,{caseId:payload.caseId,viewerId:actor.subjectId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now(),write:true});
        targetId=source.parent.id;participants=[source.parent.subject_id];
        if(!source.rows.some(row=>row.id===payload.targetEventId&&row.version<=payload.caseVersion))throw new ServiceError('moderation_case_event_mismatch',409);
        // An exact replay is allowed after a later source revision; a new report must use the current visible source.
        const replay=(await db.query('SELECT * FROM moderation_reports WHERE id=$1',[payload.id])).rows[0];
        if(!replay&&source.parent.version!==payload.caseVersion)throw new ServiceError('moderation_case_version_conflict',409);
        if(payload.evidenceId)await this.evidenceTarget(db,actor.subjectId,payload.caseId,payload.targetEventId,payload.evidenceId);
      }else{
        const {row,grants}=await this.assistance.load(db,payload.assistanceId);
        if(!this.assistance.visible(grants.get(row.id),actor.subjectId))throw new ServiceError('not_found',404);
        targetId=row.id;participants=[row.requester_id,...(row.snapshot.selected?[row.snapshot.selected.providerId]:[])];
      }
      const grant=await this.grant(db,actor.subjectId,consentId,payload.id,payloadJson);this.checkRecipients(grant,actor.subjectId,this.moderatorIds);
      const prior=(await db.query('SELECT * FROM moderation_reports WHERE id=$1',[payload.id])).rows[0];
      if(prior){if(prior.reporter_id!==actor.subjectId||prior.consent_id!==consentId||prior.payload_hash!==digest(payloadJson))throw new ServiceError('moderation_conflict',409);return {reportId:payload.id,eventId:payload.id,version:1};}
      const count=Number((await db.query(`SELECT count(*) FROM moderation_reports WHERE ${payload.caseId?'case_id':'assistance_id'}=$1 AND reporter_id=$2`,[targetId,actor.subjectId])).rows[0].count);
      if(count>=3)throw new ServiceError('moderation_report_limit',429);
      await db.query('INSERT INTO moderation_reports(id,assistance_id,reporter_id,participant_ids,consent_id,payload_text,payload_hash,case_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[payload.id,payload.assistanceId??null,actor.subjectId,JSON.stringify(participants),consentId,payloadJson,digest(payloadJson),payload.caseId??null]);
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:payload.id,action:'moderation.report',httpRequestId:actor.httpRequestId??null,...authorization});
      return {reportId:payload.id,eventId:payload.id,version:1};
    });
  }
  allowed(actor,row){return this.isModerator(actor.subjectId)||moderationParties(row).includes(actor.subjectId)||(row.verifiers??[]).some(v=>v.subjectId===actor.subjectId);}
  async event(actor,id,{consentId,payloadJson}){
    const payload=parse(payloadJson,moderationEventSchema);if(payload.reportId!==id)throw new ServiceError('moderation_target_mismatch');
    return this.access.runResourceWrite(actor,'moderation',{control:true},async(db,authorization)=>{
      const found=await this.loadReport(db,id);if(!found||!this.allowed(actor,found))throw new ServiceError('not_found',404);
      if(found.case_id)await db.query('SELECT id FROM cases WHERE id=$1 FOR UPDATE',[found.case_id]);
      else await db.query('SELECT id FROM assistance_requests WHERE id=$1 FOR UPDATE',[found.assistance_id]);
      const row=await this.loadReport(db,id,true),parties=moderationParties(row);
      const grant=await this.grant(db,actor.subjectId,consentId,payload.id,payloadJson);
      // Exact retries retain the recipients and authority of the original event,
      // even after later invitations or withdrawal change current participation.
      const previous=(await db.query('SELECT * FROM moderation_events WHERE id=$1',[payload.id])).rows[0];
      if(previous){if(previous.report_id!==id||previous.subject_id!==actor.subjectId||previous.consent_id!==consentId||previous.payload_hash!==digest(payloadJson))throw new ServiceError('moderation_conflict',409);return {reportId:id,eventId:payload.id,version:previous.version};}
      const isAppeal=payload.kind==='appeal',isStatement=['supplement','correct'].includes(payload.kind),isVerifier=verifierEventKinds.has(payload.kind);
      const isParty=parties.includes(actor.subjectId),independent=this.independentModerator(actor,row);
      if(isVerifier){
        verifierTransition(row,actor.subjectId,payload,this.access.now(),independent);
        if(payload.kind==='invite-verifier'){
          const reported=await this.grant(db,row.reporter_id,row.consent_id,row.id,row.payload_text);
          if(!canReadProjection(reported,{viewerId:actor.subjectId,now:this.access.now()}))throw new ServiceError('not_found',404);
          if(payload.expiresAt>grant.expiresAt)throw new ServiceError('verifier_invitation_expiry',409);
          await this.verifierSource(db,row,actor.subjectId);
        }
        if(['accept-verifier','verification-response'].includes(payload.kind))await this.liveVerifierInvitation(db,row,actor.subjectId,payload.invitationId);
        if(payload.kind==='verification-response')await this.verifierSource(db,row,actor.subjectId);
      }else if(isAppeal?!isParty:isStatement?!(isParty||independent||payload.kind==='correct'&&row.verifiers.some(v=>v.subjectId===actor.subjectId)):!independent)throw new ServiceError('moderation_role_denied',403);
      if(payload.kind==='correct'){
        const original=payload.correctsEventId===id?{subject_id:row.reporter_id}:
          (await db.query('SELECT subject_id FROM moderation_events WHERE id=$1 AND report_id=$2',[payload.correctsEventId,id])).rows[0];
        if(!original||original.subject_id!==actor.subjectId)throw new ServiceError('moderation_correction_denied',403);
      }
      this.checkRecipients(grant,actor.subjectId,isAppeal||isStatement&&isParty?this.moderatorIds:
        [...this.moderatorIds,...parties,...(payload.kind==='invite-verifier'?[payload.verifierId]:[])]);
      if(row.version!==payload.expectedVersion)throw new ServiceError('moderation_version_conflict',409);
      let verificationJob=null;
      if(payload.kind==='revalidate'){
        const report=JSON.parse(row.payload_text);
        if(!row.case_id||report.evidenceId!==payload.evidenceId)throw new ServiceError('moderation_evidence_target_mismatch',409);
        await readModerationCaseTarget(db,{caseId:row.case_id,viewerId:actor.subjectId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now()});
        await this.evidenceTarget(db,actor.subjectId,row.case_id,report.targetEventId,payload.evidenceId);
        const latest=await currentVerificationJob(db,payload.evidenceId,this.evidence.source.jobKind);
        if(latest&&['pending','running'].includes(latest.state))throw new ServiceError('verification_already_pending',409);
        const generation=(latest?.payload.revalidation?.generation??0)+1;
        if(generation>20)throw new ServiceError('verification_revalidation_limit',429);
        verificationJob={id:randomUUID(),kind:this.evidence.source.jobKind,payload:{evidenceId:payload.evidenceId,
          revalidation:{generation,eventId:payload.id,reportId:id,consentId,subjectId:actor.subjectId}}};
      }
      let state=row.state,paused=row.paused,appeals=row.appeal_count;
      if(payload.kind==='pause'){if(paused)throw new ServiceError('moderation_transition_denied',409);paused=true;}
      if(payload.kind==='resume'){if(!paused)throw new ServiceError('moderation_transition_denied',409);paused=false;}
      if(payload.kind==='resolve'){if(state==='resolved')throw new ServiceError('moderation_transition_denied',409);state='resolved';}
      if(isAppeal){if(state!=='resolved'||appeals>=3)throw new ServiceError('moderation_transition_denied',409);state='appealed';appeals++;}
      const version=row.version+1;if(version>100)throw new ServiceError('moderation_event_limit',413);
      await db.query('INSERT INTO moderation_events(id,report_id,subject_id,consent_id,version,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[payload.id,id,actor.subjectId,consentId,version,payloadJson,digest(payloadJson)]);
      if(verificationJob)await db.query('INSERT INTO jobs(id,kind,deduplication_key,payload) VALUES($1,$2,$3,$4)',[verificationJob.id,verificationJob.kind,`revalidate:${payload.id}`,JSON.stringify(verificationJob.payload)]);
      await db.query('UPDATE moderation_reports SET version=$2,state=$3,paused=$4,appeal_count=$5 WHERE id=$1',[id,version,state,paused,appeals]);
      await recordObjectAudit(db,{subjectId:actor.subjectId,objectId:payload.id,action:'moderation.event',httpRequestId:actor.httpRequestId??null,...authorization});
      return {reportId:id,eventId:payload.id,version};
    });
  }
  async readWithin(db,actor,id){
    const row=await this.loadReport(db,id);if(!row||!this.allowed(actor,row))throw new ServiceError('not_found',404);
    const visible=async(subjectId,consentId,eventId,payloadJson)=>{try{const grant=await this.grant(db,subjectId,consentId,eventId,payloadJson);return canReadProjection(grant,{viewerId:actor.subjectId,now:this.access.now()});}catch(error){if(!(error instanceof ServiceError))throw error;return false;}};
    const canRead=await visible(row.reporter_id,row.consent_id,id,row.payload_text),events=[];
    const recorded=row.recorded,own=row.verifiers.find(v=>v.subjectId===actor.subjectId),independent=this.independentModerator(actor,row),parties=moderationParties(row);
    for(const event of recorded)
      if(await visible(event.subject_id,event.consent_id,event.id,event.payload_text)){
        const payload=JSON.parse(event.payload_text);
        events.push({actorId:event.subject_id,version:event.version,...payload,
          ...(payload.kind==='verification-response'?{authority:'participant-signed-review',independenceVerified:false,capabilityVerified:false}: {})});
      }
    const invitation=own?events.find(event=>event.id===own.invitationId):null;
    let verifierSourceAvailable=false;
    if(own&&invitation){try{await this.verifierSource(db,row,actor.subjectId);verifierSourceAvailable=true;}catch(error){if(!(error instanceof ServiceError))throw error;}}
    const target=row.case_id?{caseId:row.case_id}: {assistanceId:row.assistance_id};
    let revalidation=null;
    const reportPayload=JSON.parse(row.payload_text);
    if(row.case_id&&reportPayload.evidenceId&&this.evidence&&canRead){
      try{
        await this.evidenceTarget(db,actor.subjectId,row.case_id,reportPayload.targetEventId,reportPayload.evidenceId);
        const latest=await currentVerificationJob(db,reportPayload.evidenceId,this.evidence.source.jobKind);
        const observation=(await db.query('SELECT id,job_id,observation FROM verification_attempts WHERE evidence_id=$1 ORDER BY ordinal DESC LIMIT 1',[reportPayload.evidenceId])).rows[0];
        revalidation={evidenceId:reportPayload.evidenceId,generation:latest?.payload.revalidation?.generation??0,
          state:latest?.state??'unavailable',observation:observation?.job_id===latest?.id?{id:observation.id,...observation.observation}:null};
      }catch(error){if(!(error instanceof ServiceError))throw error;}
    }
    let source=null;
    if(row.case_id&&(canRead||invitation)){
      try{
        const current=await readModerationCaseTarget(db,{caseId:row.case_id,viewerId:actor.subjectId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now()});
        const reported=JSON.parse(row.payload_text);
        source={caseId:row.case_id,reportedVersion:reported.caseVersion,currentVersion:current.parent.version,targetEventId:reported.targetEventId,
          targetEvent:current.rows.find(event=>event.id===reported.targetEventId)?.payload??null};
      }catch(error){if(!(error instanceof ServiceError))throw error;}
    }
    return {reportId:id,...target,version:row.version,state:row.state,paused:row.paused,
      ...(row.case_id?{source,revalidation,canRevalidate:Boolean(source&&revalidation&&independent),authority:'moderation-process',automaticallyVerified:false,
        pauseEffect:'hold-linked-collaboration-and-its-derived-eligibility; source-events-and-signed-CI-facts-unchanged'}:{}),
      report:canRead?JSON.parse(row.payload_text):null,events,
      ...(this.isModerator(actor.subjectId)||own?{reporterId:row.reporter_id,participantIds:parties.filter(id=>id!==row.reporter_id)}:{}),
      verifierParticipation:{version:1,own:own?{...own,scope:invitation?.scope??null,target:invitation?.target??null}:null,
        ...(this.isModerator(actor.subjectId)?{assignments:row.verifiers}:{}),sourceAvailable:verifierSourceAvailable,
        authority:'participant-signed-review',independenceVerified:false,capabilityVerified:false},
      canInviteVerifier:independent&&canRead,
      canAcceptVerifier:Boolean(invitation&&own.status==='invited'&&own.expiresAt>this.access.now()),
      canDeclineVerifier:own?.status==='invited',canWithdrawVerifier:own?.status==='accepted',
      canSubmitVerification:Boolean(invitation&&own.status==='accepted'&&verifierSourceAvailable),
      canAppeal:parties.includes(actor.subjectId),
      canSupplement:parties.includes(actor.subjectId)||independent,canCorrectEventIds:[...(actor.subjectId===row.reporter_id?[id]:[]),...recorded.filter(event=>event.subject_id===actor.subjectId).map(event=>event.id)],
      canModerate:independent};
  }
  get(actor,id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.access.runAuthorized(actor,'moderation',db=>this.readWithin(db,actor,id));}
  async caseContextWithin(db,actor,caseId){
    const context={version:1,authority:'viewer-authorized-moderation',automaticallyVerified:false,items:[],coverage:'up-to-20-visible-reports; latest-10-visible-events-per-report'};
    if(!actor)return context;
    try{await readModerationCaseTarget(db,{caseId,viewerId:actor.subjectId,consents:this.consents,endpoint:this.access.endpoint,now:this.access.now()});}
    catch(error){if(error instanceof ServiceError)return context;throw error;}
    const rows=(await db.query(`SELECT id FROM moderation_reports r WHERE case_id=$1 AND ($2 OR reporter_id=$3 OR participant_ids ? $3 OR EXISTS
      (SELECT 1 FROM moderation_events e WHERE e.report_id=r.id AND e.payload_text::jsonb->>'kind'='invite-verifier' AND e.payload_text::jsonb->>'verifierId'=$3)) ORDER BY id LIMIT 20`,[caseId,this.isModerator(actor.subjectId),actor.subjectId])).rows;
    for(const row of rows){
      const record=await this.readWithin(db,actor,row.id);
      context.items.push({reportId:record.reportId,version:record.version,state:record.state,paused:record.paused,
        report:record.report,events:record.events.slice(-10),revalidation:record.revalidation??null,
        source:record.source?{reportedVersion:record.source.reportedVersion,currentVersion:record.source.currentVersion,targetEventId:record.source.targetEventId}:null});
    }
    return context;
  }
  query(actor,input={}){
    const parsed=z.strictObject({assistanceId:z.uuid().optional(),caseId:z.uuid().optional(),after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)})
      .refine(value=>!(value.assistanceId&&value.caseId)).safeParse(input);
    if(!parsed.success)throw new ServiceError('invalid_moderation_query');const query=parsed.data;
    return this.access.runAuthorized(actor,'moderation',async db=>{
      const rows=(await db.query(`SELECT id,assistance_id,case_id,version,state,paused FROM moderation_reports r WHERE ($1::uuid IS NULL OR assistance_id=$1) AND ($2::uuid IS NULL OR id>$2)
        AND ($3 OR reporter_id=$4 OR participant_ids ? $4 OR EXISTS (SELECT 1 FROM moderation_events e WHERE e.report_id=r.id
          AND e.payload_text::jsonb->>'kind'='invite-verifier' AND e.payload_text::jsonb->>'verifierId'=$4))
        AND ($6::uuid IS NULL OR case_id=$6) ORDER BY id LIMIT $5`,[query.assistanceId??null,query.after??null,this.isModerator(actor.subjectId),actor.subjectId,query.limit+1,query.caseId??null])).rows;
      return {items:rows.slice(0,query.limit).map(row=>({reportId:row.id,...(row.case_id?{caseId:row.case_id}:{assistanceId:row.assistance_id}),version:row.version,state:row.state,paused:row.paused})),nextAfter:rows.length>query.limit?rows[query.limit-1].id:null};
    });
  }
}
