import {randomUUID} from "node:crypto";
import canonicalize from "canonicalize";
import {transaction} from "../../infrastructure/database.mjs";
import {digest} from "../../shared/digest.mjs";
import {recommendationPolicySaveSchema,recommendationThemeSaveSchema,parseRecommendation,normalizeRecommendationTerm} from "../../shared/operations-recommendation-schema.mjs";
import {iso,fail,diff,themeView} from './helpers.mjs';
import {RecommendationReadModel} from './read-model.mjs';
import {recommendationCommandResult} from '../command-receipts.mjs';

// Server-only frozen target conditions; never accepted in the public policy body.
const expectedThemeSchema=recommendationThemeSaveSchema.pick({expectedVersion:true,enabled:true}).extend({key:recommendationPolicySaveSchema.shape.themeKey});

// Explicit theme mapping and policy commands with current authority, CAS and original-intent receipts.
export class OperationsRecommendationService extends RecommendationReadModel{
 commandResult(operator,operationId){
  return recommendationCommandResult({db:this.db,endpoint:this.endpoint,operator,authorize:actor=>this.authorize(actor,'recommendations.read'),now:this.now},operationId);
 }
 async command(operator,kind,input,change,{authorize=null}={}){
  if(typeof authorize!=='function')fail('operations_authorization_unavailable',503);
  const current=async db=>{const fresh=await authorize({db});if(fresh?.kind!=='business-operator'&&!this.businessAdmin?.executorAuthority?.acceptsDuty(fresh)||fresh.endpoint!==this.endpoint||fresh.operatorId!==operator.operatorId)fail('business_admin_denied',403);return this.authorize(fresh,'recommendations.configure',db);};
  await current();return transaction(this.db,async db=>{
  const actor=await current(db),requestHash=digest(canonicalize({kind,input}));
  if(actor.kind==='operations-ai-service'){
   if(kind!=='policy')fail('operations_agentos_human_review_required',409);
   await this.businessAdmin.authorizeOperation(actor,'recommendations.configure',{id:input.themeKey,operationId:input.operationId,command:input},{db});
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912429))',[this.endpoint]);
  const prior=(await db.query('SELECT * FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=$2',[this.endpoint,input.operationId])).rows[0];
  if(prior){if(prior.operator_id!==actor.operatorId||prior.request_hash!==requestHash)fail('recommendation_operation_conflict');return {...prior.result,replayed:true};}
  const changed=await change(db),result={...changed.result,operationId:input.operationId,recordedAt:iso(this.now()),replayed:false};
  await current(db);
  await db.query('INSERT INTO operations_recommendation_events_v1(id,endpoint,operator_id,operation_id,request_hash,kind,revision,theme_key,changes,reason,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[randomUUID(),this.endpoint,actor.operatorId,input.operationId,requestHash,changed.kind,changed.version,changed.themeKey,JSON.stringify(changed.changes),input.reason,JSON.stringify(result),iso(this.now())]);
  if(this.businessAdmin)await this.businessAdmin.recordWithin(db,actor,'recommendations.configure',{operationId:input.operationId,selection:{kind,version:changed.version},result:{version:changed.version}});
  return result;
 });}
 savePolicy(operator,input,options){const x=parseRecommendation(recommendationPolicySaveSchema,input),expectedTheme=options?.expectedTheme===undefined?null:parseRecommendation(expectedThemeSchema,options.expectedTheme);
  if(expectedTheme&&expectedTheme.key!==x.themeKey)fail('invalid_recommendation_request',400);
  return this.command(operator,'policy',x,async db=>{
  const before=await this.policyWithin(db);if(before.version!==x.expectedVersion)fail('recommendation_policy_changed');
  if(expectedTheme){
   // The endpoint recommendation lock already serializes saveTheme. Tags use
   // a different advisory lock, so pin the exact current row until commit.
   // FOR SHARE also protects a theme from any writer outside this service.
   const[kind,id]=x.themeKey.split(':');
   if(kind==='tag')await db.query('SELECT id FROM operations_forum_tags_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE',[this.endpoint,id]);
   else if(kind==='theme')await db.query('SELECT id FROM operations_recommendation_themes_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE',[this.endpoint,id]);
  }
  const catalog=await this.catalogWithin(db),theme=catalog.find(theme=>theme.key===x.themeKey),oldDirection=before.directions.find(item=>item.key===x.themeKey)?.direction??'keep';
  if(expectedTheme&&(!theme||theme.version!==expectedTheme.expectedVersion||theme.enabled!==expectedTheme.enabled))fail('recommendation_theme_changed');
  if(!theme||!theme.enabled&&x.enabled&&x.direction!=='keep'&&x.direction!==oldDirection)fail('recommendation_theme_unavailable',404);
  const directions=new Map(before.directions.map(item=>[item.key,item.direction]));directions.set(x.themeKey,x.direction);
  const policy={...before,version:before.version+1,enabled:x.enabled,controls:x.controls,directions:[...directions].map(([key,direction])=>({key,direction})),updatedAt:iso(this.now())};
  await db.query('INSERT INTO operations_recommendation_policy_v1(endpoint,revision,enabled,directions,controls,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(endpoint) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,directions=excluded.directions,controls=excluded.controls,updated_at=excluded.updated_at',[this.endpoint,policy.version,policy.enabled,JSON.stringify(policy.directions),JSON.stringify(policy.controls),policy.updatedAt]);
  const changes=diff({enabled:before.enabled,...before.controls},{enabled:policy.enabled,...policy.controls},['enabled','avoidRepetition','avoidConcentration']);
  if(oldDirection!==x.direction)changes.direction={before:{key:x.themeKey,value:oldDirection},after:{key:x.themeKey,value:x.direction}};
  return {result:{policy},kind:'policy-updated',version:policy.version,themeKey:x.themeKey,changes};
 },options);}
 saveTheme(operator,input,options){const x=parseRecommendation(recommendationThemeSaveSchema,input);return this.command(operator,'theme',x,async db=>{
  const row=x.themeId?(await db.query('SELECT * FROM operations_recommendation_themes_v1 WHERE endpoint=$1 AND id=$2',[this.endpoint,x.themeId])).rows[0]:null;
  if(x.themeId&&!row)fail('recommendation_theme_unavailable',404);if((row?.revision??0)!==x.expectedVersion)fail('recommendation_theme_changed');
  const before=row?themeView(row):null,id=row?.id??randomUUID(),revision=(row?.revision??0)+1,mapping={...x.mapping,queryTerms:[...new Set(x.mapping.queryTerms.map(normalizeRecommendationTerm))]};
  const tags=(await db.query('SELECT id,enabled FROM operations_forum_tags_v1 WHERE endpoint=$1',[this.endpoint])).rows;
  if(mapping.tagIds.some(id=>!tags.some(tag=>tag.id===id&&(tag.enabled||before?.mapping.tagIds.includes(id)))))fail('recommendation_mapping_unavailable',404);
  await db.query('INSERT INTO operations_recommendation_themes_v1(id,endpoint,label,enabled,revision,mapping,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,revision=excluded.revision,mapping=excluded.mapping,updated_at=excluded.updated_at',[id,this.endpoint,x.label,x.enabled,revision,JSON.stringify(mapping),iso(this.now())]);
  const theme={key:'theme:'+id,id,label:x.label,kind:'theme',version:revision,enabled:x.enabled,mapping,source:'operator-mapping'};
  return {result:{theme},kind:row?'theme-updated':'theme-created',version:revision,themeKey:theme.key,changes:diff(before,theme,['label','enabled','mapping'])};
 },options);}
}
