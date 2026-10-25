import * as z from 'zod/v4';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {assertForumIds,forumActorKey} from './shared/community-forum-ids-v1.mjs';
import {forumStamp,forumSeconds} from './community-forum-permissions-v1.mjs';
import {forumAccountUsage} from './community-forum-budget-v1.mjs';
import {lockForumOperation,priorForumOperation,recordForumReceipt,recordForumAudit} from './community-forum-operations-v1.mjs';
import {forumReportSchema,forumReportEventSchema,forumReportQuerySchema,forumConfigSchema,forumWriteSpec,parseForumPayload} from './shared/community-forum-v1-schema.mjs';

const validate=(schema,input)=>{const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_forum_request');return parsed.data;};
export class CommunityForumGovernanceV1 {
 constructor(access,consents,forum,{moderatorIds=[],accounts}={}){
  Object.assign(this,{access,consents,forum,accounts});this.moderatorIds=[...new Set(z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(128).parse(moderatorIds))];
  this.policy=forum.policy;this.permissions=forum.permissions;forum.governance=this;
 }
 readScope(actor){return actor.kind==='official-account'||actor.scopes?.includes('assistance')?'assistance':'moderation';}
 async row(db,id,lock=false){return (await db.query(`SELECT * FROM forum_reports_v1 WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];}
 parties(row){return [...new Set([row.reporter_id,row.target_author_id].filter(Boolean))];}
 accountParties(row){return row.account_governance?[...new Set([row.reporter_account_id,row.target_author_account_id].filter(Boolean))]:[];}
 partyContext(actor,row){
  const accountId=actor.kind==='official-account'||actor.accountAuthorized?actor.accountId:null,accounts=this.accountParties(row),
   originalReporter=!!actor.subjectId&&row.reporter_id===actor.subjectId&&(!actor.accountId||actor.accountId===row.reporter_account_id),
   originalTarget=!!actor.subjectId&&row.target_author_id===actor.subjectId&&(!actor.accountId||actor.accountId===row.target_author_account_id),
   reporter=originalReporter||!!accountId&&row.account_governance&&row.reporter_account_id===accountId,
   party=reporter||originalTarget||!!accountId&&accounts.includes(accountId);
  return {accountId,accounts,reporter,party};
 }
 async contextActorWithin(db,actor,row,{kind=null}={}){
  if(actor.kind==='official-account'||actor.accountId)return actor;
  const candidates=kind==='supplement'||kind==='withdraw'?[row.reporter_account_id]:
   row.account_governance?this.accountParties(row):[row.reporter_id===actor.subjectId?row.reporter_account_id:null,row.target_author_id===actor.subjectId?row.target_author_account_id:null];
  const available=await this.accounts.availableWithin(db,actor),matches=[...new Set(candidates.filter(id=>id&&available.some(account=>account.id===id)))];
  if(matches.length!==1)return actor;
  return {...actor,accountId:matches[0],accountAuthorized:true};
 }
 async knownShared(db,id,others){return !!(await db.query(`SELECT 1 FROM community_account_links a JOIN community_account_links b ON b.account_id=a.account_id
  WHERE a.subject_id=$1 AND b.subject_id=ANY($2::text[]) LIMIT 1`,[id,others])).rows.length;}
 async independent(db,id,parties,accounts=[]){
  if(!id||!this.moderatorIds.includes(id)||parties.includes(id)||await this.knownShared(db,id,parties))return false;
  if(accounts.length){const rows=(await db.query(`SELECT l.issuer,l.client_id FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id
   WHERE g.subject_id=$1 AND g.account_id=ANY($2::uuid[]) AND l.revoked_at IS NULL`,[id,accounts])).rows;
   if(rows.some(row=>this.accounts.providers.has(JSON.stringify([row.issuer,row.client_id]))))return false;}
  return true;
 }
 async eligible(db,parties,accounts=[]){const items=[];for(const id of this.moderatorIds)if(await this.independent(db,id,parties,accounts))items.push(id);return items;}
 handlers(p,eligible){if(p.handlerIds&&(new Set(p.handlerIds).size!==p.handlerIds.length||p.handlerIds.some(id=>!eligible.includes(id))))throw new ServiceError('forum_private_audience_mismatch',403);return p.handlerIds??eligible;}
 async targetWithin(db,target,{read=true,lock=false,actor=null}={}){
  if(target.kind==='post-version'){
   if(lock)await this.forum.head(db,target.postId,true);
   const row=await this.forum.version(db,target.postId,target.versionId,lock);if(!row)throw new ServiceError('not_found',404);
   return {row,authorId:row.subject_id,view:read?await this.forum.readVersionWithin(db,target.postId,target.versionId,{actor}):null};
  }
  const row=await this.forum.reply(db,target.replyId,lock);if(!row)throw new ServiceError('not_found',404);
  return {row,authorId:row.subject_id,view:read?await this.forum.readReplyWithin(db,target.replyId,{actor}):null};
 }
 async baseSourceWithin(db,target,actor=null){
  const {row}=await this.targetWithin(db,target,{read:false});
  if(row.state!=='published'||target.kind==='post-version'&&row.post_state!=='published'||!row.payload_text||row.erased_at||row.event_erased)throw new ServiceError('forum_source_unavailable',403);
  return this.permissions.requireWithin(db,row.permission_id,{visibility:'Public',payloadHash:row.payload_hash,action:target.kind==='reply'?'forum.reply.publish':'forum.post.publish',objectId:target.kind==='reply'?target.replyId:target.versionId,viewerActor:actor});
 }
 config(actor,input={}){const q=validate(forumConfigSchema,input);return this.accounts.runAuthorized(actor,this.readScope(actor),async(db,_authorization,actor)=>{
  const parties=[actor.subjectId],accounts=[];
  try{accounts.push((await this.accounts.resolveWithin(db,actor)).id);}catch(error){if(!['account_verification_required','account_selection_required'].includes(error.code))throw error;}
  if(q.target){const source=await this.targetWithin(db,q.target,{actor});if(source.view.availability!=='available')throw new ServiceError('forum_report_source_unavailable',403);parties.push(source.authorId);if(source.row.account_id)accounts.push(source.row.account_id);}
  const ids=await this.eligible(db,parties.filter(Boolean),accounts);
  return {moderatorIds:ids,configured:ids.length>0||this.operationsHandling===true,operationsHandling:this.operationsHandling===true,...(this.operationsHandling?{operationsDisclosure:'仅发送给运营处理人员'}:{}),guaranteesResponse:false,maxAppeals:this.policy.maxAppeals,maxPermissionSeconds:this.policy.maxPermissionSeconds,maxGovernanceHideSeconds:this.policy.maxGovernanceHideSeconds,automaticAccountRestriction:false};
 });}
 async save(db,actor,{p,consentId,payloadJson,kind,reportId,version,permissionId,accountId,result}){
  await db.query(`INSERT INTO forum_governance_events_v1(id,operation_id,report_id,subject_id,account_id,version,kind,consent_id,permission_id,payload_text,payload_hash,created_at,resolution,effect_until,result,actor_kind,http_request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[p.governanceEventId??p.operationId,p.operationId,reportId,actor.subjectId??null,accountId,version,kind,consentId,permissionId,payloadJson,digest(payloadJson),forumStamp(this.access.now()),p.resolution??null,p.effect?forumStamp(p.effect.until):null,JSON.stringify(result),actor.kind==='official-account'?'official-account':'identity',actor.httpRequestId??null]);
 }
 async finish(db,actor,authorization,{p,consentId,payloadJson,accountId,kind,locator,result,category=null}){
  await recordForumReceipt(db,actor,{operationId:p.operationId,consentId,payloadJson,accountId,category,locator,result,now:this.access.now(),auditDays:this.policy.auditDays});
  await recordForumAudit(db,actor,authorization,{operationId:p.operationId,consentId,sourceEventId:p.governanceEventId??p.operationId,sourceTable:'forum_governance_events_v1',action:kind==='resolve'?'forum.governance.resolve':kind==='report'?'forum.report.publish':'forum.report.event'});return result;
 }
 report(actor,{signedIntent,payloadJson}){
  const p=parseForumPayload(payloadJson,forumReportSchema,this.policy.maxPayloadBytes),spec=forumWriteSpec('create-report',p);
  if([...p.summary].length>this.policy.maxReportCodePoints)throw new ServiceError('forum_content_limit',413);
  actor=this.forum.writeActor(actor,p);return this.accounts.runAuthorized(actor,'assistance',async(db,authorization,actor)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   await assertForumIds('create-report',forumActorKey(actor),p);actor=await this.forum.selectWriteAccountWithin(db,actor,p);
   const source=await this.targetWithin(db,p.target,{lock:true,actor});if(source.view.availability!=='available')throw new ServiceError('forum_report_source_unavailable',403);
   const state=await this.forum.budget.startWithin(db,actor,'report'),eligible=await this.eligible(db,[actor.subjectId,source.authorId].filter(Boolean),[state.account.id,source.row.account_id].filter(Boolean)),consentId=await this.forum.consentWithin(db,actor,authorization,signedIntent),
    permit=await this.permissions.captureWithin(db,actor,{consentId,payloadJson,spec,eventId:p.operationId,accountId:state.account.id,allowedViewers:this.handlers(p,eligible),allowedAccountViewers:[]}),at=forumStamp(this.access.now());
   await db.query(`INSERT INTO forum_reports_v1(id,subject_id,reporter_id,account_id,target,target_author_id,version,state,created_at,reporter_account_id,target_author_account_id,account_governance)
    VALUES($1,$2,$2,$3,$4,$5,1,'pending',$6,$3,$7,$8)`,[p.reportId,actor.subjectId??null,state.account.id,JSON.stringify(p.target),source.authorId,at,source.row.account_id,actor.kind==='official-account'||!!p.accountId||!source.authorId]);
   if(actor.kind==='official-account'&&this.operationsHandling)await db.query('UPDATE forum_reports_v1 SET operations_disclosed=true WHERE id=$1',[p.reportId]);
   const result={acknowledged:true,reportId:p.reportId,governanceEventId:p.operationId,version:1,state:'pending',accountId:state.account.id,subjectId:actor.subjectId??null,handlingState:actor.kind==='official-account'&&this.operationsHandling?'awaiting-operations-handler':eligible.some(id=>permit.grant.viewers.includes(id))?'awaiting-independent-handler':'awaiting-authorized-handler',authority:'accepted-operation-only'};
   await this.save(db,actor,{p,consentId,payloadJson,kind:'report',reportId:p.reportId,version:1,permissionId:permit.id,accountId:state.account.id,result});
   await this.finish(db,actor,authorization,{p,consentId,payloadJson,accountId:state.account.id,kind:'report',category:'report',locator:{kind:'report',reportId:p.reportId},result});
   return {...result,quota:await this.forum.budget.finishWithin(db,state)};
  },{resourceWrite:true}).catch(error=>{if(error.code==='23505')throw new ServiceError('forum_operation_conflict',409);throw error;});
 }
 async readableEvents(db,actor,row){
  const rows=(await db.query('SELECT * FROM forum_governance_events_v1 WHERE report_id=$1 ORDER BY version',[row.id])).rows,items=[];
  for(const event of rows){if(!event.payload_text||event.erased_at)continue;
   const permitted=await this.permissions.statusWithin(db,event.permission_id,{visibility:'Private',viewerId:actor.subjectId,viewerActor:actor,payloadHash:event.payload_hash});
   if(permitted.allowed)items.push({operationId:event.operation_id,governanceEventId:event.id,version:event.version,kind:event.kind,authorId:event.subject_id,authorAccountId:event.account_id,
    author:{kind:event.subject_id?'identity':'account',subjectId:event.subject_id??null,accountId:event.account_id??null},payload:JSON.parse(event.payload_text),checkedAt:this.access.now()});
  }
  if(this.partyContext(actor,row).party||items.length&&await this.independent(db,actor.subjectId,this.parties(row),this.accountParties(row))){
   const decisions=(await db.query('SELECT * FROM forum_operations_events_v1 WHERE report_id=$1 AND retained_until>$2 ORDER BY version',[row.id,forumStamp(this.access.now())])).rows;
   for(const event of decisions)items.push({operationId:event.id,governanceEventId:event.id,version:event.version,kind:'resolve',authorId:null,authorAccountId:null,
    author:{kind:'business-operator',operatorId:event.operator_id},payload:{kind:'resolve',reportId:row.id,reason:event.summary,resolution:event.resolution,restrictionAction:event.restriction_action??null,
     effect:event.effect_until?{kind:'hide-version',until:forumSeconds(event.effect_until)}:null},checkedAt:this.access.now()});
  }
  return items.sort((a,b)=>a.version-b.version);
 }
 async readWithin(db,actor,id){
  const row=await this.row(db,id);if(!row)throw new ServiceError('not_found',404);
  actor=await this.contextActorWithin(db,actor,row);
  const parties=this.parties(row),context=this.partyContext(actor,row),events=await this.readableEvents(db,actor,row),independent=await this.independent(db,actor.subjectId,parties,this.accountParties(row));
  if(!context.party&&(!independent||!events.length))throw new ServiceError('not_found',404);
  const canModerate=!!actor.scopes?.includes('moderation')&&independent&&events.some(event=>['report','supplement','appeal'].includes(event.kind));
  const narrativeCount=Number((await db.query("SELECT count(*) n FROM forum_governance_events_v1 WHERE report_id=$1 AND kind IN ('report','supplement')",[id])).rows[0].n);
  let decision=row.decision_event_id?(await db.query('SELECT id,operation_id,version,kind,resolution,effect_until FROM forum_governance_events_v1 WHERE id=$1',[row.decision_event_id])).rows[0]:null;
  if(row.decision_event_id&&!decision)decision=(await db.query("SELECT id,id AS operation_id,version,'resolve' AS kind,resolution,effect_until FROM forum_operations_events_v1 WHERE id=$1",[row.decision_event_id])).rows[0];
  return {reportId:id,target:row.target,version:row.version,state:row.state,
   operationsHandling:row.operations_disclosed===true,...(row.operations_disclosed===true?{operationsDisclosure:'仅发送给运营处理人员'}:{}),
   handlingState:row.operations_disclosed===true?(['pending','appealed'].includes(row.state)?'awaiting-operations-handler':'recorded'):canModerate?'awaiting-or-recorded-handler':events.length&&this.moderatorIds.length?'pending-or-recorded':'awaiting-authorized-handler',
   decisionLocator:decision?{governanceEventId:decision.id,operationId:decision.operation_id,version:decision.version,kind:decision.kind,resolution:decision.resolution,effectUntil:decision.effect_until?forumSeconds(decision.effect_until):null}:null,
   events,actionAccountId:context.accountId,canAppeal:context.party&&!!row.decision_event_id&&['resolved','withdrawn'].includes(row.state)&&row.appeal_count<this.policy.maxAppeals,
   canSupplement:context.reporter&&['pending','appealed'].includes(row.state)&&narrativeCount<this.policy.maxReportEvents,
   canWithdrawReport:context.reporter&&row.state!=='withdrawn',canModerate,
   ...(canModerate?{decisionRecipients:parties.filter(id=>id!==actor.subjectId),decisionAccountRecipients:this.accountParties(row)}:{}),checkedAt:this.access.now(),guaranteesResponse:false,authority:'configured-role-process; not-real-world-independence'};
 }
 get(actor,id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.accounts.runAuthorized(actor,this.readScope(actor),(db,_authorization,currentActor)=>this.readWithin(db,currentActor,id));}
 query(actor,input={}){const q=validate(forumReportQuerySchema,input);return this.accounts.runAuthorized(actor,this.readScope(actor),async(db,_authorization,actor)=>{
  const accountId=actor.kind==='official-account'||actor.accountAuthorized?actor.accountId:null;
  const rows=(await db.query(`SELECT r.id FROM forum_reports_v1 r WHERE ($1::uuid IS NULL OR r.id>$1) AND ($2::jsonb IS NULL OR r.target=$2::jsonb)
   AND (r.reporter_id=$3 OR r.target_author_id=$3 OR r.account_governance AND (r.reporter_account_id=$4::uuid OR r.target_author_account_id=$4::uuid)
    OR EXISTS(SELECT 1 FROM forum_governance_events_v1 e JOIN forum_permissions_v1 p ON p.id=e.permission_id WHERE e.report_id=r.id AND p.viewers ? $3)) ORDER BY r.id LIMIT 200`,[q.after??null,q.target?JSON.stringify(q.target):null,actor.subjectId??null,accountId])).rows,items=[];let scanned=null;
  for(const item of rows){scanned=item.id;try{items.push(await this.readWithin(db,actor,item.id));}catch(error){if(error.status!==404)throw error;}if(items.length===q.limit)break;}
  return {items,nextAfter:items.length===q.limit||rows.length===200?scanned:null,scanTruncated:rows.length===200&&items.length<q.limit,checkedAt:this.access.now()};
 });}
 affected(actor,input={}){const q=validate(forumReportQuerySchema,input);return this.accounts.runAuthorized(actor,'assistance',async(db,_authorization,actor)=>{
  const accountId=actor.kind==='official-account'||actor.accountAuthorized?actor.accountId:null;
  const rows=(await db.query(`SELECT id FROM forum_reports_v1 WHERE (reporter_id=$1 OR target_author_id=$1 OR account_governance AND (reporter_account_id=$5::uuid OR target_author_account_id=$5::uuid))
   AND ($2::uuid IS NULL OR id>$2) AND ($3::jsonb IS NULL OR target=$3::jsonb) ORDER BY id LIMIT $4`,[actor.subjectId??null,q.after??null,q.target?JSON.stringify(q.target):null,q.limit+1,accountId])).rows,items=[];
  for(const row of rows.slice(0,q.limit)){try{const view=await this.readWithin(db,actor,row.id);items.push({reportId:view.reportId,target:view.target,version:view.version,state:view.state,decisionLocator:view.decisionLocator,canAppeal:view.canAppeal,checkedAt:view.checkedAt});}catch(error){if(error.status!==404)throw error;}}
  return {items,nextAfter:rows.length>q.limit?rows[q.limit-1].id:null,checkedAt:this.access.now()};
 });}
 event(actor,id,{signedIntent,payloadJson}){
  const p=parseForumPayload(payloadJson,forumReportEventSchema,this.policy.maxPayloadBytes);if(p.reportId!==id)throw new ServiceError('forum_report_target_mismatch');
  if(p.summary&&[...p.summary].length>this.policy.maxReportCodePoints||p.reason&&[...p.reason].length>this.policy.maxReportCodePoints)throw new ServiceError('forum_content_limit',413);
  const kind=p.kind==='withdraw'?'withdraw-report':p.kind,spec=forumWriteSpec(kind,p),scope=p.kind==='resolve'?'moderation':'assistance',control=p.kind!=='supplement';
  actor=this.forum.writeActor(actor,p);return this.accounts.runAuthorized(actor,scope,async(db,authorization,actor)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   await assertForumIds(kind,forumActorKey(actor),p);
   const source=await this.row(db,id);if(!source)throw new ServiceError('not_found',404);
   if(p.kind!=='resolve'){
    actor=await this.contextActorWithin(db,actor,source,{kind:p.kind});
    const available=await this.accounts.availableWithin(db,actor);
    if(available.length)actor=await this.forum.selectWriteAccountWithin(db,actor,p,{owner:actor.accountAuthorized?{account_id:actor.accountId}:null,control});
    else if(!control||!this.parties(source).includes(actor.subjectId))throw new ServiceError('account_verification_required',403);
   }else if(actor.kind==='official-account')throw new ServiceError('forum_independent_handler_required',403);
   const row=await this.row(db,id,true);if(!row)throw new ServiceError('not_found',404);if(row.version!==p.expectedReportVersion)throw new ServiceError('forum_report_version_conflict',409);
   const parties=this.parties(row),accountParties=this.accountParties(row),view=await this.readWithin(db,actor,id),eligible=await this.eligible(db,parties,accountParties),
    actionAccountId=actor.kind==='official-account'||actor.accountAuthorized?actor.accountId:null;
   if(p.kind==='resolve'){
    if(!view.canModerate)throw new ServiceError('forum_independent_handler_required',403);
    if(!['pending','appealed'].includes(row.state))throw new ServiceError('forum_report_transition',409);
    if(p.effect){if(p.resolution!=='accepted'||p.effect.until<=this.access.now()||p.effect.until>this.access.now()+this.policy.maxGovernanceHideSeconds)throw new ServiceError('forum_hide_expiry',409);await this.baseSourceWithin(db,row.target,actor);}
   }else if(p.kind==='appeal'){
    if(!view.canAppeal)throw new ServiceError('forum_appeal_unavailable',409);
   }else if(p.kind==='withdraw'){
    if(!view.canWithdrawReport)throw new ServiceError('forum_report_transition',409);
   }else if(!view.canSupplement)throw new ServiceError('forum_report_transition',409);
   // Narrative cap leaves finite, state-bounded resolution/appeal/withdraw slots.
   if(row.version>=this.policy.maxReportEvents+2*this.policy.maxAppeals+2)throw new ServiceError('forum_report_event_limit',413);
   let before=null;
   if(!control){const account=await this.accounts.resolveWithin(db,actor,{lock:true});if(account.id!==row.reporter_account_id)throw new ServiceError('forum_report_account_changed',409);before=await forumAccountUsage(db,account.id);}
   const consentId=await this.forum.consentWithin(db,actor,authorization,signedIntent),allowed=p.kind==='resolve'?[...eligible,...parties]:eligible,
    permit=await this.permissions.captureWithin(db,actor,{consentId,payloadJson,spec,eventId:p.governanceEventId,accountId:actionAccountId,
     allowedViewers:p.kind==='resolve'?allowed:this.handlers(p,eligible),requiredViewers:p.kind==='resolve'?parties:[],
     allowedAccountViewers:accountParties,requiredAccountViewers:p.kind==='resolve'?accountParties:[]});
   if(p.effect&&p.effect.until>permit.publishedUntil)throw new ServiceError('forum_hide_expiry',409);
   const version=row.version+1,now=this.access.now(),at=forumStamp(now),
    state=p.kind==='resolve'?'resolved':p.kind==='appeal'?'appealed':p.kind==='withdraw'?'withdrawn':row.state,
    closed=['resolved','withdrawn'].includes(state)?at:null,result={acknowledged:true,reportId:id,governanceEventId:p.governanceEventId,version,state,accountId:actionAccountId,subjectId:actor.subjectId??null,authority:'accepted-operation-only'};
   await this.save(db,actor,{p,consentId,payloadJson,kind:p.kind,reportId:id,version,permissionId:permit.id,accountId:actionAccountId,result});
   await db.query(`UPDATE forum_reports_v1 SET version=$2,state=$3,appeal_count=appeal_count+$4,closed_at=$5,audit_until=$6,
    decision_event_id=CASE WHEN $7::boolean THEN $8::uuid ELSE decision_event_id END,
    restriction_event_id=CASE WHEN $7::boolean THEN $9::uuid ELSE restriction_event_id END,
    restriction_until=CASE WHEN $7::boolean THEN $10::timestamptz ELSE restriction_until END WHERE id=$1`,
    [id,version,state,p.kind==='appeal'?1:0,closed,closed?forumStamp(now+this.policy.auditDays*86400):null,p.kind==='resolve',p.governanceEventId,p.effect?p.governanceEventId:null,p.effect?forumStamp(p.effect.until):null]);
   if(p.kind==='withdraw'){
    const ownerColumn=actionAccountId&&row.account_governance?'account_id':'subject_id',ownerId=ownerColumn==='account_id'?actionAccountId:actor.subjectId;
    await db.query(`UPDATE forum_permissions_v1 SET revoked_at=COALESCE(revoked_at,$3) WHERE id IN
     (SELECT permission_id FROM forum_governance_events_v1 WHERE report_id=$1 AND ${ownerColumn}=$2 AND kind IN ('report','supplement'))`,[id,ownerId,at]);
   }
   await this.finish(db,actor,authorization,{p,consentId,payloadJson,accountId:actionAccountId,kind:p.kind,locator:{kind:'report',reportId:id},result});
   if(!control)await this.forum.budget.checkGrowthWithin(db,actionAccountId,before);return result;
  },{resourceWrite:true,control}).catch(error=>{if(error.code==='23505')throw new ServiceError('forum_operation_conflict',409);throw error;});
 }
 async hiddenWithin(db,target){
  if((await db.query(`SELECT 1 FROM forum_reports_v1 r JOIN forum_operations_events_v1 e ON e.id=r.restriction_event_id
   WHERE r.target=$1::jsonb AND r.restriction_until>$2 AND e.effect_until>$2 LIMIT 1`,[JSON.stringify(target),forumStamp(this.access.now())])).rows.length)return true;
  const rows=(await db.query(`SELECT r.reporter_id,r.target_author_id,r.reporter_account_id,r.target_author_account_id,r.account_governance,r.restriction_event_id,e.subject_id,e.permission_id,e.payload_hash,e.effect_until FROM forum_reports_v1 r
   JOIN forum_governance_events_v1 e ON e.id=r.restriction_event_id WHERE r.target=$1::jsonb AND r.restriction_until>$2`,[JSON.stringify(target),forumStamp(this.access.now())])).rows;
  for(const row of rows){if(!await this.independent(db,row.subject_id,this.parties(row),this.accountParties(row)))continue;
   const state=await this.permissions.statusWithin(db,row.permission_id,{visibility:'Private',viewerId:row.subject_id,payloadHash:row.payload_hash,action:'forum.governance.resolve',objectId:row.restriction_event_id});
   if(state.allowed&&row.effect_until&&forumSeconds(row.effect_until)>this.access.now())return true;
  }return false;
 }
}
