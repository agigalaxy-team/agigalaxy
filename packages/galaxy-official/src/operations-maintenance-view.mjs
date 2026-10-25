import {maintenanceModules,maintenanceComponents,maintenanceDiagnostics,maintenanceOpeningConditions} from './operations-maintenance-catalog.mjs';
import {runtimeLogEvent} from './operations/runtime-log.mjs';

export const maintenanceIso=value=>{if(value===null||value===undefined)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null;};
const number=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const token=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,99}$/.test(value)?value:null;
const ref=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,119}$/.test(value)?value:null;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
export const maintenanceAvailability=(state,code=null)=>({state:['available','unavailable','not-configured','partial'].includes(state)?state:'unavailable',code:token(code)});
const componentCodes=new Set(['maintenance_component_not_bound','maintenance_component_process_unavailable','maintenance_component_binding_invalid','maintenance_component_response_invalid','maintenance_component_unit_unavailable',
 'maintenance_health_not_connected','maintenance_health_process_not_running','maintenance_health_read_failed','maintenance_health_response_invalid','maintenance_health_source_ambiguous','maintenance_health_sample_missing','maintenance_health_sample_stale','maintenance_health_scrape_failed']);
const componentUnavailable=()=>({state:'unavailable',code:'maintenance_component_response_invalid'});
function componentAvailability(value,fallback){
 if(value===undefined)return fallback;
 if(!value||typeof value!=='object'||Array.isArray(value)||!['available','unavailable','not-configured'].includes(value.state)
  ||value.state==='available'&&value.code!==null||value.state!=='available'&&!componentCodes.has(value.code))return componentUnavailable();
 return{state:value.state,code:value.code};
}
function componentView(entry,input){
 const matches=Array.isArray(input)&&input.length<=64?input.filter(row=>row?.id===entry.id):[],row=matches.length===1?matches[0]:null;
 const invalid=matches.length>1||Array.isArray(input)&&input.length>64;
 const processBasis=['systemd-process','container-process','static-site','not-connected'].includes(row?.processBasis)?row.processBasis:['systemd-process','container-process'].includes(row?.healthBasis)?row.healthBasis:'not-connected';
 const staticSite=entry.id==='website'&&processBasis==='static-site';
 let processState=['running','stopped','failed','unknown'].includes(row?.processState)?row.processState:row?.processState==='not-applicable'&&staticSite?'not-applicable':'unknown';
 let processAvailability=invalid?componentUnavailable():componentAvailability(row?.processAvailability,['running','stopped','failed'].includes(processState)?{state:'available',code:null}:{state:'not-configured',code:'maintenance_component_not_bound'});
 if(row?.processState==='not-applicable'&&!staticSite||processBasis==='static-site'&&(!staticSite||row?.processState!=='not-applicable'))processAvailability=componentUnavailable();
 if(processAvailability.state!=='available')processState='unknown';
 const healthBasis=['prometheus-target','prometheus-probe','container-healthcheck','native-health-endpoint','systemd-process','container-process','not-connected'].includes(row?.healthBasis)?row.healthBasis:'not-connected';
 let healthAvailability=invalid?componentUnavailable():componentAvailability(row?.healthAvailability,['healthy','unhealthy'].includes(row?.health)?{state:'available',code:null}:{state:'not-configured',code:'maintenance_health_not_connected'});
 let health=['healthy','unhealthy','unknown','not-configured'].includes(row?.health)?row.health:'unknown';
 const processCheckedAt=maintenanceIso(row&&Object.hasOwn(row,'processCheckedAt')?row.processCheckedAt:row?.checkedAt),healthCheckedAt=maintenanceIso(row&&Object.hasOwn(row,'healthCheckedAt')?row.healthCheckedAt:(['healthy','unhealthy'].includes(health)?row?.checkedAt:null));
 if(healthAvailability.state==='available'&&(['not-connected','systemd-process','container-process'].includes(healthBasis)||['healthy','unhealthy'].includes(health)&&healthCheckedAt===null
  ||healthBasis==='prometheus-probe'&&entry.id!=='website'||healthBasis==='prometheus-target'&&!['api','worker'].includes(entry.id)))healthAvailability=componentUnavailable();
 if(healthAvailability.state!=='available')health='unknown';
 return{...entry,processState,processBasis,processAvailability,health,healthBasis,healthAvailability,processCheckedAt,healthCheckedAt,checkedAt:maintenanceIso(row?.checkedAt),code:token(row?.code)};
}
export function maintenanceCoverage(input=[]){
 return maintenanceModules.map(module=>{
  const item=Array.isArray(input)?input.find(x=>x?.id===module.id):null;
  return{...module,state:['covered','uncovered','unknown','not-applicable'].includes(item?.state)?item.state:'unknown',
   method:['pgbackrest-cluster','bounded-quiesced-volume','selected-files','rebuild-from-authoritative-source'].includes(item?.method)?item.method:null,
   sourceIds:Array.isArray(item?.sourceIds)?item.sourceIds.map(ref).filter(Boolean):[],
   postgresStanzas:Array.isArray(item?.postgresStanzas)?item.postgresStanzas.map(ref).filter(Boolean):[],
   reasonCodes:Array.isArray(item?.reasonCodes)?item.reasonCodes.map(token).filter(Boolean):['maintenance_coverage_not_recorded'],
   existenceAtOlderPoint:'not-inferred'};
 });
}
export function maintenancePoint(input){
 if(!hash(input?.id))return null;
 return{id:input.id,createdAt:maintenanceIso(input.createdAt??input.time),captureId:typeof input.captureId==='string'&&/^[a-f0-9-]{36}$/.test(input.captureId)?input.captureId:null,
  logicalBytes:number(input.logicalBytes),logicalFileCount:number(input.logicalFileCount),sizeBasis:'native-snapshot-processed-data',
  integrity:{state:['verified','not-verified','failed','unknown'].includes(input.integrity?.state)?input.integrity.state:'not-verified',checkedAt:maintenanceIso(input.integrity?.checkedAt)},
  coverage:maintenanceCoverage(input.coverage),
  capture:{state:['available','unavailable','unknown'].includes(input.capture?.state)?input.capture.state:'unknown',startedAt:maintenanceIso(input.capture?.startedAt),finishedAt:maintenanceIso(input.capture?.finishedAt),
   consistency:input.capture?.consistency==='named-pg-points-and-bounded-quiesced-files'?'named-pg-points-and-bounded-quiesced-files':null},
  productionRestore:{available:input.productionRestore?.available===true,blockers:Array.isArray(input.productionRestore?.blockers)?input.productionRestore.blockers.map(token).filter(Boolean):['maintenance_production_restore_not_verified']}};
}
export function maintenanceOverview(input={}){
 const components=maintenanceComponents.map(entry=>componentView(entry,input.components));
 const storage=(Array.isArray(input.storage)?input.storage:[]).flatMap(row=>{
  if(!['host-filesystem','backup-staging-filesystem','object-repository'].includes(row.id))return[];
  return[{id:row.id,kind:row.id==='object-repository'?'object-repository':'filesystem',availability:maintenanceAvailability(row.availability?.state,row.availability?.code),capacityBytes:number(row.capacityBytes),availableBytes:number(row.availableBytes),usedBytes:number(row.usedBytes),physicalReclaimedBytes:null,observedAt:maintenanceIso(row.observedAt)}];
 });
 if(!storage.some(x=>x.id==='object-repository'))storage.push({id:'object-repository',kind:'object-repository',availability:maintenanceAvailability('unavailable','maintenance_object_usage_not_connected'),capacityBytes:null,availableBytes:null,usedBytes:null,physicalReclaimedBytes:null,observedAt:null});
 return{components,storage,coverage:maintenanceCoverage(input.coverage),
  errors:{availability:maintenanceAvailability(input.errors?.availability?.state,input.errors?.availability?.code),window:'1h',scope:'collected-runtime-records',includesAllComponents:false,count:number(input.errors?.count)},
  ai:{state:'not-connected',modelState:null,requiredForCodeExecution:false},
  nativeAvailability:maintenanceAvailability(input.availability?.state,input.availability?.code)};
}
export function maintenancePolicy(input={}){
 const retention=input.retention??{},timer=input.timer??{};
 return{source:'existing-host-configuration',calendar:typeof input.calendar==='string'&&input.calendar.length<=100&&!/[\p{Cc}]/u.test(input.calendar)?input.calendar:null,
  timer:{state:['active','inactive','failed','unknown'].includes(timer.state)?timer.state:'unknown',enabled:typeof timer.enabled==='boolean'?timer.enabled:null,nextAt:maintenanceIso(timer.nextAt),lastAt:maintenanceIso(timer.lastAt)},
  retention:{daily:number(retention.daily),weekly:number(retention.weekly),monthly:number(retention.monthly),source:'existing-configuration'},
  repository:{location:['same-host','off-host','unknown'].includes(input.repository?.location)?input.repository.location:'unknown',encrypted:typeof input.repository?.encrypted==='boolean'?input.repository.encrypted:null},
  offHostPolicy:'undecided',newPolicyValues:'not-selected',
  writerPause:{mode:'online-first-bounded-related-writers',existingLimitSeconds:number(input.pauseLimitSeconds)},
  lastCreate:maintenanceBackupStatus(input.lastCreate),lastVerification:maintenanceBackupStatus(input.lastVerification)};
}
export function maintenanceBackupStatus(row){
 if(!row||!['running','succeeded','failed','unknown'].includes(row.outcome))return null;
 return{outcome:row.outcome,startedAt:maintenanceIso(row.startedAt),finishedAt:maintenanceIso(row.finishedAt),lastSuccessAt:maintenanceIso(row.lastSuccessAt),scope:row.scope==='repository-integrity'?'repository-integrity':'capture-only'};
}
export function maintenanceLog(row){
 if(!row||!['info','warn','error','debug'].includes(row.level))return null;
 const safe=runtimeLogEvent(row);
 return{at:maintenanceIso(row.at??row.time),component:ref(row.component),level:row.level,event:safe.event,diagnostic:maintenanceDiagnostics.includes(row.diagnostic)?row.diagnostic:null,
  code:safe.code??null,status:Number.isInteger(row.status)&&row.status>=100&&row.status<=599?row.status:null,
  requestId:typeof row.requestId==='string'&&/^[a-f0-9-]{36}$/.test(row.requestId)?row.requestId:null,
  jobId:typeof row.jobId==='string'&&/^[a-f0-9-]{36}$/.test(row.jobId)?row.jobId:null,
  sqlState:typeof row.sqlState==='string'&&/^[A-Z0-9]{5}$/.test(row.sqlState)?row.sqlState:null,
  detailsOmitted:true};
}
export function maintenancePlanProjection(row){
 const plan=row.plan??{},modules=maintenanceCoverage(plan.modules).filter(x=>(plan.moduleIds??[]).includes(x.id)).map(x=>({...x,restoreBasis:x.id==='accounts'?'current-security-authority':x.id==='business'?'point-with-current-permissions':x.id==='configuration'?'point-with-current-keys':'selected-recovery-point'}));
 return{id:row.id,revision:row.revision,state:row.state,point:maintenancePoint(plan.point),scope:['whole-site','selected-modules'].includes(plan.scope)?plan.scope:null,
  moduleIds:modules.map(x=>x.id),modules,planDigest:row.plan_digest,
   preservedCurrent:plan.preservedCurrent?.state==='declared'&&JSON.stringify(plan.preservedCurrent.items)===JSON.stringify(['accounts','passwords','current-permissions','keys'])?{state:'declared',items:['accounts','passwords','current-permissions','keys'],basis:'current-security-authority'}:{state:'not-recorded',items:[],basis:null},
  possibleLoss:{from:maintenanceIso(plan.possibleLoss?.from),observedAt:maintenanceIso(plan.possibleLoss?.to),observedWindowSeconds:number(plan.possibleLoss?.observedWindowSeconds),maximumSeconds:null,through:'related-writer-pause',basis:plan.possibleLoss?.basis==='point-to-plan-time'?'point-to-plan-time':'unknown',externalDeliveries:'cannot-be-retracted',unconfirmedSubmissions:'must-not-be-blindly-retried'},
  openingConditions:maintenanceOpeningConditions.map(id=>({id,state:plan.openingConditions?.find(x=>x.id===id)?.state==='ready'?'ready':'required'})),
  blockers:Array.isArray(plan.blockers)?plan.blockers.map(token).filter(Boolean):[],
  approval:row.approved_by?{operatorId:row.approved_by,at:maintenanceIso(row.approved_at),revision:row.approved_revision}:null,
  executionId:row.execution_id??null,createdAt:maintenanceIso(row.created_at),updatedAt:maintenanceIso(row.updated_at),
   productionActivation:row.state==='completed'?'recorded-by-approved-executor':row.execution_id?'unknown':'not-opened'};
}
