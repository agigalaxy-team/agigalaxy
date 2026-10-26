import { ReadingDetails, ReadingSummary } from "./shared/reading/reading-details";
import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { createWebRuntime, loadWebConfiguration } from "./runtime.mjs";
import {restoredOfficialAccountReturn} from "./features/accounts/official-account-return.mjs";
import {requesterFeedbackAvailable} from "./features/tasks/feedback/requester-feedback-client.mjs";
import {useDiscoveryUsage} from "./features/discovery/usage";
import type {ChoiceViewLease} from "./shared/operations/choice-retained-operations";
const ChatWorkspace = lazy(() => import("./features/chat/chat-workspace").then(module => ({default: module.ChatWorkspace})));
const ContactOriginWorkspace = lazy(() => import("./features/projects/contacts/origin").then(module => ({default: module.ContactOriginWorkspace})));
const ReceivedPackageReader = lazy(() => import("./features/trust-packages/received-package-reader").then(module => ({default: module.ReceivedPackageReader})));
const OnlineAccountSettings = lazy(() => import("./features/accounts/online-account-settings").then(module => ({default: module.OnlineAccountSettings})));
const PublicAccountWorkspace = lazy(() => import("./features/accounts/public-account-workspace").then(module => ({default: module.PublicAccountWorkspace})));
const AccountFollowsWorkspace = lazy(() => import("./features/account-follows/workspace").then(module => ({default: module.AccountFollowsWorkspace})));
const DiscoveryWorkspace = lazy(() => import("./features/projects/discovery").then(module => ({default: module.DiscoveryWorkspace})));
const ContentSearchWorkspace = lazy(() => import("./features/discovery/content-search").then(module => ({default: module.ContentSearchWorkspace})));
const TaskCollaboration = lazy(() => import("./features/tasks/task-collaboration").then(module => ({default: module.TaskCollaboration})));
const FactReceiptRecovery = lazy(() => import("./features/work-records/workspace").then(module => ({default: module.FactReceiptRecovery})));
const TaskOperationRecovery = lazy(() => import("./features/tasks/operations/task-operation-recovery").then(module => ({default: module.TaskOperationRecovery})));
const TaskOwnerReadWorkspace = lazy(() => import("./features/tasks/owner/task-owner-read-workspace").then(module => ({default: module.TaskOwnerReadWorkspace})));
const NotificationWorkspace = lazy(() => import("./features/notifications/workspace").then(module => ({default: module.NotificationWorkspace})));
const ProjectContactWorkspace = lazy(() => import("./features/projects/management/workspace").then(module => ({default: module.ProjectContactWorkspace})));
const ProjectDetailWorkspace = lazy(() => import("./features/projects/detail").then(module => ({default: module.ProjectDetailWorkspace})));
const ConfigurationWorkspace = lazy(() => import("./features/tools/configuration-workspace").then(module => ({default: module.ConfigurationWorkspace})));
const BuildersWorkspace = lazy(() => import("./features/builders/builders-workspace").then(module => ({default: module.BuildersWorkspace})));
const ContributionWorkspace = lazy(() => import("./features/work-records/contribution-workspace").then(module => ({default: module.ContributionWorkspace})));
const AgentIdentityWorkspace = lazy(() => import("./features/agent-identity/agent-identity-workspace").then(module => ({default: module.AgentIdentityWorkspace})));
import {readAgentIdentityEntry} from "./features/agent-identity/agent-identity-handoff.mjs";
import {createTaskPageView,type TaskPageTask} from "./features/tasks/task-page-view";
import {useCurrentTaskProjection,taskViewTitle,TaskMaterialNotice} from "./features/tasks/materials/task-material-view";
import {TaskRequestReading,taskReadingSection} from "./features/tasks/task-request-reading";
import {AgentWorkContinuation} from "./features/local-galaxy/agent-work-continuation";
import "./features/tasks/task-help-continuation.css";
import {readTaskResult} from "./features/work-records/result-navigation.mjs";
import {MemberLink,useMemberNames} from "./shared/people/conversation-ui";
const PrivacyWorkspace = lazy(() => import("./features/privacy/privacy-workspace").then(module => ({default: module.PrivacyWorkspace})));
const HelpSearchWorkspace = lazy(() => import("./features/help-search/help-search-workspace").then(module => ({default: module.HelpSearchWorkspace})));
const TaskCommentsWorkspace = lazy(() => import("./features/tasks/comments/task-comments-workspace").then(module => ({default: module.TaskCommentsWorkspace})));
const CapsuleWorkspace = lazy(() => import("./features/capsules/capsule-workspace").then(module => ({default: module.CapsuleWorkspace})));
const TaskDirectoryWorkspace = lazy(() => import("./features/tasks/task-directory-workspace").then(module => ({default: module.TaskDirectoryWorkspace})));
const TaskPublishWorkspace = lazy(() => import("./features/tasks/publish/task-publish-workspace").then(module => ({default: module.TaskPublishWorkspace})));
import { carryHelpOrigin } from "./features/help-search/help-origin-client.mjs";
const TaskOriginReturn = lazy(() => import("./features/tasks/publish/task-origin-workspace").then(module => ({default: module.TaskOriginReturn})));
const TaskApplication = lazy(() => import("./features/tasks/task-application").then(module => ({default: module.TaskApplication})));
const QualificationPermissionWorkspace = lazy(() => import("./features/qualification-permissions/qualification-permission-workspace").then(module => ({default: module.QualificationPermissionWorkspace})));
const HubsWorkspace = lazy(() => import("./features/hubs/hubs-workspace").then(module => ({default: module.HubsWorkspace})));
const WorkerPackUseWorkspace = lazy(() => import("./features/tools/worker-pack-use-workspace").then(module => ({default: module.WorkerPackUseWorkspace})));
const InformationWorkspace = lazy(() => import("./information-workspace").then(module => ({default: module.InformationWorkspace})));
const TargetGovernanceWorkspace = lazy(() => import("./features/governance/target-governance-workspace").then(module => ({default: module.TargetGovernanceWorkspace})));
const ModerationReviewWorkspace = lazy(() => import("./features/governance/moderation-review-workspace").then(module => ({default: module.ModerationReviewWorkspace})));
import { closeSummaryRuntime } from "./features/conversation-notes/native/runtime.mjs";
import {createDraftHistoryNavigation,draftNavigationBrowser} from "./shared/navigation/draft-history-navigation.mjs";
import "@/app/globals.css";
import "./workspace.css";
import "./porcelain-theme.css";
import "./full-width-layout.css";
import { SiteShell, StartPage, PageLoading } from "./site-shell";
import {LoadingFeedback} from "./shared/feedback/interaction-feedback";
import {isPublicReadingRoute,PublicReadingWorkspace} from "./features/public-reading/workspace";
const AccountOverview = lazy(() => import("./features/accounts/account-center").then(module => ({default: module.AccountOverview})));
const FeedbackForm = lazy(() => import("./features/feedback/form").then(module => ({default: module.FeedbackForm})));
const AccountAccessWorkspace = lazy(() => import("./features/accounts/account-access").then(module => ({default: module.AccountAccessWorkspace})));
const PersonProfile = lazy(() => import("./features/profiles/person-profile").then(module => ({default: module.PersonProfile})));
import {profileSubject,profileNavigationState,profileReturnNavigationState} from "./features/profiles/profile-navigation.mjs";
const WorkOverview = lazy(() => import("./features/accounts/account-center").then(module => ({default: module.WorkOverview})));
import {ProjectDirectoryWorkspace} from "./features/projects/directory";
import {browseReturnPath,browseReturnLabel} from "./features/discovery/return-navigation";
import {TaskTerms} from "./features/tasks/task-budget-fields";
const CommunityForumWorkspace = lazy(() => import("./features/community-forum/community-forum-workspace").then(module => ({default: module.CommunityForumWorkspace})));
const ReadingBookmarksWorkspace = lazy(() => import("./features/bookmarks/workspace").then(module => ({default: module.ReadingBookmarksWorkspace})));
const CommunityTaskReturn = lazy(() => import("./features/community-forum/community-forum-workspace").then(module => ({default: module.CommunityTaskReturn})));

type Runtime = Awaited<ReturnType<typeof createWebRuntime>>;
type RuntimeStatus = Awaited<ReturnType<Runtime['status']>>;
type Task = TaskPageTask;
function TaskAuthor({runtime,subjectId,connected,task,navigate}:{runtime:Runtime;subjectId?:string;connected:boolean;task:Task;navigate:(path:string)=>void}){
  const names=useMemberNames(runtime,subjectId,connected,[task.requesterId]);
  return <div className="task-author"><MemberLink subjectId={task.requesterId} name={names[task.requesterId]??undefined} ownId={subjectId} navigate={navigate} avatar/><span>发起的求助</span></div>;
}
const workspaceRoutes=['/app/match','/app/publish','/app/community','/app/bookmarks','/app/participate','/app/rooms','/app/projects','/app/history','/app/capsules','/app/configurations','/app/qualification-permissions','/app/builders','/app/worker-packs','/app/hubs','/app/information','/app/governance','/app/search','/app/settings/privacy','/app/settings/trust-package','/app/notifications','/app/settings/summaries','/app/settings/identity'];
const stateNames: Record<string, string> = { open: '正在征集', closed: '已结束', canceled: '已取消', pending: '等待回应', interested: '愿意了解', declined: '已婉拒', expired: '已过期', revoked: '已撤销', question: '有问题待回应' };
function readable(error: unknown) {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return '请求等待超时或已取消，请检查当前网络后重试。';
  const message = error instanceof Error ? error.message : '操作未完成，请重试。';
  return ({ connection_required: '请先连接当前银河身份，再继续这一步。', account_verification_required: '此操作需要银河账户关联，请到账户中心继续。', community_quota_exceeded: '今天的公开操作额度已用完，请稍后再试。', verified_account_required: '此操作需要银河账户关联。', not_found: '内容不存在，或当前身份没有查看权限。', public_write_quota_exceeded: '今天的操作额度已用完，请稍后再试。', request_timeout: '请求等待超时，请检查当前网络后重试。' } as Record<string, string>)[message] ?? message;
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
  return (entry?.valid?entry.targetPath:null) ?? identityReturnTarget(history.state?.identityReturn) ?? restoredOfficialAccountReturn(location) ?? identityReturnTarget(history.state?.from) ?? '/app/';
}
function retiredWorkspaceTarget(url:URL) {
  if(url.pathname==='/app/settings/privacy')return '/app/account?section=settings&view=privacy';
  if(url.pathname==='/app/history')return '/app/work';
  if(url.pathname==='/app/settings/identity'&&!readAgentIdentityEntry(url)){
    const target=new URL('/app/account?section=access',url.origin);
    if(url.searchParams.get('section')==='account'||url.searchParams.get('action')==='association')target.searchParams.set('action','association');
    const returnTo=identityReturnTarget(url.searchParams.get('returnTo'));
    if(returnTo)target.searchParams.set('returnTo',returnTo);
    return target.pathname+target.search;
  }
  if(url.pathname==='/app/settings/summaries'){
    const roomId=url.searchParams.get('roomId');
    return roomId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)?'/app/rooms/'+roomId:'/app/rooms';
  }
  return null;
}
function replaceRetiredLocation(){const target=retiredWorkspaceTarget(new URL(location.href));if(target)history.replaceState(history.state,'',target);}
function accountSettingsPath(pathname: string) {
  return pathname === '/app/account' || pathname === '/app/feedback' || pathname.startsWith('/app/settings/');
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
  const [endpoint,setEndpoint]=useState<string|undefined>(undefined);
  const accountRuntime=useMemo(()=>endpoint?{api:{endpoint}}:null,[endpoint]);
  const [routeSearch, setRouteSearch] = useState(location.search);
  const [routeHash, setRouteHash] = useState(location.hash);
  useDiscoveryUsage({endpoint,path,search:routeSearch});
  const publicReadingPage = isPublicReadingRoute(path);
  const agentIdentityEntry=useMemo(()=>readAgentIdentityEntry({pathname:path,search:routeSearch,origin:location.origin}),[path,routeSearch]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [configError, setConfigError] = useState('');
  const actionInProgress=useRef<symbol|null>(null),[actionOrigin,setActionOrigin]=useState<string|null>(null);
  const taskId=/^\/app\/tasks\/([0-9a-f-]{36})$/.exec(path)?.[1]??null;
  const taskReadScope=JSON.stringify([taskId,status?.connection?.bindingId,status?.connection?.generation]);
  const taskPage=useMemo(()=>createTaskPageView<Task>({taskId,scope:taskReadScope,read:runtime&&taskId?()=>runtime.api.call(`/v2/tasks/${taskId}`,null,{method:'GET',authenticated:!!runtime.api.snapshot()}):null,isCurrent:()=>location.pathname===`/app/tasks/${taskId}`}),[runtime,taskId,taskReadScope]);
  const {task:taskRecord,loading:taskLoading}=useSyncExternalStore(taskPage.subscribe,taskPage.read,taskPage.read);
  const task=useCurrentTaskProjection(runtime,taskRecord);
  const readingPositions = useRef(new Map<string, number>());
  const draftHistory = useRef<ReturnType<typeof createDraftHistoryNavigation>|null>(null);
  const [historySavePending,setHistorySavePending]=useState<'native'|'fallback'|null>(null);
  const restoreReading = useRef<{ route: string; y: number } | null>(location.hash ? {route:location.pathname+location.search,y:0} : null);
  const taskSection=taskReadingSection(task,readTaskSection(routeSearch));
  const recoverTaskRecords=new URLSearchParams(routeSearch).get('records')==='mine';
  function setRecoverTaskRecords(open:boolean){const url=new URL(location.href);if(open)url.searchParams.set('records','mine');else url.searchParams.delete('records');history.replaceState(history.state,'',url.pathname+url.search+url.hash);setRouteSearch(url.search);}
  const [returnPath,setReturnPath]=useState(readIdentityReturnTarget);
  const runtimeRef=useRef(runtime);
  useEffect(()=>{runtimeRef.current=runtime;return()=>{runtimeRef.current=null;};},[runtime]);
  const shellStatus=useRef(status);
  useLayoutEffect(()=>{shellStatus.current=status;},[status]);
  const taskShellNavigation = useRef<{runtime:Runtime;scopeKey:string;route:string;handler:(target:string)=>void;leaveAction:(action:()=>void)=>void}|null>(null);
  const registerTaskShellNavigation = useMemo(() => (scopeKey:string,handler:(target:string)=>void,leaveAction:(action:()=>void)=>void) => {
    const scope=runtime?.taskDraftScope();
    const route=draftHistory.current?.editorRoute()??location.pathname+location.search+location.hash;
    if(!runtime||!scope||scope.closed||scope.key!==scopeKey||new URL(route,location.origin).pathname!=='/app/publish')return()=>{};
    const registration={runtime,scopeKey,route,handler,leaveAction};
    taskShellNavigation.current=registration;
    draftHistory.current?.resume();
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
  const chatShellNavigation = useRef<{runtime:Runtime;lease:ChoiceViewLease;route:string;handler:(target:string)=>void;leaveAction:(action:()=>void)=>void}|null>(null);
  const registerChatShellNavigation = useMemo(() => (lease:ChoiceViewLease,handler:(target:string)=>void,leaveAction:(action:()=>void)=>void) => {
    const route=draftHistory.current?.editorRoute()??location.pathname+location.search+location.hash;
    if(!runtime||!/^\/app\/rooms(?:\/[0-9a-f-]{36})?$/.test(new URL(route,location.origin).pathname))return()=>{};
    try{lease.assertCurrent();}catch{return()=>{};}
    const registration={runtime,lease,route,handler,leaveAction};
    chatShellNavigation.current=registration;
    draftHistory.current?.resume();
    const page=location.pathname+location.search;
    const skipAnchorChanged=(event:HashChangeEvent)=>{
      if(chatShellNavigation.current!==registration||location.pathname+location.search!==page||location.hash!=='#main-content'
        ||event.oldURL!==new URL(registration.route,location.origin).href||event.newURL!==location.href)return;
      try{lease.assertCurrent();}catch{return;}
      registration.route=location.pathname+location.search+location.hash;
    };
    addEventListener('hashchange',skipAnchorChanged);
    return()=>{removeEventListener('hashchange',skipAnchorChanged);if(chatShellNavigation.current===registration)chatShellNavigation.current=null;};
  },[runtime]);
  const forumShellNavigation=useRef<{runtime:Runtime;route:string;isCurrent:()=>boolean;leaveAction:(action:()=>void)=>void}|null>(null);
  const registerForumShellNavigation=useMemo(()=>(isCurrent:()=>boolean,leaveAction:(action:()=>void)=>void)=>{
    const route=draftHistory.current?.editorRoute()??location.pathname+location.search+location.hash;
    if(!runtime||!new URL(route,location.origin).pathname.startsWith('/app/community'))return()=>{};
    const registration={runtime,route,isCurrent,leaveAction};forumShellNavigation.current=registration;draftHistory.current?.resume();
    return()=>{if(forumShellNavigation.current===registration)forumShellNavigation.current=null;};
  },[runtime]);
  const navigate = (target: string, options?:{profileReturn?:boolean}) => {
    const from = location.pathname + location.search + location.hash;
    readingPositions.current.set(location.pathname + location.search, window.scrollY);
    history.replaceState({ ...history.state, scrollY: window.scrollY }, '', location.href);
    target = carryHelpOrigin(target, from);
    let destination = new URL(target, location.origin);
    const replacement=retiredWorkspaceTarget(destination);
    if(replacement){target=replacement;destination=new URL(target,location.origin);}
    const enteringIdentity = destination.pathname === '/app/settings/identity';
    const identityReturn = accountSettingsPath(destination.pathname)
      ? accountSettingsPath(location.pathname) ? readIdentityReturnTarget() : identityReturnTarget(from) ?? readIdentityReturnTarget()
      : null;
    if (identityReturn) setReturnPath(identityReturn);
    const targetPath=new URL(target,location.origin).pathname;
    const fromParameters=new URLSearchParams(location.search);
    const fromDirectory=(['/app/','/app/work','/app/find','/app/search','/app/match','/app/history','/app/participate','/app/capsules','/app/projects','/app/community','/app/bookmarks','/app/rooms','/app/notifications','/app/information'].includes(location.pathname)||!!profileSubject(location.pathname)&&!profileSubject(targetPath))&&!fromParameters.has('mode')&&!fromParameters.has('compose');
    const toObject=/^\/app\/(tasks|capsules|projects|community|rooms|people|accounts)\/[^/]+/.test(targetPath);
    const browseReturn=fromDirectory&&toObject?from:(enteringIdentity||toObject?history.state?.browseReturn:undefined);
    const readingState=options?.profileReturn?profileReturnNavigationState(history.state??{}):{...profileNavigationState(from,target,history.state??{}),...(browseReturn?{browseReturn}:{})};
    history.pushState({from,...readingState,...(identityReturn?{identityReturn}:{})}, '', target);
    draftHistory.current?.changed();
    const route=destination.pathname+destination.search;
    restoreReading.current={route,y:readingPositions.current.get(route)??0};
    setPath(location.pathname); setRouteSearch(location.search); setRouteHash(location.hash); setError(''); setNotice(''); window.scrollTo(0, 0);
  };
  const navigateFromShell = (target:string) => {
    if(!draftHistory.current?.leave(()=>navigate(target),true))navigate(target);
  };
  const selectHistoryLeave=useCallback((origin:string)=>{
    const selected=runtimeRef.current,chatRegistration=chatShellNavigation.current,view=shellStatus.current;
    const forumRegistration=forumShellNavigation.current;
    if(selected&&forumRegistration?.runtime===selected&&forumRegistration.route.split('#')[0]===origin.split('#')[0]&&forumRegistration.isCurrent()){
      return{leave:forumRegistration.leaveAction,isCurrent:()=>runtimeRef.current===selected&&forumShellNavigation.current===forumRegistration&&forumRegistration.isCurrent()};
    }
    if(selected&&chatRegistration?.runtime===selected&&chatRegistration.route===origin){
      try{chatRegistration.lease.assertCurrent();}catch{return null;}
      const isCurrent=()=>{if(runtimeRef.current!==selected||chatShellNavigation.current!==chatRegistration)return false;try{chatRegistration.lease.assertCurrent();return true;}catch{return false;}};
      return{leave:chatRegistration.leaveAction,isCurrent};
    }
    if(new URL(origin,location.origin).pathname==='/app/publish'&&selected){
      const registration=taskShellNavigation.current,scope=selected.taskDraftScope();
      if(scope.closed||scope.subjectId!==(view?.identity?.subjectId??null))return null;
      if(registration?.runtime===selected&&registration.scopeKey===scope.key&&registration.route===origin){
        const isCurrent=()=>{const latest=selected.taskDraftScope();return runtimeRef.current===selected&&taskShellNavigation.current===registration&&!latest.closed&&latest.key===registration.scopeKey;};
        return{leave:registration.leaveAction,isCurrent};
      }
      // An editor still mounting cannot be discarded by browser traversal.
      return{leave:()=>{},isCurrent:()=>runtimeRef.current===selected&&!selected.taskDraftScope().closed&&selected.taskDraftScope().key===scope.key};
    }
    return null;
  },[]);
  const acceptHistoryLocation=useCallback(()=>{
    replaceRetiredLocation();
    const route=location.pathname+location.search+location.hash;
    const taskRegistration=taskShellNavigation.current,chatRegistration=chatShellNavigation.current;
    if(taskRegistration&&taskRegistration.route.split('#')[0]===route.split('#')[0]){
      const scope=taskRegistration.runtime.taskDraftScope();
      if(!scope.closed&&scope.key===taskRegistration.scopeKey&&runtimeRef.current===taskRegistration.runtime)taskRegistration.route=route;
    }
    if(chatRegistration&&chatRegistration.route.split('#')[0]===route.split('#')[0]){
      try{chatRegistration.lease.assertCurrent();if(runtimeRef.current===chatRegistration.runtime)chatRegistration.route=route;}catch{/* A stale registration cannot adopt the new location. */}
    }
    restoreReading.current={route:location.pathname+location.search,y:history.state?.scrollY??readingPositions.current.get(location.pathname+location.search)??0};
    setPath(location.pathname);setRouteSearch(location.search);setRouteHash(location.hash);
    setError('');setNotice('');
    if(location.pathname==='/app/settings/identity')setReturnPath(readIdentityReturnTarget());
  },[]);
  const browserNavigation=useMemo(()=>draftNavigationBrowser(window),[]);
  useLayoutEffect(()=>{
    const navigation=createDraftHistoryNavigation({
      origin:location.origin,read:()=>({route:location.pathname+location.search+location.hash,key:browserNavigation?.key()??null}),
      traverseTo:browserNavigation?(key,info)=>browserNavigation.traverseTo(key,info):null,
      selectLeave:selectHistoryLeave,accept:acceptHistoryLocation,held:setHistorySavePending,
      failed:()=>setError('输入仍保留在本页。暂时未能继续返回，可以再试一次。'),
    });
    draftHistory.current=navigation;navigation.start();
    const changed=()=>navigation.pop(),unlisten=browserNavigation?.listen(event=>navigation.navigate(event));
    addEventListener('popstate',changed);addEventListener('hashchange',changed);
    return()=>{removeEventListener('popstate',changed);removeEventListener('hashchange',changed);navigation.stop(()=>unlisten?.());if(draftHistory.current===navigation)draftHistory.current=null;};
  },[browserNavigation,selectHistoryLeave,acceptHistoryLocation]);
  useEffect(() => { const changed=()=>{draftHistory.current?.changed();setRouteSearch(location.search);setRouteHash(location.hash);};addEventListener('galaxy:route-view-changed',changed);return()=>removeEventListener('galaxy:route-view-changed',changed); }, []);
  useEffect(()=>{
    const requested=restoreReading.current;
    if(!requested||requested.route!==path+routeSearch)return;
    let done=false;
    const restore=()=>{if(done)return;const anchor=location.hash&&location.hash!=='#main-content'?document.getElementById(location.hash.slice(1)):null;
      if(anchor){const margins=getComputedStyle(anchor),available=innerHeight-(parseFloat(margins.scrollMarginTop)||0)-(parseFloat(margins.scrollMarginBottom)||0);anchor.scrollIntoView({block:anchor.getBoundingClientRect().height>available?'start':'center'});done=true;}
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
      setEndpoint(config.endpoint);
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
    if(actionInProgress.current)return;
    const ticket=Symbol('current-action'),origin=location.pathname+location.search,selected=runtime;
    actionInProgress.current=ticket;setBusy(true);setActionOrigin(origin);setError('');setNotice('');
    const stillHere=()=>location.pathname+location.search===origin;
    try{await action();}catch(reason){if(stillHere())setError(readable(reason));}
    finally{try{if(selected){const next=await selected.status();if(runtimeRef.current===selected)setStatus(next);}}catch(reason){if(stillHere())setError(readable(reason));}
      finally{if(actionInProgress.current===ticket){actionInProgress.current=null;setBusy(false);setActionOrigin(null);}}}
  }
  function disconnectNative() {
    if(!runtime)return;
    const selected=runtime,origin=location.pathname+location.search+location.hash;
    const disconnect=()=>{if(runtimeRef.current!==selected||location.pathname+location.search+location.hash!==origin)return;void run(async()=>{await selected.disconnect();setNotice('已断开网页连接。');});};
    if(!draftHistory.current?.leave(disconnect,true))disconnect();
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
  function needIdentity() { navigate('/app/account?section=access&action=native'); }
  const connected = !!status?.connection;
  const capsuleRoute = /^\/app\/capsules(?:\/([0-9a-f-]{36})(?:\/versions\/([0-9a-f-]{36}))?)?$/.exec(path);
  const projectRoute = /^\/app\/projects\/([0-9a-f-]{36})$/.exec(path);
  const personSubject = profileSubject(path);
  const qualificationPermissionRoute = /^\/app\/qualification-permissions(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const packUseRoute = /^\/app\/worker-pack-uses\/([0-9a-f-]{36})$/.exec(path);
  const informationRoute = /^\/app\/information(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const reviewRoute = /^\/app\/reviews(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const governanceRoute = /^\/app\/governance(?:\/([0-9a-f-]{36}))?$/.exec(path);
  const forumPostRoute = /^\/app\/community\/posts\/([0-9a-f-]{36})(?:\/versions\/([0-9a-f-]{36}))?$/.exec(path);
  const forumSectionRoute = /^\/app\/community\/sections\/([0-9a-f-]{36})$/.exec(path);
  const forumReplyRoute = /^\/app\/community\/replies\/([0-9a-f-]{36})$/.exec(path);
  const forumReportRoute = /^\/app\/community\/reports\/([0-9a-f-]{36})$/.exec(path);
  const publicAccountRoute = /^\/app\/accounts\/([0-9a-f-]{36})$/.exec(path);
  const forumPage = path === '/app/community' || !!forumPostRoute || !!forumReplyRoute || !!forumReportRoute || !!forumSectionRoute;
  const projectParameters = new URLSearchParams(routeSearch);
  const accessAction=projectParameters.get('action');
  const accessSection=accessAction==='association'||accessAction==='native'?accessAction:'overview';
  const accountReturn=identityReturnTarget(projectParameters.get('returnTo'))??returnPath;
  const nativeIdentity=status?.identity?.source==='native-handoff'?status.identity:null;
  const nativeControls=runtime&&nativeIdentity?<section className="account-native-current"><h2>当前网页连接</h2><code>{nativeIdentity.subjectId}</code><p>{connected?'已连接':'尚未连接'}</p><div className="button-row">{connected?<Button variant="outline" disabled={busy} onClick={disconnectNative}>断开网页连接</Button>:<Button disabled={busy} onClick={()=>void run(async()=>{await runtime.connect({confirmed:true});})}>连接网页</Button>}</div></section>:undefined;
  const accountPage=path==='/app/account'||path==='/app/bookmarks'||path==='/app/feedback'||path==='/app/work'||!!publicAccountRoute||path==='/app/settings/trust-package';
  const readingTaskResult=taskSection==='collaboration'&&projectParameters.get('view')==='work'&&projectParameters.get('record')==='results'&&readTaskResult(routeSearch).selected;
  const governanceTargetType = projectParameters.get('targetType'), governanceTargetId = projectParameters.get('targetId');
  const governanceTarget = (governanceTargetType === 'task' || governanceTargetType === 'room') && /^[0-9a-f-]{36}$/.test(governanceTargetId ?? '')
    ? { type: governanceTargetType as 'task' | 'room', id: governanceTargetId! } : undefined;
  const knownPath = publicReadingPage || path === '/app' || path === '/app/' || path === '/app/find' || path === '/app/account' || path === '/app/feedback' || path === '/app/work' || workspaceRoutes.includes(path)
    || /^\/app\/(?:tasks|rooms)\/[0-9a-f-]{36}$/.test(path) || !!capsuleRoute || !!projectRoute || !!personSubject || !!qualificationPermissionRoute || !!packUseRoute || !!informationRoute || !!governanceRoute || !!reviewRoute || forumPage || !!publicAccountRoute;
  return <SiteShell path={path} search={routeSearch} endpoint={endpoint} navigate={navigateFromShell}>
        {!publicReadingPage&&<LoadingFeedback active={busy&&actionOrigin===path+routeSearch} scopeKey={actionOrigin??''} className="workspace-operation-feedback" label="正在完成当前操作…" detail="处理仍在继续，请保留当前页面。"/>}
        {!publicReadingPage&&!accountPage&&configError && <section className="connection-unavailable" role="alert"><h1 className="small">暂时连不上银河</h1><p>可以重试，或先浏览介绍与使用文档。</p><div className="button-row"><Button onClick={retryConfiguration}>重新连接</Button><a className="text-link" href="/docs/">阅读使用文档</a></div><ReadingDetails className="technical-details"><ReadingSummary>连接问题详情</ReadingSummary><p>{configError}</p></ReadingDetails></section>}
        {!publicReadingPage&&error && (task||!/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)) && <div className="message error" role="alert">{error}</div>}{!publicReadingPage&&notice && <output className="message">{notice}</output>}
        {historySavePending&&<div className="message"><output>先保存当前输入，再继续离开。保存失败时，输入会留在本页。</output><Button variant="outline" onClick={()=>draftHistory.current?.resume()}>保存并继续</Button></div>}
        <Suspense fallback={<PageLoading label="正在打开页面…" scopeKey={path+routeSearch}/> }>
        {publicReadingPage&&<PublicReadingWorkspace path={path} search={routeSearch} hash={routeHash} navigate={navigateFromShell}/>}
        {!knownPath && <section><h1 className="small">找不到这个页面</h1><p>没有找到这个页面。可以返回发现，继续浏览。</p><Button onClick={() => navigate('/app/')}>回到发现</Button></section>}
        {(path === '/app/' || path === '/app') && <StartPage runtime={runtime} navigate={navigate}/>}
        {forumPage && runtime && <CommunityForumWorkspace key={`forum:${path}:${routeSearch}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} postId={forumPostRoute?.[1]} versionId={forumPostRoute?.[2]} replyId={forumReplyRoute?.[1]} reportId={forumReportRoute?.[1]} memberSectionId={forumSectionRoute?.[1]} section={projectParameters.get('section') ?? 'all'} compose={projectParameters.get('compose') === 'post'} manage={projectParameters.get('manage') === '1'} routeSearch={routeSearch} browseReturn={browseReturnPath('/app/community')} browseReturnLabel={browseReturnLabel('/app/community')} registerShellNavigation={registerForumShellNavigation}/>}
        {!publicReadingPage&&!accountPage&&!agentIdentityEntry&&!runtime&&!configError&&path!=='/app/'&&path!=='/app'&&<PageLoading label="正在打开页面…"/>}
        {path==='/app/bookmarks'&&<ReadingBookmarksWorkspace runtime={accountRuntime} connected={false} navigate={navigate} search={routeSearch}/>}
        {path==='/app/feedback'&&<FeedbackForm endpoint={endpoint} navigate={navigate}/>}
        {path==='/app/account'&&!['access','settings','following'].includes(projectParameters.get('section')??'')&&<AccountOverview endpoint={endpoint} navigate={navigate}/>}
        {path==='/app/account'&&projectParameters.get('section')==='access'&&<AccountAccessWorkspace endpoint={endpoint} navigate={navigate} section={accessSection} returnTo={accountReturn} identityControls={nativeControls}/>}
        {path==='/app/account'&&projectParameters.get('section')==='settings'&&<OnlineAccountSettings endpoint={endpoint} navigate={navigate} view={projectParameters.get('view')??'profile'}/>}
        {path==='/app/account'&&projectParameters.get('section')==='following'&&<AccountFollowsWorkspace endpoint={endpoint} navigate={navigate} search={routeSearch}/>}
        {publicAccountRoute&&<PublicAccountWorkspace key={publicAccountRoute[1]} accountId={publicAccountRoute[1]} endpoint={endpoint} navigate={navigate} onReturn={target=>navigate(target,{profileReturn:true})}/>}
        {path==='/app/work'&&<WorkOverview endpoint={endpoint} navigate={navigate}/>}
        {path==='/app/settings/trust-package'&&<ReceivedPackageReader runtime={runtime} subjectId={nativeIdentity?.subjectId} connected={!!nativeIdentity&&connected} navigate={navigate} returnTo={accountReturn}/>}
        {path==='/app/settings/identity'&&agentIdentityEntry&&<AgentIdentityWorkspace key={path+routeSearch} runtime={runtime} entry={agentIdentityEntry} identity={status?.identity??null} connection={status?.connection??null} navigate={navigate} onChange={async()=>{if(runtime)setStatus(await runtime.status());}} onManual={()=>navigate('/app/account?section=access')}/>}
        {runtime&&<>
        {taskLoading&&!task&&/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&<PageLoading label="正在读取这项求助…"/>}
        {!taskLoading&&!task&&runtime&&/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&<section className={connected&&recoverTaskRecords?'task-records-return':'object-unavailable'}>
          {connected&&recoverTaskRecords?<><button className="back-link" onClick={()=>setRecoverTaskRecords(false)}> 返回原请求入口</button>
            <TaskOwnerReadWorkspace key={`${path}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}:${status?.connection?.generation??''}`} runtime={runtime} taskId={path.split('/').at(-1)!} connected={connected}/>
            <ReadingDetails className="technical-details"><ReadingSummary>原请求的完整页面暂不可读</ReadingSummary><p>{error||'当前未取得完整页面，可以重新读取或返回任务目录。'}</p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>run(()=>taskDetails(path.split('/').at(-1)!))}>重新读取完整页面</Button><button className="text-link" onClick={()=>navigate('/app/participate')}>返回任务目录</button></div></ReadingDetails>
          </>:<><h1 className="small">暂时无法打开这项求助</h1><p>{connected?'可以重试，或返回任务目录。':'如果这项求助分享给了你，请接续获准的银河身份。'}</p><div className="button-row"><Button disabled={busy} onClick={()=>run(()=>taskDetails(path.split('/').at(-1)!))}>重新读取</Button>{!connected&&<Button variant="outline" onClick={needIdentity}>接续已有身份</Button>}<button className="text-link" onClick={()=>navigate('/app/participate')}>返回任务目录</button></div>{error&&<ReadingDetails className="technical-details"><ReadingSummary>读取问题详情</ReadingSummary><p>{error}</p></ReadingDetails>}{connected&&<button className="text-link" onClick={()=>setRecoverTaskRecords(true)}>查看我在这里留下的记录</button>}</>}
          <FactReceiptRecovery key={`fact-receipt:${path}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}:${status?.connection?.generation??''}`} runtime={runtime} subjectId={status?.identity?.subjectId} taskId={path.split('/').at(-1)!} connected={connected}/>
        </section>}
        {path === '/app/match' && <DiscoveryWorkspace key={routeSearch} runtime={runtime} connected={connected} navigate={navigate}/>}
        {path === '/app/find' && <ContentSearchWorkspace key={routeSearch} runtime={runtime} navigate={navigate} search={routeSearch}/>}
        {path === '/app/search' && <HelpSearchWorkspace key={routeSearch} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
        {qualificationPermissionRoute && <QualificationPermissionWorkspace key={`${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}:${qualificationPermissionRoute[1] ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} initialRequestId={qualificationPermissionRoute[1]} onNeedIdentity={needIdentity}/>}
        {capsuleRoute && <CapsuleWorkspace key={`${status?.endpoint ?? ''}:${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? 'disconnected'}:${status?.connection?.generation ?? ''}:${path}:${routeSearch}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} capsuleId={capsuleRoute[1]} versionId={capsuleRoute[2]}/>}
        {path === '/app/settings/privacy' && <PrivacyWorkspace key={`${status?.endpoint??''}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??'disconnected'}:${status?.connection?.generation??''}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/>}
        {path === '/app/participate' && <TaskDirectoryWorkspace key={`task-directory:${status?.identity?.subjectId ?? 'anonymous'}:${status?.connection?.bindingId ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} needIdentity={needIdentity}/> }
        {path === '/app/publish' && <TaskPublishWorkspace key={`${routeSearch}:${status?.endpoint}:${status?.identity?.subjectId ?? 'visitor'}:${status?.identity?.deviceId ?? ''}:${status?.connection?.bindingId ?? ''}:${status?.connection?.generation ?? ''}:${status?.localDraftGeneration ?? ''}`} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} onNeedIdentity={needIdentity} registerShellNavigation={registerTaskShellNavigation}/>}
        {task && <section className={'task-page'+(readingTaskResult?' task-result-page':'')}>{readingTaskResult?<a className="result-task-context" href={'/app/tasks/'+task.taskId} onClick={event=>{event.preventDefault();navigate('/app/tasks/'+task.taskId);}}>来自求助：{taskViewTitle(task)}</a>:<><a className="back-link" href={browseReturnPath('/app/participate')} onClick={e=>{e.preventDefault();navigate(browseReturnPath('/app/participate'));}}>{browseReturnLabel('/app/participate')}</a><span className="tag">{stateNames[task.state] ?? task.state}</span><h1 className="small">{taskViewTitle(task)}</h1></>}{taskSection==='overview'&&<TaskAuthor runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} task={task} navigate={navigate}/>}
          {task.schemaVersion===2&&!readingTaskResult&&<nav className="task-tabs" aria-label="当前求助">{[['overview','详情'],['collaboration','协作'],['comments','讨论']].map(([id,title])=><button key={id} aria-current={taskSection===id?'page':undefined} onClick={()=>navigate(`/app/tasks/${task.taskId}?section=${id}`)}>{title}</button>)}</nav>}
          {taskSection==='overview'&&<section className="request-detail-body" aria-label="求助详情"><TaskMaterialNotice task={task}/><TaskRequestReading task={task} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate}/><footer className="task-read-actions"><TaskTerms request={task.request}/>{task.view!=='requester'&&task.schemaVersion===2&&<Button onClick={()=>navigate(`/app/tasks/${task.taskId}?section=apply`)}>{task.state==='open'?'我可以提供帮助':'查看参与情况'}</Button>}</footer></section>}
          {taskSection==='apply'&&<section className="task-apply"><button className="back-link" onClick={()=>navigate(`/app/tasks/${task.taskId}`)}>返回任务详情</button><TaskApplication key={`${task.taskId}:${status?.identity?.subjectId ?? 'visitor'}:${status?.connection?.bindingId ?? ''}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)} onNeedIdentity={needIdentity}/></section>}
          {taskSection==='collaboration'&&task.schemaVersion===2&&<div role="tabpanel" aria-label="参与与交付"><TaskCollaboration key={`${task.taskId}:${status?.identity?.subjectId??'visitor'}:${status?.connection?.bindingId??''}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate} refresh={() => taskDetails(task.taskId)}/></div>}
          {taskSection==='comments'&&<div role="tabpanel" aria-label="讨论"><TaskCommentsWorkspace key={`comments:${task.taskId}:${status?.endpoint}:${status?.identity?.subjectId ?? "anonymous"}:${status?.identity?.deviceId??""}:${status?.connection?.bindingId??""}:${status?.connection?.generation??""}`} task={task} runtime={runtime} subjectId={status?.identity?.subjectId} connected={connected} navigate={navigate}/></div>}
          <TaskOperationRecovery key={`recovery:${task.taskId}:${status?.identity?.subjectId ?? "visitor"}:${status?.connection?.bindingId ?? ""}`} runtime={runtime} connected={connected} taskId={task.taskId} managedFeedback={taskSection==='collaboration'&&(!projectParameters.get('view')||projectParameters.get('view')==='people')&&(task.participations??[]).some(participant=>requesterFeedbackAvailable(task,participant,status?.identity?.subjectId))} onComplete={() => taskDetails(task.taskId)}/>
          {task.schemaVersion===2&&<TaskOriginReturn runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} task={task} navigate={navigate}/>}
          {task.schemaVersion===2&&<CommunityTaskReturn key={`forum-return:${task.taskId}:${status?.endpoint}:${status?.identity?.subjectId ?? 'visitor'}:${status?.identity?.deviceId ?? ''}:${status?.connection?.bindingId ?? ''}:${status?.connection?.generation ?? ''}`} runtime={runtime} connected={connected} subjectId={status?.identity?.subjectId} task={task} navigate={navigate}/>}
          <AgentWorkContinuation runtime={runtime} subjectId={status?.identity?.subjectId} object={{kind:'task',id:task.taskId}} title={taskViewTitle(task)} purpose="接着这项求助，理解当前问题、已取得的结果与还缺少的材料" onNeedIdentity={needIdentity}/></section>}
        {/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path) && task && <Button variant="outline" disabled={!connected} onClick={() => navigate('/app/governance?targetType=task&targetId=' + task.taskId)}>举报与处理</Button>}
        {/\/app\/rooms(?:\/[0-9a-f-]{36})?$/.test(path) && <ChatWorkspace key={path} runtime={runtime} roomId={/^\/app\/rooms\/([0-9a-f-]{36})$/.exec(path)?.[1]} search={routeSearch} connected={connected} subjectId={status?.identity?.subjectId} navigate={navigate} needIdentity={needIdentity} registerShellNavigation={registerChatShellNavigation}/> }
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
        {personSubject && <PersonProfile runtime={runtime} subjectId={status?.identity?.subjectId} targetSubjectId={personSubject} connected={connected} search={routeSearch} navigate={navigate} onReturn={target=>navigate(target,{profileReturn:true})}/>}
        </>}
        </Suspense>
  </SiteShell>;
}
replaceRetiredLocation();
createRoot(document.getElementById('root')!).render(<App/>);
