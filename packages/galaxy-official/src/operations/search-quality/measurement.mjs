import {randomUUID} from "node:crypto";
import {sameNativeSettings,normalizeSearchTerm} from "../../shared/operations-search-quality-schema.mjs";
import {iso,fail} from './helpers.mjs';
import {SearchQualityConfiguration} from './configuration.mjs';

// Public query/result provenance and observed request-bound search quality; this does not grant management rights.
export class SearchQualityMeasurement extends SearchQualityConfiguration{
 async publicPlan(){
  const state=await this.stateWithin(this.db);if(state.pending_operation)await this.reconcile(state.pending_operation);
  const [native,current]=await Promise.all([this.observedSettings(),this.stateWithin(this.db)]),active=await this.versionWithin(this.db,current.active_id);
  return active&&!current.pending_operation&&sameNativeSettings(native,active.native_settings)?{version:active.version,rankingMode:active.settings?.rankingMode??null}:{version:null,rankingMode:null};
 }
 async issueSearch(profileId,request,result,plan){
  const requestId=randomUUID(),resultState=result.items.length?'has-results':request.after>0||result.scanLimited||result.nextAfter!==null?'scan-limited':'no-results';
  const items=result.items.map((item,index)=>({kind:item.kind,id:item.id,sourceVersion:item.version,position:index+1}));
  await this.db.query('INSERT INTO discovery_search_requests_v1(endpoint,id,profile_id,query,configuration_version,source_offset,result_state,items,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[this.endpoint,requestId,profileId,request.query,plan?.version??null,request.after,resultState,JSON.stringify(items),iso(this.now())]);
  return {requestId,configurationVersion:plan?.version??null,resultState,sourceOffset:request.after};
 }
 async evidence(profileId,event){
  const row=(await this.db.query('SELECT * FROM discovery_search_requests_v1 WHERE endpoint=$1 AND id=$2 AND profile_id=$3',[this.endpoint,event.search.requestId,profileId])).rows[0];
  if(!row||event.name==='search'&&(row.source_offset!==0||normalizeSearchTerm(event.query)!==normalizeSearchTerm(row.query)))fail('discovery_search_reference_invalid',403);
  const item=event.content?row.items.find(item=>item.kind===event.content.kind&&item.id===event.content.id&&item.sourceVersion===event.content.version):null;
  if(event.content&&!item)fail('discovery_search_reference_invalid',403);
  return {requestId:row.id,query:row.query,configurationVersion:row.configuration_version,resultState:row.result_state,sourceOffset:row.source_offset,...(item?{position:item.position}:{})};
 }
 async qualityFacts(period,q,after){
  const statement=`WITH base AS (
   SELECT name,payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND purpose='site-usage-analytics'
    AND name IN ('search','search-click','content-bookmark','content-participate') AND created_at>=$2::timestamptz AND created_at<$3::timestamptz),
   searches AS (SELECT lower(regexp_replace(normalize(trim(payload->>'query'),NFKC),'[[:space:]]+',' ','g')) AS key,payload FROM base WHERE name='search'),
   measured AS (SELECT DISTINCT payload->'search'->>'requestId' AS id,key,payload->'search'->>'resultState' AS result_state FROM searches WHERE payload->'search' IS NOT NULL),
   query_counts AS (SELECT key,min(payload->>'query') AS label,count(*)::integer AS searches FROM searches GROUP BY key),
   measurements AS (SELECT key,count(*)::integer AS measured_searches,count(*) FILTER(WHERE result_state<>'scan-limited')::integer AS known_searches,count(*) FILTER(WHERE result_state='no-results')::integer AS no_results,count(*) FILTER(WHERE result_state='scan-limited')::integer AS scan_limited FROM measured GROUP BY key),
   effects AS (SELECT m.key,count(*) FILTER(WHERE e.name='search-click')::integer AS clicks,count(DISTINCT m.id) FILTER(WHERE e.name='search-click')::integer AS clicked_searches,count(*) FILTER(WHERE e.name IN ('content-bookmark','content-participate'))::integer AS follow_ups FROM measured m JOIN base e ON e.payload->'search'->>'requestId'=m.id GROUP BY m.key),
   facts AS (SELECT q.*,coalesce(m.measured_searches,0) AS measured_searches,coalesce(m.known_searches,0) AS known_searches,coalesce(m.no_results,0) AS no_results,coalesce(m.scan_limited,0) AS scan_limited,coalesce(e.clicks,0) AS clicks,coalesce(e.clicked_searches,0) AS clicked_searches,coalesce(e.follow_ups,0) AS follow_ups FROM query_counts q LEFT JOIN measurements m USING(key) LEFT JOIN effects e USING(key)),
   filtered AS (SELECT * FROM facts WHERE ($4='' OR position($4 in key)>0) AND
    CASE $5 WHEN 'all' THEN true WHEN 'no-results' THEN no_results>0 WHEN 'no-recorded-click' THEN measured_searches>0 AND clicked_searches=0 WHEN 'scan-limited' THEN scan_limited>0 WHEN 'unmeasured' THEN searches>measured_searches ELSE false END
    AND ($6='' OR key COLLATE "C">$6 COLLATE "C") ORDER BY key COLLATE "C" LIMIT $7)
   SELECT coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY key COLLATE "C") FROM filtered f),'[]'::jsonb) AS items,
    (SELECT jsonb_build_object('searches',coalesce(sum(searches),0),'measured_searches',coalesce(sum(measured_searches),0),'known_searches',coalesce(sum(known_searches),0),'no_results',coalesce(sum(no_results),0),'scan_limited',coalesce(sum(scan_limited),0),'clicks',coalesce(sum(clicks),0),'clicked_searches',coalesce(sum(clicked_searches),0),'follow_ups',coalesce(sum(follow_ups),0)) FROM facts) AS totals`;
  const row=(await this.db.query(statement,[this.endpoint,period.from,period.to,normalizeSearchTerm(q.query),q.issue,after,q.limit+1])).rows[0];
  const project=value=>({searches:Number(value.searches),measuredSearches:Number(value.measured_searches),resultKnownSearches:Number(value.known_searches),noResults:value.measured_searches>0?Number(value.no_results):null,noResultRate:value.known_searches>0?Number(value.no_results)/Number(value.known_searches):null,clicks:value.measured_searches>0?Number(value.clicks):null,clickedSearches:value.measured_searches>0?Number(value.clicked_searches):null,clickRate:value.measured_searches>0?Number(value.clicked_searches)/Number(value.measured_searches):null,followUps:value.measured_searches>0?Number(value.follow_ups):null,scanLimited:value.measured_searches>0?Number(value.scan_limited):null});
  const selected=row.items.slice(0,q.limit),items=selected.map(value=>({...project(value),key:value.key,label:value.label,issueCodes:[...(value.no_results>0?['no-results']:[]),...(value.measured_searches>0&&!Number(value.clicked_searches)?['no-recorded-click']:[]),...(value.scan_limited>0?['scan-limited']:[]),...(value.searches>value.measured_searches?['unmeasured']:[])]}));
  return {items,metrics:project(row.totals),nextAfter:row.items.length>q.limit?Buffer.from(JSON.stringify(selected.at(-1).key)).toString('base64url'):null};
 }
}
