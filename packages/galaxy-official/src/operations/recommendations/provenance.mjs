import {randomUUID} from "node:crypto";
import {transaction} from "../../database.mjs";
import {recommendationThemeKeys} from "../../discovery-runtime/recommendation-control.mjs";
import {iso,fail} from './helpers.mjs';
import {RecommendationState} from './base.mjs';

// Original public policy and server-issued recommendation positions, bound to the same profile and source version.
export class RecommendationProvenance extends RecommendationState{
 async publicPlan(profileId){return transaction(this.db,async db=>{
  const policy=await this.policyWithin(db),themes=await this.catalogWithin(db);
  const rows=policy.enabled&&policy.controls.avoidRepetition?(await db.query(`WITH latest AS (
   SELECT r.id::text AS id FROM discovery_usage_events_v1 e JOIN discovery_recommendation_requests_v1 r
    ON r.endpoint=e.endpoint AND r.profile_id=e.profile_id AND r.id::text=e.payload->'recommendation'->>'requestId'
   WHERE e.endpoint=$1 AND e.profile_id=$2 AND e.name='content-exposure'
   ORDER BY r.sequence DESC,e.created_at DESC LIMIT 1)
   SELECT payload->>'itemKey' AS item_key FROM discovery_usage_events_v1 e,latest
   WHERE endpoint=$1 AND profile_id=$2 AND name='content-exposure' AND payload->'recommendation'->>'requestId'=latest.id`,[this.endpoint,profileId])).rows:[];
  return {policy,themes,previouslyExposed:new Set(rows.map(row=>row.item_key))};
 });}
 async issue(profileId,mode,candidates,plan){
  const requestId=randomUUID(),policyVersion=mode==='personalized'&&plan.policy.enabled?plan.policy.version:null,placement='home-public-recommendations';
  const items=candidates.map((candidate,index)=>({key:candidate.document.id,kind:candidate.document.kind,id:candidate.document.sourceId,sourceVersion:candidate.document.version,
   position:index+1,candidateSource:candidate.candidate.source,themeKeys:recommendationThemeKeys(plan.themes,candidate.document)}));
  await this.db.query('INSERT INTO discovery_recommendation_requests_v1(endpoint,id,profile_id,policy_version,mode,placement,items,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[this.endpoint,requestId,profileId,policyVersion,mode,placement,JSON.stringify(items),iso(this.now())]);
  return {requestId,policyVersion,placement};
 }
 async evidence(profileId,content,requestId){
  const row=(await this.db.query('SELECT policy_version,placement,items FROM discovery_recommendation_requests_v1 WHERE endpoint=$1 AND id=$2 AND profile_id=$3',[this.endpoint,requestId,profileId])).rows[0];
  const item=row?.items.find(item=>item.kind===content.kind&&item.id===content.id&&item.sourceVersion===content.version);
  if(!item)fail('discovery_recommendation_reference_invalid',403);
  return {requestId,policyVersion:row.policy_version,placement:row.placement,position:item.position,candidateSource:item.candidateSource,themeKeys:item.themeKeys};
 }
}
