import {z} from 'zod';
import {digest} from "../../shared/digest.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsQueues} from "../jobs/service.mjs";
import {lockControllerMappingsWithin} from "../../identity/controller-mapping-lock.mjs";
import {forumTopics,forumUnclassifiedTopic} from "../../shared/community-forum-topics-v1.mjs";
import {operationsPageSchema,operationsSectionsQuerySchema,operationsSectionClassificationSchema,operationsVisibilitySchema,operationsReportsQuerySchema,operationsForumDecisionSchema} from "../../shared/operations-business-schema.mjs";
import {OperationsBusinessDomain,operationsParse,operationsFail,operationsIso,operationsStamp,operationsVisibilityWithin} from "../public-content/content-visibility.mjs";
import {publicForumActivityWithin,recentOperationsWithin,uncollectedOperationsUsage} from "../analytics/service.mjs";
import {OperationsForumContentService} from "../public-content/service.mjs";
import {hasOperationsPermission as permitted} from "../../operations-permission-catalog.mjs";
import {operationsOperatorNamesWithin} from "../accounts/history-identities.mjs";

export class OperationsCommunityService extends OperationsBusinessDomain {
 constructor({businessAdmin,forum,governance=forum.governance,now}){super({businessAdmin,now});Object.assign(this,{forum,governance});this.content=new OperationsForumContentService({businessAdmin,forum,now});this.maxHideSeconds=forum.policy.maxGovernanceHideSeconds;governance.operationsHandling=true;}
 async summary(operator,options={}){const deferred=operationsParse(z.object({publicActivity:z.literal('deferred').optional()}).strict(),options).publicActivity==='deferred';const snapshot=await this.run(operator,false,'operations-summary-read',{},async(db,actor)=>{
  const allowed=code=>permitted(actor,code),availability={},read=async(key,code,sql,args=[])=>{
   availability[key]=allowed(code)?'available':'not-authorized';return allowed(code)?(await db.query(sql,args)).rows:null;
  };
  const forum=(await read('communityReports','cases.read',"SELECT count(*) FILTER(WHERE state IN ('pending','appealed'))::integer AS pending,count(*)::integer AS total FROM forum_reports_v1"))?.[0],
   chat=(await read('chatReports','chat-reports.read',"SELECT count(*) FILTER(WHERE state IN ('received','reviewing','appealed'))::integer AS pending,count(*)::integer AS total FROM account_chat_reports_v1 WHERE endpoint=$1",[this.endpoint]))?.[0],
   sections=(await read('sections','sections.read',"SELECT count(*) FILTER(WHERE state='active')::integer AS active,count(*) FILTER(WHERE state='archived')::integer AS archived FROM forum_sections_v2"))?.[0],
   resources=(await read('resources','resources.read',"SELECT (SELECT count(*)::integer FROM projects_v2 WHERE state='active') AS projects,(SELECT count(*)::integer FROM capsules WHERE revision>0) AS methods"))?.[0],
   files=(await read('files','files.read',`SELECT count(*) FILTER(WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND NOT purge_pending AND expires_at>$1)::integer AS scan_pending,
    count(*) FILTER(WHERE state IN ('scan-pending','scanning') AND revoked_at IS NULL AND NOT purge_pending AND expires_at>$1 AND last_error IS NOT NULL AND last_error<>'attachment_cleanup_failed')::integer AS scan_failed,
    count(*) FILTER(WHERE purge_pending AND purged_at IS NULL)::integer AS cleanup_pending,
    count(*) FILTER(WHERE purge_pending AND purged_at IS NULL AND last_error='attachment_cleanup_failed')::integer AS cleanup_unknown
    FROM (SELECT state,revoked_at,purge_pending,purged_at,expires_at,last_error FROM chat_attachments
     UNION ALL SELECT state,revoked_at,purge_pending,purged_at,expires_at,last_error FROM forum_attachments_v1) files`,[operationsStamp(this.now())]))?.[0],
   jobs=await read('jobs','jobs.read',"SELECT name,state,count(*)::integer AS count FROM galaxy_jobs.job WHERE name=ANY($1::text[]) AND state IN ('created','retry','active','failed') GROUP BY name,state",[operationsQueues]),
   feedback=(await read('feedback','feedback.read',"SELECT count(*)::integer AS total,count(*) FILTER(WHERE state='pending')::integer AS pending,count(*) FILTER(WHERE state='processing')::integer AS processing,count(*) FILTER(WHERE category IS NULL)::integer AS unclassified FROM operations_feedback_v1 WHERE endpoint=$1 AND owner_deleted_at IS NULL",[this.endpoint]))?.[0],
   search=(await read('search','search.read',"SELECT count(*)::integer AS failed FROM jobs WHERE kind='search-index' AND state='failed'"))?.[0];
  availability.businessActivity=allowed('content.read')?deferred?'not-requested':'available':'not-authorized';availability.recentOperations=allowed('audit.read')?'available':'not-authorized';
  const businessActivity=!deferred&&allowed('content.read')?await publicForumActivityWithin(db,{forum:this.forum,endpoint:this.endpoint,now:this.now(),days:7}):null,
   recentOperations=allowed('audit.read')?await recentOperationsWithin(db,this.endpoint):null;
  return {communityReports:forum?{pending:forum.pending,total:forum.total}:null,chatReports:chat?{pending:chat.pending,total:chat.total}:null,sections:sections??null,
   resources:resources??null,files:files?{scanPending:files.scan_pending,scanFailed:files.scan_failed,cleanupPending:files.cleanup_pending,cleanupFailed:null,cleanupResultUnknown:files.cleanup_unknown}:null,
   jobs:jobs?{failed:jobs.filter(row=>row.state==='failed').reduce((sum,row)=>sum+row.count,0),byQueue:jobs.map(row=>({queue:row.name,state:row.state,count:row.count}))}:null,
   search:search?{failed:search.failed}:null,feedback:feedback??null,availability,operator:{id:actor.operatorId,role:actor.role,businessAuthorization:actor.businessAuthorization},analytics:uncollectedOperationsUsage(),businessActivity,recentOperations,
   ai:null,autonomy:null,checkedAt:this.now(),readExpiresAt:this.now()+30};
 },{isolation:'repeatable read'});
  // Use the same real task projection as the complete operations page. Read it
  // after the business transaction, never through a second nested DB lease.
  if(!snapshot.operator.businessAuthorization.permissions.includes('autonomy.read'))return {...snapshot,availability:{...snapshot.availability,ai:'not-authorized'}};
  if(!this.autonomy)return {...snapshot,availability:{...snapshot.availability,ai:'unavailable'}};
  try{
   const autonomy=await this.autonomy.workbenchSummary(operator);
   const progress=(autonomy.recentTasks??[]).filter(task=>!['awaiting-human','waiting-human','failed','unknown'].includes(task.state)).slice(0,3)
    .map(task=>({id:task.id,label:task.title,createdAt:task.updatedAt,href:'/admin/operations/ai-runs?task='+task.id,source:'自动运行'}));
   return {...snapshot,autonomy,ai:{state:autonomy.runtime?.state??'unavailable',logs:autonomy.recentTasks??[],recentProgress:progress},
    availability:{...snapshot.availability,ai:'available'},readExpiresAt:Math.min(snapshot.readExpiresAt,autonomy.readExpiresAt)};
  }catch(error){return {...snapshot,availability:{...snapshot.availability,ai:error.status===403?'not-authorized':'unavailable'}};}
 }
 async sectionWithin(db,id,lock=false){operationsParse(z.uuid(),id);const row=(await db.query(`SELECT * FROM forum_sections_v2 WHERE id=$1 FOR ${lock?'UPDATE':'SHARE'}`,[id])).rows[0];if(!row)operationsFail('not_found',404);return row;}
 async sectionViewWithin(db,row,actor){
  const readable=await this.forum.accessRules.ruleWithin(db,row.audience.read,null),owner=(await db.query('SELECT a.uid,p.display_name FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2',[row.maintainer_account_id,this.endpoint])).rows[0];
  const visibility=await operationsVisibilityWithin(db,{endpoint:this.endpoint,kind:'forum-section',id:row.id,now:this.now()});
  return {id:row.id,version:row.version,state:row.state,category:row.category,title:readable?row.title:null,theme:readable?row.theme:null,
   description:readable?row.description:null,sourceState:readable?'available':'restricted',maintainerAccountId:row.maintainer_account_id,
   maintainerDisplayName:owner?.display_name??null,maintainerUid:owner?.uid??null,creatorId:row.creator_subject_id,
   visibility,canHide:permitted(actor,'sections.hide')&&!visibility.hidden,canRestore:permitted(actor,'sections.restore')&&visibility.hidden,
   createdAt:operationsIso(row.created_at),updatedAt:operationsIso(row.updated_at),canManage:permitted(actor,'sections.classify'),maxHideSeconds:this.maxHideSeconds,checkedAt:this.now()};
 }
 sections(operator,input={}){const q=operationsParse(operationsSectionsQuerySchema,input);return this.run(operator,false,'community-sections-query',q,async(db,actor)=>{
  const rows=(await db.query(`SELECT * FROM forum_sections_v2 WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR state=$2) AND ($3::text IS NULL OR category=$3) ORDER BY id LIMIT $4`,[q.after??null,q.state??null,q.category??null,q.limit+1])).rows,selected=rows.slice(0,q.limit),items=[];
  for(const row of selected)items.push(await this.sectionViewWithin(db,row,actor));return{items,nextAfter:rows.length>q.limit?selected.at(-1).id:null,categories:[...forumTopics,forumUnclassifiedTopic],checkedAt:this.now()};
 });}
 section(operator,id){return this.run(operator,false,'community-section-read',{id},async(db,actor)=>this.sectionViewWithin(db,await this.sectionWithin(db,id),actor));}
 classify(operator,id,input){const x=operationsParse(operationsSectionClassificationSchema,input);operationsParse(z.uuid(),id);return this.command(operator,'community-section-classify',{id,...x},async(db,actor)=>{
  const row=await this.sectionWithin(db,id,true);if(row.version!==x.expectedVersion)operationsFail('forum_section_version_conflict');
  if((await db.query('SELECT 1 FROM forum_section_events_v2 WHERE id=$1',[x.operationId])).rows.length)operationsFail('business_admin_operation_conflict');
  const version=row.version+1,at=operationsStamp(this.now()),result={sectionId:id,version,category:x.category,actorKind:actor.kind,operatorId:actor.operatorId};
  await db.query('UPDATE forum_sections_v2 SET category=$2,version=$3,updated_at=$4 WHERE id=$1',[id,x.category,version,at]);
  const payload=JSON.stringify({sectionId:id,...x});
  await db.query(`INSERT INTO forum_section_events_v2(id,section_id,account_id,subject_id,actor_kind,operator_id,kind,version,consent_id,payload_text,payload_hash,result,http_request_id,created_at)
   VALUES($1,$2,NULL,NULL,$10,$3,'classification',$4,NULL,$5,$6,$7,$8,$9)`,[x.operationId,id,actor.operatorId,version,payload,digest(payload),JSON.stringify(result),actor.httpRequestId??null,at,actor.kind]);
  return result;
 });}
 sectionVisibility(operator,id,input){const x=operationsParse(operationsVisibilitySchema,input);operationsParse(z.uuid(),id);return this.command(operator,'community-section-visibility',{id,...x},async db=>{
  const row=await this.sectionWithin(db,id,true);return this.changeVisibilityWithin(db,{kind:'forum-section',id,expectedVersion:x.expectedVersion,sourceVersion:row.version,input:x});
 });}
 async sourceWithin(db,target){
  let source;try{source=await this.governance.targetWithin(db,target,{read:false});}catch(error){if(!(error instanceof ServiceError)||![403,404].includes(error.status))throw error;return {locator:target,availability:'unavailable',content:null,publishedUntil:null};}const row=source.row;
  const state=await this.forum.permissions.statusWithin(db,row.permission_id,{visibility:'Public',payloadHash:row.payload_hash,action:target.kind==='reply'?'forum.reply.publish':'forum.post.publish',objectId:target.kind==='reply'?target.replyId:target.versionId});
  const available=state.allowed&&row.state==='published'&&(target.kind!=='post-version'||row.post_state==='published')&&!!row.payload_text&&!row.erased_at&&!row.event_erased;
  if(!available)return {locator:target,availability:'unavailable',content:null,publishedUntil:null};
  const p=JSON.parse(row.payload_text);
  let title=p.title??null;
  if(target.kind==='reply'){const parent=await this.forum.head(db,row.post_id);title=parent?.current_version_id?(await this.sourceWithin(db,{kind:'post-version',postId:row.post_id,versionId:parent.current_version_id})).content?.title??null:null;}
  return {locator:target,availability:'available',content:{title,body:p.body,links:p.links??[]},publishedUntil:Math.floor(Date.parse(row.published_until)/1000)};
 }
 async postViewWithin(db,row,actor,{detail=false}={}){
  let source={availability:'unavailable',content:null};
  if(row.current_version_id)source=await this.sourceWithin(db,{kind:'post-version',postId:row.id,versionId:row.current_version_id});
  const author=(await db.query('SELECT a.uid,p.display_name FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2',[row.account_id,this.endpoint])).rows[0];
  return {id:row.id,version:row.head_version,currentVersionId:row.current_version_id,state:row.state,authorAccountId:row.account_id,authorId:row.subject_id,
   authorUid:author?.uid??null,authorDisplayName:author?.display_name??null,title:source.content?.title??null,sourceState:source.availability,
   createdAt:operationsIso(row.created_at),updatedAt:operationsIso(row.updated_at),
   reportCount:Number((await db.query("SELECT count(*) AS n FROM forum_reports_v1 WHERE target->>'postId'=$1",[row.id])).rows[0].n),
   canManage:['content.hide','content.restore','content.curate'].some(code=>permitted(actor,code)),...(detail?{source,contentEditingAllowed:false}:{}),checkedAt:this.now()};
 }
 posts(operator,input={}){const q=operationsParse(operationsPageSchema,input);return this.run(operator,false,'community-posts-query',q,async(db,actor)=>{
  const rows=(await db.query('SELECT * FROM forum_posts_v1 WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',[q.after??null,q.limit+1])).rows,selected=rows.slice(0,q.limit),items=[];
  for(const row of selected)items.push(await this.postViewWithin(db,row,actor));return {items,nextAfter:rows.length>q.limit?selected.at(-1).id:null,checkedAt:this.now()};
 });}
 post(operator,id){operationsParse(z.uuid(),id);return this.run(operator,false,'community-post-read',{id},async(db,actor)=>{
  const row=await this.forum.head(db,id);if(!row)operationsFail('not_found',404);return this.postViewWithin(db,row,actor,{detail:true});
 });}
 async reportWithin(db,id,lock=false){operationsParse(z.uuid(),id);const row=await this.governance.row(db,id,lock);if(!row)operationsFail('not_found',404);return row;}
 async independentWithin(db,row,actor){
  await lockControllerMappingsWithin(db,this.endpoint,this.governance.parties(row));
  if(actor.kind==='operations-ai-service'){await this.principalWithin(db,actor);return true;}
  const principal=await this.principalWithin(db,actor),accounts=(await db.query('SELECT id FROM community_accounts WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3',[this.endpoint,principal.issuer,principal.external_subject])).rows;
  for(const account of accounts){
   if([row.reporter_account_id,row.target_author_account_id].includes(account.id))return false;
   const links=(await db.query(`SELECT g.subject_id FROM community_account_links g JOIN external_identity_links e ON e.id=g.identity_link_id WHERE g.account_id=$1 AND e.endpoint=$2 AND e.revoked_at IS NULL`,[account.id,this.endpoint])).rows;
   if(links.some(link=>this.governance.parties(row).includes(link.subject_id)))return false;
  }
  return true;
 }
 async reportViewWithin(db,row,actor,{detail=false}={}){
  const independent=await this.independentWithin(db,row,actor),expired=!!row.audit_until&&Date.parse(row.audit_until)<=this.now()*1000,
   source=await this.sourceWithin(db,row.target),canModerate=permitted(actor,'cases.resolve')&&independent&&!expired&&['pending','appealed'].includes(row.state)&&row.version<this.forum.policy.maxReportEvents+2*this.forum.policy.maxAppeals+2;
  const accounts=(await db.query('SELECT a.id,a.uid,p.display_name FROM community_accounts a JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled WHERE a.endpoint=$1 AND a.id=ANY($2::uuid[])',[this.endpoint,[row.reporter_account_id,row.target_author_account_id].filter(Boolean)])).rows,
   accountLabel=id=>{const account=accounts.find(value=>value.id===id);return account?{accountId:account.id,uid:account.uid,displayName:account.display_name??null}:null;};
  const base={id:row.id,target:row.target,version:row.version,state:row.state,reporterAccountId:row.reporter_account_id,reporterId:row.reporter_id,
   targetAuthorAccountId:row.target_author_account_id,targetAuthorId:row.target_author_id,operationsDisclosed:row.operations_disclosed,
   title:source.content?.title??null,reporter:accountLabel(row.reporter_account_id),targetAuthor:accountLabel(row.target_author_account_id),
   createdAt:operationsIso(row.created_at),closedAt:operationsIso(row.closed_at),restrictedUntil:operationsIso(row.restriction_until),
   canModerate,maxHideSeconds:this.maxHideSeconds,knownPartyConflict:!independent,checkedAt:this.now(),readExpiresAt:source.availability==='available'?Math.min(this.now()+30,source.publishedUntil):this.now()+30,
   currentEffect:{active:!!row.restriction_event_id&&!!row.restriction_until&&Date.parse(row.restriction_until)>this.now()*1000,until:operationsIso(row.restriction_until),
    restrictionEventId:row.restriction_event_id??null,scope:'this-case-only',canKeep:canModerate,
    canRelease:canModerate&&!!row.restriction_event_id&&!!row.restriction_until&&Date.parse(row.restriction_until)>this.now()*1000,
    canHide:canModerate&&source.availability==='available'}};
  if(!detail)return base;
  const events=[];
  if(independent&&!expired&&row.operations_disclosed){
   const originals=(await db.query("SELECT * FROM forum_governance_events_v1 WHERE report_id=$1 AND actor_kind='official-account' ORDER BY version",[row.id])).rows;
   for(const event of originals){
    if(!event.payload_text||event.erased_at)continue;
    // This audience bypass is confined to a newly disclosed Cookie case. The
    // original account permission must still be current, exact and unerased.
    const permit=await this.forum.permissions.statusWithin(db,event.permission_id,{visibility:'Private',payloadHash:event.payload_hash,checkAudience:false});
    if(!permit.allowed)continue;
    const p=JSON.parse(event.payload_text);events.push({id:event.id,version:event.version,kind:event.kind,actorKind:'official-account',accountId:event.account_id,summary:p.summary??p.reason??null,createdAt:operationsIso(event.created_at)});
   }
  }
  const decisions=independent&&!expired?(await db.query('SELECT * FROM forum_operations_events_v1 WHERE report_id=$1 AND retained_until>$2 ORDER BY version',[row.id,operationsStamp(this.now())])).rows:[];
  const decisionRows=independent&&!expired?(await db.query(`SELECT id,version,'identity'::text AS actor_kind,subject_id AS actor_id,resolution,effect_until,NULL::text AS restriction_action,created_at
   FROM forum_governance_events_v1 WHERE report_id=$1 AND kind='resolve'
   UNION ALL SELECT id,version,actor_kind,operator_id AS actor_id,resolution,effect_until,restriction_action,created_at FROM forum_operations_events_v1
   WHERE report_id=$1 AND retained_until>$2 ORDER BY version`,[row.id,operationsStamp(this.now())])).rows:[];
  const names=await operationsOperatorNamesWithin(db,{endpoint:this.endpoint,operatorIds:[...decisions.map(event=>event.operator_id),...decisionRows.filter(event=>event.actor_kind==='business-operator').map(event=>event.actor_id)]});
  for(const event of decisions)events.push({id:event.id,version:event.version,kind:'resolve',actorKind:event.actor_kind,operatorId:event.operator_id,operatorDisplayName:names.get(event.operator_id)??null,resolution:event.resolution,summary:event.summary,
   restrictionAction:event.restriction_action??null,effectUntil:operationsIso(event.effect_until),createdAt:operationsIso(event.created_at)});
  const decisionView=value=>value?{id:value.id,version:value.version,actorKind:value.actor_kind,actorId:value.actor_id,operatorDisplayName:value.actor_kind==='business-operator'?names.get(value.actor_id)??null:null,resolution:value.resolution,
   restrictionAction:value.restriction_action,effectUntil:operationsIso(value.effect_until),createdAt:operationsIso(value.created_at)}:null;
  return {...base,source,events:events.sort((a,b)=>a.version-b.version),initialDecision:decisionView(decisionRows[0]),currentDecision:decisionView(decisionRows.find(event=>event.id===row.decision_event_id)),
   resultDelivery:{channel:'original-case-read',state:'readable',notification:'not-connected'},legacyPrivateNarrativeGranted:false,originalAudienceChanged:false};
 }
 reports(operator,input={}){const q=operationsParse(operationsReportsQuerySchema,input);return this.run(operator,false,'community-reports-query',q,async(db,actor)=>{
  const rows=(await db.query('SELECT * FROM forum_reports_v1 WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR state=$2) ORDER BY id LIMIT $3',[q.after??null,q.state??null,q.limit+1])).rows,selected=rows.slice(0,q.limit),items=[];
  for(const row of selected)items.push(await this.reportViewWithin(db,row,actor));return {items,nextAfter:rows.length>q.limit?selected.at(-1).id:null,checkedAt:this.now(),readExpiresAt:Math.min(this.now()+30,...items.map(item=>item.readExpiresAt))};
 });}
 report(operator,id){return this.run(operator,false,'community-report-read',{id},async(db,actor)=>this.reportViewWithin(db,await this.reportWithin(db,id),actor,{detail:true}));}
 resolve(operator,id,input){const x=operationsParse(operationsForumDecisionSchema,input);operationsParse(z.uuid(),id);const {summary,...metadata}=x;
  // Keep the case explanation in its bounded case record, not a second body
  // copy in the general operations audit. The intent digest preserves exact
  // same-operation retries after the explanation has reached its retention.
  return this.command(operator,'community-report-resolve',{id,...metadata,summaryDigest:digest(summary)},async(db,actor)=>{
  const row=await this.reportWithin(db,id,true),view=await this.reportViewWithin(db,row,actor,{detail:true});
  if(row.version!==x.expectedVersion)operationsFail('forum_report_version_conflict');if(!view.canModerate)operationsFail('forum_independent_handler_required',403);
  if((await db.query('SELECT 1 FROM forum_governance_events_v1 WHERE id=$1 OR operation_id=$1',[x.operationId])).rows.length)operationsFail('business_admin_operation_conflict');
  if(x.hideUntil!==undefined){
   if(x.resolution!=='accepted'||x.hideUntil<=this.now()||x.hideUntil>this.now()+this.maxHideSeconds||view.source.availability!=='available'||x.hideUntil>view.source.publishedUntil)operationsFail('forum_hide_expiry');
  }
  const restrictionAction=x.restrictionAction??(x.hideUntil!==undefined?'hide':'keep');
  if(restrictionAction==='release'&&!view.currentEffect.canRelease)operationsFail('forum_case_restriction_unavailable');
  const version=row.version+1,at=operationsStamp(this.now()),until=restrictionAction==='hide'?operationsStamp(x.hideUntil):restrictionAction==='release'?null:operationsIso(row.restriction_until),
   restrictionEventId=restrictionAction==='hide'?x.operationId:restrictionAction==='release'?null:row.restriction_event_id,retained=operationsStamp(this.now()+this.forum.policy.auditDays*86400);
  await db.query(`INSERT INTO forum_operations_events_v1(id,report_id,operator_id,http_request_id,version,resolution,summary,effect_until,created_at,retained_until,restriction_action,actor_kind)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[x.operationId,id,actor.operatorId,actor.httpRequestId??null,version,x.resolution,x.summary,until,at,retained,restrictionAction,actor.kind]);
  await db.query(`UPDATE forum_reports_v1 SET version=$2,state='resolved',decision_event_id=$3,restriction_event_id=$4,restriction_until=$5,closed_at=$6,audit_until=$7 WHERE id=$1`,[id,version,x.operationId,restrictionEventId,until,at,retained]);
  return {reportId:id,version,state:'resolved',resolution:x.resolution,restrictionAction,restrictionEventId,effectUntil:until,actorKind:actor.kind,operatorId:actor.operatorId,
   resultDelivery:{channel:'original-case-read',state:'readable',notification:'not-connected'}};
 });}
}
