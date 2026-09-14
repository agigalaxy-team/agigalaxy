import * as z from 'zod/v4';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { moderatorIdsSchema } from './shared/moderation-schema.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { targetReportSchemaV2, targetModerationSchemaV2, targetGovernanceReceiptSchemaV2, targetGovernanceQuerySchemaV2 } from './shared/target-governance-v2-schema.mjs';
import { targetRestrictionsWithin } from './target-governance-restrictions-v2.mjs';

const day = 86400, stamp = n => new Date(n * 1000), missing = e => e instanceof ServiceError && [403,404,410].includes(e.status);
const fail = (code, status = 409) => { throw new ServiceError(code, status); };
const parse = (schema, input) => { const r = schema.safeParse(input); if (!r.success) fail('invalid_target_governance',400); return r.data; };
const unique = xs => [...new Set(xs)];
export class TargetGovernanceServiceV2 {
  constructor(access, consents, { tasks, chat, accounts = null, moderatorIds = [] }) {
    Object.assign(this, { access, consents, tasks, chat, accounts });
    this.moderatorIds = moderatorIdsSchema.parse(moderatorIds);
  }
  config(actor) { return this.access.runAuthorized(actor,'moderation',async () => ({
    moderatorIds: [...this.moderatorIds], configured: this.moderatorIds.length > 0,
    roleConfigured: this.moderatorIds.includes(actor.subjectId), guaranteesResponse: false,
    reportTargets: ['task','room'], independentHandlerCheckedPerCase: true, automaticAccountRestriction: false,
  })); }
  grant(db, row) { return this.consents.require(db,{ id: row.consent_id, subjectId: row.subject_id, objectId: row.id,
    payloadJson: row.payload_text, action: 'moderation.publish', recipient: this.access.endpoint }); }
  async source(db, actor, target, { authorize = false, lock = false } = {}) {
    if (target.type === 'task') {
      let row;
      if (authorize) row = (await this.tasks.requireTaskWithin(db, actor, target.id, { write: lock, governanceBypass: true })).row;
      else row = (await db.query(`SELECT * FROM task_requests WHERE id=$1${lock?' FOR UPDATE':''}`, [target.id])).rows[0];
      if (!row) fail('target_unavailable',404);
      const parties = (await db.query("SELECT subject_id FROM task_participations WHERE task_id=$1 AND snapshot->>'confirmedAt' IS NOT NULL UNION SELECT subject_id FROM task_events WHERE task_id=$1",[row.id])).rows.map(x=>x.subject_id);
      const root = await this.tasks.taskRepository.event(db,row.root_event_id);
      let sourceAvailable = !row.snapshot.contentDeleted;
      if (sourceAvailable) try { await this.tasks.taskGrant(db,root); } catch(e) { if(!missing(e))throw e;sourceAvailable=false; }
      if(row.case_id){const c=(await db.query('SELECT state FROM cases WHERE id=$1 AND subject_id=$2',[row.case_id,row.requester_id])).rows[0];if(!c||c.state==='withdrawn')sourceAvailable=false;}
      return { target:{type:'task',id:row.id,version:row.version,rootEventId:row.root_event_id}, parties:unique([row.requester_id,...parties]),
        sourceAvailable, state:row.snapshot.state, contentAccess: 'requires-separate-current-task-permission' };
    }
    let row;
    if(authorize)row=(await this.chat.requireRoom(db,actor,target.id,{write:lock})).room;
    else row=(await db.query(`SELECT * FROM chat_rooms WHERE room_id=$1${lock?' FOR UPDATE':''}`,[target.id])).rows[0];
    if(!row)fail('target_unavailable',404);
    const parties=(await db.query('SELECT subject_id FROM chat_memberships WHERE room_id=$1 AND left_at IS NULL',[row.room_id])).rows.map(x=>x.subject_id);
    return {target:{type:'room',id:row.room_id,version:row.revision},parties,sourceAvailable:row.state!=='archived',state:row.state,
      contentAccess:'report-does-not-grant-room-history-or-membership'};
  }
  target(row) {return {type:row.target_type,id:row.task_id??row.room_id,version:row.target_version,
    ...(row.target_type==='task'?{rootEventId:row.root_event_id}:{})};}
  async load(db,id,lock=false){return(await db.query(`SELECT * FROM target_reports_v2 WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];}
  async parties(db,row) {
    let current=[];try{current=(await this.source(db,null,this.target(row))).parties;}catch(e){if(!missing(e))throw e;}
    return unique([row.subject_id,...row.party_ids,...current]);
  }
  async independent(db,actor,parties){
    if(!this.moderatorIds.includes(actor.subjectId)||parties.includes(actor.subjectId))return false;
    if(this.accounts){let account;try{account=await this.accounts.resolveWithin(db,actor);}catch(e){if(e.code!=='account_verification_required')throw e;}
      if(account&&(await db.query('SELECT 1 FROM community_account_links WHERE account_id=$1 AND subject_id=ANY($2::text[]) LIMIT 1',[account.id,parties])).rows.length)return false;
    }
    return true;
  }
  async readableEvents(db,actor,row){
    if(row.closed_at&&new Date(row.closed_at).getTime()/1000<=this.access.now()-180*day)return[];
    const items=[];for(const event of(await db.query('SELECT * FROM target_governance_events_v2 WHERE report_id=$1 ORDER BY version',[row.id])).rows){
      if(!event.payload_text||event.erased_at)continue;
      try{const g=await this.grant(db,event);if(canReadProjection(g,{viewerId:actor.subjectId,now:this.access.now()}))items.push({
        eventId:event.id,authorId:event.subject_id,at:new Date(event.created_at).toISOString(),version:event.version,...JSON.parse(event.payload_text)});
      }catch(e){if(!missing(e))throw e;}
    }return items;
  }
  async visible(db,actor,row){if(!row)fail('not_found',404);const parties=await this.parties(db,row),events=await this.readableEvents(db,actor,row);
    const ownHistory=(await db.query('SELECT 1 FROM target_governance_events_v2 WHERE report_id=$1 AND subject_id=$2 LIMIT 1',[row.id,actor.subjectId])).rows.length>0;
    if(!parties.includes(actor.subjectId)&&!events.length&&!ownHistory)fail('not_found',404);return{parties,events};}
  async receiptWithin(db,actor,input){const e=(await db.query('SELECT id,report_id,subject_id,version,payload_hash FROM target_governance_events_v2 WHERE id=$1',[input.eventId])).rows[0];
    if(e&&e.subject_id!==actor.subjectId)fail('not_found',404);
    return{eventId:input.eventId,state:!e?'absent':e.payload_hash===input.payloadHash?'acknowledged':'conflict',...(e?{reportId:e.report_id,version:e.version}:{}),
      checkedAt:this.access.now(),authority:'accepted-event-only; not-current-restriction-or-permission'};}
  receipt(actor,input){const x=parse(targetGovernanceReceiptSchemaV2,input);return this.access.runAuthorized(actor,'moderation',db=>this.receiptWithin(db,actor,x));}
  async replay(db,actor,id,consentId,payloadJson){const e=(await db.query('SELECT * FROM target_governance_events_v2 WHERE id=$1',[id])).rows[0];if(!e)return null;
    if(e.subject_id!==actor.subjectId||e.consent_id!==consentId||e.payload_hash!==digest(payloadJson))fail('target_governance_conflict');
    return this.receiptWithin(db,actor,{eventId:id,payloadHash:digest(payloadJson)});}
  privateAudience(g,actor,allowed,required=[]){if(g.visibility!=='Private'||g.viewers.some(x=>x!==actor.subjectId&&!allowed.includes(x))||required.some(x=>x!==actor.subjectId&&!g.viewers.includes(x)))fail('target_governance_audience_mismatch',403);}
  async save(db,actor,auth,x){
    await db.query(`INSERT INTO target_governance_events_v2(id,report_id,subject_id,version,kind,consent_id,payload_text,payload_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[x.id,x.reportId,actor.subjectId,x.version,x.kind,x.consentId,x.payloadJson,digest(x.payloadJson),stamp(this.access.now())]);
    if(!auth?.credentialScopes?.includes('moderation')||!auth.callerBindingId)throw new Error('Governance audit authorization required');
    const rows=(await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'moderation',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
      FROM target_governance_events_v2 e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
      JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
      WHERE e.id=$2::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1 RETURNING sequence`,
      [actor.subjectId,x.id,'target.moderation.'+x.kind,actor.httpRequestId??null,JSON.stringify(auth.credentialScopes),auth.callerBindingId])).rows;
    if(rows.length!==1)throw new Error('Governance event audit unavailable');
    return this.receiptWithin(db,actor,{eventId:x.id,payloadHash:digest(x.payloadJson)});
  }
  report(actor,{consentId,payloadJson}){
    if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>10000)fail('invalid_target_governance',400);
    let x;try{x=parse(targetReportSchemaV2,JSON.parse(payloadJson));}catch(e){if(e instanceof SyntaxError)fail('invalid_target_governance',400);throw e;}
    return this.access.runResourceWrite(actor,'moderation',{},async(db,auth)=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['target-governance:'+x.id]);const old=await this.replay(db,actor,x.id,consentId,payloadJson);if(old)return old;
      const src=await this.source(db,actor,x.target,{authorize:true,lock:true});
      if(src.target.version!==x.target.version||(x.target.type==='task'&&src.target.rootEventId!==x.target.rootEventId))fail('target_version_changed');
      if(!src.sourceAvailable)fail('target_unavailable',404);
      const g=await this.grant(db,{id:x.id,consent_id:consentId,subject_id:actor.subjectId,payload_text:payloadJson});
      this.privateAudience(g,actor,this.moderatorIds);if(g.currentVisibility?.deletionPending)fail('target_governance_author_unavailable',403);
      const count=(await db.query(`SELECT count(*)::int n FROM target_reports_v2 WHERE subject_id=$1 AND ${x.target.type==='task'?'task_id':'room_id'}=$2 AND closed_at IS NULL`,[actor.subjectId,x.target.id])).rows[0].n;
      if(count>=3)fail('target_report_limit',429);
      await db.query(`INSERT INTO target_reports_v2(id,subject_id,target_type,task_id,room_id,target_version,root_event_id,party_ids,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,[x.id,actor.subjectId,x.target.type,x.target.type==='task'?x.target.id:null,x.target.type==='room'?x.target.id:null,x.target.version,x.target.rootEventId??null,JSON.stringify(unique([actor.subjectId,...src.parties])),stamp(this.access.now())]);
      return this.save(db,actor,auth,{id:x.id,reportId:x.id,version:1,kind:'report',consentId,payloadJson});
    });
  }
  validateRestriction(row,x,maxDays){const allowed=row.target_type==='task'?['discovery-hidden','new-participation-paused']:['sending-paused','invitations-paused'];
    if(x.scopes.some(s=>!allowed.includes(s))||x.until<=this.access.now()||x.until>this.access.now()+maxDays*day)fail('invalid_target_restriction',400);}
  event(actor,{consentId,payloadJson}){
    if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>10000)fail('invalid_target_governance',400);
    let x;try{x=parse(targetModerationSchemaV2,JSON.parse(payloadJson));}catch(e){if(e instanceof SyntaxError)fail('invalid_target_governance',400);throw e;}
    // Existing-case responses cannot be blocked by exhausted public posting or
    // storage quotas. Strict payload and per-case event bounds still apply.
    return this.access.runResourceWrite(actor,'moderation',{control:true},async(db,auth)=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['target-governance:'+x.id]);const old=await this.replay(db,actor,x.id,consentId,payloadJson);if(old)return old;
      const initial=await this.load(db,x.reportId);if(!initial)fail('not_found',404);
      // Match the Task/Chat write lock order before locking the case. No network.
      let src;try{src=await this.source(db,null,this.target(initial),{lock:true});}catch(e){if(!missing(e))throw e;}
      const row=await this.load(db,x.reportId,true),view=await this.visible(db,actor,row);
      if(row.version!==x.expectedVersion)fail('target_governance_version_changed');
      const decision=['review','pause','resume','resolve'].includes(x.kind), independent=await this.independent(db,actor,view.parties);
      if(decision&&!independent)fail('target_independent_handler_required',403);
      if(!decision&&!view.parties.includes(actor.subjectId))fail('target_governance_party_required',403);
      const hasComplaint=view.events.some(e=>['report','supplement','appeal'].includes(e.kind??'report'));
      // Removing this case's own restriction requires the configured independent
      // role and known case access, but does not revive revoked complaint text.
      if(decision&&x.kind!=='resume'&&!hasComplaint)fail('target_report_material_unavailable',403);
      if(['pause','resolve'].includes(x.kind)&&(src?.target.version!==x.targetVersion||!src?.sourceAvailable))fail('target_version_or_source_unavailable');
      const g=await this.grant(db,{id:x.id,consent_id:consentId,subject_id:actor.subjectId,payload_text:payloadJson});
      this.privateAudience(g,actor,unique([...this.moderatorIds,...view.parties]),decision?[row.subject_id]:[]);
      if(g.currentVisibility?.deletionPending)fail('target_governance_author_unavailable',403);
      let state=row.state,closed=row.closed_at,appeals=row.appeal_count,until=row.restriction_until,scopes=row.restriction_scopes,restrictionEvent=row.restriction_event_id,decisionEvent=row.decision_event_id;
      if(row.closed_at&&new Date(row.closed_at).getTime()/1000<=this.access.now()-180*day)fail('target_governance_expired',410);
      if(row.version>=100&&!['resume','withdraw-report'].includes(x.kind))fail('target_governance_event_limit',429);
      if(x.kind==='review'){if(!['received','appealed','reviewing'].includes(state))fail('target_governance_state');state='reviewing';}
      if(x.kind==='pause'){if(['withdrawn','resolved'].includes(state))fail('target_governance_state');this.validateRestriction(row,x,7);until=stamp(x.until);scopes=x.scopes;restrictionEvent=x.id;}
      if(x.kind==='resume'){until=null;scopes=[];restrictionEvent=x.id;}
      if(x.kind==='resolve'){
        if(['withdrawn','resolved'].includes(state))fail('target_governance_state');
        if(x.verdict==='dismissed'&&x.restriction)fail('dismissed_cannot_restrict',400);
        if(x.restriction)this.validateRestriction(row,x.restriction,30);
        until=x.restriction?stamp(x.restriction.until):null;scopes=x.restriction?.scopes??[];restrictionEvent=x.id;decisionEvent=x.id;state='resolved';closed=stamp(this.access.now());
      }
      if(x.kind==='appeal'){const effective=until&&new Date(until).getTime()/1000>this.access.now();if(state!=='resolved'&&!effective||appeals>=3)fail('target_governance_state');state='appealed';closed=null;appeals++;}
      if(x.kind==='withdraw-report'){if(actor.subjectId!==row.subject_id||state==='withdrawn')fail('target_governance_state');state='withdrawn';closed=stamp(this.access.now());}
      if(x.kind==='supplement'&&state==='withdrawn')fail('target_governance_state');
      const receipt=await this.save(db,actor,auth,{id:x.id,reportId:row.id,version:row.version+1,kind:x.kind,consentId,payloadJson});
      await db.query(`UPDATE target_reports_v2 SET version=$2,state=$3,closed_at=$4,appeal_count=$5,restriction_until=$6,restriction_scopes=$7::jsonb,restriction_event_id=$8,decision_event_id=$9 WHERE id=$1`,
        [row.id,row.version+1,state,closed,appeals,until,JSON.stringify(scopes),restrictionEvent,decisionEvent]);return receipt;
    });
  }
  targetInfo(actor,input){const x=parse(z.strictObject({type:z.enum(['task','room']),id:z.uuid()}),input);return this.access.runAuthorized(actor,'moderation',async db=>{
    const src=await this.source(db,actor,x,{authorize:true});return{target:src.target,state:src.state,sourceAvailable:src.sourceAvailable,contentAccess:src.contentAccess,
      currentRestrictions:await targetRestrictionsWithin(db,x.type,x.id,this.access.now())};});}
  async readWithin(db,actor,id){const row=await this.load(db,id),view=await this.visible(db,actor,row), independent=await this.independent(db,actor,view.parties);
    let src,canReadTarget=false;try{src=await this.source(db,null,this.target(row));}catch(e){if(!missing(e))throw e;}
    if(src)try{await this.source(db,actor,this.target(row),{authorize:true});canReadTarget=true;}catch(e){if(!missing(e))throw e;}
    const current=await targetRestrictionsWithin(db,row.target_type,row.task_id??row.room_id,this.access.now());
    return {schemaVersion:2,reportId:row.id,target:this.target(row),version:row.version,state:row.state,reporterId:row.subject_id,
      events:view.events,closedAt:row.closed_at?new Date(row.closed_at).toISOString():null,
      canModerate:independent,canAppeal:(row.state==='resolved'||row.restriction_until&&new Date(row.restriction_until).getTime()/1000>this.access.now())&&view.parties.includes(actor.subjectId)&&row.appeal_count<3,
      canRespond:view.parties.includes(actor.subjectId),canWithdraw:actor.subjectId===row.subject_id&&row.state!=='withdrawn',
      handling:view.events.some(e=>['review','resolve','pause'].includes(e.kind))?'handler-event-recorded':this.moderatorIds.some(id=>view.events.some(e=>e.authorId===id))?'handler-event-recorded':'awaiting-authorized-independent-handler',
      currentTarget:src?{...src.target,state:src.state,sourceAvailable:src.sourceAvailable,contentAccess:src.contentAccess,canReadTarget}:null,
      requiredDecisionViewers:[row.subject_id],currentRestrictions:current,
      ownRestriction:row.restriction_until&&new Date(row.restriction_until).getTime()/1000>this.access.now()?{scopes:row.restriction_scopes,until:new Date(row.restriction_until).toISOString(),eventId:row.restriction_event_id}:null,
      guaranteesResponse:false,authority:'private-handling-and-target-operations; not-task-result-or-capability-verdict'};
  }
  read(actor,id){parse(z.uuid(),id);return this.access.runAuthorized(actor,'moderation',db=>this.readWithin(db,actor,id));}
  query(actor,input={}){const x=parse(targetGovernanceQuerySchemaV2,input);return this.access.runAuthorized(actor,'moderation',async db=>{
    const candidates=(await db.query(`SELECT r.id FROM target_reports_v2 r WHERE ($1::uuid IS NULL OR r.id>$1) AND ($2::text IS NULL OR target_type=$2 AND COALESCE(task_id,room_id)=$3)
      AND (r.subject_id=$4 OR r.party_ids ? $4 OR EXISTS(SELECT 1 FROM target_governance_events_v2 e JOIN consents c ON c.id=e.consent_id WHERE e.report_id=r.id AND (e.subject_id=$4 OR c.intent->'viewers' ? $4))
       OR EXISTS(SELECT 1 FROM chat_memberships m WHERE m.room_id=r.room_id AND m.subject_id=$4 AND m.left_at IS NULL)
       OR EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=r.task_id AND e.subject_id=$4)) ORDER BY r.id LIMIT 200`,[x.after??null,x.target?.type??null,x.target?.id??null,actor.subjectId])).rows;
    const items=[];let last=x.after??null;for(const c of candidates){last=c.id;try{items.push(await this.readWithin(db,actor,c.id));}catch(e){if(!missing(e))throw e;}if(items.length===x.limit)break;}
    return{items,next:candidates.length===200||items.length===x.limit?last:null,coverage:'currently-visible-page-only'};
  });}
}
