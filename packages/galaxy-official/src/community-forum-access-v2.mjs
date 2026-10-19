import {ServiceError} from './shared/service-error.mjs';
import {forumAudienceSchema,legacyForumAudience} from './shared/community-forum-access-v2.mjs';

const unavailable=error=>error instanceof ServiceError&&[403,404,409,422,503].includes(error.status);
export class CommunityForumAccessV2{
 constructor(forum){this.forum=forum;this.accounts=forum.accounts;this.honor=null;this.externalCredentials=null;}
 async viewerWithin(db,actor){
  if(!actor)return null;
  try{const account=await this.accounts.resolveWithin(db,actor);return {accountId:account.id,actor};}
  catch(error){if(['account_verification_required','account_selection_required'].includes(error.code))return null;throw error;}
 }
 async subjectIdsWithin(db,viewer){
  if(viewer.subjectIds)return viewer.subjectIds;
  const rows=(await db.query(`SELECT DISTINCT l.subject_id,l.issuer,l.client_id FROM external_identity_links l
   JOIN community_account_links g ON g.identity_link_id=l.id WHERE g.account_id=$1 AND l.revoked_at IS NULL AND l.endpoint=$2`,[viewer.accountId,this.forum.access.endpoint])).rows;
  viewer.subjectIds=[...new Set(rows.filter(row=>this.accounts.providers.has(JSON.stringify([row.issuer,row.client_id]))).map(row=>row.subject_id))];
  return viewer.subjectIds;
 }
 async ruleWithin(db,rule,viewer){
  // Stored source snapshots include their original author's own read right.
  // This internal form is never accepted as an authored audience selector.
  if(rule.kind==='source-audience')return viewer?.accountId===rule.authorAccountId||this.ruleWithin(db,rule.rule,viewer);
  if(rule.kind==='everyone')return true;
  if(!viewer)return false;
  if(rule.kind==='accounts')return true;
  if(rule.kind==='selected-accounts')return rule.accountIds.includes(viewer.accountId);
  if(rule.kind==='external-credential')return !!this.externalCredentials&&await this.externalCredentials.hasConditionWithin(db,{accountId:viewer.accountId,issuerId:rule.issuerId,conditionId:rule.conditionId});
  if(rule.kind==='honor'&&this.honor){
   // Only public, current facts in one exact Honor rule may satisfy this
   // creator-selected condition. No score, trust judgment or private-ID read.
   for(const subjectId of await this.subjectIdsWithin(db,viewer))try{
    const current=await this.honor.projectWithin(db,null,{subjectId,ruleId:rule.ruleId,ruleVersion:rule.ruleVersion,limit:1});
    if(current.card.status==='active')return true;
   }catch(error){if(!unavailable(error))throw error;}
  }
  return false;
 }
 async assertAudienceWithin(db,audience){
  const parsed=forumAudienceSchema.safeParse(audience);if(!parsed.success)throw new ServiceError('invalid_forum_audience');
  for(const rule of [parsed.data.read,parsed.data.participate])if(rule.kind==='honor'){
   if(!this.honor)throw new ServiceError('forum_condition_unavailable',409);
   try{const selected=await this.honor.select(db,rule.ruleId,rule.ruleVersion);if(!selected.configured||selected.rule.revoked)throw new ServiceError('forum_condition_unavailable',409);}
   catch(error){if(unavailable(error))throw new ServiceError('forum_condition_unavailable',409);throw error;}
  }
  for(const rule of [parsed.data.read,parsed.data.participate])if(rule.kind==='external-credential'&&!this.externalCredentials?.supportedConditions().some(condition=>condition.issuerId===rule.issuerId&&condition.conditionId===rule.conditionId))throw new ServiceError('forum_condition_unavailable',409);
  return parsed.data;
 }
 async sectionWithin(db,id,{lock=false}={}){
  if(!id)return null;return (await db.query(`SELECT * FROM forum_sections_v2 WHERE id=$1${lock?' FOR SHARE':''}`,[id])).rows[0]??null;
 }
 async sectionAllowedWithin(db,section,viewer,mode='read'){
  if(!section)return false;
  if(viewer?.accountId===section.maintainer_account_id)return mode!=='participate'||section.state==='active';
  if(mode==='participate'&&section.state!=='active')return false;
  return await this.ruleWithin(db,section.audience.read,viewer)&&(mode==='read'||await this.ruleWithin(db,section.audience.participate,viewer));
 }
 async publicationWithin(db,actor,p,{previous=null,source=null}={}){
  const viewer=await this.viewerWithin(db,actor),audience=await this.assertAudienceWithin(db,p.audience??previous?.audience??source?.audience??legacyForumAudience),
   sectionId=p.sectionId===undefined?(previous?.section_id??source?.section_id??null):p.sectionId;
  const section=sectionId?await this.sectionWithin(db,sectionId,{lock:true}):null;
  if(sectionId&&(!section||!await this.sectionAllowedWithin(db,section,viewer,'participate')))throw new ServiceError('forum_section_participation_denied',403);
  return {audience,sectionId};
 }
 async snapshotWithin(db,row){
  const rules=[{kind:'source-audience',authorAccountId:row.account_id,rule:(row.audience??legacyForumAudience).read}];
  if(row.section_id){const section=await this.sectionWithin(db,row.section_id);if(!section)throw new ServiceError('forum_source_unavailable',403);rules.push({kind:'source-audience',authorAccountId:section.maintainer_account_id,rule:section.audience.read});}
  return rules;
 }
 async contentWithin(db,permission,{viewerActor=null}={}){
  if(!['forum.post.publish','forum.reply.publish'].includes(permission.action))return true;
  const table=permission.action==='forum.post.publish'?'forum_versions_v1':'forum_replies_v1',row=(await db.query(`SELECT * FROM ${table} WHERE publication_event_id=$1`,[permission.event_id])).rows[0];
  if(!row)return false;
  if(viewerActor?.subjectId&&viewerActor.subjectId===row.subject_id)return true;
  const viewer=await this.viewerWithin(db,viewerActor);
  if(viewer?.accountId===row.account_id)return true;
  if(!row.audience_inherited&&!await this.ruleWithin(db,(row.audience??legacyForumAudience).read,viewer))return false;
  for(const rule of row.parent_audience??[])if(!await this.ruleWithin(db,rule,viewer))return false;
  if(row.section_id){const section=await this.sectionWithin(db,row.section_id);if(!await this.sectionAllowedWithin(db,section,viewer,'read'))return false;}
  return true;
 }
 async participationWithin(db,actor,source){
  const viewer=await this.viewerWithin(db,actor);
  if(!viewer||!await this.ruleWithin(db,(source.audience??legacyForumAudience).participate,viewer))throw new ServiceError('forum_participation_denied',403);
  if(source.section_id&&!await this.sectionAllowedWithin(db,await this.sectionWithin(db,source.section_id,{lock:true}),viewer,'participate'))throw new ServiceError('forum_section_participation_denied',403);
 }
 async options(){
  const honor=this.honor?await this.honor.legacy.list():null;
  return {rules:[{kind:'everyone',label:'所有人'},{kind:'accounts',label:'银河账户'},{kind:'selected-accounts',label:'指定账户'}],
   honors:(honor?.rules??[]).filter(rule=>rule.sourceProfile==='facts-v2'&&!rule.revoked).map(rule=>({ruleId:rule.id,ruleVersion:rule.version,label:rule.name??rule.id,issuer:rule.issuer})),
   externalCredentials:this.externalCredentials?.supportedConditions()??[],externalCredentialsState:this.externalCredentials?.supportedConditions().length?'configured':'no-configured-external-credential-source',checkedAt:this.forum.clock()};
 }
}
