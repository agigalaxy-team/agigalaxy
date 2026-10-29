'use client';
import {AutonomyObjectContext} from "../autonomy/AutonomyObjectContext";

import {SettingsDraftBoundary,useSettingsDraftState} from "../SettingsDraftBoundary";
import {useSettingsDraftMemory} from "../../lib/use-settings-draft-memory";
import {SettingsReceiptNotice,useSettingsReceiptRecovery} from "../../lib/use-settings-receipt-recovery";

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {FormEvent,ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {AdminIcon} from "../AdminIcons";
import {CommandFeedback,ReadStatus} from "../OperationControls";
import {useOperationCommand} from "../../lib/use-operation-command";
import {useOperationsRead} from "../../lib/use-operations-read";
import {operationsRequest,OperationsRequestError} from "../../lib/operations-client";
import type {MaintenanceRecoveredResult} from "../../lib/maintenance-view-model";
import {maintenanceApprovalBody,maintenanceRecoveryReceipt,maintenanceRecoveryNative,maintenanceAvailabilityText,maintenanceBytes,maintenanceCalendar,maintenanceCommandErrors,maintenanceComponentSource,maintenanceConditionLabels,maintenanceCount,maintenanceCurrentAuthorityDeclared,maintenanceExecutionBody,maintenanceHealthText,maintenanceHref,maintenanceIntegrity,maintenanceLocation,maintenanceLossText,maintenanceNext,maintenancePath,maintenancePlanLabels,maintenancePrevious,maintenanceProcessText,maintenanceReason,maintenanceRestoreBasis,maintenanceTime} from "../../lib/maintenance-view-model";
import type {MaintenanceAvailability,MaintenanceBackupDetail,MaintenanceBackupPage,MaintenanceComponent,MaintenanceLocation,MaintenanceLog,MaintenanceLogPage,MaintenanceModule,MaintenanceNativeOperation,MaintenanceOperationDetail,MaintenanceOverview,MaintenancePlanDetail,MaintenancePlanPage,MaintenancePolicy} from './maintenance-types';
import './maintenance.css';

type RestoreDraft={scope:'whole-site'|'selected-modules';moduleIds:string[]};
type WriteKind='create'|'verify'|'plan'|'approve'|'execute'|'cancel';
type WriteIntent={kind:WriteKind;point:string;plan:string};
const modeLabels={normal:'正常模式',contained:'维护限制中',recovery:'恢复中',resolved:'维护已解除',unknown:'未取得'} as const;
const queueLabels:Record<string,string>={'information-watch':'资料关注','search-recovery':'检索恢复','content-publication':'内容发布','account-notice':'账户通知','retention-cleanup':'到期清理','messaging-run':'消息计划','messaging-delivery':'消息投递'};
const queueStateLabels={created:'待执行',retry:'等待重试',active:'执行中',completed:'已完成',cancelled:'已取消',failed:'失败'} as const;
const nativeStateLabels={pending:'等待执行',running:'执行中',succeeded:'已完成',failed:'执行失败',unknown:'结果未取得',blocked:'条件未齐'} as const;
const diagnosticLabels:Record<string,string>={connection_failure:'连接失败',permission_denied:'权限被拒绝',memory_pressure:'内存压力',storage_full:'空间不足',tls_event:'TLS事件',database_migration:'数据库迁移',backup_event:'备份事件',authentication_event:'认证事件',scanner_event:'扫描事件',service_shutdown:'服务停止',service_lifecycle:'服务状态变化',failure:'运行失败'};
const historyLabels:Record<string,string>={'restore-plan':'已整理具体方案','restore-approve':'人工批准本次方案','restore-execute':'已请求执行本次方案','restore-cancel':'已取消本次方案'};
const executionStepLabels:Record<string,string>={'prepare':'准备','preparing':'准备','restore':'恢复','restoring':'恢复','validate':'校验','validating':'校验','open':'统一开放','opening':'统一开放','capture-integrity':'备份完整性校验','database-consistency':'数据库一致性核对','authorization-invalidated':'旧会话处理','source-lifecycle-reconciled':'来源与到期核对','outbound-delivery-reconciled':'投递结果核对','required-modules-ready':'计划模块就绪','public-readiness':'对外可用性核对'};
const blankDraft:RestoreDraft={scope:'whole-site',moduleIds:[]};
const logKey=(log:MaintenanceLog)=>[log.at,log.component,log.level,log.event,log.requestId,log.jobId,log.status,log.code].join('|');

function Fact({label,children}:{label:string;children:ReactNode}){return <div><dt>{label}</dt><dd>{children}</dd></div>;}
function Empty({title,children}:{title:string;children?:ReactNode}){return <div className="maintenance-empty"><AdminIcon name="activity" size={25}/><strong>{title}</strong>{children&&<p>{children}</p>}</div>;}
function Availability({value}:{value:MaintenanceAvailability|null|undefined}){return <span className="maintenance-muted">{maintenanceAvailabilityText(value)}</span>;}
function MaintenanceLinks(){return <nav className="maintenance-tool-links" aria-label="相关维护工具"><Link href="/admin/operations/jobs">运行任务</Link><Link href="/admin/operations/search-recovery">检索维护</Link><Link href="/admin/operations/retention">到期清理</Link></nav>;}
function Coverage({items,compact=false,restore=false}:{items:MaintenanceModule[];compact?:boolean;restore?:boolean}){
 return <table className={'maintenance-coverage'+(compact?' maintenance-coverage--compact':'')}><thead><tr><th>模块</th><th>覆盖</th>{restore?<th>本次处理</th>:!compact&&<th>方式</th>}</tr></thead><tbody>{items.map(item=><tr key={item.id}><th>{item.label}</th><td data-state={item.state}>{({covered:'已覆盖',uncovered:'未覆盖',unknown:'未取得','not-applicable':'不适用'})[item.state]}</td>{restore?<td>{maintenanceRestoreBasis(item.restoreBasis)}</td>:!compact&&<td>{item.method?({'pgbackrest-cluster':'数据库集群','bounded-quiesced-volume':'相关写入短停','selected-files':'选定文件','rebuild-from-authoritative-source':'按原始数据重建'})[item.method]:'未记录'}</td>}</tr>)}</tbody></table>;
}
function Components({items}:{items:MaintenanceComponent[]}){
 return <table className="maintenance-components"><thead><tr><th>组件</th><th>进程</th><th>健康</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><th>{item.label}</th><td><span data-state={item.processState}>{maintenanceProcessText(item)}</span>{item.processAvailability&&item.processAvailability.state!=='available'&&<div className="maintenance-muted">{maintenanceComponentSource(item.processAvailability)}</div>}</td><td><span data-state={item.health}>{maintenanceHealthText(item)}</span>{item.healthAvailability?.state==='unavailable'&&<div className="maintenance-muted">{maintenanceComponentSource(item.healthAvailability)}</div>}</td></tr>)}</tbody></table>;
}
function QueueFacts({overview}:{overview:MaintenanceOverview|null}){
 if(!overview)return <Empty title="队列状态暂未取得"/>;
 if(overview.queues.availability.state!=='available')return <Empty title="队列状态暂未取得">{maintenanceReason(overview.queues.availability.code)}</Empty>;
 return <><p className="maintenance-caption">已登记业务队列 · 项</p><div className="maintenance-queues">{overview.queues.items.map(queue=><section key={queue.name}><h3>{queueLabels[queue.name]??queue.name}</h3><dl>{(['created','retry','active','failed'] as const).map(state=><Fact key={state} label={queueStateLabels[state]}>{maintenanceCount(queue.counts[state])}</Fact>)}</dl></section>)}</div></>;
}
function StorageFacts({overview}:{overview:MaintenanceOverview|null}){
 if(!overview)return <Empty title="空间信息暂未取得"/>;
 return <div className="maintenance-storage">{overview.storage.map(storage=><section key={storage.id}><div className="maintenance-section-title"><h3>{({'host-filesystem':'主机文件系统','backup-staging-filesystem':'备份工作目录文件系统','object-repository':'对象仓库'})[storage.id]}</h3><Availability value={storage.availability}/></div>{storage.availability.state==='available'&&storage.usedBytes!==null&&storage.capacityBytes!==null&&storage.capacityBytes>0?<div className="maintenance-storage-bar" aria-label={'已用 '+maintenanceBytes(storage.usedBytes)+'，总计 '+maintenanceBytes(storage.capacityBytes)}><i style={{width:Math.min(100,100*storage.usedBytes/storage.capacityBytes)+'%'}}/></div>:null}<dl className="maintenance-facts"><Fact label="已用">{maintenanceBytes(storage.usedBytes)}</Fact><Fact label="可用">{maintenanceBytes(storage.availableBytes)}</Fact><Fact label="总量">{maintenanceBytes(storage.capacityBytes)}</Fact></dl></section>)}</div>;
}
function BackupPolicy({policy}:{policy:MaintenancePolicy|null}){
 if(!policy)return <Empty title="备份计划暂未取得"/>;
 return <><div className="maintenance-section-title"><h3>当前备份计划</h3><span data-state={policy.timer.state}>{({active:'计时器运行中',inactive:'计时器未运行',failed:'计时器失败',unknown:'计时器未取得'})[policy.timer.state]}</span></div><dl className="maintenance-facts"><Fact label="现行日程">{maintenanceCalendar(policy.calendar)}</Fact><Fact label="下次执行">{maintenanceTime(policy.timer.nextAt)}</Fact><Fact label="定时启用">{policy.timer.enabled===null?'未取得':policy.timer.enabled?'已启用':'未启用'}</Fact><Fact label="最近捕获">{policy.lastCreate?({running:'执行中',succeeded:'捕获已完成',failed:'捕获失败',unknown:'结果未取得'})[policy.lastCreate.outcome]:'未记录'}</Fact><Fact label="最近仓库校验">{policy.lastVerification?({running:'校验中',succeeded:'仓库完整性已校验',failed:'校验失败',unknown:'结果未取得'})[policy.lastVerification.outcome]:'未记录'}</Fact></dl><p className="maintenance-caption">在线优先，必要时短暂停止相关写入。</p></>;
}
function NativeOperation({operation}:{operation:MaintenanceNativeOperation|null}){
 if(!operation)return null;
 return <section className="maintenance-section"><div className="maintenance-section-title"><h3>{operation.kind==='backup-create'?'本次备份':operation.kind==='backup-verify'?'本次校验':'本次执行'}</h3><span data-state={operation.state}>{nativeStateLabels[operation.state]}</span></div><dl className="maintenance-facts"><Fact label="开始">{maintenanceTime(operation.startedAt)}</Fact><Fact label="结束">{maintenanceTime(operation.finishedAt)}</Fact></dl>{operation.code&&<p className="maintenance-problem">{maintenanceReason(operation.code)}</p>}{operation.steps.length>0&&<ol className="maintenance-steps">{operation.steps.map((step,index)=><li key={(step.id??'step')+index}><span className="maintenance-step-index">{index+1}</span><div><strong>{step.id?executionStepLabels[step.id]??'已记录步骤':'已记录步骤'}</strong><span>{nativeStateLabels[step.state]}</span><small>{maintenanceTime(step.startedAt)}{step.finishedAt?' — '+maintenanceTime(step.finishedAt):''}</small></div></li>)}</ol>}</section>;
}
function Pagination({kind,location,next,locked,onNavigate}:{kind:'backups'|'plans'|'history'|'logs';location:MaintenanceLocation;next:string|null;locked:boolean;onNavigate:(patch:Partial<MaintenanceLocation>)=>void}){
 const current=kind==='backups'?location.backupAfter:kind==='plans'?location.planAfter:kind==='history'?location.historyAfter:location.before;
 const patch=next?maintenanceNext(location,kind,next):null;
 return current||patch?<div className="maintenance-pagination">{current&&<button type="button" disabled={locked} onClick={()=>onNavigate(maintenancePrevious(location,kind))}>上一批</button>}{patch&&<button type="button" disabled={locked} onClick={()=>onNavigate(patch)}>更早记录</button>}</div>:null;
}
function PlanReview({detail}:{detail:MaintenancePlanDetail}){
 const plan=detail.plan,preserved=maintenanceCurrentAuthorityDeclared(plan);
 return <>
  <div className="maintenance-plan-heading"><h3>本次恢复方案</h3><span data-state={plan.state}>{maintenancePlanLabels[plan.state]}</span></div>
  <dl className="maintenance-plan-summary">
   <Fact label="恢复点">{maintenanceTime(plan.point?.createdAt)}</Fact>
   <Fact label="范围">{plan.scope==='whole-site'?'当前整站计划':plan.modules.length+' 个选定模块'}</Fact>
   <Fact label="恢复内容">本次所选业务内容、文件与引擎恢复到所选恢复点。</Fact>
   <Fact label="保留当前">{preserved?'账号、密码、当前权限与密钥。':<span className="maintenance-problem">{maintenanceReason('maintenance_security_preservation_not_recorded')}。</span>}</Fact>
   <Fact label="可能损失">{maintenanceLossText(plan)}{plan.possibleLoss.from&&<small>起点 {maintenanceTime(plan.possibleLoss.from)}</small>}{plan.possibleLoss.observedAt&&<small>方案观察 {maintenanceTime(plan.possibleLoss.observedAt)}</small>}</Fact>
   <Fact label="统一开放">本次计划内全部模块及开放条件就绪后，由程序统一开放。</Fact>
  </dl>
  {plan.blockers.length>0&&<section className="maintenance-blockers"><h3>当前待满足</h3><ul>{plan.blockers.map(code=><li key={code}>{maintenanceReason(code)}</li>)}</ul></section>}
  <section className="maintenance-section"><h3>本次模块</h3><Coverage items={plan.modules} compact restore={preserved}/></section>
  <section className="maintenance-section"><h3>开放条件</h3><ul className="maintenance-conditions">{plan.openingConditions.map(condition=><li key={condition.id}><span>{maintenanceConditionLabels[condition.id]??'已记录条件'}</span><span data-state={condition.state}>{condition.state==='ready'?'已就绪':'待核对'}</span></li>)}</ul></section>
  <p className="maintenance-caption">已发送的外部消息不能撤回；未确认投递结果需核对后接续。</p>
  {plan.approval&&<p className="maintenance-caption">本次批准 {maintenanceTime(plan.approval.at)} · 操作者 <code>{plan.approval.operatorId}</code></p>}
  <NativeOperation operation={detail.operation}/>
 </>;
}

export function Maintenance(props:Parameters<typeof MaintenanceSettings>[0]){return <SettingsDraftBoundary scope="/admin/operations/maintenance" resetKey={props.csrfToken}><MaintenanceSettings {...props}/></SettingsDraftBoundary>;}
function MaintenanceSettings({location:requestedLocation,csrfToken,canRead,canReadLogs}:{location:MaintenanceLocation;csrfToken:string;canRead:boolean;canReadLogs:boolean}){
 const [pinned,setPinned]=useState<MaintenanceLocation|null>(null),location=pinned??requestedLocation,requested=useRef(requestedLocation);requested.current=requestedLocation;
 const router=useRouter(),inBackups=location.tab==='backups',needsPolicy=inBackups||location.tab==='control';
 const overviewRead=useOperationsRead<MaintenanceOverview>({path:canRead?maintenancePath('overview',location):null,clearOnOffline:true,retryUnavailable:true,failureMessage:'当前运行状态暂时无法取得。'});
 const backupsRead=useOperationsRead<MaintenanceBackupPage>({path:canRead&&needsPolicy?maintenancePath('backups',location):null,clearOnOffline:true,retryUnavailable:true,failureMessage:'备份记录暂时无法取得。'});
 const pointRead=useOperationsRead<MaintenanceBackupDetail>({path:canRead&&inBackups?maintenancePath('point',location):null,clearOnOffline:true,failureMessage:'所选恢复点暂时无法取得。'});
 const plansRead=useOperationsRead<MaintenancePlanPage>({path:canRead&&inBackups?maintenancePath('plans',location):null,clearOnOffline:true,retryUnavailable:true,failureMessage:'恢复方案记录暂时无法取得。'});
 const planRead=useOperationsRead<MaintenancePlanDetail>({path:canRead&&inBackups?maintenancePath('plan',location):null,clearOnOffline:true,failureMessage:'这份恢复方案暂时无法取得。'});
 const logsRead=useOperationsRead<MaintenanceLogPage>({path:location.tab==='logs'&&canReadLogs?maintenancePath('logs',location):null,clearOnOffline:true,failureMessage:'运行日志暂时无法取得。'});
 const [drafts,setDrafts]=useState<Record<string,RestoreDraft>>({}),[operationId,setOperationId]=useState(''),[selectedLog,setSelectedLog]=useState<string|null>(null),[writeIntent,setWriteIntent]=useState<WriteIntent|null>(null);
 const operationRead=useOperationsRead<MaintenanceOperationDetail>({path:canRead&&operationId?'/v1/operations/maintenance/operations/'+operationId:null,clearOnOffline:true,retryUnavailable:true,failureMessage:'本次维护任务结果暂时无法取得。'});
 const overview=overviewRead.value,backups=backupsRead.value,point=pointRead.value?.point??null,plans=plansRead.value,detail=planRead.value,logs=logsRead.value,operation=operationRead.verified?operationRead.value?.operation??null:null;
 const positions=useRef<Record<string,number>>({}),runtimeColumn=useRef<HTMLDivElement|null>(null),backupColumn=useRef<HTMLDivElement|null>(null),restoreColumn=useRef<HTMLDivElement|null>(null),logsColumn=useRef<HTMLDivElement|null>(null);
 const draft=drafts[location.point]??blankDraft;
 useSettingsDraftMemory({scope:'maintenance',ready:!!overview&&overviewRead.verified&&(!location.point||!!point&&pointRead.verified),denied:!canRead||!!overview&&!overview.permissions.canPlanRestore||!!overviewRead.error&&/登录|权限/.test(overviewRead.error)||!!pointRead.error&&/登录|权限/.test(pointRead.error),snapshot:()=>({drafts,positions:positions.current}),restore:value=>{setDrafts(value.drafts);positions.current=value.positions;},discard:()=>{setDrafts({});}});
 const currentWrite=writeIntent;
 const freshOverview=!!overview&&overviewRead.verified&&!overviewRead.loading;
 const freshBackups=!!backups&&backupsRead.verified&&!backupsRead.loading;
 const freshPoint=!!point&&pointRead.verified&&!pointRead.loading;
 const freshPlan=!!detail&&planRead.verified&&!planRead.loading;
 const allowKind=(kind:WriteKind|null)=>{
  if(!canRead)return false;
  if(!kind)return freshOverview||freshBackups||freshPlan;
  if(kind==='create')return freshBackups&&!!backups?.permissions.canCreateBackup;
  if(kind==='verify')return freshBackups&&freshPoint&&!!backups?.permissions.canVerifyBackup&&location.point===currentWrite?.point;
  if(kind==='plan')return freshOverview&&freshPoint&&!!overview?.permissions.canPlanRestore&&location.point===currentWrite?.point;
  if(location.plan!==currentWrite?.plan||!freshPlan)return false;
  return kind==='approve'?!!detail&&!!maintenanceApprovalBody(detail):kind==='execute'?!!detail&&!!maintenanceExecutionBody(detail):!!detail?.permissions.canCancel;
 };
 const committed=useCallback(async(result:MaintenanceRecoveredResult)=>{
  setWriteIntent(null);
  if(result.operationId&&result.operation)setOperationId(result.operationId);
  if(result.planId&&result.planId!==location.plan&&requested.current.plan===location.plan&&requested.current.point===location.point){router.push(maintenanceHref(location,{plan:result.planId,historyAfter:'',historyTrail:[]}),{scroll:false});}
  await Promise.all([overviewRead.read(),backupsRead.read(),pointRead.read(),plansRead.read(),planRead.read(),operationRead.read()]);
 },[location,router,overviewRead.read,backupsRead.read,pointRead.read,plansRead.read,planRead.read,operationRead.read]);
 const conflict=useCallback(()=>{setWriteIntent(null);void overviewRead.read();void backupsRead.read();void pointRead.read();void plansRead.read();void planRead.read();},[overviewRead.read,backupsRead.read,pointRead.read,plansRead.read,planRead.read]);
 const recoverOriginal=useCallback(async(intent:Readonly<{path:string;body:Record<string,unknown>}>,{signal}:{signal:AbortSignal})=>{
  try{
   const id=String(intent.body.operationId),receipt=await operationsRequest<unknown>('/v1/operations/maintenance/command-results/'+id,{signal}),recovered=maintenanceRecoveryReceipt(intent,receipt);
   if(!recovered)throw Error('Original maintenance result unavailable');
   if(recovered.nativeKind){
    const native=await operationsRequest<MaintenanceOperationDetail>('/v1/operations/maintenance/operations/'+id,{signal});
    return{state:'recorded' as const,value:{...recovered.result,operation:maintenanceRecoveryNative(native,id,recovered.nativeKind)}};
   }
   return{state:'recorded' as const,value:recovered.result};
  }catch(error){
   if(error instanceof OperationsRequestError&&[401,403].includes(error.status))throw error;
   // An absent intent/native result is unknown, never permission to re-POST.
   throw Error('Original maintenance result unavailable');
  }
 },[]);
 const localCommand=useOperationCommand<MaintenanceRecoveredResult>({csrfToken,canWrite:allowKind(currentWrite?.kind??null),canRecover:canRead&&(freshOverview||freshBackups||freshPlan),recover:recoverOriginal,onCommitted:committed,onConflict:conflict,errorMessages:maintenanceCommandErrors});
 const recovery=useSettingsReceiptRecovery({scope:'maintenance',refresh:async()=>{await Promise.all([overviewRead.read(),backupsRead.read(),pointRead.read(),plansRead.read(),planRead.read(),operationRead.read()]);},live:localCommand.pending&&currentWrite?{operationId:String(localCommand.pending.body.operationId),kind:currentWrite.kind}:null,ready:!!overview&&overviewRead.verified,denied:!canRead||!!overviewRead.error&&/登录|权限/.test(overviewRead.error),onRecorded:async receipt=>{if(['create','verify','execute'].includes(receipt.kind))setOperationId(receipt.operationId);await Promise.all([overviewRead.read(),backupsRead.read(),pointRead.read(),plansRead.read(),planRead.read(),operationRead.read()]);},onDenied:()=>{overviewRead.clear();backupsRead.clear();pointRead.clear();plansRead.clear();planRead.clear();operationRead.clear();setDrafts({});}});
 const command={...localCommand,locked:localCommand.locked||recovery.pending};
 useEffect(()=>{if(!command.locked)setPinned(null);},[command.locked]);
 useEffect(()=>{if(!command.locked)setWriteIntent(null);},[command.locked]);
 useEffect(()=>{
  if(!operationId||!operationRead.value||operationRead.loading||operationRead.refreshing||operation&&!['pending','running','unknown'].includes(operation.state))return;
  const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible'){void operationRead.read();}},4000);return()=>clearTimeout(timer);
 },[operationId,operation,operationRead.value,operationRead.loading,operationRead.refreshing,operationRead.read,backupsRead.read,overviewRead.read]);

 useLayoutEffect(()=>{
  const regions=[{ref:runtimeColumn,key:location.tab+':runtime',readable:!!overview},{ref:backupColumn,key:location.tab+':backup:'+location.point,readable:!!backups},{ref:restoreColumn,key:location.tab+':restore:'+location.plan,readable:!!plans},{ref:logsColumn,key:'logs:'+location.component+':'+location.level+':'+location.period+':'+location.before,readable:!!logs}];
  for(const region of regions)if(region.readable&&region.ref.current)region.ref.current.scrollTop=positions.current[region.key]??0;
 },[location.tab,location.point,location.plan,location.component,location.level,location.period,location.before,!!overview,!!backups,!!plans,!!logs]);
 useEffect(()=>setSelectedLog(null),[location.before,location.component,location.level,location.period]);
 function navigate(patch:Partial<MaintenanceLocation>){if(command.locked)return;router.push(maintenanceHref(location,patch),{scroll:false});}
 async function refresh(){if(command.locked)return;await Promise.all([overviewRead.read(),backupsRead.read(),pointRead.read(),plansRead.read(),planRead.read(),logsRead.read(),operationRead.read()]);}
 async function submit(kind:WriteKind,path:string,body:Record<string,unknown>,message:string){
  const permitted=kind==='create'?freshBackups&&!!backups?.permissions.canCreateBackup:kind==='verify'?freshBackups&&freshPoint&&!!backups?.permissions.canVerifyBackup:kind==='plan'?freshOverview&&freshPoint&&!!overview?.permissions.canPlanRestore:kind==='approve'?freshPlan&&!!detail&&!!maintenanceApprovalBody(detail):kind==='execute'?freshPlan&&!!detail&&!!maintenanceExecutionBody(detail):freshPlan&&!!detail?.permissions.canCancel;
  if(!permitted||command.locked)return;setPinned(location);setWriteIntent({kind,point:location.point,plan:location.plan});await command.submit(path,body,message);
 }
 function updateDraft(patch:Partial<RestoreDraft>){if(!location.point||command.locked)return;setDrafts(previous=>({...previous,[location.point]:{...draft,...patch}}));}
 async function createPlan(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(!point||draft.scope==='selected-modules'&&!draft.moduleIds.length)return;
  await submit('plan','/v1/operations/maintenance/restore-plans',{pointId:point.id,scope:draft.scope,...(draft.scope==='selected-modules'?{moduleIds:draft.moduleIds}:{})},'已整理本次恢复方案。');
 }
 function filterLogs(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(command.locked)return;const form=new FormData(event.currentTarget),next=maintenanceLocation({...location,component:form.get('component'),level:form.get('level'),period:form.get('period'),before:'',logTrail:[]});
  navigate(next);
 }
 const busyRead=overviewRead.loading||backupsRead.loading||pointRead.loading||plansRead.loading||planRead.loading||logsRead.loading;
 const currentPlan=detail?.plan??null,approvalBody=detail?maintenanceApprovalBody(detail):null,executionBody=detail?maintenanceExecutionBody(detail):null;
 const queueKnown=overview?.queues.availability.state==='available',pendingCount=queueKnown?overview.queues.items.reduce((sum,item)=>sum+item.counts.created+item.counts.retry,0):null;
 const chosenLog=selectedLog!==null?logs?.items.find(item=>logKey(item)===selectedLog)??null:null;
 const latestCheckedAt=overview?.checkedAt??backups?.checkedAt??detail?.checkedAt??logs?.checkedAt;
 const componentNames=new Map<string,string>(overview?.components.map(item=>[item.id,item.label] as const)??[]);
 useSettingsDraftState(Object.values(drafts).some(value=>value.scope!=='whole-site'||value.moduleIds.length>0),command.locked);
 return <section className="galaxy-maintenance" aria-label="系统维护与备份恢复">
  <SettingsReceiptNotice recovery={recovery}/><header className="maintenance-page-header"><div><h1>系统维护与备份恢复</h1><p>{location.tab==='logs'?'运行日志与故障线索':location.tab==='control'?'当前维护状态与设置':location.tab==='overview'?'组件、队列与空间':'运行、备份与本次恢复方案'}</p></div><div><span className="maintenance-updated">{latestCheckedAt?'更新于 '+maintenanceTime(new Date(latestCheckedAt*1000).toISOString())+' · 上海时间':''}</span><button type="button" disabled={command.locked||busyRead} onClick={()=>void refresh()}><AdminIcon name="refresh" size={14}/>刷新</button></div></header><AutonomyObjectContext targetType="maintenance" targetId="website" csrfToken={csrfToken}/>
  <div className="maintenance-command"><CommandFeedback command={{...command,message:operation&&['succeeded','failed'].includes(operation.state)&&['备份任务已受理，结果将在完成后更新。','校验任务已受理，结果将在完成后更新。','已请求程序按本次批准方案执行。'].includes(command.message)?'':command.message}}/></div>
  {canRead&&inBackups&&<div className="maintenance-status-strip"><span>维护模式 <b>{overview?modeLabels[overview.maintenanceMode.state]:'未取得'}</b></span><span>最近备份 <b>{backups?.policy.lastCreate?({running:'执行中',succeeded:'捕获已完成',failed:'捕获失败',unknown:'结果未取得'})[backups.policy.lastCreate.outcome]:'未取得'}</b></span><span>恢复方案 <b>{currentPlan?maintenancePlanLabels[currentPlan.state]:location.plan?'正在读取':'未选择'}</b></span></div>}
  {location.tab==='backups'?<div className="maintenance-workspace">
   <section className="maintenance-column" aria-label="运行状态"><header><h2>当前运行</h2><Availability value={overview?.nativeAvailability}/></header><ReadStatus loading={overviewRead.loading} error={overviewRead.error} retry={overviewRead.read}/><div className="maintenance-column-scroll" ref={runtimeColumn} onScroll={event=>{if(overview)positions.current[location.tab+':runtime']=event.currentTarget.scrollTop;}}>
    {overview?<><Components items={overview.components}/><section className="maintenance-section"><div className="maintenance-section-title"><h3>错误与队列</h3><Link href={maintenanceHref(location,{tab:'logs'})} aria-disabled={command.locked||undefined} onClick={event=>{if(command.locked)event.preventDefault();}}>查看日志</Link></div><div className="maintenance-mini-stats"><span>近1小时错误<strong>{overview.errors.availability.state==='available'?maintenanceCount(overview.errors.count):'未取得'}</strong></span><span>业务队列待执行<strong>{maintenanceCount(pendingCount)}</strong></span></div><QueueFacts overview={overview}/></section></>:!overviewRead.loading&&<Empty title="运行状态暂未取得"/>}<MaintenanceLinks/>
   </div></section>
   <section className="maintenance-column" aria-label="整站备份"><header><h2>备份与恢复点</h2>{backups?.permissions.canCreateBackup&&<button type="button" disabled={command.locked||!freshBackups} onClick={()=>void submit('create','/v1/operations/maintenance/backups',{kind:'create'},'备份任务已受理，结果将在完成后更新。')}>立即备份</button>}</header><ReadStatus loading={backupsRead.loading} error={backupsRead.error} retry={backupsRead.read}/><div className="maintenance-column-scroll" ref={backupColumn} onScroll={event=>{if(backups)positions.current[location.tab+':backup:'+location.point]=event.currentTarget.scrollTop;}}>
    <BackupPolicy policy={backups?.policy??null}/><section className="maintenance-section"><div className="maintenance-section-title"><h3>备份记录</h3><span className="maintenance-muted">{backups?.total!==null&&backups?.total!==undefined?'共 '+maintenanceCount(backups.total)+' 条':''}</span></div>
     {backups?.availability.state==='available'&&backups.items.length?<table className="maintenance-points"><thead><tr><th>时间</th><th>校验</th><th>快照数据量</th></tr></thead><tbody>{backups.items.map(item=><tr key={item.id} data-selected={item.id===location.point}><th><button type="button" className="maintenance-text-button" aria-pressed={item.id===location.point} disabled={command.locked} onClick={()=>navigate({point:item.id,plan:'',historyAfter:'',historyTrail:[]})}>{maintenanceTime(item.createdAt)}</button></th><td><span data-state={item.integrity.state}>{maintenanceIntegrity(item)}</span></td><td>{maintenanceBytes(item.logicalBytes)}</td></tr>)}</tbody></table>:<Empty title={backups?.availability.state==='available'?'暂无备份记录':'备份目录暂未取得'}/>}
     <Pagination kind="backups" location={location} next={backups?.nextAfter??null} locked={command.locked} onNavigate={navigate}/>
    </section>{location.point&&<section className="maintenance-section"><ReadStatus loading={pointRead.loading} error={pointRead.error} retry={pointRead.read}/>{point?<><div className="maintenance-section-title"><h3>所选恢复点</h3><span data-state={point.integrity.state}>{maintenanceIntegrity(point)}</span></div><dl className="maintenance-facts"><Fact label="时间">{maintenanceTime(point.createdAt)}</Fact><Fact label="快照数据量">{maintenanceBytes(point.logicalBytes)}</Fact><Fact label="逻辑文件数">{maintenanceCount(point.logicalFileCount)}</Fact><Fact label="校验时刻">{maintenanceTime(point.integrity.checkedAt)}</Fact><Fact label="捕获窗口">{maintenanceTime(point.capture.startedAt)} — {maintenanceTime(point.capture.finishedAt)}</Fact></dl><Coverage items={point.coverage} compact/>{point.productionRestore.blockers.length>0&&<ul className="maintenance-brief-problems">{point.productionRestore.blockers.map(code=><li key={code}>{maintenanceReason(code)}</li>)}</ul>}<p className="maintenance-caption">校验所选恢复点引用的数据，涉及的共享数据包会一并读取；索引检查仍覆盖整个仓库。此操作不执行恢复演练。</p>{backups?.permissions.canVerifyBackup&&<button type="button" disabled={command.locked||!freshPoint||!freshBackups} onClick={()=>void submit('verify','/v1/operations/maintenance/backups',{kind:'verify',pointId:point.id},'校验任务已受理，结果将在完成后更新。')}>校验所选备份</button>}</>:!pointRead.loading&&<Empty title="恢复点暂不可读取"/>}</section>}{operationId&&<ReadStatus loading={operationRead.loading} error={operationRead.error} retry={operationRead.read}/>}<NativeOperation operation={operation}/><section className="maintenance-section"><h3>空间使用</h3><StorageFacts overview={overview}/></section>
   </div></section>
   <section className="maintenance-column" aria-label="本次恢复方案"><header><h2>恢复方案</h2>{location.plan&&<button type="button" disabled={command.locked} onClick={()=>navigate({plan:'',historyAfter:'',historyTrail:[]})}>准备另一方案</button>}</header><ReadStatus loading={plansRead.loading} error={plansRead.error} retry={plansRead.read}/><div className="maintenance-column-scroll" ref={restoreColumn} onScroll={event=>{if(plans)positions.current[location.tab+':restore:'+location.plan]=event.currentTarget.scrollTop;}}>
    {(plans?.items.length||location.plan)?<section className="maintenance-plan-picker"><label>方案记录<select aria-label="恢复方案记录" value={location.plan} disabled={command.locked} onChange={event=>{const id=event.target.value,selected=plans?.items.find(item=>item.id===id);navigate({plan:id,...(selected?.point?{point:selected.point.id}:{}),historyAfter:'',historyTrail:[]});}}><option value="">准备本次方案</option>{location.plan&&!plans?.items.some(item=>item.id===location.plan)&&<option value={location.plan}>{currentPlan?maintenanceTime(currentPlan.createdAt)+' · '+maintenancePlanLabels[currentPlan.state]:'当前方案'}</option>}{plans?.items.map(item=><option key={item.id} value={item.id}>{maintenanceTime(item.createdAt)} · {maintenancePlanLabels[item.state]}</option>)}</select></label><Pagination kind="plans" location={location} next={plans?.nextAfter??null} locked={command.locked} onNavigate={navigate}/></section>:null}
    {location.plan?<><ReadStatus loading={planRead.loading} error={planRead.error} retry={planRead.read}/>{detail?<><PlanReview detail={detail}/><div className="maintenance-plan-actions">{approvalBody&&<button type="button" className="maintenance-primary" disabled={command.locked||!freshPlan} onClick={()=>void submit('approve','/v1/operations/maintenance/restore-plans/'+detail.plan.id+'/approve',approvalBody,'已批准这份具体恢复方案。')}>批准本次方案</button>}{executionBody&&<button type="button" className="maintenance-primary" disabled={command.locked||!freshPlan} onClick={()=>void submit('execute','/v1/operations/maintenance/restore-plans/'+detail.plan.id+'/execute',executionBody,'已请求程序按本次批准方案执行。')}>执行已批准方案</button>}{detail.permissions.canCancel&&<button type="button" disabled={command.locked||!freshPlan} onClick={()=>void submit('cancel','/v1/operations/maintenance/restore-plans/'+detail.plan.id+'/cancel',{expectedRevision:detail.plan.revision},'已取消本次恢复方案。')}>取消本次方案</button>}</div><section className="maintenance-section"><h3>方案记录</h3>{detail.history.items.length?<ol className="maintenance-history">{detail.history.items.map(event=><li key={event.sequence}><time>{maintenanceTime(event.createdAt)}</time><div><strong>{historyLabels[event.action]??'已记录的方案变化'}</strong>{event.state&&<span>{maintenancePlanLabels[event.state as keyof typeof maintenancePlanLabels]??'状态已记录'}</span>}<small>操作者 <code>{event.operatorId}</code></small></div></li>)}</ol>:<p className="maintenance-caption">暂无已记录的变化。</p>}<Pagination kind="history" location={location} next={detail.history.nextAfter} locked={command.locked} onNavigate={navigate}/></section></>:!planRead.loading&&<Empty title="恢复方案暂不可读取"/>}</>:<form className="maintenance-prepare" onSubmit={event=>void createPlan(event)}><h3>准备具体恢复方案</h3>{point?<><p className="maintenance-selected-point">恢复点 <strong>{maintenanceTime(point.createdAt)}</strong></p><fieldset disabled={command.locked||!freshPoint}><legend>恢复范围</legend><label><input type="radio" name="restore-scope" checked={draft.scope==='whole-site'} onChange={()=>updateDraft({scope:'whole-site'})}/>当前整站计划</label><label><input type="radio" name="restore-scope" checked={draft.scope==='selected-modules'} onChange={()=>updateDraft({scope:'selected-modules'})}/>选定模块</label>{draft.scope==='selected-modules'&&<div className="maintenance-module-choices">{point.coverage.map(module=><label key={module.id}><input type="checkbox" checked={draft.moduleIds.includes(module.id)} onChange={event=>updateDraft({moduleIds:event.target.checked?[...draft.moduleIds,module.id]:draft.moduleIds.filter(id=>id!==module.id)})}/>{module.label}</label>)}</div>}</fieldset><p className="maintenance-caption">先核对恢复点、影响和开放条件；本次生产恢复需人工批准具体方案。</p>{overview?.permissions.canPlanRestore?<button className="maintenance-primary" type="submit" disabled={command.locked||!freshPoint||!freshOverview||draft.scope==='selected-modules'&&!draft.moduleIds.length}>整理本次方案</button>:<p className="maintenance-caption">当前身份没有准备恢复方案的权限。</p>}</>:<Empty title="先选择恢复点">选中已有备份后查看覆盖范围和具体恢复条件。</Empty>}</form>}
   </div></section>
  </div>:location.tab==='overview'?<div className="maintenance-workspace">
   <section className="maintenance-column"><header><h2>系统组件</h2><Availability value={overview?.nativeAvailability}/></header><ReadStatus loading={overviewRead.loading} error={overviewRead.error} retry={overviewRead.read}/><div className="maintenance-column-scroll">{overview?<Components items={overview.components}/>:<Empty title="组件状态暂未取得"/>}<MaintenanceLinks/></div></section>
   <section className="maintenance-column"><header><h2>错误与业务队列</h2><Link href={maintenanceHref(location,{tab:'logs'})} aria-disabled={command.locked||undefined} onClick={event=>{if(command.locked)event.preventDefault();}}>日志与诊断</Link></header><div className="maintenance-column-scroll"><dl className="maintenance-facts"><Fact label="近1小时错误">{overview?.errors.availability.state==='available'?maintenanceCount(overview.errors.count):'未取得'}</Fact><Fact label="待执行">{maintenanceCount(pendingCount)}</Fact></dl><QueueFacts overview={overview}/></div></section>
   <section className="maintenance-column"><header><h2>空间与备份覆盖</h2></header><div className="maintenance-column-scroll"><StorageFacts overview={overview}/><section className="maintenance-section"><h3>当前站点备份覆盖</h3>{overview?<Coverage items={overview.coverage}/>:<Empty title="覆盖情况暂未取得"/>}<Link href={maintenanceHref(location,{tab:'backups'})} aria-disabled={command.locked||undefined} onClick={event=>{if(command.locked)event.preventDefault();}}>查看备份与恢复点</Link></section></div></section>
  </div>:location.tab==='logs'?<section className="maintenance-logs">
   {!canReadLogs?<Empty title="当前身份没有读取运行日志的权限"/>:<><form className="maintenance-log-filters" onSubmit={filterLogs} key={[location.component,location.level,location.period].join(':')}><label>组件<select name="component" defaultValue={location.component}><option value="">全部组件</option>{location.component&&!logs?.components.includes(location.component)&&<option value={location.component}>{componentNames.get(location.component)??location.component}</option>}{logs?.components.map(component=><option key={component} value={component}>{componentNames.get(component)??component}</option>)}</select></label><label>级别<select name="level" defaultValue={location.level}><option value="all">全部级别</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select></label><label>时间<select name="period" defaultValue={location.period}><option value="15m">近15分钟</option><option value="1h">近1小时</option><option value="24h">近24小时</option></select></label><button type="submit">筛选</button><Availability value={logs?.availability}/></form><ReadStatus loading={logsRead.loading} error={logsRead.error} retry={logsRead.read}/><div className="maintenance-log-workspace"><div className="maintenance-log-table-scroll" ref={logsColumn} onScroll={event=>{if(logs)positions.current['logs:'+location.component+':'+location.level+':'+location.period+':'+location.before]=event.currentTarget.scrollTop;}}>{logs?.availability.state==='available'&&logs.items.length?<table><thead><tr><th>时间</th><th>组件</th><th>级别</th><th>运行事件</th><th>状态</th></tr></thead><tbody>{logs.items.map((item,index)=><tr key={(item.at??'')+':'+index} data-selected={selectedLog===logKey(item)}><th><button className="maintenance-text-button" type="button" onClick={()=>setSelectedLog(logKey(item))}>{maintenanceTime(item.at)}</button></th><td>{item.component?componentNames.get(item.component)??item.component:'未记录'}</td><td data-state={item.level}>{({info:'信息',warn:'警告',error:'错误',debug:'调试'})[item.level]}</td><td>{item.diagnostic?diagnosticLabels[item.diagnostic]??'已记录事件':'已记录事件'}</td><td>{item.status??'—'}</td></tr>)}</tbody></table>:<Empty title={logs?.availability.state==='available'?'当前范围暂无日志':'运行日志暂未取得'}/>}</div><aside className="maintenance-log-detail">{chosenLog?<LogDetail log={chosenLog} componentLabel={chosenLog.component?componentNames.get(chosenLog.component):undefined}/>:<Empty title="选择日志查看关联信息"/>}</aside></div><Pagination kind="logs" location={location} next={logs?.nextBefore??null} locked={false} onNavigate={navigate}/></>}
  </section>:<div className="maintenance-workspace">
   <section className="maintenance-column"><header><h2>维护模式</h2></header><ReadStatus loading={overviewRead.loading} error={overviewRead.error} retry={overviewRead.read}/><div className="maintenance-column-scroll"><dl className="maintenance-facts"><Fact label="当前模式">{overview?modeLabels[overview.maintenanceMode.state]:'未取得'}</Fact><Fact label="业务写入">{overview?.maintenanceMode.businessWritesAccepted===true?'当前接收':overview?.maintenanceMode.businessWritesAccepted===false?'当前受限':'未取得'}</Fact></dl><p className="maintenance-caption">恢复中的相关写入限制由本次方案控制，全部计划模块满足开放条件后统一开放。</p><MaintenanceLinks/></div></section>
   <section className="maintenance-column"><header><h2>当前备份设置</h2></header><ReadStatus loading={backupsRead.loading} error={backupsRead.error} retry={backupsRead.read}/><div className="maintenance-column-scroll"><BackupPolicy policy={backups?.policy??null}/>{backups&&<section className="maintenance-section"><h3>现行保留设置</h3><dl className="maintenance-facts"><Fact label="每日点数">{maintenanceCount(backups.policy.retention.daily)}</Fact><Fact label="每周点数">{maintenanceCount(backups.policy.retention.weekly)}</Fact><Fact label="每月点数">{maintenanceCount(backups.policy.retention.monthly)}</Fact><Fact label="仓库位置">{({ 'same-host':'当前主机','off-host':'离机仓库',unknown:'未取得'})[backups.policy.repository.location]}</Fact><Fact label="仓库加密">{backups.policy.repository.encrypted===null?'未取得':backups.policy.repository.encrypted?'已启用':'未启用'}</Fact></dl></section>}</div></section>
   <section className="maintenance-column"><header><h2>恢复与重新开放</h2></header><div className="maintenance-column-scroll"><p>每次生产恢复按一份具体方案执行。</p><ol className="maintenance-conditions">{Object.entries(maintenanceConditionLabels).map(([id,label])=><li key={id}>{label}</li>)}</ol><Link href={maintenanceHref(location,{tab:'backups'})} aria-disabled={command.locked||undefined} onClick={event=>{if(command.locked)event.preventDefault();}}>审阅具体恢复方案</Link><section className="maintenance-section"><h3>维护入口</h3><MaintenanceLinks/></section></div></section>
  </div>}
 </section>;
}

function LogDetail({log,componentLabel}:{log:MaintenanceLog;componentLabel:string|undefined}){
 return <><h3>{log.diagnostic?diagnosticLabels[log.diagnostic]??'运行事件':'运行事件'}</h3><dl className="maintenance-facts"><Fact label="时间">{maintenanceTime(log.at)}</Fact><Fact label="组件">{componentLabel??log.component??'未记录'}</Fact><Fact label="状态码">{log.status??'未记录'}</Fact>{log.code&&<Fact label="诊断码"><code>{log.code}</code></Fact>}{log.event&&<Fact label="事件"><code>{log.event}</code></Fact>}{log.requestId&&<Fact label="请求"><code>{log.requestId}</code></Fact>}{log.jobId&&<Fact label="任务"><code>{log.jobId}</code></Fact>}{log.sqlState&&<Fact label="数据库状态"><code>{log.sqlState}</code></Fact>}</dl></>;
}
