import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {businessOperatorSchema,businessUsersQuerySchema,businessAuditQuerySchema,businessRestrictionSchema,businessReleaseRestrictionSchema,businessTypeChangeSchema} from './shared/business-admin-schema.mjs';
import {businessRestrictionView,changeAccountRestrictionWithin,changeAccountTypeWithin} from './business-admin-domain.mjs';

const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_business_admin_request');return result.data;};
const stamp=value=>value?new Date(value).toISOString():null;
const accountKey=row=>JSON.stringify([row.issuer,row.external_subject]);
const linkPageSchema=z.strictObject({after:z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(),limit:z.number().int().min(1).max(100).default(20)});
const historyPageSchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,9}$/).refine(value=>Number(value)<=2147483647).optional(),limit:z.number().int().min(1).max(100).default(100)});
const columns=`a.id,a.uid,a.endpoint,a.issuer,a.external_subject,a.verification_method,a.verified_at,a.created_at,
 a.restricted_until,a.restriction_reason,a.restriction_revision,p.display_name,p.subject_type,p.revision,
 p.query_enabled,p.query_scope,p.query_linked_ids,p.query_external_credentials`;
const auditView=row=>({id:row.id,sequence:String(row.sequence),operatorId:row.operator_id,operatorRole:row.operator_role,
 action:row.action,accountId:row.account_id,operationId:row.operation_id,httpRequestId:row.http_request_id,
 selection:row.selection,result:row.result,createdAt:stamp(row.created_at)});

async function mapLimited(rows,read){
 const result=new Array(rows.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{for(;;){const index=cursor++;if(index>=rows.length)return;result[index]=await read(rows[index]);}}));
 return result;
}

// A verified operations principal is not a Galaxy ID or an account-owner
// principal. The HTTP adapter obtains it afresh from the server authorizer.
export class BusinessAdminService {
 constructor({db,endpoint,identityDirectory=null,operatorAuthorization=null,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,identityDirectory,operatorAuthorization,now});}
 require(operator,{write=false}={}){
  const parsed=businessOperatorSchema.safeParse(operator);if(!parsed.success)throw new ServiceError('business_admin_denied',403);const actor=parsed.data;
  if(actor.endpoint!==this.endpoint||write&&actor.role!=='administrator')throw new ServiceError('business_admin_denied',403);
  return actor;
 }
 async revalidate(operator,{write=false,db=this.db}={}){
  const actor=this.require(operator);
  if(typeof this.operatorAuthorization!=='function')throw new ServiceError('operations_authorization_unavailable',503);
  const role=await this.operatorAuthorization(actor,{db});
  return this.require({...actor,role},{write});
 }
 async accountWithin(db,id,{lock=false}={}){
  parse(z.uuid(),id);
  const row=(await db.query(`SELECT ${columns} FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
   WHERE a.id=$1 AND a.endpoint=$2${lock?' FOR UPDATE OF a':''}`,[id,this.endpoint])).rows[0];
  if(!row)throw new ServiceError('not_found',404);return row;
 }
 async recordWithin(db,actor,action,{accountId=null,operationId=null,selection={},result={}}={}){
  const row=(await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING sequence`,
  [randomUUID(),this.endpoint,actor.operatorId,actor.role,action,accountId,operationId,actor.httpRequestId??null,JSON.stringify(selection),JSON.stringify(result),new Date(this.now()*1000).toISOString()])).rows[0];
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
 async itemWithin(db,row,known){return {accountId:row.id,uid:row.uid,displayName:row.display_name??null,subjectType:row.subject_type??null,profileRevision:row.revision??0,
  createdAt:stamp(row.created_at),verifiedAt:stamp(row.verified_at),identity:await this.identityFor(row,known),
  restriction:businessRestrictionView(row,this.now()),links:await this.linksSummaryWithin(db,row.id)};}
 async list(operator,input={}){
  const actor=this.require(operator),query=parse(businessUsersQuerySchema,input),email=z.email().safeParse(query.query).success,known=new Map();let matches=[];
  if(email){
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
   ORDER BY a.uid LIMIT $6`,[this.endpoint,query.after??null,email,JSON.stringify(matches),query.query,query.limit+1])).rows;
  const selected=rows.slice(0,query.limit),items=await mapLimited(selected,row=>this.itemWithin(this.db,row,known));
  await this.recordWithin(this.db,actor,'users-query',{selection:{queryKind:email?'email':query.query?'uid-or-username':'all',after:query.after??null,limit:query.limit},result:{accountIds:items.map(item=>item.accountId),count:items.length}});
  return {items,nextAfter:rows.length>query.limit?selected.at(-1).uid:null,checkedAt:this.now(),permissions:{canManage:actor.role==='administrator'}};
 }
 async linkedIdsWithin(db,accountId,input={}){
  const page=parse(linkPageSchema,input),rows=(await db.query(`SELECT g.subject_id,min(g.created_at) AS linked_at,
   CASE WHEN bool_or(l.revoked_at IS NULL) THEN NULL ELSE max(l.revoked_at) END AS revoked_at,bool_or(l.revoked_at IS NULL) AS active
   FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id WHERE g.account_id=$1 AND l.endpoint=$2
   AND ($3::text IS NULL OR g.subject_id>$3) GROUP BY g.subject_id ORDER BY g.subject_id LIMIT $4`,[accountId,this.endpoint,page.after??null,page.limit+1])).rows;
  return {items:rows.slice(0,page.limit).map(row=>({subjectId:row.subject_id,linkedAt:stamp(row.linked_at),revokedAt:stamp(row.revoked_at),state:row.active?'active':'revoked'})),nextAfter:rows.length>page.limit?rows[page.limit-1].subject_id:null};
 }
 async get(operator,accountId){
  const actor=this.require(operator),row=await this.accountWithin(this.db,accountId),account=await this.itemWithin(this.db,row);
  const history=await this.typeHistoryWithin(this.db,accountId);
  const linkedIds=await this.linkedIdsWithin(this.db,accountId);
  await this.recordWithin(this.db,actor,'user-read',{accountId,result:{view:'business-account-metadata'}});
  return {account,profile:{revision:row.revision??0,publicQuery:{enabled:row.query_enabled===true,scope:row.query_scope??'profile',showLinkedIds:row.query_linked_ids===true,showExternalCredentials:row.query_external_credentials===true}},
   typeHistory:history.items,typeHistoryNextAfter:history.nextAfter,linkedIds,checkedAt:this.now(),permissions:{canManage:actor.role==='administrator'}};
 }
 async typeHistoryWithin(db,accountId,input={}){
  const page=parse(historyPageSchema,input),rows=(await db.query(`SELECT revision,previous_type,next_type,reason,basis,created_at,actor_kind,operator_id
   FROM official_account_type_history_v1 WHERE account_id=$1 AND ($2::integer IS NULL OR revision<$2) ORDER BY revision DESC LIMIT $3`,[accountId,page.after??null,page.limit+1])).rows;
  return {items:rows.slice(0,page.limit).map(history=>({previousType:history.previous_type,nextType:history.next_type,revision:history.revision,reason:history.reason,basis:history.basis,
   createdAt:stamp(history.created_at),actorKind:history.actor_kind,operatorId:history.operator_id})),nextAfter:rows.length>page.limit?String(rows[page.limit-1].revision):null};
 }
 async typeHistory(operator,accountId,input={}){
  const actor=this.require(operator);await this.accountWithin(this.db,accountId);const result=await this.typeHistoryWithin(this.db,accountId,input);
  await this.recordWithin(this.db,actor,'user-read',{accountId,selection:{view:'type-history',after:input.after??null},result:{count:result.items.length}});
  return {...result,checkedAt:this.now()};
 }
 async links(operator,accountId,input={}){
  const actor=this.require(operator);await this.accountWithin(this.db,accountId);const result=await this.linkedIdsWithin(this.db,accountId,input);
  await this.recordWithin(this.db,actor,'user-read',{accountId,selection:{view:'association-metadata',after:input.after??null},result:{subjectIds:result.items.map(row=>row.subjectId)}});
  return {...result,checkedAt:this.now()};
 }
 async audit(operator,input={}){
  const actor=this.require(operator),query=parse(businessAuditQuerySchema,input);
  const rows=(await this.db.query(`SELECT * FROM business_admin_audit_v1 WHERE endpoint=$1 AND ($2::uuid IS NULL OR account_id=$2)
   AND ($3::bigint IS NULL OR sequence<$3)
   AND ($5::text IS NULL OR $5=ANY(ARRAY[selection->>'resourceId',selection->>'id',selection->>'sectionId',selection->>'reportId',selection->>'projectId',selection->>'methodId',selection->>'fileId',selection->>'noticeId',selection->>'runId',selection->>'jobId']))
   ORDER BY sequence DESC LIMIT $4`,[this.endpoint,query.accountId??null,query.after??null,query.limit+1,query.resourceId??null])).rows;
  await this.recordWithin(this.db,actor,'audit-read',{accountId:query.accountId??null,selection:{resourceId:query.resourceId??null,after:query.after??null,limit:query.limit},result:{count:Math.min(rows.length,query.limit)}});
  return {items:rows.slice(0,query.limit).map(auditView),nextAfter:rows.length>query.limit?String(rows[query.limit-1].sequence):null,checkedAt:this.now(),metadataOnly:true};
 }
 async execute(operator,accountId,action,data,operation){
  const actor=this.require(operator,{write:true});parse(z.uuid(),accountId);
  return transaction(this.db,async db=>{
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
  return this.execute(operator,accountId,'restriction-set',data,(db,actor)=>changeAccountRestrictionWithin(db,{accountId,endpoint:this.endpoint,now:this.now(),source:actor,input:data}));}
 async releaseRestriction(operator,accountId,input){const data=parse(businessReleaseRestrictionSchema,input);
  return this.execute(operator,accountId,'restriction-release',data,(db,actor)=>changeAccountRestrictionWithin(db,{accountId,endpoint:this.endpoint,now:this.now(),source:actor,input:data,release:true}));}
 async changeType(operator,accountId,input){const data=parse(businessTypeChangeSchema,input),change={expectedRevision:data.expectedRevision,subjectType:data.subjectType,reason:data.reason,basis:data.basis,preserveHistory:data.preserveHistory};
  return this.execute(operator,accountId,'type-change',data,(db,actor)=>changeAccountTypeWithin(db,{accountId,endpoint:this.endpoint,now:this.now(),source:actor,input:change}));}
}
