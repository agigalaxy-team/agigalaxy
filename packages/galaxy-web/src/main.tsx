import React, { lazy, Suspense, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Compass, Plus, Handshake, MessagesSquare, Fingerprint, ArrowLeft, Copy, Download, Bell, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { createWebRuntime, loadWebConfiguration } from './runtime.mjs';
import {requesterFeedbackAvailable} from './requester-feedback-client.mjs';
import type {DeviceControlState} from './device-management';
const IdentityOperationQuery = lazy(() => import('./identity-operation-query').then(module => ({default: module.IdentityOperationQuery})));
const ChatWorkspace = lazy(() => import('./chat-workspace').then(module => ({default: module.ChatWorkspace})));
const ContactOriginWorkspace = lazy(() => import('./contact-origin-workspace').then(module => ({default: module.ContactOriginWorkspace})));
const AccountSettings = lazy(() => import('./account-settings').then(module => ({default: module.AccountSettings})));
const DiscoveryWorkspace = lazy(() => import('./discovery-workspace').then(module => ({default: module.DiscoveryWorkspace})));
const TaskCollaboration = lazy(() => import('./task-collaboration').then(module => ({default: module.TaskCollaboration})));
const FactReceiptRecovery = lazy(() => import('./fact-workspace').then(module => ({default: module.FactReceiptRecovery})));
const TaskOperationRecovery = lazy(() => import('./task-operation-recovery').then(module => ({default: module.TaskOperationRecovery})));
const TaskOwnerReadWorkspace = lazy(() => import('./task-owner-read-workspace').then(module => ({default: module.TaskOwnerReadWorkspace})));
const PersonalSummaryWorkspace = lazy(() => import('./personal-summary-workspace').then(module => ({default: module.PersonalSummaryWorkspace})));
const NotificationWorkspace = lazy(() => import('./notification-workspace').then(module => ({default: module.NotificationWorkspace})));
const ProjectContactWorkspace = lazy(() => import('./project-contact-workspace').then(module => ({default: module.ProjectContactWorkspace})));
const ProjectDetailWorkspace = lazy(() => import('./project-detail-workspace').then(module => ({default: module.ProjectDetailWorkspace})));
const ConfigurationWorkspace = lazy(() => import('./configuration-workspace').then(module => ({default: module.ConfigurationWorkspace})));
const BuildersWorkspace = lazy(() => import('./builders-workspace').then(module => ({default: module.BuildersWorkspace})));
const ContributionWorkspace = lazy(() => import('./contribution-workspace').then(module => ({default: module.ContributionWorkspace})));
const IdentityWorkspace = lazy(() => import('./identity-workspace').then(module => ({default: module.IdentityWorkspace})));
const AgentIdentityWorkspace = lazy(() => import('./agent-identity-workspace').then(module => ({default: module.AgentIdentityWorkspace})));
import {readAgentIdentityEntry} from './agent-identity-handoff.mjs';
import {TaskAgentIdentityPrompt} from './task-agent-identity-prompt';
import {createTaskPageView,type TaskPageTask} from './task-page-view';
import {useCurrentTaskProjection,taskViewTitle,TaskMaterialNotice} from './task-material-view';
import {TaskRequestReading,taskReadingSection} from './task-request-reading';
import './task-help-continuation.css';
import {readTaskResult} from './task-result-navigation.mjs';
import {MemberLink,useMemberNames} from './conversation-ui';
const IdentityGroupWorkspace = lazy(() => import('./identity-group-workspace').then(module => ({default: module.IdentityGroupWorkspace})));
const PrivacyWorkspace = lazy(() => import('./privacy-workspace').then(module => ({default: module.PrivacyWorkspace})));
const HelpSearchWorkspace = lazy(() => import('./help-search-workspace').then(module => ({default: module.HelpSearchWorkspace})));
const TaskCommentsWorkspace = lazy(() => import('./task-comments-workspace').then(module => ({default: module.TaskCommentsWorkspace})));
const CapsuleWorkspace = lazy(() => import('./capsule-workspace').then(module => ({default: module.CapsuleWorkspace})));
const TaskDirectoryWorkspace = lazy(() => import('./task-directory-workspace').then(module => ({default: module.TaskDirectoryWorkspace})));
const TaskPublishWorkspace = lazy(() => import('./task-publish-workspace').then(module => ({default: module.TaskPublishWorkspace})));
import { carryHelpOrigin } from './help-origin-client.mjs';
const TaskOriginReturn = lazy(() => import('./task-origin-workspace').then(module => ({default: module.TaskOriginReturn})));
const TaskApplication = lazy(() => import('./task-application').then(module => ({default: module.TaskApplication})));
const QualificationPermissionWorkspace = lazy(() => import('./qualification-permission-workspace').then(module => ({default: module.QualificationPermissionWorkspace})));
const TrustPackageWorkspace = lazy(() => import('./trust-package-workspace').then(module => ({default: module.TrustPackageWorkspace})));
const HubsWorkspace = lazy(() => import('./hubs-workspace').then(module => ({default: module.HubsWorkspace})));
const WorkerPackUseWorkspace = lazy(() => import('./worker-pack-use-workspace').then(module => ({default: module.WorkerPackUseWorkspace})));
const InformationWorkspace = lazy(() => import('./information-workspace').then(module => ({default: module.InformationWorkspace})));
const TargetGovernanceWorkspace = lazy(() => import('./target-governance-workspace').then(module => ({default: module.TargetGovernanceWorkspace})));
const ModerationReviewWorkspace = lazy(() => import('./moderation-review-workspace').then(module => ({default: module.ModerationReviewWorkspace})));
import { closeSummaryRuntime } from './summary-runtime.mjs';
import '@/app/globals.css';
import './workspace.css';
import './identity-recovery.css';
import { SiteShell, StartPage, PageLoading } from './site-shell';
const AccountOverview = lazy(() => import('./account-center').then(module => ({default: module.AccountOverview})));
const PersonProfile = lazy(() => import('./person-profile').then(module => ({default: module.PersonProfile})));
import {profileSubject,profileNavigationState} from './profile-navigation.mjs';
const WorkOverview = lazy(() => import('./account-center').then(module => ({default: module.WorkOverview})));
import {ProjectDirectoryWorkspace,browseReturnPath,browseReturnLabel} from './public-browse-workspace';
import {TaskTerms} from './task-budget-fields';
const CommunityForumWorkspace = lazy(() => import('./community-forum-workspace').then(module => ({default: module.CommunityForumWorkspace})));
const CommunityTaskReturn = lazy(() => import('./community-forum-workspace').then(module => ({default: module.CommunityTaskReturn})));

type Runtime = Awaited<ReturnType<typeof createWebRuntime>>;
type RuntimeStatus = Awaited<ReturnType<Runtime['status']>>;
type IdentityResult = RuntimeStatus & {kind:string;operationId:string;replacementCode?:string;recoveryOperationId?:string};
type Task = TaskPageTask;
function TaskAuthor({runtime,subjectId,connected,task,navigate}:{runtime:Runtime;subjectId?:string;connected:boolean;task:Task;navigate:(path:string)=>void}){
  const names=useMemberNames(runtime,subjectId,connected,[task.requesterId]);
  return <div className="task-author"><MemberLink subjectId={task.requesterId} name={names[task.requesterId]??undefined} ownId={subjectId} navigate={navigate} avatar/><span>发起的求助</span></div>;
}
const entries = [{ path: '/app/match', label: '发现匹配', icon: Compass }, { path: '/app/publish', label: '发布任务', icon: Plus },
  { path: '/app/community', label: '社区', icon: MessagesSquare },
  { path: '/app/participate', label: '参与任务', icon: Handshake }, { path: '/app/rooms', label: '聊天', icon: MessagesSquare },
  { path: '/app/projects', label: '项目与联系', icon: Compass },
  { path: '/app/history', label: '履历与贡献', icon: Compass },
  { path: '/app/capsules', label: 'Capsule 方法', icon: FileText },
  { path: '/app/configurations', label: '配置版本', icon: FileText },
  { path: '/app/qualification-permissions', label: '材料许可', icon: FileText },
  { path: '/app/builders', label: '建设者与接入', icon: FileText },
  { path: '/app/worker-packs', label: 'Worker Pack 使用', icon: FileText },
  { path: '/app/hubs', label: 'Hub 社区与互联', icon: Compass },
  { path: '/app/information', label: '资料与关注', icon: Compass },
  { path: '/app/governance', label: '举报与处理', icon: FileText },
  { path: '/app/search', label: '检索帮助', icon: Compass },
  { path: '/app/settings/privacy', label: '隐私与数据', icon: FileText },
  { path: '/app/settings/trust-package', label: '身份与资料包', icon: FileText },
  { path: '/app/notifications', label: '通知', icon: Bell }, { path: '/app/settings/summaries', label: '个人摘要', icon: FileText },
  { path: '/app/settings/identity', label: '身份与设置', icon: Fingerprint }];
const stateNames: Record<string, string> = { open: '正在征集', closed: '已结束', canceled: '已取消', pending: '等待回应', interested: '愿意了解', declined: '已婉拒', expired: '已过期', revoked: '已撤销', question: '有问题待回应' };
function readable(error: unknown) {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return '请求等待超时或已取消，请检查当前网络后重试。';
  const message = error instanceof Error ? error.message : '操作未完成，请重试。';
  return ({ connection_required: '请先连接当前银河身份，再继续这一步。', account_verification_required: '发布或加入房间前需要验证账号，请前往身份与设置完成验证。', community_quota_exceeded: '今天的公开操作额度已用完，请稍后再试。', verified_account_required: '此操作需要验证账号。', not_found: '内容不存在，或当前身份没有查看权限。', public_write_quota_exceeded: '今天的操作额度已用完，请稍后再试。', request_timeout: '请求等待超时，请检查当前网络后重试。' } as Record<string, string>)[message] ?? message;
}
function identityReturnTarget(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const target = new URL(value, location.origin);
    if (target.origin !== location.origin || !(target.pathname === '/app' || target.pathname.startsWith('/app/')) || target.pathname === '/app/settings/identity') return null;
    return target.pathname + target.search + target.hash;
  } catch { return null; }
}
function readIdentityReturnTarget() {
  const entry=readAgentIdentityEntry(location);
  return (entry?.valid?entry.targetPath:null) ?? identityReturnTarget(history.state?.identityReturn) ?? identityReturnTarget(history.state?.from) ?? '/app/';
}
type RecoveryContinueIntent = {version:1;endpoint:string;subjectId:string;deviceId:string;recoveryOperationId:string;target:string};
function readRecoveryContinueIntent():RecoveryContinueIntent|null {
  const value=history.state?.identityRecoveryContinue;
  if(value?.version!==1||!['endpoint','subjectId','deviceId','recoveryOperationId','target'].every(key=>typeof value[key]==='string'))return null;
  const target=value.target==='/app/settings/identity?section=account'?value.target:identityReturnTarget(value.target);
  return target?{...value,target}:null;
}
function recoveryMessage(error:unknown,stage:'prepare'|'recover'|'save'|'connect') {
  const value=error as {code?:string;message?:string},code=value?.code??value?.message??'';
  const messages:Record<string,string>={
    recovery_code_invalid:'这份恢复码无法识别，请复制你保存的完整恢复码。',
    recovery_material_not_current:'这份恢复码已使用或已更换，请使用最近保存的新码。',
    recovery_generation_consumed:'这份恢复码已使用或已更换，请使用最近保存的新码。',
    recovery_device_not_current:'这个身份已在别处接回，请使用那次保存的新恢复码，或由当前管理设备接续。',
    recovery_device_material_unavailable:'这台浏览器缺少上次恢复所需的本机材料，请使用当前管理设备或最近保存的恢复码。',
    recovery_display_operation_changed:'恢复码已变化，请重新打开当前这份码后保存。',
    recovery_display_operation_required:'请重新打开当前恢复码，再确认保存。',
    recovery_identity_changed:'当前身份已经变化，请重新打开身份设置。',
    recovery_operation_expired:'上次恢复已到期，请重新提交你保存的恢复码。',
    identity_challenge_expired:'上次确认已到期，请重新提交你保存的恢复码。',
    control_epoch_changed:'身份控制已经变化，请使用当前管理设备或最近保存的新码。',
    identity_control_stale:'身份设置刚有变化，请重新读取后继续。',
    device_controller_not_authorized:'这台设备不能更换恢复码，请使用有管理权限的设备。',
    local_atomic_update_unavailable:'此浏览器暂时无法安全保存恢复材料，请换一个支持本机存储的浏览器。',
    recovery_connect_failed:'恢复码已保存，但暂时未连上服务。再次连接即可继续。',
  };
  if(messages[code])return messages[code];
  if(['Unsupported recovery code version.','Invalid recovery code.','Invalid Galaxy GUID.','Invalid base64url.','Noncanonical base64url.','Recovery code requires 32 bytes.'].includes(code))return messages.recovery_code_invalid;
  if(code==='恢复码已更换、已使用或不属于当前身份。')return messages.recovery_material_not_current;
  return stage==='prepare'?'暂时无法准备恢复码，请稍后再试。':stage==='recover'?'暂时无法确认恢复结果，页面会继续核对。':stage==='save'?'暂时无法确认新码是否已保存，页面会继续核对。请保留这份码。':'暂时未连上服务，请再次连接。';
}
function accountSettingsPath(pathname: string) {
  return pathname === '/app/account' || pathname.startsWith('/app/settings/');
}
function readTaskSection(search: string) {
  const section=new URLSearchParams(search).get('section');return ['collaboration','comments','apply'].includes(section??'')?section!:'overview';
}
function App() {
  const [configurationAttempt,setConfigurationAttempt]=useState(0);
  return <GalaxySession key={configurationAttempt} retryConfiguration={()=>setConfigurationAttempt(value=>value+1)}/>;
}
function GalaxySession({retryConfiguration}:{retryConfiguration:()=>void}) {
  const [path, setPath] = useState(location.pathname), [runtime, setRuntime] = useState<Runtime | null>(null), [status, setStatus] = useState<RuntimeStatus|null>(null);
  const [routeSearch, setRouteSearch] = useState(location.search);
  const [routeHash, setRouteHash] = useState(location.hash);
  const agentIdentityEntry=useMemo(()=>readAgentIdentityEntry({pathname:path,search:routeSearch,origin:location.origin}),[path,routeSearch]);
  const identitySettingsPage=path==='/app/settings/identity'&&!agentIdentityEntry&&new URLSearchParams(routeSearch).get('section')!=='account';
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [configError, setConfigError] = useState('');
  const taskId=/^\/app\/tasks\/([0-9a-f-]{36})$/.exec(path)?.[1]??null;
  const taskReadScope=JSON.stringify([taskId,status?.connection?.bindingId,status?.connection?.generation]);
  const taskPage=useMemo(()=>createTaskPageView<Task>({taskId,scope:taskReadScope,read:runtime&&taskId?()=>runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET',authenticated:!!runtime.api.snapshot()}):null,isCurrent:()=>location.pathname===`/app/tasks/${taskId}`}),[runtime,taskId,taskReadScope]);
  const {task:taskRecord,loading:taskLoading}=useSyncExternalStore(taskPage.subscribe,taskPage.read,taskPage.read);
  const task=useCurrentTaskProjection(runtime,taskRecord);
  const readingPositions = useRef(new Map<string, number>());
  const restoreReading = useRef<{ route: string; y: number } | null>(location.hash ? {route:location.pathname+location.search,y:0} : null);
  const taskSection=taskReadingSection(task,readTaskSection(routeSearch));
  const selectedIdentityMethod=new URLSearchParams(routeSearch).get('method');
  const identityMethod=path==='/app/settings/identity'&&(selectedIdentityMethod==='recovery'||selectedIdentityMethod==='device')?selectedIdentityMethod:null;
  const [accountVerificationVisit,setAccountVerificationVisit]=useState(0);
  useEffect(() => {
    if (path !== '/app/settings/identity' || new URLSearchParams(routeSearch).get('section') !== 'account' || !status?.identity?.subjectId) return;
    const panel = document.getElementById('account-verification') as HTMLDetailsElement | null;
    if (!panel) return;
    panel.open = true;
    const frame = requestAnimationFrame(() => { panel.scrollIntoView({block:'start'}); panel.querySelector('summary')?.focus({preventScroll:true}); });
    return () => cancelAnimationFrame(frame);
  }, [path, routeSearch, status?.identity?.subjectId, accountVerificationVisit]);
  function setIdentityMethodLocation(method:string|null){const url=new URL(location.href);if(method==='recovery'||method==='device')url.searchParams.set('method',method);else url.searchParams.delete('method');history.replaceState(history.state,'',url.pathname+url.search+url.hash);setRouteSearch(url.search);}
  function openIdentityMethod(method:string){setRecoveryError('');setRecoveryNote('');setCodePanelOpen(false);setIdentityMethodLocation(method);requestAnimationFrame(()=>{const panel=document.getElementById(method==='device'?'existing-device':'recover-existing');if(panel){if(panel instanceof HTMLDetailsElement)panel.open=true;panel.scrollIntoView({block:'start'});(panel.querySelector('input,textarea,button') as HTMLElement|null)?.focus({preventScroll:true});}});}
  function identityNavigate(target:string){if(target==='/app/settings/identity'){const button=document.getElementById('connect-current-identity');button?.scrollIntoView({block:'center'});button?.focus();}else navigate(target);}
  const recoverTaskRecords=new URLSearchParams(routeSearch).get('records')==='mine';
  function setRecoverTaskRecords(open:boolean){const url=new URL(location.href);if(open)url.searchParams.set('records','mine');else url.searchParams.delete('records');history.replaceState(history.state,'',url.pathname+url.search+url.hash);setRouteSearch(url.search);}
  const [recoveryCode, setRecoveryCode] = useState(''), [newCode, setNewCode] = useState(''), [recovered, setRecovered] = useState(false), [returnPath, setReturnPath] = useState(readIdentityReturnTarget);
  const [codePanelOpen,setCodePanelOpen]=useState(false),[codeVisible,setCodeVisible]=useState(false),[recoveryInputVisible,setRecoveryInputVisible]=useState(false);
  const [recoveryError,setRecoveryError]=useState(''),[recoveryNote,setRecoveryNote]=useState(''),[recoveryConnectReady,setRecoveryConnectReady]=useState(false);
  const currentIdentityOwner = status?.identity ? `${status.identity.subjectId}:${status.identity.deviceId}` : 'visitor';
  const [deviceManagementScope,setDeviceManagementScope]=useState<{key:string;current:DeviceControlState|null}>({key:'',current:null});
  const [newCodeOwner, setNewCodeOwner] = useState(''), [newCodeOperationId, setNewCodeOperationId] = useState('');
  const recoveryScope=useMemo(()=>({runtime,identitySettingsPage,currentIdentityOwner}),[runtime,identitySettingsPage,currentIdentityOwner]);
  const [recoveryViewScope,setRecoveryViewScope]=useState(recoveryScope);
  // Keep transient input out of the first paint for a different identity or route.
  // A freshly recovered code already assigned to the new owner remains available.
  if(recoveryViewScope!==recoveryScope){
    setRecoveryViewScope(recoveryScope);setRecoveryCode('');setRecoveryInputVisible(false);setCodeVisible(false);setRecoveryError('');setRecoveryNote('');
    if(!runtime||!identitySettingsPage||recoveryViewScope.runtime!==runtime||newCodeOwner!==currentIdentityOwner){
      setNewCode('');setNewCodeOwner('');setNewCodeOperationId('');setCodePanelOpen(false);setRecoveryConnectReady(false);
    }
  }
  const recoveryDisplayGeneration = useRef(0);
  const cancelRecoveryDisplay=useCallback(()=>{recoveryDisplayGeneration.current++;},[]);
  const displayedRecovery=useRef<{runtime:Runtime;owner:string;operationId:string;code:string;recovered:boolean}|null>(null);
  const identityWorking=useRef(false),recoveryConnecting=useRef(false),identityRuntime=useRef(runtime);
  useEffect(()=>{identityRuntime.current=runtime;return()=>{identityRuntime.current=null;};},[runtime]);
  const taskShellNavigation = useRef<{runtime:Runtime;scopeKey:string;route:string;handler:(target:string)=>void}|null>(null);
  const registerTaskShellNavigation = useMemo(() => (scopeKey:string,handler:(target:string)=>void) => {
    const scope=runtime?.taskDraftScope();
    if(!runtime||!scope||scope.closed||scope.key!==scopeKey||location.pathname!=='/app/publish')return()=>{};
    const registration={runtime,scopeKey,route:location.pathname+location.search+location.hash,handler};
    taskShellNavigation.current=registration;
    const page=location.pathname+location.search;
    const skipAnchorChanged=(event:HashChangeEvent)=>{
      const currentScope=runtime.taskDraftScope();
      if(taskShellNavigation.current!==registration||currentScope.closed||currentScope.key!==scopeKey
        ||location.pathname+location.search!==page||location.hash!=='#main-content'
        ||event.oldURL!==new URL(registration.route,location.origin).href||event.newURL!==location.href)return;
      registration.route=location.pathname+location.search+location.hash;
    };
    addEventListener('hashchange',skipAnchorChanged);
    return()=>{removeEventListener('hashchange',skipAnchorChanged);if(taskShellNavigation.current===registration)taskShellNavigation.current=null;};
  },[runtime]);
  function clearRecoveryCode() { cancelRecoveryDisplay(); displayedRecovery.current=null;setNewCode('');setNewCodeOwner('');setNewCodeOperationId('');setCodePanelOpen(false);setCodeVisible(false); }
  function showRecoveryCode(code:string,isRecovered:boolean,operationId:string,identity=status?.identity) {
    if(!runtime||!identity||typeof code!=='string'||!code||!operationId)return;
    const owner=`${identity.subjectId}:${identity.deviceId}`;recoveryDisplayGeneration.current++;
    displayedRecovery.current={runtime,owner,operationId,code,recovered:isRecovered};
    setNewCodeOwner(owner);setNewCodeOperationId(operationId);setNewCode(code);setRecovered(isRecovered);
    setCodePanelOpen(true);setCodeVisible(false);setRecoveryInputVisible(false);setRecoveryCode('');setRecoveryConnectReady(false);setRecoveryError('');setRecoveryNote('');
  }
  function recoveryContinueIntent(value:RecoveryContinueIntent|null) {history.replaceState({...history.state,identityRecoveryContinue:value},'',location.href);}
  function identityDestination(){return new URLSearchParams(location.search).get('continue')==='account'?'/app/settings/identity?section=account':identityReturnTarget(returnPath)??'/app/';}
  function leaveRecoveryPanel(){recoveryContinueIntent(null);setCodePanelOpen(false);setCodeVisible(false);setRecoveryInputVisible(false);setRecoveryCode('');setRecoveryError('');setRecoveryNote('');setRecoveryConnectReady(false);setIdentityMethodLocation(null);}
  async function recoveryAction(stage:'prepare'|'recover'|'save'|'connect',action:()=>Promise<void>){
    if(identityWorking.current||busy)return;identityWorking.current=true;const selected=runtime;
    try{await run(async()=>{setRecoveryError('');setRecoveryNote('');try{await action();}catch(reason){if(identityRuntime.current===selected&&location.pathname==='/app/settings/identity')setRecoveryError(recoveryMessage(reason,stage));}});}
    finally{identityWorking.current=false;}
  }
  async function prepareRecoveryCode(){
    if(!runtime)return;
    if(displayedRecovery.current?.runtime===runtime&&displayedRecovery.current.owner===currentIdentityOwner){setCodePanelOpen(true);setCodeVisible(false);return;}
    const displayGeneration=++recoveryDisplayGeneration.current,value=await runtime.prepareRecovery();
    if(displayGeneration===recoveryDisplayGeneration.current&&identityRuntime.current===runtime&&location.pathname==='/app/settings/identity')showRecoveryCode(value.code,false,value.operationId);
  }
  async function submitRecovery(){
    if(!runtime||!recoveryCode.trim())return;
    const displayGeneration=++recoveryDisplayGeneration.current,value=await runtime.recover(recoveryCode.trim(),{confirmed:true});
    if(displayGeneration!==recoveryDisplayGeneration.current||identityRuntime.current!==runtime||location.pathname!=='/app/settings/identity')return;
    setStatus({identity:value.identity,connection:value.connection,endpoint:value.endpoint,localDraftGeneration:value.localDraftGeneration});
    showRecoveryCode(value.replacementCode,true,value.operationId,value.identity);
  }
  async function connectRecovered(intent:RecoveryContinueIntent){
    if(!runtime||identityRuntime.current!==runtime||location.pathname!=='/app/settings/identity'||recoveryConnecting.current)return;
    recoveryConnecting.current=true;
    try{
    const exact=()=>{const saved=readRecoveryContinueIntent();return !!saved&&['endpoint','subjectId','deviceId','recoveryOperationId','target'].every(key=>saved[key as keyof RecoveryContinueIntent]===intent[key as keyof RecoveryContinueIntent]);};
    if(!exact())return;
    const selected=await runtime.status();
    if(selected.endpoint!==intent.endpoint||selected.identity?.subjectId!==intent.subjectId||selected.identity?.deviceId!==intent.deviceId)throw Object.assign(new Error('recovery_identity_changed'),{code:'recovery_identity_changed'});
    const pending=await runtime.pendingRecoveryCode();if(!exact()||identityRuntime.current!==runtime||location.pathname!=='/app/settings/identity')return;
    if(pending){showRecoveryCode(pending.code,pending.recovered,pending.operationId,selected.identity);recoveryContinueIntent(null);setRecoveryNote('还有一份恢复码待保存，请核对当前这份。');return;}
    if(displayedRecovery.current?.operationId===intent.recoveryOperationId)clearRecoveryCode();
    setIdentityMethodLocation(null);setRecoveryConnectReady(true);
    try{await runtime.connect({confirmed:true});}catch{throw Object.assign(new Error('recovery_connect_failed'),{code:'recovery_connect_failed'});}
    const next=await runtime.status();
    if(next.endpoint!==intent.endpoint||next.identity?.subjectId!==intent.subjectId||next.identity?.deviceId!==intent.deviceId||next.connection?.subjectId!==intent.subjectId)throw Object.assign(new Error('recovery_identity_changed'),{code:'recovery_identity_changed'});
    if(identityRuntime.current!==runtime||location.pathname!=='/app/settings/identity'||!exact())return;
    setStatus(next);setRecoveryConnectReady(false);recoveryContinueIntent(null);navigate(intent.target);
    }finally{recoveryConnecting.current=false;}
  }
  async function saveDisplayedRecovery(){
    const shown=displayedRecovery.current;if(!runtime||!shown||shown.runtime!==runtime||shown.owner!==currentIdentityOwner)return;
    const selected=await runtime.status();
    if(`${selected.identity?.subjectId}:${selected.identity?.deviceId}`!==shown.owner||displayedRecovery.current!==shown)throw Object.assign(new Error('recovery_display_operation_changed'),{code:'recovery_display_operation_changed'});
    const intent:RecoveryContinueIntent={version:1,endpoint:selected.endpoint,subjectId:selected.identity!.subjectId,deviceId:selected.identity!.deviceId,recoveryOperationId:shown.operationId,target:identityDestination()};
    if(shown.recovered)recoveryContinueIntent(intent);
    if(shown.recovered)await runtime.confirmRecoveredCode({operationId:shown.operationId,confirmed:true});else await runtime.saveRecovery({operationId:shown.operationId,confirmed:true});
    if(identityRuntime.current!==runtime||location.pathname!=='/app/settings/identity')return;
    if(displayedRecovery.current===shown)clearRecoveryCode();
    if(shown.recovered){await connectRecovered(intent);return;}
    const pending=await runtime.pendingRecoveryCode();
    if(pending)showRecoveryCode(pending.code,pending.recovered,pending.operationId,selected.identity);
    else {setIdentityMethodLocation(null);setNotice('恢复码已启用，请妥善保管。');}
  }
  async function continueIdentityResult(result:IdentityResult){
    if(!runtime||identityRuntime.current!==runtime||location.pathname!=='/app/settings/identity')return;
    setStatus({identity:result.identity,connection:result.connection,endpoint:result.endpoint,localDraftGeneration:result.localDraftGeneration});
    if(result.replacementCode){showRecoveryCode(result.replacementCode,true,result.operationId,result.identity);return;}
    const codeOperationId=result.kind==='declare-recovery-saved'?result.recoveryOperationId:result.kind==='set-recovery'?result.operationId:null;
    const intent=readRecoveryContinueIntent();
    if(result.kind==='declare-recovery-saved'&&intent&&intent.recoveryOperationId===codeOperationId&&intent.endpoint===result.endpoint&&intent.subjectId===result.identity?.subjectId&&intent.deviceId===result.identity?.deviceId){
      try{await connectRecovered(intent);}catch(reason){setRecoveryError(recoveryMessage(reason,'connect'));}return;
    }
    if(codeOperationId&&displayedRecovery.current?.operationId===codeOperationId){clearRecoveryCode();setIdentityMethodLocation(null);}
    if(result.kind==='bootstrap')setNotice('身份已建立，可以连接继续。');
    else if(codeOperationId)setNotice('恢复码已保存。');
  }
  async function reviewIdentityOperation(row:{kind:string;operationId:string}) {
    if(row.kind==='recover'){openIdentityMethod('recovery');return;}
    if(row.kind==='bootstrap'){
      await run(async()=>{if(runtime){await runtime.createIdentity({confirmed:true});setNotice('身份已建立，可以连接继续。');}});return;
    }
    if(!runtime)return;
    const displayGeneration=++recoveryDisplayGeneration.current;
    await recoveryAction('save',async()=>{
      const value=await runtime.pendingRecoveryCode();
      if(displayGeneration!==recoveryDisplayGeneration.current)return;
      if(!value||(row.kind==='set-recovery'&&value.operationId!==row.operationId))throw Error('原恢复材料当前不可用，请查看这次操作的记录。');
      showRecoveryCode(value.code,value.recovered,value.operationId);
      requestAnimationFrame(()=>{const control=document.getElementById('identity-recovery-save');control?.scrollIntoView({block:'start'});control?.focus({preventScroll:true});});
    });
  }
  const navigate = (target: string) => {
    const from = location.pathname + location.search + location.hash;
    readingPositions.current.set(location.pathname + location.search, window.scrollY);
    history.replaceState({ ...history.state, scrollY: window.scrollY }, '', location.href);
    target = carryHelpOrigin(target, from);
    const destination = new URL(target, location.origin);
    const enteringIdentity = destination.pathname === '/app/settings/identity';
    const identityReturn = accountSettingsPath(destination.pathname)
      ? accountSettingsPath(location.pathname) ? readIdentityReturnTarget() : identityReturnTarget(from) ?? readIdentityReturnTarget()
      : null;
    if (identityReturn) setReturnPath(identityReturn);
    if (enteringIdentity && new URL(target, location.origin).searchParams.get('section') === 'account') setAccountVerificationVisit(value => value + 1);
    const targetPath=new URL(target,location.origin).pathname;
    const fromParameters=new URLSearchParams(location.search);
    const fromDirectory=['/app/','/app/work','/app/search','/app/match','/app/history','/app/participate','/app/capsules','/app/projects','/app/community','/app/rooms','/app/notifications','/app/information'].includes(location.pathname)&&!fromParameters.has('mode')&&!fromParameters.has('compose');
    const toObject=/^\/app\/(tasks|capsules|projects|community|rooms|people)\/[^/]+/.test(targetPath);
    const browseReturn=fromDirectory&&toObject?from:(enteringIdentity||toObject?history.state?.browseReturn:undefined);
    history.pushState({from,...profileNavigationState(from,target,history.state??{}),...(identityReturn?{identityReturn}:{}),...(browseReturn?{browseReturn}:{})}, '', target);
    const route=destination.pathname+destination.search;
    restoreReading.current={route,y:readingPositions.current.get(route)??0};
    setPath(location.pathname); setRouteSearch(location.search); setRouteHash(location.hash); setError(''); setNotice(''); window.scrollTo(0, 0);
  };
  const navigateFromShell = (target:string) => {
    if(location.pathname!=='/app/publish'||!runtime){navigate(target);return;}
    const registration=taskShellNavigation.current,scope=runtime.taskDraftScope();
    const taskSessionExpected=!scope.closed&&scope.subjectId===(status?.identity?.subjectId??null);
    if(!registration&&!taskSessionExpected){navigate(target);return;}
    if(registration?.runtime===runtime&&!scope.closed&&registration.scopeKey===scope.key
      &&registration.route===location.pathname+location.search+location.hash)registration.handler(target);
  };
  useEffect(() => { const changed = () => { restoreReading.current={route:location.pathname+location.search,y:history.state?.scrollY??readingPositions.current.get(location.pathname+location.search)??0};setPath(location.pathname); setRouteSearch(location.search); setRouteHash(location.hash); if (location.pathname === '/app/settings/identity') setReturnPath(readIdentityReturnTarget()); }; addEventListener('popstate', changed); return () => removeEventListener('popstate', changed); }, []);
  useEffect(() => { const changed=()=>{setRouteSearch(location.search);setRouteHash(location.hash);};addEventListener('galaxy:route-view-changed',changed);return()=>removeEventListener('galaxy:route-view-changed',changed); }, []);
  useEffect(()=>{
    const requested=restoreReading.current;
    if(!requested||requested.route!==path+routeSearch)return;
    let done=false;
    const restore=()=>{if(done)return;const anchor=location.hash&&location.hash!=='#main-content'?document.getElementById(location.hash.slice(1)):null;
      if(anchor){anchor.scrollIntoView({block:'center'});done=true;}
      else if(!routeHash&&document.documentElement.scrollHeight-innerHeight>=requested.y){window.scrollTo(0,requested.y);done=true;}
    };
    const observer=new MutationObserver(restore);observer.observe(document.getElementById('main-content')!,{childList:true,subtree:true});
    const frame=requestAnimationFrame(restore),timer=setTimeout(()=>{done=true;observer.disconnect();},5000);
    const cancel=()=>{done=true;};addEventListener('wheel',cancel,{passive:true});addEventListener('touchstart',cancel,{passive:true});addEventListener('pointerdown',cancel,{passive:true});addEventListener('keydown',cancel);
    return()=>{done=true;cancelAnimationFrame(frame);clearTimeout(timer);observer.disconnect();removeEventListener('wheel',cancel);removeEventListener('touchstart',cancel);removeEventListener('pointerdown',cancel);removeEventListener('keydown',cancel);};
  },[path,routeSearch,routeHash]);
  useEffect(() => {
    let active=true, expired=false, opened:Runtime|null=null;
    const timer=window.setTimeout(()=>{expired=true;opened?.close();if(active){setRuntime(null);setConfigError('网站初始化超时，请检查当前网络后重试。');}},12000);
    (async()=>{
      const config=await loadWebConfiguration();if(!active||expired)return;
      const value=await createWebRuntime(config);opened=value;
      if(!active||expired){value.close();return;}
      try{await value.resumeConnection();}catch{/* Explicit identity actions remain available if a saved connection cannot resume. */}
      const next=await value.status();if(!active||expired){value.close();return;}
      setRuntime(value);setStatus(next);
    })().catch(reason=>{opened?.close();if(active&&!expired)setConfigError(readable(reason));}).finally(()=>window.clearTimeout(timer));
    return()=>{active=false;window.clearTimeout(timer);if(opened)closeSummaryRuntime(opened);opened?.close();};
  },[]);
  useEffect(() => {
    if (!runtime) return;
    let active = true;
    const refresh = () => {
      if (active && !document.hidden) runtime.resumeConnection().catch(()=>null).then(()=>runtime.status()).then(next => { if (active) setStatus(next); }).catch(() => {});
    };
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; document.removeEventListener('visibilitychange', refresh); };
  }, [runtime]);
  async function run(action: () => Promise<void>) {
    if(busy)return;const origin=location.pathname;setBusy(true);setError('');setNotice('');
    try{await action();}catch(reason){if(location.pathname===origin)setError(readable(reason));}
    finally{try{if(runtime)setStatus(await runtime.status());}catch(reason){if(location.pathname===origin)setError(readable(reason));}finally{setBusy(false);}}
  }
  useEffect(()=>{if(!runtime)return;let active=true;const timer=setInterval(()=>runtime.resumeConnection().catch(()=>null).then(()=>runtime.status()).then(value=>{if(active)setStatus(value);}).catch(()=>{}),15000);return()=>{active=false;clearInterval(timer);};},[runtime]);
  const taskDetails=useCallback(async(id:string,quiet=false)=>{const loaded=await taskPage.refresh(id,quiet);if(loaded)setError('');},[taskPage]);
  useEffect(() => {taskPage.open();
    if (runtime&&taskId) {
      const refresh=(quiet=false)=>taskPage.refresh(taskId,quiet).then(loaded=>{if(loaded)setError('');}).catch(reason=>setError(readable(reason)));
      void refresh();
      const refreshOnVisible = () => { if (!document.hidden) void refresh(true); };
      document.addEventListener('visibilitychange', refreshOnVisible);
      const timer=window.setInterval(refreshOnVisible,10000);
      return () => {taskPage.close();window.clearInterval(timer);document.removeEventListener('visibilitychange',refreshOnVisible);};
    }
    return () => {taskPage.close();};
  }, [taskPage,runtime,taskId]);
  const onPendingRecoveryCode=useEffectEvent(async(value:Awaited<ReturnType<Runtime['pendingRecoveryCode']>>,selected:Runtime,owner:string,valid:()=>boolean)=>{
    if(!valid())return;
    if(value){showRecoveryCode(value.code,value.recovered,value.operationId);return;}
    const intent=readRecoveryContinueIntent();
    if(!intent||intent.endpoint!==status?.endpoint||`${intent.subjectId}:${intent.deviceId}`!==owner)return;
    const control=await selected.publicControl(intent.subjectId);if(!valid())return;
    if(control.recovery?.sourceEventId===intent.recoveryOperationId&&control.recoveryReadiness==='registered-save-declared')await recoveryAction('connect',()=>connectRecovered(intent));
    else recoveryContinueIntent(null);
  });
  useEffect(() => {
    let current=true;
    const shown=displayedRecovery.current;
    if(!runtime||!identitySettingsPage){cancelRecoveryDisplay();displayedRecovery.current=null;return;}
    if(shown?.runtime===runtime&&shown.owner===currentIdentityOwner)return;
    cancelRecoveryDisplay();displayedRecovery.current=null;const displayGeneration=recoveryDisplayGeneration.current;
    const valid=()=>current&&displayGeneration===recoveryDisplayGeneration.current&&identityRuntime.current===runtime;
    void runtime.pendingRecoveryCode().then(value=>onPendingRecoveryCode(value,runtime,currentIdentityOwner,valid)).catch(reason=>{if(valid())setRecoveryError(recoveryMessage(reason,'save'));});
    return()=>{current=false;cancelRecoveryDisplay();};
  },[runtime,identitySettingsPage,currentIdentityOwner,cancelRecoveryDisplay]);
  useEffect(()=>{const hide=()=>{if(document.hidden){setCodeVisible(false);setRecoveryInputVisible(false);}};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide);},[]);
  function needIdentity() { navigate('/app/settings/identity'); }
  const connected = !!status?.connection;
  const deviceControlKey=JSON.stringify([status?.endpoint,currentIdentityOwner,status?.connection?.bindingId??null,status?.connection?.generation??null]);
  const currentDeviceControl=deviceManagementScope.key===deviceControlKey&&deviceManagementScope.current?.subjectId===status?.identity?.subjectId
    &&deviceManagementScope.current?.deviceId===status?.identity?.deviceId&&deviceManagementScope.current?.endpoint===status?.endpoint?deviceManagementScope.current:null;
  const currentDevice=currentDeviceControl?.devices.find(device=>device.currentDevice&&device.deviceId===status?.identity?.deviceId);
  const currentDeviceCanConnect=!!currentDevice&&currentDevice.state==='active'&&currentDevice.epoch===currentDeviceControl?.epoch
    &&currentDevice.scopes.some(scope=>scope==='binding'||scope==='*');
  const currentConnectionUnavailable=!!currentDeviceControl&&!currentDeviceCanConnect;
  const canManageIdentity=!!currentDeviceControl?.canManage&&currentDeviceCanConnect;
  async function copyCode() {const shown=displayedRecovery.current;if(!shown||shown.owner!==currentIdentityOwner)return;try{await navigator.clipboard.writeText(shown.code);if(displayedRecovery.current===shown)setRecoveryNote('已复制，请保存在这台设备之外。');}catch{if(displayedRecovery.current===shown)setRecoveryNote('复制未完成，可以下载，或显示后手动复制。');}}
  function downloadCode() {const shown=displayedRecovery.current;if(!shown||shown.owner!==currentIdentityOwner)return;const url=URL.createObjectURL(new Blob([shown.code+'\n'],{type:'text/plain;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download='galaxy-recovery.txt';anchor.click();URL.revokeObjectURL(url);setRecoveryNote('请把下载的恢复码文件保存在这台设备之外。');}
  const capsuleRoute = /^\/app\/capsules(?:\/([0-9a-f-]{36})(?:\/versions\/([0-9a-f-]{36}))?)?$/.exec(path);
  const projectRoute = /^\/app\/projects\/([0-9a-f-]{36})$/.exec(path);
  const personSubject = profileSubject(path);
  const qualificationPermissionRoute = /^\/app\/qualification-permissions(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const packUseRoute = /^\/app\/worker-pack-uses\/([0-9a-f-]{36})$/.exec(path);
  const informationRoute = /^\/app\/information(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const reviewRoute = /^\/app\/reviews(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const governanceRoute = /^\/app\/governance(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const forumPostRoute = /^\/app\/community\/posts\/([0-9a-f-]{36})(?:\/versions\/([0-9a-f-]{36}))?$/.exec(path);
  const forumReplyRoute = /^\/app\/community\/replies\/([0-9a-f-]{36})$/.exec(path);
  const forumReportRoute = /^\/app\/community\/reports\/([0-9a-f-]{36})$/.exec(path);
  const forumPage = path === '/app/community' || !!forumPostRoute || !!forumReplyRoute || !!forumReportRoute;
  const projectParameters = new URLSearchParams(routeSearch);
  const readingTaskResult=taskSection==='collaboration'&&projectParameters.get('view')==='work'&&projectParameters.get('record')==='results'&&readTaskResult(routeSearch).selected;
  const governanceTargetType = projectParameters.get('targetType'), governanceTargetId = projectParameters.get('targetId');
  const governanceTarget = (governanceTargetType === 'task' || governanceTargetType === 'room') && /^[0-9a-f-]{36}$/.test(governanceTargetId ?? '')
    ? { type: governanceTargetType as 'task' | 'room', id: governanceTargetId! } : undefined;
  const knownPath = path === '/app' || path === '/app/' || path === '/app/account' || path === '/app/work' || entries.some(entry => entry.path === path)
    || /^\/app\/(?:tasks|rooms)\/[0-9a-f-]{36}$/.test(path) || !!capsuleRoute || !!projectRoute || !!personSubject || !!qualificationPermissionRoute || !!packUseRoute || !!informationRoute || !!governanceRoute || !!reviewRoute || forumPage;
  const hasDisplayedCode=!!newCode&&newCodeOwner===currentIdentityOwner;
  const savingRecoveryCode=hasDisplayedCode&&codePanelOpen;
  const enteringRecoveryCode=identityMethod==='recovery'&&!savingRecoveryCode&&!recoveryConnectReady;
  const recoveryFlow=savingRecoveryCode||enteringRecoveryCode||recoveryConnectReady;
  return <SiteShell path={path} search={routeSearch} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigateFromShell} onDisconnect={()=>run(async()=>{await runtime?.disconnect();setNotice("已退出本次连接。");})}>
        {busy && <output className="operation-progress"><span/>正在处理当前操作，请稍候…</output>}
        {configError && <section className="connection-unavailable" role="alert"><h1 className="small">暂时连不上银河</h1><p>可以重试，或先浏览介绍与使用文档。</p><div className="button-row"><Button onClick={retryConfiguration}>重新连接</Button><a className="text-link" href="/docs/">阅读使用文档</a></div><details className="technical-details"><summary>连接问题详情</summary><p>{configError}</p></details></section>}
        {error && (task||!/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)) && <div className="message error" role="alert">{error}</div>}{notice && <output className="message">{notice}</output>}
        <Suspense fallback={<PageLoading label="正在打开页面…"/>}>
        {!knownPath && <section><h1 className="small">找不到这个页面</h1><p>链接没有对应的银河页面。可以回到首页选择入口，或让原聊天中的模型核对对象地址。</p><Button onClick={() => navigate('/app/')}>回到首页</Button></section>}
        {(path === '/app/' || path === '/app') && <StartPage runtime={runtime} navigate={navigate}/>}
        {forumPage && runtime && <CommunityForumWorkspace key={`forum:${status?.endpoint}:${status?.identity?.subjectId ?? 'visitor'}:${status?.identity?.deviceId ?? ''}:${status?.connection?.bindingId ?? ''}:${status?.connection?.generation ?? ''}:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} postId={forumPostRoute?.[1]} versionId={forumPostRoute?.[2]} replyId={forumReplyRoute?.[1]} reportId={forumReportRoute?.[1]} section={projectParameters.get('section') ?? 'all'} compose={projectParameters.get('compose') === 'post'} manage={projectParameters.get('manage') === '1'}/>}
        {!runtime&&!configError&&path!=='/app/'&&path!=='/app'&&<PageLoading label="正在读取连接与本机资料…"/>}
        {runtime&&<>
        {taskLoading&&!task&&/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&<PageLoading label="正在读取这项求助…"/>}
        {!taskLoading&&!task&&runtime&&/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&<section className={connected&&recoverTaskRecords?'task-records-return':'object-unavailable'}>
          {connected&&recoverTaskRecords?<><button className="back-link" onClick={()=>setRecoverTaskRecords(false)}>← 返回原请求入口</button>
            <TaskOwnerReadWorkspace key={`${path}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}:${status?.connection?.generation??''}`} runtime={runtime} taskId={path.split('/').at(-1)!} connected={connected}/>
            <details className="technical-details"><summary>原请求的完整页面暂不可读</summary><p>{error||'当前未取得完整页面，可以重新读取或返回任务目录。'}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>run(()=>taskDetails(path.split('/').at(-1)!))}>重新读取完整页面</Button><button className="text-link" onClick={()=>navigate('/app/participate')}>返回任务目录</button></div></details>
          </>:<><h1 className="small">暂时无法打开这项求助</h1><p>{connected?'可以重试，或返回任务目录。':'如果这项求助分享给了你，请先登录。'}</p><div className="button-row"><Button disabled={busy} onClick={()=>run(()=>taskDetails(path.split('/').at(-1)!))}>重新读取</Button>{!connected&&<Button variant="outline" onClick={needIdentity}>登录并继续</Button>}<button className="text-link" onClick={()=>navigate('/app/participate')}>返回任务目录</button></div>{error&&<details className="technical-details"><summary>读取问题详情</summary><p>{error}</p></details>}{connected&&<button className="text-link" onClick={()=>setRecoverTaskRecords(true)}>查看我在这里留下的记录</button>}</>}
          <FactReceiptRecovery key={`fact-receipt:${path}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}:${status?.connection?.generation??''}`} runtime={runtime} subjectId={status?.identity?.subjectId} taskId={path.split('/').at(-1)!} connected={connected}/>
        </section>}
        {path === '/app/match' && <DiscoveryWorkspace key={routeSearch} runtime={runtime} connected={connected} navigate={navigate}/>}
        {path === '/app/search' && <HelpSearchWorkspace key={routeSearch} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
        {qualificationPermissionRoute && <QualificationPermissionWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${qualificationPermissionRoute[1] ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialRequestId={qualificationPermissionRoute[1]} onNeedIdentity={needIdentity}/>}
        {capsuleRoute && <CapsuleWorkspace key={`${status?.endpoint ?? ''}:${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? 'disconnected'}:${status?.connection?.generation ?? ''}:${path}:${routeSearch}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} capsuleId={capsuleRoute[1]} versionId={capsuleRoute[2]}/>}
        {path === '/app/settings/privacy' && <PrivacyWorkspace key={`${status?.endpoint??''}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??'disconnected'}:${status?.connection?.generation??''}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
        {path === '/app/settings/trust-package' && <TrustPackageWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/participate' && <TaskDirectoryWorkspace key={`task-directory:${status?.identity?.subjectId ?? 'anonymous'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} needIdentity={needIdentity}/> }
        {path === '/app/publish' && <TaskPublishWorkspace key={`${routeSearch}:${status?.endpoint}:${status?.identity?.subjectId ?? 'visitor'}:${status?.identity?.deviceId ?? ''}:${status?.connection?.bindingId ?? ''}:${status?.connection?.generation ?? ''}:${status?.localDraftGeneration ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} registerShellNavigation={registerTaskShellNavigation}/>}
        {task && <section className={'task-page'+(readingTaskResult?' task-result-page':'')}>{readingTaskResult?<a className="result-task-context" href={'/app/tasks/'+task.taskId} onClick={event=>{event.preventDefault();navigate('/app/tasks/'+task.taskId);}}>来自求助：{taskViewTitle(task)}</a>:<><a className="back-link" href={browseReturnPath('/app/participate')} onClick={e=>{e.preventDefault();navigate(browseReturnPath('/app/participate'));}}><ArrowLeft size={16}/>{browseReturnLabel('/app/participate')}</a><span className="tag">{stateNames[task.state] ?? task.state}</span><h1 className="small">{taskViewTitle(task)}</h1></>}{taskSection==='overview'&&<TaskAuthor runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} task={task} navigate={navigate}/>}
          {task.schemaVersion===2&&!readingTaskResult&&<nav className="task-tabs" aria-label="当前求助">{[['overview','详情'],['collaboration','协作'],['comments','讨论']].map(([id,title])=><button key={id} aria-current={taskSection===id?'page':undefined} onClick={()=>navigate(`/app/tasks/${task.taskId}?section=${id}`)}>{title}</button>)}</nav>}
          {taskSection==='overview'&&<section className="request-detail-body" aria-label="求助详情"><TaskMaterialNotice task={task}/><TaskRequestReading task={task}/><footer className="task-read-actions"><TaskTerms request={task.request}/>{task.view!=='requester'&&task.schemaVersion===2&&<Button onClick={()=>navigate(`/app/tasks/${task.taskId}?section=apply`)}>{task.state==='open'?'我可以提供帮助':'查看参与情况'}<ArrowRight size={15}/></Button>}</footer></section>}
          {taskSection==='apply'&&<section className="task-apply"><button className="back-link" onClick={()=>navigate(`/app/tasks/${task.taskId}`)}><ArrowLeft size={16}/>返回任务详情</button><TaskApplication key={`${task.taskId}:${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)} onNeedIdentity={needIdentity}/></section>}
          {taskSection==='collaboration'&&task.schemaVersion===2&&<div role="tabpanel" aria-label="参与与交付"><TaskCollaboration key={`${task.taskId}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)}/></div>}
          {taskSection==='comments'&&<div role="tabpanel" aria-label="讨论"><TaskCommentsWorkspace key={`comments:${task.taskId}:${status?.endpoint}:${status?.identity?.subjectId ?? "anonymous"}:${status?.identity?.deviceId??""}:${status?.connection?.bindingId??""}:${status?.connection?.generation??""}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/></div>}
          <TaskOperationRecovery key={`recovery:${task.taskId}:${status?.identity?.subjectId ?? "visitor"}:${status?.connection?.bindingId ?? ""}`} runtime={runtime} connected={connected} taskId={task.taskId} managedFeedback={taskSection==='collaboration'&&(!projectParameters.get('view')||projectParameters.get('view')==='people')&&(task.participations??[]).some(participant=>requesterFeedbackAvailable(task,participant,status?.identity?.subjectId))} onComplete={() => taskDetails(task.taskId)}/>
          {task.schemaVersion===2&&<TaskOriginReturn runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} task={task} navigate={navigate}/>}
          {task.schemaVersion===2&&<CommunityTaskReturn key={`forum-return:${task.taskId}:${status?.endpoint}:${status?.identity?.subjectId ?? 'visitor'}:${status?.identity?.deviceId ?? ''}:${status?.connection?.bindingId ?? ''}:${status?.connection?.generation ?? ''}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} task={task} navigate={navigate}/>}
          <details className="return-note"><summary>在自己的 AI 中继续这项任务</summary><p>让你的模型按同一任务链接刷新当前状态。关闭网页不会取消任务。</p></details></section>}
        {/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path) && task && <Button variant="outline" disabled={!connected} onClick={() => navigate('/app/governance?targetType=task&targetId=' + task.taskId)}>举报与处理</Button>}
        {/\/app\/rooms(?:\/[0-9a-f-]{36})?$/.test(path) && <ChatWorkspace key={path + (status?.identity?.subjectId ?? '')} runtime={runtime} roomId={/^\/app\/rooms\/([0-9a-f-]{36})$/.exec(path)?.[1]} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} needIdentity={needIdentity}/> }
        {path === '/app/notifications' && <NotificationWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/projects' && !['projects','contacts','recruitment','willingness','discover'].includes(projectParameters.get('section')??'') && <ProjectDirectoryWorkspace runtime={runtime} navigate={navigate}/>}
        {path === '/app/projects' && ['projects','contacts','recruitment','willingness','discover'].includes(projectParameters.get('section')??'') && <ProjectContactWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialTab={projectParameters.get('section') ?? undefined} initialProjectId={projectParameters.get('projectId') ?? undefined} initialContactId={projectParameters.get('contactId') ?? undefined}/>}
        {projectRoute && <><ContactOriginWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} projectId={projectRoute[1]} contactId={projectParameters.get('fromContact')??undefined} roomId={projectParameters.get('fromRoom')??undefined}/><ProjectDetailWorkspace runtime={runtime} subjectId={status?.identity?.subjectId ?? null} connected={connected} navigate={navigate} projectId={projectRoute[1]}/></>}
        {path === '/app/configurations' && <ConfigurationWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/builders' && <BuildersWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {(path === '/app/worker-packs' || packUseRoute) && <WorkerPackUseWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} useId={packUseRoute?.[1]} builderId={projectParameters.get('builderId') ?? undefined} manifestId={projectParameters.get('manifestId') ?? undefined}/>}
        {path === '/app/hubs' && <HubsWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected}/>}
        {informationRoute && <InformationWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} watchId={informationRoute[1]}/>}
        {reviewRoute && <ModerationReviewWorkspace key={path+routeSearch+(status?.identity?.subjectId??'')} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} reportId={reviewRoute[1]} caseId={projectParameters.get('caseId')??undefined} navigate={navigate}/>}
        {governanceRoute && <TargetGovernanceWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} reportId={governanceRoute[1]} target={governanceTarget}/>}
        {path === '/app/history' && <ContributionWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/settings/summaries' && <PersonalSummaryWorkspace runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/account' && <AccountOverview runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} hasIdentity={!!status?.identity} navigate={navigate}/>}
        {personSubject && <PersonProfile runtime={runtime} subjectId={status?.identity?.subjectId} targetSubjectId={personSubject} connected={connected} search={routeSearch} navigate={navigate}/>}
        {path === '/app/work' && <WorkOverview runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/>}
        {path === '/app/settings/identity' && !agentIdentityEntry && projectParameters.get('section')==='account' && <section><button className="back-link" onClick={()=>navigate(returnPath)}><ArrowLeft size={16}/>回到原目标</button><h1 className="small">账号验证</h1><p className="lead">管理当前银河身份关联的验证账号。</p>{!connected&&<div className="browse-note"><p>{status?.identity?'先连接已有身份，再查看验证入口。':'先建立或接回银河身份，再继续验证账号。'}</p><Button onClick={()=>navigate('/app/settings/identity?continue=account')}>{status?.identity?'连接已有身份':'建立或接回身份'}</Button></div>}<AccountSettings key={[status?.endpoint,status?.identity?.subjectId,status?.identity?.deviceId,status?.connection?.bindingId,status?.connection?.generation].join(':')} runtime={runtime} connected={connected}/></section>}
        {path === '/app/settings/identity' && agentIdentityEntry && <AgentIdentityWorkspace key={path+routeSearch} runtime={runtime} entry={agentIdentityEntry} identity={status?.identity??null} connection={status?.connection??null} navigate={navigate} onChange={async()=>{if(runtime)setStatus(await runtime.status());}} onManual={()=>{navigate('/app/settings/identity?deviceRequest=original');openIdentityMethod('device');}}/>}
        {identitySettingsPage&&<section className={'identity-settings-page'+(recoveryFlow?' identity-recovery-flow':'')}>
          <button className="back-link" onClick={()=>navigate(returnPath)}><ArrowLeft size={16}/>{returnPath==='/app/'?'返回首页':'回到原来的页面'}</button>
          <h1 className="small">{savingRecoveryCode?(recovered?'保存新的恢复码':'保存恢复码'):enteringRecoveryCode?'用恢复码接回身份':recoveryConnectReady?'继续原来的工作':'身份与设备'}</h1>
          {!recoveryFlow&&<p className="lead">在不同设备继续使用同一个银河身份。</p>}
          {recoveryError&&<p className="message error" role="alert">{recoveryError}</p>}

          {enteringRecoveryCode&&<section id="recover-existing" className="identity-recovery-step" tabIndex={-1}>
            <form className="workspace-form recovery-input-form" onSubmit={event=>{event.preventDefault();void recoveryAction('recover',submitRecovery);}}>
              <p>粘贴最近保存的恢复码，接回它对应的银河身份。</p>
              <label htmlFor="identity-recovery-input">恢复码<Input id="identity-recovery-input" type={recoveryInputVisible?'text':'password'} autoComplete="off" autoCapitalize="none" spellCheck={false} value={recoveryCode} maxLength={1024} onChange={event=>{setRecoveryCode(event.target.value);setRecoveryError('');}} required placeholder="粘贴完整恢复码" aria-describedby="identity-recovery-effect"/></label>
              <button className="text-link recovery-visibility" type="button" onClick={()=>setRecoveryInputVisible(value=>!value)} aria-pressed={recoveryInputVisible}>{recoveryInputVisible?'隐藏恢复码':'显示恢复码'}</button>
              <p id="identity-recovery-effect" className="recovery-boundary">接回后，原设备在当前服务的连接与控制将失效。原设备上的私有文件和未同步资料仍留在原处。</p>
              <div className="button-row"><Button type="submit" disabled={!runtime||busy||!recoveryCode.trim()}>接回这个身份</Button><Button type="button" variant="ghost" disabled={busy} onClick={leaveRecoveryPanel}>其他接续方式</Button></div>
            </form>
          </section>}

          {savingRecoveryCode&&<section id="identity-recovery-save" className="identity-recovery-step recovery-save-panel" tabIndex={-1}>
            <p>{recovered?'原身份已接回，旧恢复码已使用。请保存这份新码，用于下一次恢复。':'请先把这份码保存在这台设备之外。确认保存后启用；已设置过的恢复码会失效。'}</p>
            <div className="protected-recovery-code">
              <div><span>{codeVisible?'恢复码':'恢复码已隐藏'}</span><button type="button" className="text-link" onClick={()=>setCodeVisible(value=>!value)} aria-pressed={codeVisible}>{codeVisible?'隐藏':'显示'}</button></div>
              {codeVisible?<textarea className="recovery-code" aria-label="新的恢复码" readOnly value={newCode} spellCheck={false} autoComplete="off" onFocus={event=>event.target.select()}/>:<span className="recovery-mask" aria-hidden="true">•••• •••• •••• ••••</span>}
            </div>
            <p className="recovery-boundary">持有这份码的人可以接管你的身份，请勿发给他人。</p>
            <div className="button-row recovery-copy-actions"><Button type="button" variant="outline" disabled={busy} onClick={()=>void copyCode()}><Copy size={16}/>复制恢复码</Button><Button type="button" variant="outline" disabled={busy} onClick={downloadCode}><Download size={16}/>下载恢复码</Button></div>
            {recoveryNote&&<output className="recovery-note">{recoveryNote}</output>}
            <div className="recovery-save-actions"><Button type="button" disabled={busy||!newCodeOperationId} onClick={()=>void recoveryAction('save',saveDisplayedRecovery)}>{busy?'正在处理…':recovered?'我已保存，连接并继续':'我已保存，启用恢复码'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={leaveRecoveryPanel}>稍后保存</Button></div>
          </section>}

          {recoveryConnectReady&&<section className="identity-recovery-step">
            <p>身份已接回，新恢复码已保存。连接后回到刚才的页面。</p>
            <div className="button-row"><Button disabled={busy} onClick={()=>{const intent=readRecoveryContinueIntent();if(intent)void recoveryAction('connect',()=>connectRecovered(intent));}}>连接并继续</Button><Button variant="ghost" disabled={busy} onClick={leaveRecoveryPanel}>返回身份设置</Button></div>
          </section>}

          <IdentityOperationQuery key={currentIdentityOwner} runtime={runtime} owner={currentIdentityOwner} busy={busy} run={run} onReview={reviewIdentityOperation} onContinue={continueIdentityResult} displayedOperationId={savingRecoveryCode?newCodeOperationId:undefined} completedRecoveryId={hasDisplayedCode&&recovered?newCodeOperationId:undefined} recoveryFormOpen={enteringRecoveryCode}/>

          {!recoveryFlow&&<>
            {/^\/app\/(?:publish|participate|tasks)(?:[/?#]|$)/.test(returnPath)&&<TaskAgentIdentityPrompt runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} identityPage returnTo={returnPath}/>}
            {status?.identity?<>
              <section className="identity-current-panel"><h2>当前银河身份</h2><p>{currentConnectionUnavailable?'这台设备已不能继续原连接，可使用管理设备或恢复码接回。':connected?'已连接，可以继续刚才的工作。':'身份保存在这台设备，连接后即可继续。'}</p>
                <div className="button-row"><Button id="connect-current-identity" disabled={busy||currentConnectionUnavailable} onClick={()=>run(async()=>{if(!connected)await runtime!.connect({confirmed:true});navigate(identityDestination());})}>{connected?'返回继续':'连接并继续'}</Button>{connected&&<Button variant="ghost" disabled={busy} onClick={()=>run(async()=>{await runtime!.disconnect();})}>断开本次连接</Button>}</div>
                <details className="identity-reference"><summary>银河 ID 与服务</summary><code className="identity-id">{status.identity.subjectId}</code><p>{status.endpoint}</p></details>
              </section>
              <section className="identity-recovery-setting"><div><h2>恢复码</h2><p>{hasDisplayedCode?'有一份恢复码还未确认保存。':!currentDeviceControl?'正在读取恢复设置…':currentDeviceControl.recoveryReadiness==='registered-awaiting-save-declaration'?'新恢复码还未确认保存。':currentDeviceControl.recoveryConfigured?'已经设置，请保管好你保存的恢复码。':'尚未设置，换设备时可用它接回身份。'}</p></div>
                {(hasDisplayedCode||canManageIdentity)&&<Button variant="outline" disabled={busy} onClick={()=>void recoveryAction('prepare',prepareRecoveryCode)}>{hasDisplayedCode?'继续保存恢复码':currentDeviceControl?.recoveryConfigured?'更换恢复码':'准备恢复码'}</Button>}
                <button className="text-link recovery-existing-link" disabled={busy} onClick={()=>openIdentityMethod('recovery')}>使用已保存的恢复码接回身份</button>
              </section>
            </>:<div className="identity-choice-grid">
              <Card><CardContent className="task-body"><h2>已有银河身份</h2><p>用自己的恢复码，或请已有设备批准，继续使用原身份。</p><div className="button-row"><Button onClick={()=>openIdentityMethod('recovery')}>用恢复码接回</Button><Button variant="outline" onClick={()=>openIdentityMethod('device')}>用已有设备接续</Button></div></CardContent></Card>
              <Card><CardContent className="task-body"><h2>第一次使用普通社区</h2><p>可以在浏览器建立本机身份。任务发布与参与沿用本机 Agent 的已有身份。</p><Button variant="outline" disabled={!runtime||busy} onClick={()=>run(async()=>{await runtime!.createIdentity({confirmed:true});setNotice('身份已建立，可以准备恢复码或连接继续。');})}>创建我的银河身份<ArrowRight size={16}/></Button></CardContent></Card>
            </div>}
            <IdentityWorkspace key={`identity-workspace:${status?.endpoint}:${currentIdentityOwner}:${status?.connection?.bindingId??''}:${status?.connection?.generation??''}`} showControls={!!status?.identity||identityMethod==='device'} controlsOpen={identityMethod==='device'} onDeviceStateChange={current=>setDeviceManagementScope({key:deviceControlKey,current})} onConnected={async()=>{if(runtime)setStatus(await runtime.status());navigate(identityDestination());}} runtime={runtime} subjectId={status?.identity?.subjectId} deviceId={status?.identity?.deviceId} connected={connected} navigate={navigate} onChange={async()=>{if(runtime)setStatus(await runtime.status());}}/>
            <details hidden={!status?.identity} open={!!(projectParameters.get('identityGroupOperation')||projectParameters.get('identityGroupView')||projectParameters.get('identityGroupId'))}><summary>整理多个银河身份的展示关系</summary><IdentityGroupWorkspace key={`identity-group:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={identityNavigate} initialOperationId={projectParameters.get('identityGroupOperation')??undefined}/></details>
            <p className="settings-related"><a href="/app/settings/identity?section=account" onClick={event=>{event.preventDefault();navigate('/app/settings/identity?section=account');}}>管理账号验证与服务关联 →</a></p>
          </>}
        </section>}
        </>}
        </Suspense>
  </SiteShell>;
}
createRoot(document.getElementById('root')!).render(<App/>);
