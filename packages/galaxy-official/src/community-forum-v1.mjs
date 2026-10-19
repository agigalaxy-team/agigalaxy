import * as z from 'zod/v4';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {assertForumIds,forumActorKey,forumActorOwns} from './shared/community-forum-ids-v1.mjs';
import {CommunityForumPermissionsV1,forumStamp,forumSeconds} from './community-forum-permissions-v1.mjs';
import {CommunityForumBudgetV1} from './community-forum-budget-v1.mjs';
import {CommunityForumAccessV2} from './community-forum-access-v2.mjs';
import {CommunityForumSectionsV2} from './community-forum-sections-v2.mjs';
import {legacyForumAudience,forumNotificationsQuerySchema,forumNotificationReadSchema} from './shared/community-forum-access-v2.mjs';
import {forumTopics,forumUnclassifiedTopic} from './shared/community-forum-topics-v1.mjs';
import {forumPageFor,forumPageAfter,forumMatchesQuery} from './community-forum-page-v1.mjs';
import {defaultForumPolicy,forumPolicySchema,forumPolicyHash} from './community-forum-policy-v1.mjs';
import {lockForumOperation,priorForumOperation,recordForumReceipt,recordForumAudit,forumReceiptWithin} from './community-forum-operations-v1.mjs';
import {forumWriteSpec,parseForumPayload,forumCreatePostSchema,forumPublishVersionSchema,forumCreateReplySchema,
 forumWithdrawPostSchema,forumWithdrawVersionSchema,forumWithdrawReplySchema,forumPostsQuerySchema,forumVersionsQuerySchema,forumRepliesQuerySchema,forumReceiptSchema,forumAccountContextSchema,forumAccountChoicesSchema} from './shared/community-forum-v1-schema.mjs';

const validate=(schema,value)=>{const parsed=schema.safeParse(value);if(!parsed.success)throw new ServiceError('invalid_forum_request');return parsed.data;};
const unavailable=(locator,availability,checkedAt)=>({locator,availability,checkedAt});
const authorship=row=>({authorId:row.subject_id??null,authorAccountId:row.account_id??null,
 author:{kind:row.subject_id?'identity':'account',subjectId:row.subject_id??null,accountId:row.account_id??null}});
export class CommunityForumV1 {
 constructor(access,consents,{accounts,publicWrites,policy=defaultForumPolicy}={}){
  Object.assign(this,{access,consents,accounts,publicWrites});this.policy=forumPolicySchema.parse(policy);this.policyHash=forumPolicyHash(this.policy);
  this.permissions=new CommunityForumPermissionsV1(access,consents,{policy:this.policy,policyHash:this.policyHash,accounts});
  this.budget=new CommunityForumBudgetV1(access,accounts,publicWrites,{policy:this.policy,policyHash:this.policyHash});
  this.accessRules=new CommunityForumAccessV2(this);this.sections=new CommunityForumSectionsV2(this);
  this.budget.contextActorWithin=this.contextActorWithin.bind(this);
  this.permissions.contentAudience=this.accessRules.contentWithin.bind(this.accessRules);
 }
 clock(){return this.access.now();}
 runRead(actor,operation){return actor?this.accounts.runAuthorized(actor,actor.kind==='official-account'||actor.scopes?.includes('binding')?'binding':'assistance',operation):transaction(this.access.db,operation);}
 topics(){return {items:forumTopics,unclassified:forumUnclassifiedTopic,checkedAt:this.clock()};}
 async consentWithin(db,actor,authorization,signedIntent){
  if(actor.kind==='official-account'){if(signedIntent!==undefined)throw new ServiceError('invalid_forum_request');return null;}
  if(typeof signedIntent!=='string')throw new ServiceError('forum_signature_evidence_required',403);
  return (await this.consents.createWithin(db,actor,signedIntent,authorization,{forum:true})).consentId;
 }
 writeActor(actor,p){
  if(p.accountId&&actor.accountId&&p.accountId!==actor.accountId)throw new ServiceError(actor.kind==='official-account'?'official_account_changed':'forum_account_target_mismatch',409);
  return {...actor,...(p.accountId?{accountId:p.accountId}:{})};
 }
 async objectActorWithin(db,actor,row,{required=false,lock=false}={}){
  if(!row){if(required)throw new ServiceError('not_found',404);return actor;}
  if(!actor)return null;
  const accountId=row.account_id??row.maintainer_account_id;
  if(!accountId)return actor;
  if(actor.accountId){if(required&&actor.accountId!==accountId)throw new ServiceError('not_found',404);return actor;}
  try{const account=await this.accounts.resolveWithin(db,actor,{accountId,lock});return {...actor,accountId:account.id,accountAuthorized:true};}
  catch(error){if(!['account_target_unavailable','account_verification_required'].includes(error.code))throw error;if(required)throw new ServiceError('not_found',404);return actor;}
 }
 async contextActorWithin(db,actor,input={}){
  const q=validate(forumAccountContextSchema,input);let row;
  if(q.postId)row=await this.head(db,q.postId);
  else if(q.replyId)row=await this.reply(db,q.replyId);
  else if(q.sectionId)row=await this.accessRules.sectionWithin(db,q.sectionId);
  else return actor;
  const target=await this.objectActorWithin(db,actor,row,{required:true});
  if(!row?.maintainer_account_id&&!forumActorOwns(target,row))throw new ServiceError('not_found',404);
  return target;
 }
 async selectWriteAccountWithin(db,actor,p,{owner=null,control=false}={}){
  const ownerAccountId=owner?.account_id??owner?.maintainer_account_id;
  if(ownerAccountId){
   if(actor.accountId&&actor.accountId!==ownerAccountId)throw new ServiceError('not_found',404);
   const account=await this.accounts.resolveWithin(db,actor,{accountId:ownerAccountId,lock:true});
   if(!control&&account.restricted_until&&Date.parse(account.restricted_until)>this.clock()*1000)throw new ServiceError('community_restricted',403);
   return {...actor,accountId:account.id,accountAuthorized:true};
  }
  if(actor.kind!=='official-account'&&!p.accountId&&(await this.accounts.availableWithin(db,actor)).length>1)throw new ServiceError('account_selection_required',409);
  const account=await this.accounts.resolveWithin(db,actor,{lock:true});
  if(!control&&account.restricted_until&&Date.parse(account.restricted_until)>this.clock()*1000)throw new ServiceError('community_restricted',403);
  return {...actor,accountId:account.id,accountAuthorized:true};
 }
 accountChoices(actor,input={}){const q=validate(forumAccountChoicesSchema,input);return this.runRead(actor,async db=>({...await this.accounts.publicChoicesWithin(db,q),checkedAt:this.clock()}));}
 async head(db,id,lock=false){return (await db.query(`SELECT * FROM forum_posts_v1 WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];}
 async version(db,postId,versionId,lock=false){return (await db.query(`SELECT v.*,e.payload_text,e.erased_at event_erased,p.state post_state,p.head_version,p.current_version_id,
  p.created_at post_created_at,p.updated_at post_updated_at
  FROM forum_versions_v1 v JOIN forum_posts_v1 p ON p.id=v.post_id LEFT JOIN forum_events_v1 e ON e.id=v.publication_event_id
  WHERE v.id=$1 AND v.post_id=$2${lock?' FOR UPDATE OF v':''}`,[versionId,postId])).rows[0];}
 async reply(db,id,lock=false){return (await db.query(`SELECT r.*,e.payload_text,e.erased_at event_erased FROM forum_replies_v1 r
  LEFT JOIN forum_events_v1 e ON e.id=r.publication_event_id WHERE r.id=$1${lock?' FOR UPDATE OF r':''}`,[id])).rows[0];}
 checkBounds(payload,kind){
  const p=this.policy;if(payload.title&&[...payload.title].length>p.maxTitleCodePoints||payload.body&&[...payload.body].length>(kind==='create-reply'?p.maxReplyCodePoints:p.maxBodyCodePoints)
   ||payload.links&&(payload.links.length>p.maxLinks||payload.links.some(link=>[...link].length>p.maxLinkCodePoints)))throw new ServiceError('forum_content_limit',413);
 }
 async saveEvent(db,actor,{p,consentId,payloadJson,kind,accountId=null,result}){
  await db.query(`INSERT INTO forum_events_v1(id,subject_id,account_id,kind,post_id,version_id,reply_id,consent_id,payload_text,payload_hash,result,created_at,actor_kind,http_request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[p.operationId,actor.subjectId??null,accountId,kind,p.postId??null,p.versionId??null,p.replyId??null,consentId,payloadJson,digest(payloadJson),JSON.stringify(result),forumStamp(this.clock()),actor.kind==='official-account'?'official-account':'identity',actor.httpRequestId??null]);
 }
 async complete(db,actor,authorization,{p,consentId,payloadJson,kind,accountId=null,category=null,locator,result}){
  await recordForumReceipt(db,actor,{operationId:p.operationId,consentId,payloadJson,accountId,category,locator,result,now:this.clock(),auditDays:this.policy.auditDays});
  await recordForumAudit(db,actor,authorization,{operationId:p.operationId,consentId,action:kind});return result;
 }
 publish(actor,{signedIntent,payloadJson}){
  let raw;try{raw=JSON.parse(payloadJson);}catch{throw new ServiceError('invalid_forum_payload');}
  const kind=raw.expectedHeadVersion===0?'create-post':'publish-version',p=parseForumPayload(payloadJson,kind==='create-post'?forumCreatePostSchema:forumPublishVersionSchema,this.policy.maxPayloadBytes);
  this.checkBounds(p,kind);const spec=forumWriteSpec(kind,p);actor=this.writeActor(actor,p);
  return this.accounts.runAuthorized(actor,'assistance',async(db,authorization,actor)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   await assertForumIds(kind,forumActorKey(actor),p);
   let head=await this.head(db,p.postId);
   if(kind!=='create-post'&&!head)throw new ServiceError('not_found',404);
   actor=await this.selectWriteAccountWithin(db,actor,p,{owner:kind==='create-post'?null:head});
   head=await this.head(db,p.postId,true);
   const state=await this.budget.startWithin(db,actor,kind==='create-post'?'post':'version'),at=forumStamp(this.clock());
   let number,previous=null;
   if(kind==='create-post'){
    if(head)throw new ServiceError('forum_post_conflict',409);number=1;
    await db.query("INSERT INTO forum_posts_v1(id,subject_id,account_id,head_version,state,created_at,updated_at) VALUES($1,$2,$3,1,'published',$4,$4)",[p.postId,actor.subjectId??null,state.account.id,at]);
   }else{
    if(!forumActorOwns(actor,head))throw new ServiceError('not_found',404);
    if(head.state==='withdrawn')throw new ServiceError('forum_post_withdrawn',409);
    if(head.head_version!==p.expectedHeadVersion)throw new ServiceError('forum_head_conflict',409);
    number=Number((await db.query('SELECT coalesce(max(version_number),0)+1 value FROM forum_versions_v1 WHERE post_id=$1',[p.postId])).rows[0].value);
    const latest=(await db.query('SELECT id FROM forum_versions_v1 WHERE post_id=$1 ORDER BY version_number DESC LIMIT 1',[p.postId])).rows[0];
    if(latest)previous=await this.version(db,p.postId,latest.id);
   }
   const publication=await this.accessRules.publicationWithin(db,actor,p,{previous});
   const consentId=await this.consentWithin(db,actor,authorization,signedIntent),permit=await this.permissions.captureWithin(db,actor,{consentId,payloadJson,spec,eventId:p.operationId,accountId:state.account.id,publishedUntil:p.publishedUntil});
   const headVersion=kind==='create-post'?1:head.head_version+1,locator={kind:'post-version',postId:p.postId,versionId:p.versionId,versionNumber:number},
    result={acknowledged:true,postId:p.postId,versionId:p.versionId,versionNumber:number,headVersion,permissionId:permit.id,publishedUntil:p.publishedUntil,accountId:state.account.id,subjectId:actor.subjectId??null,authority:'accepted-operation-only'};
   await this.saveEvent(db,actor,{p,consentId,payloadJson,kind,accountId:state.account.id,result});
   await db.query(`INSERT INTO forum_versions_v1(id,post_id,subject_id,account_id,version_number,publication_event_id,permission_id,payload_hash,published_until,state,created_at,topic,section_id,audience)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,$11,$12,$13)`,[p.versionId,p.postId,actor.subjectId??null,state.account.id,number,p.operationId,permit.id,digest(payloadJson),forumStamp(p.publishedUntil),at,p.topic??null,publication.sectionId,JSON.stringify(publication.audience)]);
   await db.query('UPDATE forum_posts_v1 SET current_version_id=$2,head_version=$3,updated_at=$4 WHERE id=$1',[p.postId,p.versionId,headVersion,at]);
   await this.complete(db,actor,authorization,{p,consentId,payloadJson,kind:'forum.post.publish',accountId:state.account.id,category:state.quota.category,locator,result});
   return {...result,quota:await this.budget.finishWithin(db,state)};
  },{resourceWrite:true}).catch(error=>{if(error.code==='23505')throw new ServiceError('forum_operation_conflict',409);throw error;});
 }
 createReply(actor,{signedIntent,payloadJson}){
  const p=parseForumPayload(payloadJson,forumCreateReplySchema,this.policy.maxPayloadBytes),spec=forumWriteSpec('create-reply',p);this.checkBounds(p,'create-reply');
  actor=this.writeActor(actor,p);return this.accounts.runAuthorized(actor,'assistance',async(db,authorization,actor)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   await assertForumIds('create-reply',forumActorKey(actor),p);actor=await this.selectWriteAccountWithin(db,actor,p);
   const state=await this.budget.startWithin(db,actor,'reply');
   const head=await this.head(db,p.postId,true);if(!head||head.state!=='published')throw new ServiceError('forum_reply_source_unavailable',403);
   const source=await this.readVersionWithin(db,p.postId,p.postVersionId,{actor});if(source.availability!=='available')throw new ServiceError('forum_reply_source_unavailable',403);
   const sourceRow=await this.version(db,p.postId,p.postVersionId);await this.accessRules.participationWithin(db,actor,sourceRow);
   const publication=await this.accessRules.publicationWithin(db,actor,p,{source:sourceRow}),parentAudience=await this.accessRules.snapshotWithin(db,sourceRow);
   if(p.replyTo){const parent=await this.reply(db,p.replyTo.replyId,true);if(!parent||parent.post_id!==p.postId||parent.post_version_id!==p.postVersionId
    ||(await this.readReplyWithin(db,parent.id,{actor})).availability!=='available')throw new ServiceError('forum_reply_source_unavailable',403);
    parentAudience.push(...await this.accessRules.snapshotWithin(db,parent),...(parent.parent_audience??[]));}
   const consentId=await this.consentWithin(db,actor,authorization,signedIntent),permit=await this.permissions.captureWithin(db,actor,{consentId,payloadJson,spec,eventId:p.operationId,accountId:state.account.id,publishedUntil:p.publishedUntil}),
    locator={kind:'reply',replyId:p.replyId,contentRevision:1,postId:p.postId,postVersionId:p.postVersionId},
    result={acknowledged:true,replyId:p.replyId,revision:1,permissionId:permit.id,publishedUntil:p.publishedUntil,accountId:state.account.id,subjectId:actor.subjectId??null,authority:'accepted-operation-only'};
   await this.saveEvent(db,actor,{p,consentId,payloadJson,kind:'create-reply',accountId:state.account.id,result});
   await db.query(`INSERT INTO forum_replies_v1(id,post_id,post_version_id,reply_to_id,subject_id,account_id,revision,publication_event_id,permission_id,payload_hash,published_until,state,created_at,section_id,audience,parent_audience,audience_inherited)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'published',$11,$12,$13,$14,$15)`,[p.replyId,p.postId,p.postVersionId,p.replyTo?.replyId??null,actor.subjectId??null,state.account.id,p.operationId,permit.id,digest(payloadJson),forumStamp(p.publishedUntil),forumStamp(this.clock()),publication.sectionId,JSON.stringify(publication.audience),JSON.stringify(parentAudience),p.audience===undefined]);
   await this.complete(db,actor,authorization,{p,consentId,payloadJson,kind:'forum.reply.publish',accountId:state.account.id,category:'reply',locator,result});
   return {...result,quota:await this.budget.finishWithin(db,state)};
  },{resourceWrite:true}).catch(error=>{if(error.code==='23505')throw new ServiceError('forum_operation_conflict',409);throw error;});
 }
 withdraw(actor,kind,{signedIntent,payloadJson}){
  const schema={'withdraw-post':forumWithdrawPostSchema,'withdraw-version':forumWithdrawVersionSchema,'withdraw-reply':forumWithdrawReplySchema}[kind];
  if(!schema)throw new ServiceError('invalid_forum_action');const p=parseForumPayload(payloadJson,schema,this.policy.maxPayloadBytes),spec=forumWriteSpec(kind,p);
  actor=this.writeActor(actor,p);return this.accounts.runAuthorized(actor,'assistance',async(db,authorization,actor)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   let target,head,accountId,locator,result;
   if(kind==='withdraw-reply'){
    target=await this.reply(db,p.replyId);if(!target)throw new ServiceError('not_found',404);
    actor=await this.selectWriteAccountWithin(db,actor,p,{owner:target,control:true});target=await this.reply(db,p.replyId,true);if(!forumActorOwns(actor,target))throw new ServiceError('not_found',404);
    if(target.state==='withdrawn'||target.revision!==p.expectedRevision)throw new ServiceError('forum_reply_transition',409);
    accountId=target.account_id;locator={kind:'reply',replyId:p.replyId,contentRevision:1};result={acknowledged:true,replyId:p.replyId,revision:2,state:'withdrawn',authority:'accepted-operation-only'};
   }else{
    head=await this.head(db,p.postId);if(!head)throw new ServiceError('not_found',404);
    actor=await this.selectWriteAccountWithin(db,actor,p,{owner:head,control:true});head=await this.head(db,p.postId,true);if(!forumActorOwns(actor,head))throw new ServiceError('not_found',404);
    if(head.head_version!==p.expectedHeadVersion||head.state==='withdrawn')throw new ServiceError('forum_head_conflict',409);
    if(kind==='withdraw-version'){target=await this.version(db,p.postId,p.versionId,true);if(!forumActorOwns(actor,target))throw new ServiceError('not_found',404);if(target.state==='withdrawn')throw new ServiceError('forum_version_transition',409);}
    accountId=head.account_id;locator=p.versionId?{kind:'post-version',postId:p.postId,versionId:p.versionId}:{kind:'post',postId:p.postId};
    result={acknowledged:true,postId:p.postId,...(p.versionId?{versionId:p.versionId}:{}),headVersion:head.head_version+1,state:'withdrawn',authority:'accepted-operation-only'};
   }
   result={...result,accountId,subjectId:actor.subjectId??null};
   const consentId=await this.consentWithin(db,actor,authorization,signedIntent);
   await this.permissions.captureWithin(db,actor,{consentId,payloadJson,spec,eventId:p.operationId,accountId});
   await this.saveEvent(db,actor,{p,consentId,payloadJson,kind,accountId,result});const at=forumStamp(this.clock());
   if(kind==='withdraw-reply'){
    await db.query("UPDATE forum_replies_v1 SET state='withdrawn',revision=2 WHERE id=$1",[p.replyId]);
    await db.query('UPDATE forum_permissions_v1 SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[target.permission_id,at]);
   }else if(kind==='withdraw-version'){
    await db.query("UPDATE forum_versions_v1 SET state='withdrawn' WHERE id=$1",[p.versionId]);
    await db.query('UPDATE forum_permissions_v1 SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1',[target.permission_id,at]);
    await db.query('UPDATE forum_posts_v1 SET head_version=head_version+1,current_version_id=CASE WHEN current_version_id=$2 THEN NULL ELSE current_version_id END,updated_at=$3 WHERE id=$1',[p.postId,p.versionId,at]);
   }else{
    await db.query("UPDATE forum_posts_v1 SET state='withdrawn',head_version=head_version+1,current_version_id=NULL,updated_at=$2 WHERE id=$1",[p.postId,at]);
    await db.query("UPDATE forum_versions_v1 SET state='withdrawn' WHERE post_id=$1",[p.postId]);
    await db.query('UPDATE forum_permissions_v1 SET revoked_at=COALESCE(revoked_at,$2) WHERE id IN (SELECT permission_id FROM forum_versions_v1 WHERE post_id=$1)',[p.postId,at]);
   }
   return this.complete(db,actor,authorization,{p,consentId,payloadJson,kind:'forum.withdraw',accountId,locator,result});
  },{resourceWrite:true,control:true});
 }
 async hiddenWithin(db,target){return this.governance?this.governance.hiddenWithin(db,target):false;}
 async readVersionWithin(db,postId,versionId,{actor=null}={}){
  const row=await this.version(db,postId,versionId);if(!row)throw new ServiceError('not_found',404);
  actor=await this.objectActorWithin(db,actor,row);
  const locator={kind:'post-version',postId,versionId,versionNumber:row.version_number},now=this.clock();
  if(row.state==='withdrawn'||row.post_state==='withdrawn')return unavailable(locator,'withdrawn',now);
  const state=await this.permissions.statusWithin(db,row.permission_id,{visibility:'Public',payloadHash:row.payload_hash,action:'forum.post.publish',objectId:versionId,viewerActor:actor});
  if(!state.allowed||!row.payload_text||row.erased_at||row.event_erased)return unavailable(locator,state.reasons.includes('content-expired')?'expired':'unavailable',now);
  if(await this.hiddenWithin(db,{kind:'post-version',postId,versionId}))return unavailable(locator,'unavailable',now);
  const payload=JSON.parse(row.payload_text);
  if((row.topic??null)!==(payload.topic??null))return unavailable(locator,'unavailable',now);
  return {locator,...authorship(row),headVersion:row.head_version,currentVersionId:row.current_version_id,availability:'available',payload,
   topic:payload.topic??'unclassified',audience:row.audience??legacyForumAudience,sectionId:row.section_id??null,
   canParticipate:await this.canParticipateWithin(db,actor,row),createdAt:forumSeconds(row.post_created_at),versionCreatedAt:forumSeconds(row.created_at),updatedAt:forumSeconds(row.post_updated_at),
   permissionId:row.permission_id,publishedUntil:forumSeconds(row.published_until),checkedAt:now,authorizationEvidence:await this.permissions.publicEvidenceWithin(db,state.row)};
 }
 async canParticipateWithin(db,actor,row){try{await this.accessRules.participationWithin(db,actor,row);return true;}catch(error){if(error instanceof ServiceError&&[401,403,404,409].includes(error.status))return false;throw error;}}
 async readReplyWithin(db,id,{parent=true,actor=null}={}){
  const row=await this.reply(db,id);if(!row)throw new ServiceError('not_found',404);
  actor=await this.objectActorWithin(db,actor,row);
  const locator={kind:'reply',replyId:id,contentRevision:1,postId:row.post_id,postVersionId:row.post_version_id},now=this.clock();
  if(row.state==='withdrawn')return unavailable(locator,'withdrawn',now);
  const state=await this.permissions.statusWithin(db,row.permission_id,{visibility:'Public',payloadHash:row.payload_hash,action:'forum.reply.publish',objectId:id,viewerActor:actor});
  if(!state.allowed||!row.payload_text||row.erased_at||row.event_erased)return unavailable(locator,state.reasons.includes('content-expired')?'expired':'unavailable',now);
  if(await this.hiddenWithin(db,{kind:'reply',replyId:id,contentRevision:1}))return unavailable(locator,'unavailable',now);
  let parentAvailability='unavailable';if(parent)try{parentAvailability=(await this.readVersionWithin(db,row.post_id,row.post_version_id,{actor})).availability;}catch(error){if(error.status!==404)throw error;}
  return {locator,...authorship(row),revision:row.revision,availability:'available',payload:JSON.parse(row.payload_text),permissionId:row.permission_id,
   audience:row.audience??legacyForumAudience,audienceInherited:row.audience_inherited??false,sectionId:row.section_id??null,publishedUntil:forumSeconds(row.published_until),createdAt:forumSeconds(row.created_at),checkedAt:now,parentAvailability,authorizationEvidence:await this.permissions.publicEvidenceWithin(db,state.row)};
 }
 async versionsWithin(db,id,input={},actor=null){
  const q=validate(forumVersionsQuerySchema,input),head=await this.head(db,id);if(!head)throw new ServiceError('not_found',404);
  const rows=(await db.query('SELECT id,version_number FROM forum_versions_v1 WHERE post_id=$1 AND version_number>$2 ORDER BY version_number LIMIT $3',[id,q.afterVersion??0,q.limit+1])).rows,items=[];
  for(const row of rows.slice(0,q.limit)){const view=await this.readVersionWithin(db,id,row.id,{actor});items.push({locator:view.locator,availability:view.availability,checkedAt:view.checkedAt,...(view.availability==='available'?{permissionId:view.permissionId,publishedUntil:view.publishedUntil}:{})});}
  return {postId:id,items,nextAfterVersion:rows.length>q.limit?items.at(-1).locator.versionNumber:null,checkedAt:this.clock()};
 }
 async headWithin(db,id,{actor=null}={}){
  const head=await this.head(db,id);if(!head)throw new ServiceError('not_found',404);
  let current=null;if(head.current_version_id)current=await this.readVersionWithin(db,id,head.current_version_id,{actor});
  if(!current||current.availability!=='available')return unavailable({kind:'post',postId:id},head.state==='withdrawn'?'withdrawn':current?.availability??'unavailable',this.clock());
  const versions=await this.versionsWithin(db,id,{},actor);return {...current,locator:{kind:'post',postId:id},versionLocators:versions.items,nextAfterVersion:versions.nextAfterVersion};
 }
 getVersion(postId,versionId,actor=null){if(!z.uuid().safeParse(postId).success||!z.uuid().safeParse(versionId).success)throw new ServiceError('not_found',404);return this.runRead(actor,db=>this.readVersionWithin(db,postId,versionId,{actor}));}
 getPost(id,actor=null){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.runRead(actor,db=>this.headWithin(db,id,{actor}));}
 getReply(id,actor=null){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.runRead(actor,db=>this.readReplyWithin(db,id,{actor}));}
 versions(id,input={},actor=null){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.runRead(actor,db=>this.versionsWithin(db,id,input,actor));}
 async ownedSummaryWithin(db,actor,id){
  const head=await this.head(db,id);actor=await this.objectActorWithin(db,actor,head,{required:true});if(!forumActorOwns(actor,head))throw new ServiceError('not_found',404);
  const current=head.current_version_id?await this.readVersionWithin(db,id,head.current_version_id,{actor}):null;
  const base={locator:{kind:'post',postId:id},...authorship(head),headVersion:head.head_version,currentVersionId:head.current_version_id,
   state:head.state,createdAt:forumSeconds(head.created_at),updatedAt:forumSeconds(head.updated_at),checkedAt:this.clock()};
  if(current?.availability!=='available')return {...base,availability:head.state==='withdrawn'?'withdrawn':current?.availability??'unavailable'};
  return {...current,...base};
 }
 /** @param {{kind?:string,subjectId?:string,accountId?:string,accountAuthorized?:boolean}|null} [actor] */
 async browseWithin(db,q,page,actor=null,viewer=actor,ownedAccounts=null){
  // Topic/time indexes locate candidates. Keyword matching happens only after
  // current source checks, so an expired cached body cannot affect matches.
  // The 200-candidate budget has an explicit continuation, never a false end.
  const accountOwner=actor&&(actor.kind==='official-account'||actor.accountAuthorized),ownerColumn=accountOwner?'account_id':'subject_id',ownerId=actor?(accountOwner?actor.accountId:actor.subjectId):null;
  const rows=(await db.query(`SELECT p.id,p.created_at FROM forum_posts_v1 p
   LEFT JOIN forum_versions_v1 v ON v.id=p.current_version_id AND v.post_id=p.id
   WHERE (($7::uuid[] IS NOT NULL AND (p.account_id=ANY($7::uuid[]) OR p.account_id IS NULL AND p.subject_id=$8::text)) OR
    ($7::uuid[] IS NULL AND (($1::text IS NOT NULL AND p.${ownerColumn}::text=$1::text) OR
    ($1::text IS NULL AND p.state='published' AND v.state='published' AND v.erased_at IS NULL AND v.published_until>$5::timestamptz))))
   AND ($2::text IS NULL OR COALESCE(v.topic,'unclassified')=$2::text) AND ($6::uuid IS NULL OR v.section_id=$6)
   AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid))
   ORDER BY p.created_at DESC,p.id DESC LIMIT 201`,[ownerId,q.topic??null,page.afterAt,page.afterId,forumStamp(this.clock()),q.sectionId??null,ownedAccounts,actor?.subjectId??null])).rows;
  const items=[];let scanned=null,processed=0;
  for(const row of rows.slice(0,200)){
   scanned=row;processed++;
   const view=actor?await this.ownedSummaryWithin(db,actor,row.id):await this.headWithin(db,row.id,{actor:viewer});
   const match=actor&&q.topic===undefined&&!q.query||forumMatchesQuery(view,q);
   if(match&&(actor||view.availability==='available'))items.push(view);
   if(items.length===q.limit)break;
  }
  const more=processed<rows.length;
  return {items,nextAfter:more&&scanned?forumPageAfter(page,scanned):null,scanTruncated:more&&processed===200&&items.length<q.limit,
   order:page.order,checkedAt:this.clock()};
 }
 query(input={},actor=null){const q=validate(forumPostsQuerySchema,input),page=forumPageFor(q,actor?`viewer:${actor.accountId??forumActorKey(actor)}`:null);return this.runRead(actor,async db=>{
  if(page.order==='published')return this.browseWithin(db,q,page,null,actor);
  const rows=(await db.query("SELECT id FROM forum_posts_v1 WHERE state='published' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 200",[q.after??null])).rows,items=[];let scanned=null;
  for(const row of rows){scanned=row.id;const view=await this.headWithin(db,row.id,{actor});if(view.availability==='available')items.push(view);if(items.length===q.limit)break;}
  return {items,nextAfter:items.length===q.limit||rows.length===200?scanned:null,scanTruncated:rows.length===200&&items.length<q.limit,order:page.order,checkedAt:this.clock()};
 });}
 publicForAccount(accountId,{limit=20}={}){
  if(!z.uuid().safeParse(accountId).success||!Number.isInteger(limit)||limit<1||limit>50)throw new ServiceError('invalid_forum_request');
  return transaction(this.access.db,async db=>{
   const rows=(await db.query("SELECT id FROM forum_posts_v1 WHERE account_id=$1 AND state='published' ORDER BY created_at DESC,id DESC LIMIT 201",[accountId])).rows,items=[];let scanned=0;
   for(const row of rows.slice(0,200)){
    scanned++;const view=await this.headWithin(db,row.id);
    if(view.availability==='available')items.push(view);
    if(items.length===limit)break;
   }
   return {items,scanTruncated:scanned<rows.length,checkedAt:this.clock()};
  });
 }
 replies(input,actor=null){const q=validate(forumRepliesQuerySchema,input);return this.runRead(actor,async db=>{
  if(!await this.version(db,q.postId,q.postVersionId))throw new ServiceError('not_found',404);
  const source=await this.readVersionWithin(db,q.postId,q.postVersionId,{actor});
  if(source.availability!=='available')return {items:[],nextAfter:null,scanTruncated:false,sourceAvailability:source.availability,checkedAt:this.clock()};
  const rows=(await db.query('SELECT id FROM forum_replies_v1 WHERE post_id=$1 AND post_version_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 200',[q.postId,q.postVersionId,q.after??null])).rows,items=[];let scanned=null;
  for(const row of rows){scanned=row.id;const view=await this.readReplyWithin(db,row.id,{actor});if(view.availability==='available')items.push(view);if(items.length===q.limit)break;}
  return {items,nextAfter:items.length===q.limit||rows.length===200?scanned:null,scanTruncated:rows.length===200&&items.length<q.limit,checkedAt:this.clock()};
 });}
 async ownedWithin(db,actor,id){
  const head=await this.head(db,id);actor=await this.objectActorWithin(db,actor,head,{required:true});if(!forumActorOwns(actor,head))throw new ServiceError('not_found',404);
  const rows=(await db.query('SELECT id,version_number,state,permission_id,published_until FROM forum_versions_v1 WHERE post_id=$1 ORDER BY version_number',[id])).rows,versionLocators=[];
  for(const row of rows){const view=await this.readVersionWithin(db,id,row.id,{actor});versionLocators.push({locator:view.locator,state:row.state,permissionId:row.permission_id,publishedUntil:forumSeconds(row.published_until),availability:view.availability});}
  return {locator:{kind:'post',postId:id},...authorship(head),headVersion:head.head_version,currentVersionId:head.current_version_id,state:head.state,versionLocators,checkedAt:this.clock()};
 }
 ownedPost(actor,id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.accounts.runAuthorized(actor,'assistance',(db,_authorization,currentActor)=>this.ownedWithin(db,currentActor,id));}
 ownedReply(actor,id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.accounts.runAuthorized(actor,'assistance',async(db,_authorization,actor)=>{
  const row=await this.reply(db,id);actor=await this.objectActorWithin(db,actor,row,{required:true});if(!forumActorOwns(actor,row))throw new ServiceError('not_found',404);const view=await this.readReplyWithin(db,id,{actor});
  return {locator:view.locator,...authorship(row),revision:row.revision,state:row.state,permissionId:row.permission_id,publishedUntil:forumSeconds(row.published_until),availability:view.availability,checkedAt:this.clock()};
 });}
 owned(actor,input={}){const q=validate(forumPostsQuerySchema,input);return this.accounts.runAuthorized(actor,'assistance',async(db,_authorization,actor)=>{
  const accountOwner=actor.kind==='official-account'||actor.accountAuthorized,ownerColumn=accountOwner?'account_id':'subject_id',ownerId=accountOwner?actor.accountId:actor.subjectId,
   page=forumPageFor(q,accountOwner?`account:${ownerId}`:forumActorKey(actor)),ownedAccounts=accountOwner?null:(await this.accounts.availableWithin(db,actor)).map(row=>row.id);
  if(page.order==='published')return this.browseWithin(db,q,page,actor,actor,ownedAccounts);
  const rows=(await db.query(`SELECT id,head_version,current_version_id,state FROM forum_posts_v1
   WHERE (($4::uuid[] IS NULL AND ${ownerColumn}=$1::${accountOwner?'uuid':'text'}) OR ($4::uuid[] IS NOT NULL AND (account_id=ANY($4::uuid[]) OR account_id IS NULL AND subject_id=$1::text)))
   AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[ownerId,q.after??null,q.limit+1,ownedAccounts])).rows;
  const items=[];for(const row of rows.slice(0,q.limit))items.push(await this.ownedSummaryWithin(db,actor,row.id));
  return {items,nextAfter:rows.length>q.limit?rows[q.limit-1].id:null,order:page.order,checkedAt:this.clock()};
 });}
 receipt(actor,input){const p=validate(forumReceiptSchema,input);return this.accounts.runAuthorized(actor,actor.kind==='official-account'||actor.scopes?.includes('assistance')?'assistance':'moderation',(db,_authorization,currentActor)=>forumReceiptWithin(db,currentActor,p));}
 async noticeWithin(db,actor,accountId,replyId){
  const row=(await db.query(`SELECT r.*,n.read_at FROM forum_replies_v1 r JOIN forum_posts_v1 p ON p.id=r.post_id
   LEFT JOIN forum_replies_v1 parent ON parent.id=r.reply_to_id LEFT JOIN forum_notification_reads_v2 n ON n.account_id=$2 AND n.reply_id=r.id
   WHERE r.id=$1 AND (p.account_id=$2 OR parent.account_id=$2) AND r.account_id IS DISTINCT FROM $2::uuid`,[replyId,accountId])).rows[0];
  if(!row)return null;
  const view=await this.readReplyWithin(db,row.id,{actor});if(view.availability!=='available')return null;
  const post=await this.readVersionWithin(db,row.post_id,row.post_version_id,{actor});
  if(post.availability!=='available')return null;
  return {replyId:row.id,postId:row.post_id,postVersionId:row.post_version_id,...authorship(row),title:post.payload.title,
   preview:view.payload.body.slice(0,180),at:forumStamp(forumSeconds(row.created_at)),read:!!row.read_at,sourceExpiresAt:forumStamp(Math.min(view.publishedUntil,post.publishedUntil))};
 }
 notifications(actor,input={}){
  const q=validate(forumNotificationsQuerySchema,input);return this.accounts.runAuthorized(actor,'assistance',async(db,_authorization,actor)=>{
   const account=await this.accounts.resolveWithin(db,actor),rows=(await db.query(`SELECT r.id FROM forum_replies_v1 r JOIN forum_posts_v1 p ON p.id=r.post_id
    LEFT JOIN forum_replies_v1 parent ON parent.id=r.reply_to_id LEFT JOIN forum_notification_reads_v2 n ON n.account_id=$1 AND n.reply_id=r.id
    WHERE (p.account_id=$1 OR parent.account_id=$1) AND r.account_id IS DISTINCT FROM $1::uuid AND r.state='published' AND r.published_until>$2
    AND ($3::uuid IS NULL OR r.id>$3) AND (NOT $4::boolean OR n.reply_id IS NULL) ORDER BY r.id LIMIT 201`,[account.id,forumStamp(this.clock()),q.after??null,q.unreadOnly])).rows,items=[];let scanned=null,processed=0;
   for(const row of rows.slice(0,200)){scanned=row.id;processed++;const item=await this.noticeWithin(db,actor,account.id,row.id);if(item)items.push(item);if(items.length===q.limit)break;}
   return {items,nextAfter:processed<rows.length?scanned:null,scanTruncated:processed===200&&items.length<q.limit&&rows.length>200,checkedAt:this.clock()};
  });
 }
 markNotificationRead(actor,input){const p=validate(forumNotificationReadSchema,input);return this.accounts.runAuthorized(actor,'assistance',async(db,_authorization,actor)=>{
  const account=await this.accounts.resolveWithin(db,actor);if(!await this.noticeWithin(db,actor,account.id,p.replyId))throw new ServiceError('not_found',404);
  await db.query('INSERT INTO forum_notification_reads_v2(account_id,reply_id,read_at) VALUES($1,$2,$3) ON CONFLICT(account_id,reply_id) DO NOTHING',[account.id,p.replyId,forumStamp(this.clock())]);
  return {replyId:p.replyId,read:true,checkedAt:this.clock()};
 },{resourceWrite:true,control:true});}
}
