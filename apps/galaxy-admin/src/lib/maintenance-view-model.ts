import type {MaintenanceAvailability,MaintenanceCommandResult,MaintenanceComponent,MaintenanceComponentAvailability,MaintenanceLocation,MaintenanceNativeOperation,MaintenanceOperationDetail,MaintenancePlan,MaintenancePlanDetail,MaintenancePoint,MaintenanceTab} from '../components/maintenance-types';

const hash=/^[a-f0-9]{64}$/,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,sequence=/^[1-9][0-9]{0,15}$/;
export type MaintenanceRecoveredResult=Omit<MaintenanceCommandResult,'recordedAt'>;
type OriginalIntent=Readonly<{path:string;body:Record<string,unknown>}>;
export function maintenanceRecoveryReceipt(intent:OriginalIntent,value:unknown):{result:MaintenanceRecoveredResult;nativeKind:'backup-create'|'backup-verify'|'restore-execute'|null}|null{
 const operationId=typeof intent.body.operationId==='string'?intent.body.operationId:'';
 if(!uuid.test(operationId))throw Error('Invalid original maintenance operation');
 const plan=/^\/v1\/operations\/maintenance\/restore-plans\/([0-9a-f-]{36})\/(approve|execute|cancel)$/.exec(intent.path);
 const kind=intent.path==='/v1/operations/maintenance/backups'&&['create','verify'].includes(String(intent.body.kind))?String(intent.body.kind):intent.path==='/v1/operations/maintenance/restore-plans'?'plan':plan?.[2];
 if(!kind||plan&&!uuid.test(plan[1]))throw Error('Different original maintenance operation');
 // This endpoint enforces the same endpoint/current owner before projection.
 const row=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
 if(!row||row.operationId!==operationId||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.readExpiresAt<row.checkedAt||row.readExpiresAt-row.checkedAt>31||row.readExpiresAt*1000<=Date.now())throw Error('Invalid maintenance owner receipt');
 if(row.state==='not-recorded'||row.state==='unknown')return null;
 if(row.state!=='recorded'||row.kind!==kind)throw Error('Different maintenance owner receipt');
 const result=row.result&&typeof row.result==='object'&&!Array.isArray(row.result)?row.result as Record<string,unknown>:null;
 if(!result||!['accepted','blocked','awaiting-approval','approved','preparing','cancelled'].includes(String(result.state)))throw Error('Invalid maintenance receipt result');
 if(kind==='create'||kind==='verify'){
  if(result.state!=='accepted')throw Error('Invalid maintenance backup receipt');
  return{result:{operationId,state:'accepted',replayed:true},nativeKind:kind==='create'?'backup-create':'backup-verify'};
 }
 const planId=typeof result.planId==='string'?result.planId:'',revision=result.revision;
 if(!uuid.test(planId)||plan&&planId!==plan[1]||typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1)throw Error('Different maintenance plan receipt');
 return{result:{operationId,state:String(result.state),planId,revision,replayed:true},nativeKind:kind==='execute'?'restore-execute':null};
}
export function maintenanceRecoveryNative(value:MaintenanceOperationDetail,operationId:string,kind:'backup-create'|'backup-verify'|'restore-execute'):MaintenanceNativeOperation{
 const op=value?.operation,now=Date.now()/1000;
 if(value?.metadataOnly!==true||!Number.isFinite(value.checkedAt)||!Number.isFinite(value.readExpiresAt)||value.readExpiresAt<value.checkedAt||value.readExpiresAt-value.checkedAt>31||value.readExpiresAt<=now||value.availability?.state!=='available'||!op||op.id!==operationId||op.kind!==kind||!['pending','running','succeeded','failed','unknown'].includes(op.state))throw Error('Original native maintenance result unavailable');
 return op;
}
const string=(value:unknown)=>typeof value==='string'?value:'';
const iso=(value:unknown)=>{const s=string(value);return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.]\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)&&Number.isFinite(Date.parse(s))?s:'';};
const logCursor=(value:unknown)=>{const s=string(value);return /^[0-9]{16,20}$/.test(s)?s:iso(s);};
function trail(input:unknown,valid:(value:string)=>boolean){
 if(Array.isArray(input))return input.length<=30&&input.every(x=>typeof x==='string'&&(x===''||valid(x)))?[...input] as string[]:[];
 const source=string(input);if(!source||source.length>6500)return[];
 try{const values:unknown=JSON.parse(source);return Array.isArray(values)&&values.length<=30&&values.every(x=>typeof x==='string'&&(x===''||valid(x)))?values as string[]:[];}catch{return[];}
}
export const maintenanceTabs:readonly {id:MaintenanceTab;label:string}[]=[{id:'overview',label:'运行概览'},{id:'logs',label:'日志与诊断'},{id:'backups',label:'整站备份恢复'},{id:'control',label:'维护控制'}];
export function maintenanceLocation(input:Record<string,unknown>={}):MaintenanceLocation{
 const tab=string(input.tab),level=string(input.level),period=string(input.period);
 return{tab:maintenanceTabs.some(x=>x.id===tab)?tab as MaintenanceTab:'backups',point:hash.test(string(input.point))?string(input.point):'',plan:uuid.test(string(input.plan))?string(input.plan):'',
 backupAfter:hash.test(string(input.backupAfter))?string(input.backupAfter):'',backupTrail:trail(input.backupTrail,x=>hash.test(x)),planAfter:uuid.test(string(input.planAfter))?string(input.planAfter):'',planTrail:trail(input.planTrail,x=>uuid.test(x)),historyAfter:sequence.test(string(input.historyAfter))?string(input.historyAfter):'',historyTrail:trail(input.historyTrail,x=>sequence.test(x)),
 component:/^[a-z][a-z0-9-]{0,63}$/.test(string(input.component))?string(input.component):'',level:['info','warn','error'].includes(level)?level as MaintenanceLocation['level']:'all',period:['15m','24h'].includes(period)?period as MaintenanceLocation['period']:'1h',before:logCursor(input.before),logTrail:trail(input.logTrail,x=>!!logCursor(x))};
}
export function maintenanceHref(location:MaintenanceLocation,patch:Partial<MaintenanceLocation>={}){
 const value=maintenanceLocation({...location,...patch}),params=new URLSearchParams({tab:value.tab});
 for(const key of ['point','plan','backupAfter','planAfter','historyAfter','component','before'] as const)if(value[key])params.set(key,value[key]);
 if(value.level!=='all')params.set('level',value.level);if(value.period!=='1h')params.set('period',value.period);
 for(const key of ['backupTrail','planTrail','historyTrail','logTrail'] as const)if(value[key].length)params.set(key,JSON.stringify(value[key]));
 return'/admin/operations/maintenance?'+params.toString();
}
export function maintenancePath(kind:'overview'|'backups'|'plans'|'plan'|'point'|'logs',location:MaintenanceLocation){
 const base='/v1/operations/maintenance',params=new URLSearchParams();
 if(kind==='overview')return base+'/overview';
 if(kind==='point')return location.point?base+'/backups/'+location.point:null;
 if(kind==='plan'){if(!location.plan)return null;params.set('limit','25');if(location.historyAfter)params.set('after',location.historyAfter);return base+'/restore-plans/'+location.plan+'?'+params;}
 if(kind==='backups'){params.set('limit','25');if(location.backupAfter)params.set('after',location.backupAfter);return base+'/backups?'+params;}
 if(kind==='plans'){params.set('limit','25');if(location.planAfter)params.set('after',location.planAfter);return base+'/restore-plans?'+params;}
 params.set('level',location.level);params.set('period',location.period);params.set('limit','50');if(location.component)params.set('component',location.component);if(location.before)params.set('before',location.before);
 return base+'/logs?'+params;
}
export function maintenanceNext(location:MaintenanceLocation,kind:'backups'|'plans'|'history'|'logs',cursor:string):Partial<MaintenanceLocation>|null{
 if(kind==='backups')return hash.test(cursor)?{backupAfter:cursor,backupTrail:[...location.backupTrail,location.backupAfter].slice(-30)}:null;
 if(kind==='plans')return uuid.test(cursor)?{planAfter:cursor,planTrail:[...location.planTrail,location.planAfter].slice(-30)}:null;
 if(kind==='history')return sequence.test(cursor)?{historyAfter:cursor,historyTrail:[...location.historyTrail,location.historyAfter].slice(-30)}:null;
 return logCursor(cursor)?{before:cursor,logTrail:[...location.logTrail,location.before].slice(-30)}:null;
}
export function maintenancePrevious(location:MaintenanceLocation,kind:'backups'|'plans'|'history'|'logs'):Partial<MaintenanceLocation>{
 if(kind==='backups')return{backupAfter:location.backupTrail.at(-1)??'',backupTrail:location.backupTrail.slice(0,-1)};
 if(kind==='plans')return{planAfter:location.planTrail.at(-1)??'',planTrail:location.planTrail.slice(0,-1)};
 if(kind==='history')return{historyAfter:location.historyTrail.at(-1)??'',historyTrail:location.historyTrail.slice(0,-1)};
 return{before:location.logTrail.at(-1)??'',logTrail:location.logTrail.slice(0,-1)};
}
export const maintenanceLease=<T extends {readExpiresAt:number},>(value:T|null,now:number):T|null=>value&&Number.isFinite(value.readExpiresAt)&&value.readExpiresAt*1000>now?value:null;
export function maintenanceCount(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value.toLocaleString('zh-CN'):'未取得';}
export function maintenanceBytes(value:unknown){
 if(typeof value!=='number'||!Number.isFinite(value)||value<0)return'未取得';
 if(value<1024)return value.toLocaleString('zh-CN')+' B';const units=['KiB','MiB','GiB','TiB'];let size=value/1024,index=0;while(size>=1024&&index<units.length-1){size/=1024;index++;}return size.toLocaleString('zh-CN',{maximumFractionDigits:1})+' '+units[index];
}
export function maintenanceTime(value:string|null|undefined){if(!value||!Number.isFinite(Date.parse(value)))return'未记录';return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});}
export function maintenanceCalendar(value:string|null|undefined){if(!value)return'未取得';const match=/^\*-\*-\* ([01][0-9]|2[0-3]):([0-5][0-9]):00 UTC$/.exec(value);return match?'每日 '+match[1]+':'+match[2]+' UTC':value;}
export const maintenancePlanLabels:Record<MaintenancePlan['state'],string>={blocked:'条件未齐', 'awaiting-approval':'待人工批准',approved:'已批准',preparing:'准备中',restoring:'恢复中',validating:'核对中','ready-to-open':'等待统一开放',opening:'开放中',completed:'已完成',failed:'执行失败',cancelled:'已取消'};
export function maintenanceIntegrity(point:MaintenancePoint){return{verified:'完整性已校验','not-verified':'尚未校验',failed:'完整性校验失败',unknown:'校验状态未知'}[point.integrity.state];}
export function maintenanceAvailabilityText(value:MaintenanceAvailability|null|undefined){return value?.state==='available'?'已取得':value?.state==='partial'?'部分已取得':value?.state==='not-configured'?'尚未配置':'暂未取得';}
const componentSourceReasons:Record<string,string>={maintenance_component_not_bound:'未接入来源',maintenance_component_process_unavailable:'读取失败',maintenance_component_binding_invalid:'来源未能核对',maintenance_component_response_invalid:'来源未能核对',maintenance_component_unit_unavailable:'未取得服务',maintenance_health_not_connected:'未接入检查',maintenance_health_process_not_running:'进程未运行',maintenance_health_read_failed:'读取失败',maintenance_health_response_invalid:'来源未能核对',maintenance_health_source_ambiguous:'来源未能核对',maintenance_health_sample_missing:'未取得样本',maintenance_health_sample_stale:'观测已过期',maintenance_health_scrape_failed:'采集失败'};
export function maintenanceComponentSource(value:MaintenanceComponentAvailability|null|undefined){return value?.state==='available'?'':componentSourceReasons[value?.code??'']??'暂未取得';}
export function maintenanceProcessText(item:MaintenanceComponent){return item.processState==='not-applicable'&&item.id==='website'&&item.processBasis==='static-site'?'无独立进程':({running:'运行中',stopped:'已停止',failed:'运行失败',unknown:'未取得','not-applicable':'未取得'})[item.processState];}
export function maintenanceHealthText(item:MaintenanceComponent){
 if(item.healthAvailability?.state==='not-configured')return'未接入检查';
 if(item.healthAvailability&&item.healthAvailability.state!=='available')return'未取得';
 if(item.healthBasis==='prometheus-target')return item.health==='healthy'?'采集正常':item.health==='unhealthy'?'采集异常':'未取得';
 if(item.healthBasis==='prometheus-probe')return item.health==='healthy'?'可访问':item.health==='unhealthy'?'访问异常':'未取得';
 return({healthy:'健康',unhealthy:'异常',unknown:'检查中','not-configured':'未配置'})[item.health];
}
export const maintenanceConditionLabels:Record<string,string>={'capture-integrity':'备份完整性校验通过','database-consistency':'数据库一致性达到要求','authorization-invalidated':'旧会话与授权完成处理','source-lifecycle-reconciled':'来源、到期与撤回状态完成核对','outbound-delivery-reconciled':'外发消息与未知投递结果完成核对','required-modules-ready':'本次方案全部模块就绪','public-readiness':'对外服务可用性检查通过'};
const reasons:Record<string,string>={
 maintenance_execution_failed:'本次操作执行失败。',
 maintenance_api_readiness_timeout:'等待业务服务就绪超时，本次备份未完成。',
 maintenance_api_readiness_failed:'未能确认业务服务已就绪，本次备份未完成。',
 maintenance_api_binding_invalid:'当前业务服务版本无法核对，本次备份已停止。',
 maintenance_api_binding_changed:'业务服务版本与本次备份不一致，操作已停止。',
 maintenance_current_footprint_changed:'备份来源核对未通过，本次备份未完成。请查看运行记录。',
 maintenance_security_preservation_not_recorded:'本方案未记录账号与安全状态的保留安排，请重新整理方案',
 maintenance_native_not_connected:'维护服务尚未连接',maintenance_native_not_configured:'维护服务尚未配置',maintenance_native_unavailable:'维护服务暂不可用',maintenance_queue_query_failed:'任务队列暂时无法读取',maintenance_object_usage_not_connected:'对象仓库空间尚未取得',maintenance_coverage_not_recorded:'覆盖情况未记录',maintenance_production_restore_not_verified:'生产恢复条件尚未验证',maintenance_point_coverage_incomplete:'本次恢复点覆盖不完整',maintenance_point_not_verified:'恢复点尚未通过完整性校验',maintenance_production_adapter_unavailable:'生产整站恢复执行器尚未就绪',maintenance_current_footprint_unknown:'当前站点组成尚未取得',maintenance_capture_coverage_incomplete:'备份捕获范围不完整',maintenance_point_missing:'恢复点当前不可用',maintenance_native_busy:'已有维护操作正在进行',maintenance_plan_changed:'方案或当前站点已有变化，请重新读取',maintenance_plan_not_approvable:'当前方案条件未齐，暂不能批准',maintenance_plan_not_found:'这份恢复方案不存在',maintenance_backup_not_found:'这个恢复点当前不存在',maintenance_operation_conflict:'原操作内容不一致，请查看当前结果',maintenance_human_required:'本次操作需要人工管理身份',maintenance_authorization_unavailable:'当前授权暂时无法核对',invalid_maintenance_request:'本次参数无效，请重新读取后继续',
};
export function maintenanceReason(code:string|null|undefined){return code?reasons[code]??'当前条件尚未满足':'未记录';}
export const maintenanceCommandErrors=reasons;
export function maintenanceRestoreBasis(value:unknown){
 return value==='current-security-authority'?'保留当前状态':value==='point-with-current-permissions'?'按恢复点，保留当前权限':value==='point-with-current-keys'?'按恢复点，保留当前密钥':value==='selected-recovery-point'?'按所选恢复点':'处理方式未记录';
}
const preservedCurrentItems=['accounts','passwords','current-permissions','keys'] as const;
export function maintenanceCurrentAuthorityDeclared(plan:Pick<MaintenancePlan,'preservedCurrent'>){
 const value=plan.preservedCurrent;
 return value?.state==='declared'&&value.basis==='current-security-authority'&&Array.isArray(value.items)&&value.items.length===preservedCurrentItems.length
  &&preservedCurrentItems.every(item=>value.items.includes(item));
}
export function maintenanceApprovalBody(detail:MaintenancePlanDetail){
 const plan=detail.plan;if(!detail.permissions.canApprove||!maintenanceCurrentAuthorityDeclared(plan)||plan.state!=='awaiting-approval'||plan.blockers.length||!hash.test(plan.planDigest)||!Number.isSafeInteger(plan.revision)||plan.revision<1)return null;
 return{expectedRevision:plan.revision,expectedPlanDigest:plan.planDigest,acknowledgement:{point:true,scope:true,possibleLoss:true,openingConditions:true}};
}
export function maintenanceExecutionBody(detail:MaintenancePlanDetail){
 return detail.permissions.canExecute&&maintenanceCurrentAuthorityDeclared(detail.plan)&&detail.plan.state==='approved'&&!detail.plan.blockers.length&&detail.plan.approval&&detail.plan.approval.revision===detail.plan.revision?{expectedRevision:detail.plan.revision}:null;
}
export function maintenanceLossText(plan:MaintenancePlan){
 return plan.possibleLoss.from?'所选业务资料在恢复点之后至相关写入暂停前的变化可能丢失。':'可能丢失的时间范围尚未取得。';
}
