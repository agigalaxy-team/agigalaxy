import * as z from 'zod/v4';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {assertForumIds} from './shared/community-forum-ids-v1.mjs';
import {CommunityForumPermissionsV1,forumStamp,forumSeconds} from './community-forum-permissions-v1.mjs';
import {CommunityForumBudgetV1} from './community-forum-budget-v1.mjs';
import {forumTopics,forumUnclassifiedTopic} from './shared/community-forum-topics-v1.mjs';
import {forumPageFor,forumPageAfter,forumMatchesQuery} from './community-forum-page-v1.mjs';
import {defaultForumPolicy,forumPolicySchema,forumPolicyHash} from './community-forum-policy-v1.mjs';
import {lockForumOperation,priorForumOperation,recordForumReceipt,recordForumAudit,forumReceiptWithin} from './community-forum-operations-v1.mjs';
import {forumWriteSpec,parseForumPayload,forumCreatePostSchema,forumPublishVersionSchema,forumCreateReplySchema,
 forumWithdrawPostSchema,forumWithdrawVersionSchema,forumWithdrawReplySchema,forumPostsQuerySchema,forumVersionsQuerySchema,forumRepliesQuerySchema,forumReceiptSchema} from './shared/community-forum-v1-schema.mjs';

const validate=(schema,value)=>{const parsed=schema.safeParse(value);if(!parsed.success)throw new ServiceError('invalid_forum_request');return parsed.data;};
const unavailable=(locator,availability,checkedAt)=>({locator,availability,checkedAt});
export class CommunityForumV1 {
 constructor(access,consents,{accounts,publicWrites,policy=defaultForumPolicy}={}){
  Object.assign(this,{access,consents,accounts,publicWrites});this.policy=forumPolicySchema.parse(policy);this.policyHash=forumPolicyHash(this.policy);
  this.permissions=new CommunityForumPermissionsV1(access,consents,{policy:this.policy,policyHash:this.policyHash});
  this.budget=new CommunityForumBudgetV1(access,accounts,publicWrites,{policy:this.policy,policyHash:this.policyHash});
 }
 clock(){return this.access.now();}
 topics(){return {items:forumTopics,unclassified:forumUnclassifiedTopic,checkedAt:this.clock()};}
 async consentWithin(db,actor,authorization,signedIntent){return (await this.consents.createWithin(db,actor,signedIntent,authorization,{forum:true})).consentId;}
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
  await db.query(`INSERT INTO forum_events_v1(id,subject_id,account_id,kind,post_id,version_id,reply_id,consent_id,payload_text,payload_hash,result,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[p.operationId,actor.subjectId,accountId,kind,p.postId??null,p.versionId??null,p.replyId??null,consentId,payloadJson,digest(payloadJson),JSON.stringify(result),forumStamp(this.clock())]);
 }
 async complete(db,actor,authorization,{p,consentId,payloadJson,kind,accountId=null,category=null,locator,result}){
  await recordForumReceipt(db,actor,{operationId:p.operationId,consentId,payloadJson,accountId,category,locator,result,now:this.clock(),auditDays:this.policy.auditDays});
  await recordForumAudit(db,actor,authorization,{operationId:p.operationId,consentId,action:kind});return result;
 }
 publish(actor,{signedIntent,payloadJson}){
  let raw;try{raw=JSON.parse(payloadJson);}catch{throw new ServiceError('invalid_forum_payload');}
  const kind=raw.expectedHeadVersion===0?'create-post':'publish-version',p=parseForumPayload(payloadJson,kind==='create-post'?forumCreatePostSchema:forumPublishVersionSchema,this.policy.maxPayloadBytes);
  this.checkBounds(p,kind);const spec=forumWriteSpec(kind,p);
  return this.access.runResourceWrite(actor,'assistance',{},async(db,authorization)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   await assertForumIds(kind,actor.subjectId,p);
   const state=await this.budget.startWithin(db,actor,kind==='create-post'?'post':'version'),at=forumStamp(this.clock());
   const head=await this.head(db,p.postId,true);let number;
   if(kind==='create-post'){
    if(head)throw new ServiceError('forum_post_conflict',409);number=1;
    await db.query("INSERT INTO forum_posts_v1(id,subject_id,account_id,head_version,state,created_at,updated_at) VALUES($1,$2,$3,1,'published',$4,$4)",[p.postId,actor.subjectId,state.account.id,at]);
   }else{
    if(!head||head.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);
    if(head.state==='withdrawn')throw new ServiceError('forum_post_withdrawn',409);
    if(head.head_version!==p.expectedHeadVersion)throw new ServiceError('forum_head_conflict',409);
    number=Number((await db.query('SELECT coalesce(max(version_number),0)+1 value FROM forum_versions_v1 WHERE post_id=$1',[p.postId])).rows[0].value);
   }
   const consentId=await this.consentWithin(db,actor,authorization,signedIntent),permit=await this.permissions.captureWithin(db,actor,{consentId,payloadJson,spec,eventId:p.operationId,accountId:state.account.id,publishedUntil:p.publishedUntil});
   const headVersion=kind==='create-post'?1:head.head_version+1,locator={kind:'post-version',postId:p.postId,versionId:p.versionId,versionNumber:number},
    result={acknowledged:true,postId:p.postId,versionId:p.versionId,versionNumber:number,headVersion,permissionId:permit.id,publishedUntil:p.publishedUntil,authority:'accepted-operation-only'};
   await this.saveEvent(db,actor,{p,consentId,payloadJson,kind,accountId:state.account.id,result});
   await db.query(`INSERT INTO forum_versions_v1(id,post_id,subject_id,account_id,version_number,publication_event_id,permission_id,payload_hash,published_until,state,created_at,topic)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,$11)`,[p.versionId,p.postId,actor.subjectId,state.account.id,number,p.operationId,permit.id,digest(payloadJson),forumStamp(p.publishedUntil),at,p.topic??null]);
   await db.query('UPDATE forum_posts_v1 SET current_version_id=$2,head_version=$3,updated_at=$4 WHERE id=$1',[p.postId,p.versionId,headVersion,at]);
   await this.complete(db,actor,authorization,{p,consentId,payloadJson,kind:'forum.post.publish',accountId:state.account.id,category:state.quota.category,locator,result});
   return {...result,quota:await this.budget.finishWithin(db,state)};
  }).catch(error=>{if(error.code==='23505')throw new ServiceError('forum_operation_conflict',409);throw error;});
 }
 createReply(actor,{signedIntent,payloadJson}){
  const p=parseForumPayload(payloadJson,forumCreateReplySchema,this.policy.maxPayloadBytes),spec=forumWriteSpec('create-reply',p);this.checkBounds(p,'create-reply');
  return this.access.runResourceWrite(actor,'assistance',{},async(db,authorization)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   await assertForumIds('create-reply',actor.subjectId,p);
   const state=await this.budget.startWithin(db,actor,'reply');
   const head=await this.head(db,p.postId,true);if(!head||head.state!=='published')throw new ServiceError('forum_reply_source_unavailable',403);
   const source=await this.readVersionWithin(db,p.postId,p.postVersionId);if(source.availability!=='available')throw new ServiceError('forum_reply_source_unavailable',403);
   if(p.replyTo){const parent=await this.reply(db,p.replyTo.replyId,true);if(!parent||parent.post_id!==p.postId||parent.post_version_id!==p.postVersionId
    ||(await this.readReplyWithin(db,parent.id)).availability!=='available')throw new ServiceError('forum_reply_source_unavailable',403);}
   const consentId=await this.consentWithin(db,actor,authorization,signedIntent),permit=await this.permissions.captureWithin(db,actor,{consentId,payloadJson,spec,eventId:p.operationId,accountId:state.account.id,publishedUntil:p.publishedUntil}),
    locator={kind:'reply',replyId:p.replyId,contentRevision:1,postId:p.postId,postVersionId:p.postVersionId},
    result={acknowledged:true,replyId:p.replyId,revision:1,permissionId:permit.id,publishedUntil:p.publishedUntil,authority:'accepted-operation-only'};
   await this.saveEvent(db,actor,{p,consentId,payloadJson,kind:'create-reply',accountId:state.account.id,result});
   await db.query(`INSERT INTO forum_replies_v1(id,post_id,post_version_id,reply_to_id,subject_id,account_id,revision,publication_event_id,permission_id,payload_hash,published_until,state,created_at)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'published',$11)`,[p.replyId,p.postId,p.postVersionId,p.replyTo?.replyId??null,actor.subjectId,state.account.id,p.operationId,permit.id,digest(payloadJson),forumStamp(p.publishedUntil),forumStamp(this.clock())]);
   await this.complete(db,actor,authorization,{p,consentId,payloadJson,kind:'forum.reply.publish',accountId:state.account.id,category:'reply',locator,result});
   return {...result,quota:await this.budget.finishWithin(db,state)};
  }).catch(error=>{if(error.code==='23505')throw new ServiceError('forum_operation_conflict',409);throw error;});
 }
 withdraw(actor,kind,{signedIntent,payloadJson}){
  const schema={'withdraw-post':forumWithdrawPostSchema,'withdraw-version':forumWithdrawVersionSchema,'withdraw-reply':forumWithdrawReplySchema}[kind];
  if(!schema)throw new ServiceError('invalid_forum_action');const p=parseForumPayload(payloadJson,schema,this.policy.maxPayloadBytes),spec=forumWriteSpec(kind,p);
  return this.access.runResourceWrite(actor,'assistance',{control:true},async(db,authorization)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   let target,head,accountId,locator,result;
   if(kind==='withdraw-reply'){
    target=await this.reply(db,p.replyId,true);if(!target||target.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);
    if(target.state==='withdrawn'||target.revision!==p.expectedRevision)throw new ServiceError('forum_reply_transition',409);
    accountId=target.account_id;locator={kind:'reply',replyId:p.replyId,contentRevision:1};result={acknowledged:true,replyId:p.replyId,revision:2,state:'withdrawn',authority:'accepted-operation-only'};
   }else{
    head=await this.head(db,p.postId,true);if(!head||head.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);
    if(head.head_version!==p.expectedHeadVersion||head.state==='withdrawn')throw new ServiceError('forum_head_conflict',409);
    if(kind==='withdraw-version'){target=await this.version(db,p.postId,p.versionId,true);if(!target||target.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);if(target.state==='withdrawn')throw new ServiceError('forum_version_transition',409);}
    accountId=head.account_id;locator=p.versionId?{kind:'post-version',postId:p.postId,versionId:p.versionId}:{kind:'post',postId:p.postId};
    result={acknowledged:true,postId:p.postId,...(p.versionId?{versionId:p.versionId}:{}),headVersion:head.head_version+1,state:'withdrawn',authority:'accepted-operation-only'};
   }
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
  });
 }
 async hiddenWithin(db,target){return this.governance?this.governance.hiddenWithin(db,target):false;}
 async readVersionWithin(db,postId,versionId){
  const row=await this.version(db,postId,versionId);if(!row)throw new ServiceError('not_found',404);
  const locator={kind:'post-version',postId,versionId,versionNumber:row.version_number},now=this.clock();
  if(row.state==='withdrawn'||row.post_state==='withdrawn')return unavailable(locator,'withdrawn',now);
  const state=await this.permissions.statusWithin(db,row.permission_id,{visibility:'Public',payloadHash:row.payload_hash,action:'forum.post.publish',objectId:versionId});
  if(!state.allowed||!row.payload_text||row.erased_at||row.event_erased)return unavailable(locator,state.reasons.includes('content-expired')?'expired':'unavailable',now);
  if(await this.hiddenWithin(db,{kind:'post-version',postId,versionId}))return unavailable(locator,'unavailable',now);
  const payload=JSON.parse(row.payload_text);
  if((row.topic??null)!==(payload.topic??null))return unavailable(locator,'unavailable',now);
  return {locator,authorId:row.subject_id,headVersion:row.head_version,currentVersionId:row.current_version_id,availability:'available',payload,
   topic:payload.topic??'unclassified',createdAt:forumSeconds(row.post_created_at),versionCreatedAt:forumSeconds(row.created_at),updatedAt:forumSeconds(row.post_updated_at),
   permissionId:row.permission_id,publishedUntil:forumSeconds(row.published_until),checkedAt:now,authorizationEvidence:await this.permissions.publicEvidenceWithin(db,state.row)};
 }
 async readReplyWithin(db,id,{parent=true}={}){
  const row=await this.reply(db,id);if(!row)throw new ServiceError('not_found',404);
  const locator={kind:'reply',replyId:id,contentRevision:1,postId:row.post_id,postVersionId:row.post_version_id},now=this.clock();
  if(row.state==='withdrawn')return unavailable(locator,'withdrawn',now);
  const state=await this.permissions.statusWithin(db,row.permission_id,{visibility:'Public',payloadHash:row.payload_hash,action:'forum.reply.publish',objectId:id});
  if(!state.allowed||!row.payload_text||row.erased_at||row.event_erased)return unavailable(locator,state.reasons.includes('content-expired')?'expired':'unavailable',now);
  if(await this.hiddenWithin(db,{kind:'reply',replyId:id,contentRevision:1}))return unavailable(locator,'unavailable',now);
  let parentAvailability='unavailable';if(parent)try{parentAvailability=(await this.readVersionWithin(db,row.post_id,row.post_version_id)).availability;}catch(error){if(error.status!==404)throw error;}
  return {locator,authorId:row.subject_id,revision:row.revision,availability:'available',payload:JSON.parse(row.payload_text),permissionId:row.permission_id,
   publishedUntil:forumSeconds(row.published_until),createdAt:forumSeconds(row.created_at),checkedAt:now,parentAvailability,authorizationEvidence:await this.permissions.publicEvidenceWithin(db,state.row)};
 }
 async versionsWithin(db,id,input={}){
  const q=validate(forumVersionsQuerySchema,input),head=await this.head(db,id);if(!head)throw new ServiceError('not_found',404);
  const rows=(await db.query('SELECT id,version_number FROM forum_versions_v1 WHERE post_id=$1 AND version_number>$2 ORDER BY version_number LIMIT $3',[id,q.afterVersion??0,q.limit+1])).rows,items=[];
  for(const row of rows.slice(0,q.limit)){const view=await this.readVersionWithin(db,id,row.id);items.push({locator:view.locator,availability:view.availability,checkedAt:view.checkedAt,...(view.availability==='available'?{permissionId:view.permissionId,publishedUntil:view.publishedUntil}:{})});}
  return {postId:id,items,nextAfterVersion:rows.length>q.limit?items.at(-1).locator.versionNumber:null,checkedAt:this.clock()};
 }
 async headWithin(db,id){
  const head=await this.head(db,id);if(!head)throw new ServiceError('not_found',404);
  let current=null;if(head.current_version_id)current=await this.readVersionWithin(db,id,head.current_version_id);
  if(!current||current.availability!=='available')return unavailable({kind:'post',postId:id},head.state==='withdrawn'?'withdrawn':current?.availability??'unavailable',this.clock());
  const versions=await this.versionsWithin(db,id);return {...current,locator:{kind:'post',postId:id},versionLocators:versions.items,nextAfterVersion:versions.nextAfterVersion};
 }
 getVersion(postId,versionId){if(!z.uuid().safeParse(postId).success||!z.uuid().safeParse(versionId).success)throw new ServiceError('not_found',404);return transaction(this.access.db,db=>this.readVersionWithin(db,postId,versionId));}
 getPost(id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return transaction(this.access.db,db=>this.headWithin(db,id));}
 getReply(id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return transaction(this.access.db,db=>this.readReplyWithin(db,id));}
 versions(id,input={}){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return transaction(this.access.db,db=>this.versionsWithin(db,id,input));}
 async ownedSummaryWithin(db,actor,id){
  const head=await this.head(db,id);if(!head||head.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);
  const current=head.current_version_id?await this.readVersionWithin(db,id,head.current_version_id):null;
  const base={locator:{kind:'post',postId:id},authorId:actor.subjectId,headVersion:head.head_version,currentVersionId:head.current_version_id,
   state:head.state,createdAt:forumSeconds(head.created_at),updatedAt:forumSeconds(head.updated_at),checkedAt:this.clock()};
  if(current?.availability!=='available')return {...base,availability:head.state==='withdrawn'?'withdrawn':current?.availability??'unavailable'};
  return {...current,...base};
 }
 /** @param {{subjectId:string}|null} [actor] */
 async browseWithin(db,q,page,actor=null){
  // Topic/time indexes locate candidates. Keyword matching happens only after
  // current source checks, so an expired cached body cannot affect matches.
  // The 200-candidate budget has an explicit continuation, never a false end.
  const rows=(await db.query(`SELECT p.id,p.created_at FROM forum_posts_v1 p
   LEFT JOIN forum_versions_v1 v ON v.id=p.current_version_id AND v.post_id=p.id
   WHERE (($1::text IS NOT NULL AND p.subject_id=$1::text) OR
    ($1::text IS NULL AND p.state='published' AND v.state='published' AND v.erased_at IS NULL AND v.published_until>$5::timestamptz))
   AND ($2::text IS NULL OR COALESCE(v.topic,'unclassified')=$2::text)
   AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid))
   ORDER BY p.created_at DESC,p.id DESC LIMIT 201`,[actor?.subjectId??null,q.topic??null,page.afterAt,page.afterId,forumStamp(this.clock())])).rows;
  const items=[];let scanned=null,processed=0;
  for(const row of rows.slice(0,200)){
   scanned=row;processed++;
   const view=actor?await this.ownedSummaryWithin(db,actor,row.id):await this.headWithin(db,row.id);
   const match=actor&&q.topic===undefined&&!q.query||forumMatchesQuery(view,q);
   if(match&&(actor||view.availability==='available'))items.push(view);
   if(items.length===q.limit)break;
  }
  const more=processed<rows.length;
  return {items,nextAfter:more&&scanned?forumPageAfter(page,scanned):null,scanTruncated:more&&processed===200&&items.length<q.limit,
   order:page.order,checkedAt:this.clock()};
 }
 query(input={}){const q=validate(forumPostsQuerySchema,input),page=forumPageFor(q);return transaction(this.access.db,async db=>{
  if(page.order==='published')return this.browseWithin(db,q,page);
  const rows=(await db.query("SELECT id FROM forum_posts_v1 WHERE state='published' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 200",[q.after??null])).rows,items=[];let scanned=null;
  for(const row of rows){scanned=row.id;const view=await this.headWithin(db,row.id);if(view.availability==='available')items.push(view);if(items.length===q.limit)break;}
  return {items,nextAfter:items.length===q.limit||rows.length===200?scanned:null,scanTruncated:rows.length===200&&items.length<q.limit,order:page.order,checkedAt:this.clock()};
 });}
 replies(input){const q=validate(forumRepliesQuerySchema,input);return transaction(this.access.db,async db=>{
  if(!await this.version(db,q.postId,q.postVersionId))throw new ServiceError('not_found',404);
  const rows=(await db.query('SELECT id FROM forum_replies_v1 WHERE post_id=$1 AND post_version_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 200',[q.postId,q.postVersionId,q.after??null])).rows,items=[];let scanned=null;
  for(const row of rows){scanned=row.id;const view=await this.readReplyWithin(db,row.id);if(view.availability==='available')items.push(view);if(items.length===q.limit)break;}
  return {items,nextAfter:items.length===q.limit||rows.length===200?scanned:null,scanTruncated:rows.length===200&&items.length<q.limit,checkedAt:this.clock()};
 });}
 async ownedWithin(db,actor,id){
  const head=await this.head(db,id);if(!head||head.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);
  const rows=(await db.query('SELECT id,version_number,state,permission_id,published_until FROM forum_versions_v1 WHERE post_id=$1 ORDER BY version_number',[id])).rows,versionLocators=[];
  for(const row of rows){const view=await this.readVersionWithin(db,id,row.id);versionLocators.push({locator:view.locator,state:row.state,permissionId:row.permission_id,publishedUntil:forumSeconds(row.published_until),availability:view.availability});}
  return {locator:{kind:'post',postId:id},authorId:actor.subjectId,headVersion:head.head_version,currentVersionId:head.current_version_id,state:head.state,versionLocators,checkedAt:this.clock()};
 }
 ownedPost(actor,id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.access.runAuthorized(actor,'assistance',db=>this.ownedWithin(db,actor,id));}
 ownedReply(actor,id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.access.runAuthorized(actor,'assistance',async db=>{
  const row=await this.reply(db,id);if(!row||row.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);const view=await this.readReplyWithin(db,id);
  return {locator:view.locator,authorId:actor.subjectId,revision:row.revision,state:row.state,permissionId:row.permission_id,publishedUntil:forumSeconds(row.published_until),availability:view.availability,checkedAt:this.clock()};
 });}
 owned(actor,input={}){const q=validate(forumPostsQuerySchema,input),page=forumPageFor(q,actor.subjectId);return this.access.runAuthorized(actor,'assistance',async db=>{
  if(page.order==='published')return this.browseWithin(db,q,page,actor);
  const rows=(await db.query('SELECT id,head_version,current_version_id,state FROM forum_posts_v1 WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[actor.subjectId,q.after??null,q.limit+1])).rows;
  const items=[];for(const row of rows.slice(0,q.limit))items.push(await this.ownedSummaryWithin(db,actor,row.id));
  return {items,nextAfter:rows.length>q.limit?rows[q.limit-1].id:null,order:page.order,checkedAt:this.clock()};
 });}
 receipt(actor,input){const p=validate(forumReceiptSchema,input);return this.access.runAuthorized(actor,actor.scopes?.includes('assistance')?'assistance':'moderation',db=>forumReceiptWithin(db,actor,p));}
}
