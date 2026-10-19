import * as z from 'zod/v4';
import {ServiceError} from './shared/service-error.mjs';
import {digest} from './shared/digest.mjs';
import {forumStamp,forumSeconds} from './community-forum-permissions-v1.mjs';
import {forumAccountUsage} from './community-forum-budget-v1.mjs';
import {lockForumOperation,priorForumOperation,recordForumReceipt,recordForumAudit} from './community-forum-operations-v1.mjs';
import {forumSectionWriteSchema,forumSectionClassificationSchema,forumSectionsQuerySchema} from './shared/community-forum-access-v2.mjs';
import {parseForumPayload} from './shared/community-forum-v1-schema.mjs';
import {assertForumIds,forumActorKey} from './shared/community-forum-ids-v1.mjs';

export class CommunityForumSectionsV2{
 constructor(forum){this.forum=forum;this.access=forum.access;this.accounts=forum.accounts;}
 view(row,viewer){return {sectionId:row.id,title:row.title,theme:row.theme,description:row.description,
  maintainerAccountId:row.maintainer_account_id,creatorSubjectId:row.creator_subject_id,version:row.version,state:row.state,
  category:row.category,audience:row.audience,canMaintain:viewer?.accountId===row.maintainer_account_id,
  createdAt:forumSeconds(row.created_at),updatedAt:forumSeconds(row.updated_at),checkedAt:this.forum.clock()};}
 async getWithin(db,actor,id){
  const row=await this.forum.accessRules.sectionWithin(db,id);actor=await this.forum.objectActorWithin(db,actor,row);
  const viewer=await this.forum.accessRules.viewerWithin(db,actor);
  if(!row||!await this.forum.accessRules.sectionAllowedWithin(db,row,viewer))throw new ServiceError('not_found',404);
  return {...this.view(row,viewer),canParticipate:await this.forum.accessRules.sectionAllowedWithin(db,row,viewer,'participate')};
 }
 get(actor,id){if(!z.uuid().safeParse(id).success)throw new ServiceError('not_found',404);return this.forum.runRead(actor,db=>this.getWithin(db,actor,id));}
 query(actor,input={}){
  const parsed=forumSectionsQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_forum_request');const q=parsed.data;
  return this.forum.runRead(actor,async db=>{
   const viewer=await this.forum.accessRules.viewerWithin(db,actor),managedIds=viewer?[viewer.accountId]:actor?(await this.accounts.availableWithin(db,actor)).map(row=>row.id):[];
   if(q.managed&&!actor)throw new ServiceError('access_denied',401);
   const rows=(await db.query(`SELECT * FROM forum_sections_v2 WHERE ($1::uuid IS NULL OR id>$1) AND (NOT $2::boolean OR maintainer_account_id=ANY($3::uuid[]))
    ORDER BY id LIMIT 201`,[q.after??null,q.managed,managedIds])).rows,items=[];let scanned=null,processed=0;
   for(const row of rows.slice(0,200)){scanned=row.id;processed++;
    const contextActor=await this.forum.objectActorWithin(db,actor,row),contextViewer=contextActor===actor?viewer:await this.forum.accessRules.viewerWithin(db,contextActor);
    if(await this.forum.accessRules.sectionAllowedWithin(db,row,contextViewer))items.push({...this.view(row,contextViewer),canParticipate:await this.forum.accessRules.sectionAllowedWithin(db,row,contextViewer,'participate')});
    if(items.length===q.limit)break;
   }
   return {items,nextAfter:processed<rows.length?scanned:null,scanTruncated:processed===200&&items.length<q.limit&&rows.length>200,checkedAt:this.forum.clock()};
  });
 }
 async authorizeWithin(db,actor,authorization,signedIntent,payloadJson,action,objectId){
  const consentId=await this.forum.consentWithin(db,actor,authorization,signedIntent);
  if(actor.kind!=='official-account')await this.forum.consents.require(db,{id:consentId,subjectId:actor.subjectId,action,objectId,recipient:this.access.endpoint,payloadJson});
  return consentId;
 }
 async recordWithin(db,actor,authorization,{p,payloadJson,consentId,kind,version,result,accountId}){
  await db.query(`INSERT INTO forum_section_events_v2(id,section_id,account_id,subject_id,actor_kind,kind,version,consent_id,payload_text,payload_hash,result,http_request_id,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[p.operationId,p.sectionId,accountId,actor.subjectId??null,actor.kind==='official-account'?'official-account':'identity',kind,version,consentId,payloadJson,digest(payloadJson),JSON.stringify(result),actor.httpRequestId??null,forumStamp(this.forum.clock())]);
  await recordForumReceipt(db,actor,{operationId:p.operationId,consentId,payloadJson,accountId,locator:{kind:'section',sectionId:p.sectionId},result,now:this.forum.clock(),auditDays:this.forum.policy.auditDays});
  await recordForumAudit(db,actor,authorization,{operationId:p.operationId,consentId,action:kind==='classification'?'forum.section.classify':'forum.section.write',sourceTable:'forum_section_events_v2'});
 }
 save(actor,{signedIntent,payloadJson}){
  const p=parseForumPayload(payloadJson,forumSectionWriteSchema,this.forum.policy.maxPayloadBytes);actor=this.forum.writeActor(actor,p);
  return this.accounts.runAuthorized(actor,'assistance',async(db,authorization,actor)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   await assertForumIds(p.expectedVersion===0?'create-section':'update-section',forumActorKey(actor),p);
   const source=await this.forum.accessRules.sectionWithin(db,p.sectionId);
   if(p.expectedVersion>0&&!source)throw new ServiceError('not_found',404);
   actor=await this.forum.selectWriteAccountWithin(db,actor,p,{owner:p.expectedVersion>0?source:null});
   const before=await forumAccountUsage(db,actor.accountId),current=(await db.query('SELECT * FROM forum_sections_v2 WHERE id=$1 FOR UPDATE',[p.sectionId])).rows[0];
   if(p.expectedVersion===0&&current)throw new ServiceError('forum_section_conflict',409);
   if(p.expectedVersion>0&&(!current||current.maintainer_account_id!==actor.accountId))throw new ServiceError('not_found',404);
   if((current?.version??0)!==p.expectedVersion)throw new ServiceError('forum_section_version_conflict',409);
   await this.forum.accessRules.assertAudienceWithin(db,p.audience);
   const consentId=await this.authorizeWithin(db,actor,authorization,signedIntent,payloadJson,'forum.section.write',p.sectionId),at=forumStamp(this.forum.clock()),version=p.expectedVersion+1;
   if(!current)await db.query(`INSERT INTO forum_sections_v2(id,maintainer_account_id,creator_subject_id,version,title,theme,description,audience,state,created_at,updated_at)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$9)`,[p.sectionId,actor.accountId,actor.subjectId??null,p.title,p.theme,p.description,JSON.stringify(p.audience),p.state??'active',at]);
   else await db.query('UPDATE forum_sections_v2 SET version=$2,title=$3,theme=$4,description=$5,audience=$6,state=$7,updated_at=$8 WHERE id=$1',
    [p.sectionId,version,p.title,p.theme,p.description,JSON.stringify(p.audience),p.state??current.state,at]);
   const result={acknowledged:true,sectionId:p.sectionId,version,accountId:actor.accountId,subjectId:actor.subjectId??null,authority:'accepted-operation-only'};
   await this.recordWithin(db,actor,authorization,{p,payloadJson,consentId,kind:current?'update':'create',version,result,accountId:actor.accountId});
   await this.forum.budget.checkGrowthWithin(db,actor.accountId,before);return result;
  },{resourceWrite:true});
 }
 classify(actor,{signedIntent,payloadJson}){
  const p=parseForumPayload(payloadJson,forumSectionClassificationSchema,this.forum.policy.maxPayloadBytes);
  if(actor.kind==='official-account'||!this.forum.governance?.moderatorIds.includes(actor.subjectId))throw new ServiceError('access_denied',403);
  return this.access.runResourceWrite(actor,'moderation',{},async(db,authorization)=>{
   await lockForumOperation(db,p.operationId);const prior=await priorForumOperation(db,actor,p.operationId,payloadJson);if(prior)return prior;
   const row=(await db.query('SELECT * FROM forum_sections_v2 WHERE id=$1 FOR UPDATE',[p.sectionId])).rows[0];if(!row)throw new ServiceError('not_found',404);
   if(row.version!==p.expectedVersion)throw new ServiceError('forum_section_version_conflict',409);
   const consentId=await this.authorizeWithin(db,actor,authorization,signedIntent,payloadJson,'forum.section.classify',p.sectionId),version=row.version+1;
   await db.query('UPDATE forum_sections_v2 SET category=$2,version=$3,updated_at=$4 WHERE id=$1',[p.sectionId,p.category,version,forumStamp(this.forum.clock())]);
   const result={acknowledged:true,sectionId:p.sectionId,version,category:p.category,subjectId:actor.subjectId,authority:'accepted-operation-only'};
   await this.recordWithin(db,actor,authorization,{p,payloadJson,consentId,kind:'classification',version,result,accountId:null});return result;
  });
 }
}
