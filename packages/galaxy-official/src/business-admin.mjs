import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {businessOperatorSchema,operationsExecutorSchema,businessUsersQuerySchema,businessSummaryQuerySchema,businessAuditQuerySchema,businessRestrictionSchema,businessReleaseRestrictionSchema,businessTypeChangeSchema} from './shared/business-admin-schema.mjs';
import {businessRestrictionView,changeAccountRestrictionWithin,changeAccountTypeWithin} from './business-admin-domain.mjs';
import {businessAuditMetadata} from './business-admin-audit-view.mjs';
import {businessAuditActorContext,withBusinessAuditAttribution} from './business-admin-audit-attribution.mjs';
import {withPermissionAuditLinks} from './business-admin-permission-audit-links.mjs';
import {BusinessAuditPages,businessAuditReadActions,businessAuditBusinessActions} from './business-admin-audit-pages.mjs';
import {operationsAnalyticsPeriod,publicForumActivityWithin} from './operations-analytics.mjs';
import {operationActionPermissions,hasOperationsPermission} from './operations-permission-catalog.mjs';
import {inheritOperationsAiUse} from './shared/operations-ai-use.mjs';
import {aiActionDefinition} from './shared/operations-ai-action-registry.mjs';

const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_business_admin_request');return result.data;};
const stamp=value=>value?new Date(value).toISOString():null;
const accountKey=row=>JSON.stringify([row.issuer,row.external_subject]);
const linkPageSchema=z.strictObject({after:z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(),limit:z.number().int().min(1).max(100).default(20)});
const historyPageSchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value=>Number(value)<=2147483647).optional(),limit:z.number().int().min(1).max(100).default(100)});
const restrictionReceipt=z.strictObject({scope:z.literal('community-participation'),active:z.boolean(),until:z.iso.datetime({offset:true}).nullable(),reason:z.string().max(2000).nullable(),revision:z.number().int().nonnegative()});
const operationResults={
 'type-change':z.strictObject({accountId:z.uuid(),previousType:z.enum(['person','organization','agent']).nullable(),subjectType:z.enum(['person','organization','agent']),revision:z.number().int().positive(),basisKind:z.literal('operator-recorded-statement'),permissionsChanged:z.literal(false),operationId:z.uuid(),recordedAt:z.iso.datetime({offset:true})}),
 'restriction-set':z.strictObject({accountId:z.uuid(),before:restrictionReceipt,restriction:restrictionReceipt,operationId:z.uuid(),recordedAt:z.iso.datetime({offset:true})}),
 'restriction-release':z.strictObject({accountId:z.uuid(),before:restrictionReceipt,restriction:restrictionReceipt,operationId:z.uuid(),recordedAt:z.iso.datetime({offset:true})})
};
const operationInputs={'type-change':businessTypeChangeSchema,'restriction-set':businessRestrictionSchema,'restriction-release':businessReleaseRestrictionSchema};
const columns=`a.id,a.uid,a.endpoint,a.issuer,a.external_subject,a.verification_method,a.verified_at,a.created_at,
 a.restricted_until,a.restriction_reason,a.restriction_revision,p.display_name,p.avatar_key,p.bio,p.subject_type,p.revision,
 p.query_enabled,p.query_scope,p.query_linked_ids,p.query_external_credentials`;

async function mapLimited(rows,read){
 const result=Array.from({length:rows.length});let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{for(;;){const index=cursor++;if(index>=rows.length)return;result[index]=await read(rows[index]);}}));
 return result;
}

// A verified operations principal is not a Galaxy ID or an account-owner
// principal. The HTTP adapter obtains it afresh from the server authorizer.
export class BusinessAdminService {
 constructor({db,endpoint,identityDirectory=null,operatorAuthorization=null,permissions=null,executorAuthority=null,executorGateway=null,forum=null,accountUsageAnalysis=null,accountProfileAnalysis=null,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,identityDirectory,operatorAuthorization,permissions,executorAuthority,executorGateway,forum,accountUsageAnalysis,accountProfileAnalysis,now});this.auditPages=new BusinessAuditPages({db,endpoint,now});}
 require(operator,{write:_write=false}={}){
  if(operator?.kind==='operations-ai-service'){
   if(operator.endpoint!==this.endpoint||!this.executorAuthority?.acceptsDuty(operator))throw new ServiceError('business_admin_denied',403);
   return operator;
  }
  if(operator?.kind==='operations-executor'){
   if(!operationsExecutorSchema.safeParse(operator).success||operator.endpoint!==this.endpoint||!this.executorAuthority?.accepts(operator))throw new ServiceError('business_admin_denied',403);
   return operator;
  }
  const parsed=businessOperatorSchema.safeParse(operator);if(!parsed.success)throw new ServiceError('business_admin_denied',403);const actor=parsed.data;
  if(actor.endpoint!==this.endpoint)throw new ServiceError('business_admin_denied',403);
  return inheritOperationsAiUse(operator,actor);
 }
 async authorizeAction(operator,action,{db=this.db}={}){
  const actor=this.require(operator);if(!this.permissions)throw new ServiceError('operations_authorization_unavailable',503);
  if(actor.kind==='operations-ai-service')return this.executorAuthority.requireDutyAction(actor,action,{db});
  if(actor.kind==='operations-executor')return this.executorAuthority.requireAction(actor,action,{db});
  return this.permissions.requireAction(actor,action,{db});
 }
 async authorizeOperation(operator,action,selection={},options={}){
  const required=operationActionPermissions(action,selection);if(!required.length)throw new ServiceError('operations_permission_unknown',403);
  if(operator?.kind==='operations-ai-service'){
   this.require(operator);if(action==='community-content-batch-preview'||required.every(code=>aiActionDefinition(code)?.query)){
    let actor=operator;for(const code of required)actor=await this.executorAuthority.requireDutyAction(actor,code,options);return actor;
   }
   return this.executorAuthority.requireDutyOperation(operator,required,selection,{...options,action});
  }
  if(operator?.kind==='operations-executor'){
   this.require(operator);const actor=await this.executorAuthority.requireOperation(operator,required,selection,options);
   if(!this.executorGateway)throw new ServiceError('operations_authorization_unavailable',503);
   await this.executorGateway.guardOperationWithin(options.db??this.db,actor,action,selection);return actor;
  }
  let actor=operator;for(const code of required)actor=await this.authorizeAction(actor,code,options);return actor;
 }
 async revalidate(operator,{write:_write=false,action=null,db=this.db}={}){
  if(action)return this.authorizeAction(operator,action,{db});
  const actor=this.require(operator);if(!this.permissions)throw new ServiceError('operations_authorization_unavailable',503);
  if(actor.kind==='operations-ai-service')return this.executorAuthority.requireDutyAction(actor,'workbench.read',{db});
  if(actor.kind==='operations-executor')return this.executorAuthority.actor(actor.executionId,{db,resourceIds:actor.resourceIds,from:actor});
  const effective=await this.permissions.effective(actor,{db});
  return inheritOperationsAiUse(actor,{...Object.fromEntries(Object.entries(actor)),role:effective.role,businessAuthorization:{version:effective.version,permissions:effective.permissions}});
 }
 async accountWithin(db,id,{lock=false}={}){
  parse(z.uuid(),id);
  const row=(await db.query(`SELECT ${columns} FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
   WHERE a.id=$1 AND a.endpoint=$2${lock?' FOR UPDATE OF a':''}`,[id,this.endpoint])).rows[0];
  if(!row)throw new ServiceError('not_found',404);return row;
 }
 async recordWithin(db,actor,action,{accountId=null,operationId=null,selection={},result={}}={}){
  // Executor attribution is explicit and remains separate from management
  // eligibility. No reader/administrator role is fabricated for an engine.
  const context=businessAuditActorContext(this.executorAuthority,actor);
  const row=(await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING sequence`,
  [randomUUID(),this.endpoint,actor.operatorId,actor.role,action,accountId,operationId,actor.httpRequestId??null,JSON.stringify(selection),JSON.stringify(result),new Date(this.now()*1000).toISOString(),actor.kind,actor.executionId??null,actor.grantId??null,context?JSON.stringify(context):null])).rows[0];
  return String(row.sequence);
 }
 async identityFor(row,known=new Map()){
  const base={issuer:row.issuer,externalSubject:row.external_subject,email:null,emailVerified:null,enabled:null};
  if(!this.identityDirectory)return {...base,state:'not-configured'};
  try{
   const identity=known.has(accountKey(row))?known.get(accountKey(row)):await this.identityDirectory.get({issuer:row.issuer,externalSubject:row.external_subject});
   if(!identity)return {...base,state:'not-found'};
   if(identity.issuer!==row.issuer||identity.externalSubject!==row.external_subject)throw Error('identity_directory_mismatch');
   return {...base,state:'available',email:typeof identity.email==='string'&&identity.email.length<=320?identity.email:null,
    emailVerified:typeof identity.emailVerified==='boolean'?identity.emailVerified:null,enabled:typeof identity.enabled==='boolean'?identity.enabled:null};
  }catch{return {...base,state:'temporarily-unavailable'};}
 }
 async linksSummaryWithin(db,accountId){
  const result=(await db.query(`SELECT count(*) FILTER(WHERE active)::integer AS active,count(*) FILTER(WHERE NOT active)::integer AS revoked FROM (
   SELECT g.subject_id,bool_or(l.revoked_at IS NULL) AS active FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id
   WHERE g.account_id=$1 AND l.endpoint=$2 GROUP BY g.subject_id) links`,[accountId,this.endpoint])).rows[0];
  return {activeCount:result.active,revokedCount:result.revoked};
 }
 async itemWithin(db,row,known,actor){return {accountId:row.id,uid:row.uid,displayName:row.display_name??null,avatarKey:row.avatar_key??null,subjectType:row.subject_type??null,profileRevision:row.revision??0,
  createdAt:stamp(row.created_at),verifiedAt:stamp(row.verified_at),identity:hasOperationsPermission(actor,'accounts.identity.read')?await this.identityFor(row,known):{issuer:row.issuer,externalSubject:row.external_subject,email:null,emailVerified:null,enabled:null,state:'not-authorized'},
  restriction:businessRestrictionView(row,this.now()),links:await this.linksSummaryWithin(db,row.id)};}
 async list(operator,input={}){
  const actor=await this.authorizeAction(operator,'accounts.read'),query=parse(businessUsersQuerySchema,input),email=z.email().safeParse(query.query).success,known=new Map();let matches=[];
  if(email){
   await this.authorizeAction(actor,'accounts.identity.read');
   if(!this.identityDirectory)throw new ServiceError('identity_directory_unavailable',503);
   try{
    const found=await this.identityDirectory.findByEmail(query.query);
    if(!Array.isArray(found)||found.length>1000)throw Error();
    matches=found.filter(row=>typeof row.issuer==='string'&&typeof row.externalSubject==='string'&&row.externalSubject.length>0&&row.externalSubject.length<=255)
     .map(row=>{known.set(JSON.stringify([row.issuer,row.externalSubject]),row);return {issuer:row.issuer,externalSubject:row.externalSubject};});
   }catch{throw new ServiceError('identity_directory_unavailable',503);}
  }
  const rows=(await this.db.query(`SELECT ${columns} FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
   WHERE a.endpoint=$1 AND ($2::text IS NULL OR a.uid>$2) AND
   CASE WHEN $3::boolean THEN EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) candidate WHERE candidate->>'issuer'=a.issuer AND candidate->>'externalSubject'=a.external_subject)
    ELSE $5::text='' OR position(lower($5::text) in lower(coalesce(p.display_name,'')))>0 OR position(upper($5::text) in a.uid)>0 OR a.id::text=$5::text END
   AND ($7::text IS NULL OR CASE WHEN $7='unknown' THEN p.subject_type IS NULL ELSE p.subject_type=$7 END)
   AND ($8::text IS NULL OR CASE WHEN $8='restricted' THEN a.restricted_until>$9::timestamptz ELSE a.restricted_until IS NULL OR a.restricted_until<=$9::timestamptz END)
   ORDER BY a.uid LIMIT $6`,[this.endpoint,query.after??null,email,JSON.stringify(matches),query.query,query.limit+1,query.subjectType??null,query.restriction??null,stamp(this.now()*1000)])).rows;
  const selected=rows.slice(0,query.limit),items=await mapLimited(selected,row=>this.itemWithin(this.db,row,known,actor));
  await this.authorizeAction(actor,'accounts.read');
  if(hasOperationsPermission(actor,'accounts.identity.read'))await this.authorizeAction(actor,'accounts.identity.read');
  await this.recordWithin(this.db,actor,'users-query',{selection:{queryKind:email?'email':query.query?'uid-or-username':'all',after:query.after??null,limit:query.limit,subjectType:query.subjectType??null,restriction:query.restriction??null},result:{accountIds:items.map(item=>item.accountId),count:items.length}});
  return {items,nextAfter:rows.length>query.limit?selected.at(-1).uid:null,checkedAt:this.now(),permissions:this.accountCapabilities(actor)};
 }
 accountCapabilities(actor){return {canManage:['accounts.type.change','accounts.restriction.apply','accounts.restriction.release'].some(code=>hasOperationsPermission(actor,code)),canChangeType:hasOperationsPermission(actor,'accounts.type.change'),canRestrict:hasOperationsPermission(actor,'accounts.restriction.apply'),canRelease:hasOperationsPermission(actor,'accounts.restriction.release'),canReadIdentity:hasOperationsPermission(actor,'accounts.identity.read')};}
 async directorySummary(operator,input={}){
  const actor=await this.authorizeAction(operator,'analytics.read'),{days}=parse(businessSummaryQuerySchema,input),now=this.now(),window=operationsAnalyticsPeriod(now,days);
  return transaction(this.db,async db=>{
   const row=(await db.query(`SELECT count(*)::integer AS accounts,
    count(*) FILTER(WHERE p.subject_type='person')::integer AS person,
    count(*) FILTER(WHERE p.subject_type='agent')::integer AS agent,
    count(*) FILTER(WHERE p.subject_type='organization')::integer AS organization,
    count(*) FILTER(WHERE p.subject_type IS NULL)::integer AS unknown,
    count(*) FILTER(WHERE a.restricted_until>$2::timestamptz)::integer AS restricted
    FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.endpoint=$1`,[this.endpoint,stamp(now*1000)])).rows[0];
   await this.recordWithin(db,actor,'users-query',{selection:{view:'directory-summary',days},result:{count:row.accounts}});
   return {checkedAt:now,days,period:window.period,coverage:'business-service-accounts',totals:{...row,active:null}};
  });
 }
 async accountSummary(operator,accountId,input={}){
  const actor=await this.authorizeAction(operator,'analytics.read'),{days}=parse(businessSummaryQuerySchema,input);
  // Discovery's native reads have their own before/after authorization and
  // must finish outside this PG transaction, including on a one-client store.
  const usageAnalysis=this.accountUsageAnalysis?await this.accountUsageAnalysis.get(actor,accountId,{days}):null,
   profileAnalysis=this.accountProfileAnalysis?await this.accountProfileAnalysis.get(actor,accountId,{days}):null,now=this.now(),window=operationsAnalyticsPeriod(now,days);
  return transaction(this.db,async db=>{
   await this.accountWithin(db,accountId);
   const activity=await publicForumActivityWithin(db,{forum:this.forum,endpoint:this.endpoint,now,days,accountId});
   const currentActor=await this.authorizeAction(actor,'analytics.read',{db});
   await this.recordWithin(db,actor,'user-read',{accountId,selection:{view:'usage-summary',days},result:{publicActivityState:activity.state}});
   const prediction=()=>({state:'not-analyzed',label:null,summary:null});
   return {accountId,checkedAt:now,readExpiresAt:Math.min(now+30,usageAnalysis?.readExpiresAt??now+30,profileAnalysis?.readExpiresAt??now+30),days,period:window.period,usageAnalysis,
    usage:{activeDays:null,searches:null,bookmarks:null,participation:null,
     publicContributions:activity.available?activity.totals.posts+activity.totals.replies:null,
     lastActivityAt:activity.lastActivityAt,
     dailyActivity:activity.available?activity.daily.map(row=>({date:row.date,count:row.posts+row.replies})):window.dates.map(date=>({date,count:null})),
     basis:activity.basis,publicActivityState:activity.state,publicActivityReason:activity.reason},
    profile:profileAnalysis?.profile??{state:'not-analyzed',interests:[],needs:[],sourceTypes:[],updatedAt:null,validUntil:null},
    predictions:{participation:prediction(),needs:prediction()},
     recommendations:profileAnalysis&&!hasOperationsPermission(currentActor,'recommendations.read')?{...profileAnalysis.recommendations,state:'not-authorized',categories:[],updatedAt:null,basis:{...profileAnalysis.recommendations.basis,complete:false,reasonCodes:['not-authorized']}}:profileAnalysis?.recommendations??{state:'not-analyzed',categories:[],updatedAt:null}};
  },{isolation:'repeatable read'});
 }
 async linkedIdsWithin(db,accountId,input={}){
  const page=parse(linkPageSchema,input),rows=(await db.query(`SELECT g.subject_id,min(g.created_at) AS linked_at,
   CASE WHEN bool_or(l.revoked_at IS NULL) THEN NULL ELSE max(l.revoked_at) END AS revoked_at,bool_or(l.revoked_at IS NULL) AS active
   FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id WHERE g.account_id=$1 AND l.endpoint=$2
   AND ($3::text IS NULL OR g.subject_id>$3) GROUP BY g.subject_id ORDER BY g.subject_id LIMIT $4`,[accountId,this.endpoint,page.after??null,page.limit+1])).rows;
  return {items:rows.slice(0,page.limit).map(row=>({subjectId:row.subject_id,linkedAt:stamp(row.linked_at),revokedAt:stamp(row.revoked_at),state:row.active?'active':'revoked'})),nextAfter:rows.length>page.limit?rows[page.limit-1].subject_id:null};
 }
 async get(operator,accountId){
  const actor=await this.authorizeAction(operator,'accounts.read'),row=await this.accountWithin(this.db,accountId),account=await this.itemWithin(this.db,row,undefined,actor);
  const history=await this.typeHistoryWithin(this.db,accountId);
  const linkedIds=await this.linkedIdsWithin(this.db,accountId);
  await this.authorizeAction(actor,'accounts.read');
  if(hasOperationsPermission(actor,'accounts.identity.read'))await this.authorizeAction(actor,'accounts.identity.read');
  await this.recordWithin(this.db,actor,'user-read',{accountId,result:{view:'business-account-metadata'}});
  return {account,profile:{revision:row.revision??0,avatarKey:row.avatar_key??null,bio:row.bio??'',publicQuery:{enabled:row.query_enabled===true,scope:row.query_scope??'profile',showLinkedIds:row.query_linked_ids===true,showExternalCredentials:row.query_external_credentials===true}},
   typeHistory:history.items,typeHistoryNextAfter:history.nextAfter,linkedIds,checkedAt:this.now(),permissions:this.accountCapabilities(actor)};
 }
 async typeHistoryWithin(db,accountId,input={}){
  const page=parse(historyPageSchema,input),rows=(await db.query(`SELECT revision,previous_type,next_type,reason,basis,created_at,actor_kind,operator_id
   FROM official_account_type_history_v1 WHERE account_id=$1 AND ($2::integer IS NULL OR revision<$2) ORDER BY revision DESC LIMIT $3`,[accountId,page.after??null,page.limit+1])).rows;
  return {items:rows.slice(0,page.limit).map(history=>({previousType:history.previous_type,nextType:history.next_type,revision:history.revision,reason:history.reason,basis:history.basis,
   createdAt:stamp(history.created_at),actorKind:history.actor_kind,operatorId:history.operator_id})),nextAfter:rows.length>page.limit?String(rows[page.limit-1].revision):null};
 }
 async typeHistory(operator,accountId,input={}){
  const actor=await this.authorizeAction(operator,'accounts.read');await this.accountWithin(this.db,accountId);const result=await this.typeHistoryWithin(this.db,accountId,input);
  await this.recordWithin(this.db,actor,'user-read',{accountId,selection:{view:'type-history',after:input.after??null},result:{count:result.items.length}});
  return {...result,checkedAt:this.now()};
 }
 async links(operator,accountId,input={}){
  const actor=await this.authorizeAction(operator,'accounts.read');await this.accountWithin(this.db,accountId);const result=await this.linkedIdsWithin(this.db,accountId,input);
  await this.recordWithin(this.db,actor,'user-read',{accountId,selection:{view:'association-metadata',after:input.after??null},result:{subjectIds:result.items.map(row=>row.subjectId)}});
  return {...result,checkedAt:this.now()};
 }
 async audit(operator,input={}){
  const actor=await this.authorizeAction(operator,'audit.read'),query=parse(businessAuditQuerySchema,input);
  if(['page','pageSize','snapshot','sort'].some(key=>query[key]!==undefined)){
   try{
    const result=await this.auditPages.read(actor,query);await this.authorizeAction(actor,'audit.read');
    await this.recordWithin(this.db,actor,'audit-read',{accountId:query.accountId??null,
     selection:{resourceId:query.resourceId??null,limit:result.pagination.pageSize,kind:query.kind,action:query.action??null,day:query.day??null,hasQuery:!!query.query,page:result.pagination.page},result:{count:result.items.length}});
    return result;
   }catch(error){if([401,403].includes(error?.status))this.auditPages.forget(actor);throw error;}
  }
  // Existing account-history and tool callers keep their explicit sequence
  // cursor contract. The full audit page opts into snapshots with page keys.
  query.limit??=30;
  const reads=businessAuditReadActions,business=businessAuditBusinessActions;
  if(query.action&&![...reads,...business].includes(query.action))throw new ServiceError('invalid_business_admin_request');
  // Only controlled action codes populate the menu. A dirty/unknown historical
  // string must not become a new display or keyword channel through a facet.
  const actions=(await this.db.query(`SELECT DISTINCT action FROM business_admin_audit_v1
   WHERE endpoint=$1 AND action=ANY($2::text[]) ORDER BY action`,[this.endpoint,[...reads,...business]])).rows.map(row=>row.action);
  const kindActions=query.kind==='reads'?reads:query.kind==='business'?business:null;
  const projecting=!!(query.resourceId||query.query),maximum=projecting?500:query.limit;
  const linkedRows=await withPermissionAuditLinks(this.db,{endpoint:this.endpoint,rows:(await this.db.query(`SELECT a.*,NULLIF(BTRIM(p.display_name),'') AS operator_display_name
   FROM business_admin_audit_v1 a LEFT JOIN operations_operator_principals_v1 p
    ON p.operator_id=a.operator_id AND p.endpoint=a.endpoint AND a.actor_kind='business-operator'
   WHERE a.endpoint=$1 AND ($2::uuid IS NULL OR a.account_id=$2)
   AND ($3::bigint IS NULL OR a.sequence<$3) AND ($5::text IS NULL OR a.action=$5)
   AND ($6::text[] IS NULL OR a.action=ANY($6))
   AND ($7::date IS NULL OR (a.created_at>=($7::date::timestamp AT TIME ZONE 'Asia/Shanghai')
    AND a.created_at<(($7::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
   ORDER BY a.sequence DESC LIMIT $4`,[this.endpoint,query.accountId??null,query.after??null,maximum+1,query.action??null,kindActions,query.day??null])).rows});
  const rows=await withBusinessAuditAttribution(this.db,{endpoint:this.endpoint,rows:linkedRows,canReadTasks:hasOperationsPermission(actor,'autonomy.read')});
  const resourceKeys=['resourceId','id','sectionId','reportId','projectId','methodId','fileId','feedbackId','noticeId','runId','jobId','planId','modelRecordId','roleId','versionId'];
  const scalarValues=value=>Array.isArray(value)?value.flatMap(scalarValues):value&&typeof value==='object'?Object.values(value).flatMap(scalarValues):
   ['string','number','boolean'].includes(typeof value)?[String(value)]:[];
  const needle=query.query.toLocaleLowerCase('zh-CN'),matches=[];
  let inspected=0;
  for(const row of rows.slice(0,projecting?maximum:maximum+1)){
   inspected++;
   // Search the same closed projection that may leave the service. Never use
   // selection/result::text: even a match could disclose hidden stored prose.
   const item=businessAuditMetadata(row);
   if(query.resourceId&&![...resourceKeys.map(key=>item.selection[key]),item.attribution?.taskId,item.attribution?.cardId].some(id=>typeof id==='string'&&id.toLowerCase()===query.resourceId.toLowerCase()))continue;
   if(needle&&!scalarValues(item).some(value=>value.toLocaleLowerCase('zh-CN').includes(needle)))continue;
   matches.push(item);if(matches.length>query.limit)break;
  }
  const items=matches.slice(0,query.limit),scanLimited=projecting&&matches.length<=query.limit&&rows.length>maximum;
  const nextAfter=matches.length>query.limit?String(items.at(-1).sequence):scanLimited?String(rows[inspected-1].sequence):null;
  await this.authorizeAction(actor,'audit.read');
  await this.recordWithin(this.db,actor,'audit-read',{accountId:query.accountId??null,
   selection:{resourceId:query.resourceId??null,after:query.after??null,limit:query.limit,kind:query.kind,action:query.action??null,day:query.day??null,hasQuery:!!query.query},result:{count:items.length}});
  return {items,nextAfter,checkedAt:this.now(),metadataOnly:true,actions,scanLimited};
 }
 async operation(operator,accountId,operationId){
  const actor=await this.authorizeAction(operator,'accounts.read');parse(z.uuid(),accountId);parse(z.uuid(),operationId);
  if(actor.kind!=='business-operator'&&!this.executorAuthority?.acceptsDuty(actor))throw new ServiceError('business_admin_denied',403);
  return transaction(this.db,async db=>{
   await this.authorizeAction(actor,'accounts.read',{db});await this.accountWithin(db,accountId);
   const row=(await db.query('SELECT operator_id,account_id,action,selection,result,created_at FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,operationId])).rows[0];
   const metadata={operationId,accountId,checkedAt:this.now(),readExpiresAt:this.now()+30,metadataOnly:true};
   if(!row){await this.authorizeAction(actor,'accounts.read',{db});return{state:'not-recorded',...metadata,action:null,selection:null,result:null,recordedAt:null};}
   if(row.operator_id!==actor.operatorId||row.account_id!==accountId||!Object.hasOwn(operationInputs,row.action))throw new ServiceError('not_found',404);
   const input=operationInputs[row.action].safeParse(row.selection),output=operationResults[row.action].safeParse(row.result);
   if(!input.success||!output.success||input.data.operationId!==operationId||output.data.operationId!==operationId||output.data.accountId!==accountId)throw new ServiceError('business_admin_operation_unavailable',503);
   const selection=input.data,result=output.data;
   const bound=row.action==='type-change'?result.revision===selection.expectedRevision+1&&result.subjectType===selection.subjectType
    :result.before.revision===selection.expectedRevision&&result.restriction.revision===selection.expectedRevision+1
     &&(row.action==='restriction-set'?Date.parse(result.restriction.until)===Date.parse(selection.until)&&result.restriction.active===true&&result.restriction.reason===selection.reason
      :result.restriction.until===null&&result.restriction.active===false&&result.restriction.reason===null);
   if(!bound){
    // Old or malformed data cannot become an unbound success response.
    throw new ServiceError('business_admin_operation_unavailable',503);
   }
   await this.authorizeAction(actor,'accounts.read',{db});
   return{state:'recorded',...metadata,action:row.action,selection,result,recordedAt:result.recordedAt};
  });
 }
 async execute(operator,accountId,action,data,operation){
  this.require(operator);parse(z.uuid(),accountId);
  return transaction(this.db,async db=>{
   const actor=await this.authorizeOperation(operator,action,{...data,accountId},{db});
   // Stable command IDs serialize only the same command. The recorded input is
   // compared directly; a retry cannot replace its target, operator or intent.
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.endpoint+':business-admin:'+data.operationId]);
   const previous=(await db.query('SELECT * FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,data.operationId])).rows[0];
   if(previous){
    if(previous.operator_id!==actor.operatorId||previous.account_id!==accountId||previous.action!==action||!isDeepStrictEqual(previous.selection,data))throw new ServiceError('business_admin_operation_conflict',409);
    return {...previous.result,replayed:true};
   }
   await this.accountWithin(db,accountId,{lock:true});
   const result={...await operation(db,actor),operationId:data.operationId,recordedAt:new Date(this.now()*1000).toISOString()};
   await this.recordWithin(db,actor,action,{accountId,operationId:data.operationId,selection:data,result});return result;
  });
 }
 async restrict(operator,accountId,input){const data=parse(businessRestrictionSchema,input);
  return this.execute(operator,accountId,'restriction-set',data,(db,actor)=>changeAccountRestrictionWithin(db,{accountId,endpoint:this.endpoint,now:this.now(),source:actor,input:data,permissions:this.permissions}));}
 async releaseRestriction(operator,accountId,input){const data=parse(businessReleaseRestrictionSchema,input);
  return this.execute(operator,accountId,'restriction-release',data,(db,actor)=>changeAccountRestrictionWithin(db,{accountId,endpoint:this.endpoint,now:this.now(),source:actor,input:data,release:true,permissions:this.permissions}));}
 async changeType(operator,accountId,input){const data=parse(businessTypeChangeSchema,input),change={expectedRevision:data.expectedRevision,subjectType:data.subjectType,reason:data.reason,basis:data.basis,preserveHistory:data.preserveHistory};
  return this.execute(operator,accountId,'type-change',data,(db,actor)=>changeAccountTypeWithin(db,{accountId,endpoint:this.endpoint,now:this.now(),source:actor,input:change,permissions:this.permissions}));}
}
