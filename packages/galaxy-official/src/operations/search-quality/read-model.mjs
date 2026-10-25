import {transaction} from "../../database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {operationsOperatorNamesWithin} from "../../operations-history-identities.mjs";
import {searchQualityFixedConstraints,searchQualityOverviewSchema,searchQualityHistorySchema,searchQualityOperationSchema,parseSearchQuality,editableSearchSettings,sameNativeSettings} from "../../shared/operations-search-quality-schema.mjs";
import {iso,stamp,fail,phases,versionView,operationView,changes} from './helpers.mjs';
import {SearchQualityMeasurement} from './measurement.mjs';

// Current configuration, operation history and quality overview projections for authorized management reads.
export class SearchQualityReadModel extends SearchQualityMeasurement{
 async configurationWithin(db,native){
  const state=await this.stateWithin(db),active=await this.versionWithin(db,state.active_id),draft=await this.versionWithin(db,state.draft_id),pending=state.pending_operation?await this.operationWithin(db,state.pending_operation):null;
  return {revision:state.revision,active:versionView(active),draft:versionView(draft),native:{state:native?active&&!sameNativeSettings(native,active.native_settings)?'drifted':'available':this.meili?'unavailable':'not-connected',settings:native?editableSearchSettings(native):null},pending:pending?operationView(pending):null};
 }
 async operation(operator,id){const value=parseSearchQuality(searchQualityOperationSchema,id);await this.authorize(operator,'search-quality.read');let row=await this.operationWithin(this.db,value);if(!row)fail('search_quality_operation_unavailable',404);if(phases.has(row.phase))row=await this.reconcile(value);await this.authorize(operator,'search-quality.read');return {...operationView(row),...this.metadata()};}
 async history(operator,input={}){
  const q=parseSearchQuality(searchQualityHistorySchema,input);await this.authorize(operator,'search-quality.read');
  const rows=(await this.db.query('SELECT o.*,v.version FROM operations_search_quality_operations_v1 o JOIN operations_search_quality_versions_v1 v ON v.endpoint=o.endpoint AND v.id=o.version_id WHERE o.endpoint=$1 AND ($2::bigint IS NULL OR o.sequence<$2::bigint) ORDER BY o.sequence DESC LIMIT $3',[this.endpoint,q.after??null,q.limit+1])).rows;
  const versions=(await this.db.query("SELECT v.*,EXISTS(SELECT 1 FROM operations_search_quality_operations_v1 o WHERE o.endpoint=v.endpoint AND o.version_id=v.id AND o.kind IN ('apply','restore') AND o.phase='applied') AS was_applied FROM operations_search_quality_versions_v1 v WHERE v.endpoint=$1 AND (v.version=0 OR v.id=ANY($2::uuid[])) ORDER BY v.version DESC",[this.endpoint,[...new Set(rows.slice(0,q.limit).map(row=>row.version_id))]])).rows.map(versionView);
  const selected=rows.slice(0,q.limit),names=await operationsOperatorNamesWithin(this.db,{endpoint:this.endpoint,operatorIds:selected.map(row=>row.operator_id)});
  await this.authorize(operator,'search-quality.read');return {items:selected.map(row=>({id:row.operation_id,sequence:String(row.sequence),kind:row.kind,operatorId:row.operator_id,operatorDisplayName:names.get(row.operator_id)??null,versionId:row.version_id,version:row.version,phase:row.phase,changes:row.changes,reason:row.reason,createdAt:stamp(row.created_at)})),versions,nextAfter:rows.length>q.limit?String(rows[q.limit-1].sequence):null,...this.metadata()};
 }
 async overview(operator,input={}){
  const q=parseSearchQuality(searchQualityOverviewSchema,input);await this.authorize(operator,'search-quality.read');const now=this.now(),period={from:iso(now-q.days*86400),to:iso(now),days:q.days};
  const state=await this.stateWithin(this.db);if(state.pending_operation)await this.reconcile(state.pending_operation);
  let native=null;try{native=await this.observedSettings();}catch(error){if(!(error instanceof ServiceError))throw error;}
  let after='';if(q.after){try{after=JSON.parse(Buffer.from(q.after,'base64url').toString('utf8'));if(typeof after!=='string'||after.length>160||Buffer.from(JSON.stringify(after)).toString('base64url')!==q.after)throw Error();}catch{fail('invalid_search_quality_request',400);}}
  const configuration=await transaction(this.db,db=>this.configurationWithin(db,native)),facts=await this.qualityFacts(period,q,after);
  let report={metrics:{searches:null},trend:{items:[],availability:this.openpanel?'unavailable':'not-connected'}};if(this.openpanel)report=await this.openpanel.searchQualityReport({startDate:period.from,endDate:iso(now-1)});
  const actor=await this.authorize(operator,'search-quality.read'),p=actor.businessAuthorization.permissions;
  return {period,metrics:{...facts.metrics,searches:report.metrics.searches},trend:report.trend,queries:{items:facts.items,nextAfter:facts.nextAfter},configuration,
   capabilities:{canConfigure:p.includes('search-quality.configure')&&!configuration.pending&&(!!configuration.active||configuration.native.state==='available'),canPublish:p.includes('search-quality.publish')&&!configuration.pending&&!!configuration.draft&&configuration.native.state==='available',canRestore:p.includes('search-quality.restore')&&!configuration.pending&&configuration.native.state==='available'},
   basis:{source:'meilisearch-community',metricsSource:'openpanel-native-and-galaxy-request-bound-events',identity:'same-profile-and-source-version',unit:'events',rates:'observed-matched-requests-in-window',bounds:'[from,to)',historicalBackfill:false,qualityCollection:'request-bound-only',noResult:'qualified-empty-and-scan-complete',fixedConstraints:searchQualityFixedConstraints,model:'not-configured'},...this.metadata()};
 }
}
