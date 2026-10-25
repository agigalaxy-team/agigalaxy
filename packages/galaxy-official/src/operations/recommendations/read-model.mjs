import {transaction} from "../../database.mjs";
import {operationsOperatorNamesWithin} from "../../operations-history-identities.mjs";
import {recommendationOverviewSchema,recommendationHistorySchema,parseRecommendation,normalizeRecommendationTerm} from "../../shared/operations-recommendation-schema.mjs";
import {recommendationThemeKeys} from "../../discovery-runtime/recommendation-control.mjs";
import {iso,stamp,unknownMetrics} from './helpers.mjs';
import {RecommendationProvenance} from './provenance.mjs';

// Qualified current public supply, request-bound theme facts and authorized overview/history. Partial and missing observations stay unknown.
export class RecommendationReadModel extends RecommendationProvenance{
 async sourceSnapshot(catalog){
  if(typeof this.source.qualifiedSnapshot==='function'){
   const snapshot=await this.source.qualifiedSnapshot();return {...snapshot,documents:snapshot.documents.map(document=>({...document,themeKeys:recommendationThemeKeys(catalog,document)}))};
  }
  // Explicit injected readers keep their existing single-reader contract.
  const documents=[];let after='',scanned=0;
  for(;;){const rows=await this.source.candidates({after,limit:100});if(!rows.length)break;
   for(const reference of rows){const document=await this.source.load(reference);if(document)documents.push({...document,themeKeys:recommendationThemeKeys(catalog,document)});}
   scanned+=rows.length;after=rows.at(-1).kind+':'+rows.at(-1).id;if(rows.length<100)break;
  }
  return {documents,complete:true,scanned};
 }
 async topicMetrics(catalog,snapshot,period){
  if(!snapshot.complete)return catalog.map(theme=>({key:theme.key,supply:null,demand:null,...unknownMetrics(),availability:{supply:'partial',usage:'partial'}}));
  const themes=catalog.map(theme=>({key:theme.key,query_terms:theme.enabled?theme.mapping.queryTerms.map(normalizeRecommendationTerm):[]}));
  const refs=snapshot.documents.map(document=>({item_key:document.id,version:document.version,theme_keys:document.themeKeys}));
  const rows=(await this.db.query(`WITH themes AS (SELECT * FROM jsonb_to_recordset($4::jsonb) AS t(key text,query_terms jsonb)),
   refs AS (SELECT * FROM jsonb_to_recordset($5::jsonb) AS r(item_key text,version text,theme_keys jsonb)),
   events AS (SELECT e.name,e.payload,r.theme_keys FROM discovery_usage_events_v1 e LEFT JOIN refs r
    ON r.item_key=e.payload->>'itemKey' AND r.version=e.payload->>'sourceVersion'
    WHERE e.endpoint=$1 AND e.purpose='site-usage-analytics' AND e.created_at>=$2::timestamptz AND e.created_at<$3::timestamptz)
   SELECT t.key,
    count(*) FILTER(WHERE e.name IN ('content-view','content-click','content-bookmark','content-participate','search-click','search')
     AND (coalesce(e.theme_keys,'[]'::jsonb) ? t.key OR e.name='search' AND t.query_terms ? lower(regexp_replace(normalize(trim(coalesce(e.payload->>'query','')),NFKC),'[[:space:]]+',' ','g'))))::integer AS demand,
    count(*) FILTER(WHERE e.name='content-exposure' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS exposures,
    count(*) FILTER(WHERE e.name='content-click' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS clicks,
    count(*) FILTER(WHERE e.name='content-bookmark' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS bookmarks,
    count(*) FILTER(WHERE e.name='not-interested' AND e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS negative,
    count(*) FILTER(WHERE e.payload->'recommendation'->'themeKeys' ? t.key)::integer AS attributed
   FROM themes t LEFT JOIN events e ON coalesce(e.theme_keys,'[]'::jsonb) ? t.key
    OR e.payload->'recommendation'->'themeKeys' ? t.key OR e.name='search' AND t.query_terms ? lower(regexp_replace(normalize(trim(coalesce(e.payload->>'query','')),NFKC),'[[:space:]]+',' ','g'))
   GROUP BY t.key`,[this.endpoint,period.from,period.to,JSON.stringify(themes),JSON.stringify(refs)])).rows;
  const values=new Map(rows.map(row=>[row.key,row]));
  return catalog.map(theme=>{const value=values.get(theme.key),attributed=Number(value?.attributed??0)>0;return {key:theme.key,supply:snapshot.documents.filter(document=>document.themeKeys.includes(theme.key)).length,demand:Number(value?.demand??0),
   exposures:attributed?Number(value.exposures):null,clicks:attributed?Number(value.clicks):null,bookmarks:attributed?Number(value.bookmarks):null,notInterested:attributed?Number(value.negative):null,
   availability:{supply:'available',usage:attributed?'available':'not-collected'}};});
 }
 async overview(operator,input={}){
  const q=parseRecommendation(recommendationOverviewSchema,input);await this.authorize(operator,'recommendations.read');
  const now=this.now(),period={from:iso(now-q.days*86400),to:iso(now),days:q.days};
  const state=await transaction(this.db,async db=>({catalog:await this.catalogWithin(db),policy:await this.policyWithin(db)}));
  const snapshot=await this.sourceSnapshot(state.catalog),topics=await this.topicMetrics(state.catalog,snapshot,period);
  const native=this.openpanel?await this.openpanel.recommendationReport({startDate:period.from,endDate:iso(now-1)}):{metrics:unknownMetrics(),trend:{items:[],availability:'not-connected'}};
  const actor=await this.authorize(operator,'recommendations.read'),canConfigure=actor.businessAuthorization.permissions.includes('recommendations.configure');
  const needle=normalizeRecommendationTerm(q.query),catalog=state.catalog.filter(theme=>!needle||[theme.label,...theme.mapping.queryTerms].some(value=>normalizeRecommendationTerm(value).includes(needle))),keys=new Set(catalog.map(theme=>theme.key));
  return {catalog:{items:catalog},mappingCatalog:{items:state.catalog.filter(theme=>theme.kind!=='theme')},topics:{items:topics.filter(item=>keys.has(item.key))},metrics:native.metrics,trend:native.trend,policy:state.policy,period,
   capabilities:{canConfigure,canMapThemes:canConfigure},basis:{metricsSource:'openpanel-native',topicSource:'galaxy-qualified-usage-events',recommendationAttribution:'request-bound-only',historicalBackfill:false,model:'not-configured',demandUnit:'qualified-normal-usage-events',supplyScope:'current-anonymous-public-community',sourceScanComplete:snapshot.complete,sourceScanStartedAt:snapshot.startedAt??null,sourceScanCompletedAt:snapshot.completedAt??null,sourceSnapshotIsolation:typeof this.source.qualifiedSnapshot==='function'?'repeatable-read':null},...this.metadata()};
 }
 async history(operator,input={}){const q=parseRecommendation(recommendationHistorySchema,input);await this.authorize(operator,'recommendations.read');
  const rows=(await this.db.query('SELECT * FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2::bigint) ORDER BY sequence DESC LIMIT $3',[this.endpoint,q.after??null,q.limit+1])).rows;
  const selected=rows.slice(0,q.limit),names=await operationsOperatorNamesWithin(this.db,{endpoint:this.endpoint,operatorIds:selected.map(row=>row.operator_id)});
  await this.authorize(operator,'recommendations.read');return {items:selected.map(row=>({id:row.id,sequence:String(row.sequence),kind:row.kind,operatorId:row.operator_id,operatorDisplayName:names.get(row.operator_id)??null,version:row.revision,themeKey:row.theme_key,changes:row.changes,reason:row.reason,createdAt:stamp(row.created_at)})),nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,...this.metadata()};
 }
}
