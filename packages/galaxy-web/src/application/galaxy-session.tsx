"use client";

import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {QueryClientProvider,useQuery,useQueryClient} from "@tanstack/react-query";
import {AccountSessionScope} from "../features/accounts/account-session-scope";
import {createGalaxyQueryClient,galaxyQueryKey} from "../shared/runtime/query-client";
import {createGalaxyEventClient} from "../shared/runtime/event-stream";
import {nativeQueryScope} from "./query-scope";
import {RetainedPageSlot} from "./retained-route-slot";
import {createContext,useContext} from "react";

import {Button} from "@/components/ui/button";
import {createWebRuntime,loadWebConfiguration} from "../runtime.mjs";
import {restoredOfficialAccountReturn} from "../features/accounts/official-account-return.mjs";

import {useDiscoveryUsage} from "../features/discovery/usage";
import type {ChoiceViewLease} from "../shared/operations/choice-retained-operations";
import {readAgentIdentityEntry} from "../features/agent-identity/agent-identity-handoff.mjs";
import {type TaskPageTask} from "../features/tasks/task-page-view";
import {useCurrentTaskProjection} from "../features/tasks/materials/task-material-view";
import {taskReadingSection} from "../features/tasks/task-request-reading";

import {readTaskResult} from "../features/work-records/result-navigation.mjs";

import {carryHelpOrigin} from "../features/help-search/help-origin-client.mjs";
import {closeSummaryRuntime} from "../features/conversation-notes/native/runtime.mjs";
import {createDraftHistoryNavigation,draftNavigationBrowser} from "../shared/navigation/draft-history-navigation.mjs";

import {isPublicReadingRoute} from "../features/public-reading/workspace";
import {profileSubject,profileNavigationState,profileReturnNavigationState} from "../features/profiles/profile-navigation.mjs";

type Runtime = Awaited<ReturnType<typeof createWebRuntime>>;
type RuntimeStatus = Awaited<ReturnType<Runtime['status']>>;
type Task = TaskPageTask;
const workspaceRoutes=['/app/match','/app/publish','/app/community','/app/bookmarks','/app/participate','/app/rooms','/app/projects','/app/history','/app/capsules','/app/configurations','/app/qualification-permissions','/app/builders','/app/worker-packs','/app/hubs','/app/information','/app/governance','/app/search','/app/settings/privacy','/app/settings/trust-package','/app/notifications','/app/settings/summaries','/app/settings/identity'];

function readingRoute(pathname:string,search:string){const query=new URLSearchParams(search).toString();return(pathname!=='/'?pathname.replace(/\/$/,''):pathname)+(query?'?'+query:'');}
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
function accountSettingsPath(pathname: string) {
  return pathname === '/app/account' || pathname === '/app/feedback' || pathname.startsWith('/app/settings/');
}
function readTaskSection(search: string) {
  const section=new URLSearchParams(search).get('section');return ['collaboration','comments','apply'].includes(section??'')?section!:'overview';
}

function useSessionState(){
  const queryClient=useQueryClient();
  const [configurationAttempt,setConfigurationAttempt]=useState(0);
  const retryConfiguration=useCallback(()=>setConfigurationAttempt(value=>value+1),[]);
  const router=useContext(NavigationContext)!;
  const path=router.pathname,parameters=new URLSearchParams(router.search);
  const [runtime,setRuntime]=useState<Runtime|null>(null),[status,setStatus]=useState<RuntimeStatus|null>(null);
  const [endpoint,setEndpoint]=useState<string|undefined>(undefined);
  const accountRuntime=useMemo(()=>endpoint?{api:{endpoint}}:null,[endpoint]);
  const routeSearch=parameters.size?"?"+parameters.toString():"";
  const [routeHash,setRouteHash]=useState(location.hash);
  useEffect(()=>{const changed=()=>setRouteHash(location.hash);addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);
  useDiscoveryUsage({endpoint,path,search:routeSearch});
  const publicReadingPage = isPublicReadingRoute(path);
  const agentIdentityEntry=useMemo(()=>readAgentIdentityEntry({pathname:path,search:routeSearch,origin:location.origin}),[path,routeSearch]);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [configError, setConfigError] = useState('');
  const actionInProgress=useRef<symbol|null>(null),[actionOrigin,setActionOrigin]=useState<string|null>(null);
  const taskId=/^\/app\/tasks\/([0-9a-f-]{36})$/.exec(path)?.[1]??null;
  const taskReadScope=JSON.stringify([taskId,status?.connection?.bindingId,status?.connection?.generation]);
  // Public reads keep their anonymous authority even while Native is connected.
  useEffect(()=>{
    if(!endpoint)return;
    const events=createGalaxyEventClient({scope:{endpoint,identity:'anonymous',surface:'web'},queryClient,
      topics:['forum','tasks','projects','capsules','builders','information','choice-sync','ci','site-content']});
    events.start();return()=>events.stop();
  },[endpoint,queryClient]);
  useEffect(()=>{
    if(!runtime)return;
    const scope=nativeQueryScope(runtime,status?.identity?.subjectId);
    if(!scope.identity.startsWith('native:'))return;
    const eventFetch=Reflect.get(runtime.api,'eventFetch') as typeof fetch|undefined;
    if(!eventFetch)return;
    const modules=['tasks','projects','contacts','capsules','notifications','builders','information','choice-sync','ci'];
    const clearNative=()=>{for(const module of modules){const queryKey=galaxyQueryKey(scope,module);
      void queryClient.cancelQueries({queryKey});
      // Query.reset clears observers immediately but does not refetch. Removing
      // the old generation then prevents future mounts from recovering its data.
      for(const query of queryClient.getQueryCache().findAll({queryKey}))query.reset();
      queryClient.removeQueries({queryKey});
    }};
    const events=createGalaxyEventClient({scope,queryClient,topics:modules,fetch:eventFetch,
      onReset:()=>{void runtime.status().then(setStatus).catch(()=>{});}});
    events.start();
    const expiresAt=Number(runtime.api.snapshot()?.expiresAt);
    const timer=Number.isFinite(expiresAt)?setTimeout(()=>{events.stop();clearNative();void runtime.status().then(setStatus).catch(()=>{});},Math.max(0,Math.min(2147483647,expiresAt*1000-Date.now()+1))):null;
    return()=>{events.stop();if(timer!==null)clearTimeout(timer);clearNative();};
  },[runtime,status?.identity?.subjectId,status?.connection?.bindingId,status?.connection?.generation,queryClient]);
  const taskQuery=useQuery<Task>({
    queryKey:galaxyQueryKey(nativeQueryScope(runtime,status?.identity?.subjectId),'tasks',taskId,taskReadScope),
    enabled:!!runtime&&!!taskId&&nativeQueryScope(runtime,status?.identity?.subjectId).identity!=='unavailable',
    queryFn:({signal})=>runtime!.api.call(`/v2/tasks/${taskId}`,null,{method:'GET',signal,authenticated:!!runtime!.api.snapshot()}) as Promise<Task>,
  });
  const taskRecord=taskQuery.data??null,taskLoading=taskQuery.isPending&&taskQuery.fetchStatus==='fetching';
  const task=useCurrentTaskProjection(runtime,taskRecord);
  const pendingReadingState=useRef<{route:string;state:Record<string,unknown>}|null>(null);
  const [,setNavigationMetadataVersion]=useState(0);
  useLayoutEffect(()=>{if(pendingReadingState.current?.route===readingRoute(path,routeSearch)){history.replaceState({...history.state,...pendingReadingState.current.state},"",location.href);pendingReadingState.current=null;setNavigationMetadataVersion(value=>value+1);}},[path,routeSearch]);
  useEffect(()=>{const target=retiredWorkspaceTarget(new URL(location.href));if(target)router.replace(target);},[path,routeSearch,router]);
  const readingPositions = useRef(new Map<string, number>());
  useEffect(()=>{const remember=()=>readingPositions.current.set(readingRoute(location.pathname,location.search),window.scrollY);addEventListener('scroll',remember,{passive:true});return()=>removeEventListener('scroll',remember);},[]);
  const draftHistory = useRef<ReturnType<typeof createDraftHistoryNavigation>|null>(null);
  const [historySavePending,setHistorySavePending]=useState<'native'|'fallback'|null>(null);
  const restoreReading = useRef<{ route: string; y: number } | null>(location.hash ? {route:readingRoute(location.pathname,location.search),y:0} : null);
  const taskSection=taskReadingSection(task,readTaskSection(routeSearch));
  const recoverTaskRecords=new URLSearchParams(routeSearch).get('records')==='mine';
  function setRecoverTaskRecords(open:boolean){const url=new URL(location.href);if(open)url.searchParams.set('records','mine');else url.searchParams.delete('records');router.replace(url.pathname+url.search+url.hash,{scroll:false});}
  const [returnPath,setReturnPath]=useState(readIdentityReturnTarget);
  const runtimeRef=useRef(runtime);
  useEffect(()=>{runtimeRef.current=runtime;return()=>{runtimeRef.current=null;};},[runtime]);
  const shellStatus=useRef(status);
  useLayoutEffect(()=>{shellStatus.current=status;},[status]);
  const taskShellNavigation = useRef<{runtime:Runtime;scopeKey:string;route:string;handler:(target:string)=>void;leaveAction:(action:()=>void)=>void}|null>(null);
  const registerTaskShellNavigation = useMemo(() => (scopeKey:string,handler:(target:string)=>void,leaveAction:(action:()=>void)=>void) => {
    const scope=runtime?.taskDraftScope();
    const route=path+routeSearch+routeHash;
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
  },[runtime,path,routeSearch,routeHash]);
  const chatShellNavigation = useRef<{runtime:Runtime;lease:ChoiceViewLease;route:string;handler:(target:string)=>void;leaveAction:(action:()=>void)=>void}|null>(null);
  const registerChatShellNavigation = useMemo(() => (lease:ChoiceViewLease,handler:(target:string)=>void,leaveAction:(action:()=>void)=>void) => {
    const route=path+routeSearch+routeHash;
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
  },[runtime,path,routeSearch,routeHash]);
  const forumShellNavigation=useRef<{runtime:Runtime;route:string;isCurrent:()=>boolean;leaveAction:(action:()=>void)=>void}|null>(null);
  const registerForumShellNavigation=useMemo(()=>(isCurrent:()=>boolean,leaveAction:(action:()=>void)=>void)=>{
    const route=path+routeSearch+routeHash;
    if(!runtime||!new URL(route,location.origin).pathname.startsWith('/app/community'))return()=>{};
    const registration={runtime,route,isCurrent,leaveAction};forumShellNavigation.current=registration;draftHistory.current?.resume();
    return()=>{if(forumShellNavigation.current===registration)forumShellNavigation.current=null;};
  },[runtime,path,routeSearch,routeHash]);
  const performNavigate = (target: string, options?:{profileReturn?:boolean}) => {
    const from = location.pathname + location.search + location.hash;
    readingPositions.current.set(readingRoute(location.pathname,location.search),window.scrollY);

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
    pendingReadingState.current={route:readingRoute(destination.pathname,destination.search),state:{from,...readingState,...(identityReturn?{identityReturn}:{})}};
    router.push(target,{scroll:false});
    draftHistory.current?.changed();
    const route=readingRoute(destination.pathname,destination.search);
    restoreReading.current={route,y:readingPositions.current.get(route)??0};
    setError('');setNotice('');
  };
  const navigate=(target:string,options?:{profileReturn?:boolean})=>{if(!draftHistory.current?.leave(()=>performNavigate(target,options),true))performNavigate(target,options);};
  const navigateFromShell=navigate;
  useEffect(()=>{const follow=(event:MouseEvent)=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;
    if(!(anchor instanceof HTMLAnchorElement)||anchor.hasAttribute('download')||anchor.target&&anchor.target!=='_self'||anchor.getAttribute('href')?.startsWith('#'))return;
    const url=new URL(anchor.href,location.href);
    if(url.origin!==location.origin||!(url.pathname==='/'||url.pathname==='/app'||url.pathname.startsWith('/app/')||isPublicReadingRoute(url.pathname)))return;
    event.preventDefault();navigate(url.pathname+url.search+url.hash);
  };document.addEventListener('click',follow);return()=>document.removeEventListener('click',follow);});

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

    const route=location.pathname+location.search+location.hash;
    const taskRegistration=taskShellNavigation.current,chatRegistration=chatShellNavigation.current;
    if(taskRegistration&&taskRegistration.route.split('#')[0]===route.split('#')[0]){
      const scope=taskRegistration.runtime.taskDraftScope();
      if(!scope.closed&&scope.key===taskRegistration.scopeKey&&runtimeRef.current===taskRegistration.runtime)taskRegistration.route=route;
    }
    if(chatRegistration&&chatRegistration.route.split('#')[0]===route.split('#')[0]){
      try{chatRegistration.lease.assertCurrent();if(runtimeRef.current===chatRegistration.runtime)chatRegistration.route=route;}catch{/* A stale registration cannot adopt the new location. */}
    }
    restoreReading.current={route:readingRoute(location.pathname,location.search),y:history.state?.scrollY??readingPositions.current.get(readingRoute(location.pathname,location.search))??0};
    setRouteHash(location.hash);
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
    const unlisten=browserNavigation?.listen(event=>navigation.navigate(event));
    return()=>{navigation.stop(()=>unlisten?.());if(draftHistory.current===navigation)draftHistory.current=null;};
  },[browserNavigation,selectHistoryLeave,acceptHistoryLocation]);
  useEffect(()=>{const changed=()=>{router.replace(location.pathname+location.search+location.hash,{scroll:false});};addEventListener('galaxy:route-view-changed',changed);return()=>removeEventListener('galaxy:route-view-changed',changed);},[router]);
  useEffect(()=>{
    const requested=restoreReading.current;
    if(!requested||requested.route!==readingRoute(path,routeSearch))return;
    let done=false;
    const restore=()=>{if(done)return;const anchor=location.hash&&location.hash!=='#main-content'?document.getElementById(location.hash.slice(1)):null;
      if(anchor){const margins=getComputedStyle(anchor),available=innerHeight-(parseFloat(margins.scrollMarginTop)||0)-(parseFloat(margins.scrollMarginBottom)||0);anchor.scrollIntoView({block:anchor.getBoundingClientRect().height>available?'start':'center'});done=true;}
      else if(!routeHash&&document.documentElement.scrollHeight-innerHeight>=requested.y){window.scrollTo(0,requested.y);done=true;}
    };
    const observer=new MutationObserver(restore);observer.observe(document.getElementById('main-content')??document.body,{childList:true,subtree:true});
    const frame=requestAnimationFrame(restore),timer=setTimeout(()=>{done=true;observer.disconnect();},5000);
    const cancel=()=>{done=true;};addEventListener('wheel',cancel,{passive:true});addEventListener('touchstart',cancel,{passive:true});addEventListener('pointerdown',cancel,{passive:true});addEventListener('keydown',cancel);
    return()=>{done=true;cancelAnimationFrame(frame);clearTimeout(timer);observer.disconnect();removeEventListener('wheel',cancel);removeEventListener('touchstart',cancel);removeEventListener('pointerdown',cancel);removeEventListener('keydown',cancel);};
  },[path,routeSearch,routeHash]);
  useEffect(() => {
    let active=true, expired=false, opened:Runtime|null=null;
    setConfigError('');setRuntime(null);setStatus(null);
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
  },[configurationAttempt]);
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
  const refetchTask=taskQuery.refetch;
  const taskDetails=useCallback(async(id:string,_quiet=false)=>{if(id!==taskId)return;const result=await refetchTask();if(result.error)throw result.error;setError('');},[taskId,refetchTask]);
  useEffect(()=>{if(taskQuery.error)setError(readable(taskQuery.error));},[taskQuery.error]);
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
  const accessSection:'association'|'native'|'overview'=accessAction==='association'||accessAction==='native'?accessAction:'overview';
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

  return {path,routeSearch,routeHash,runtime,status,setStatus,endpoint,accountRuntime,publicReadingPage,agentIdentityEntry,error,notice,busy,configError,actionOrigin,historySavePending,draftHistory,navigate,navigateFromShell,task,taskLoading,taskSection,recoverTaskRecords,setRecoverTaskRecords,returnPath,connected,capsuleRoute,projectRoute,personSubject,qualificationPermissionRoute,packUseRoute,informationRoute,reviewRoute,governanceRoute,forumPostRoute,forumSectionRoute,forumReplyRoute,forumReportRoute,publicAccountRoute,forumPage,projectParameters,accessSection,accountReturn,nativeIdentity,nativeControls,accountPage,readingTaskResult,governanceTarget,knownPath,taskDetails,needIdentity,run,registerTaskShellNavigation,registerChatShellNavigation,registerForumShellNavigation,selectHistoryLeave,retryConfiguration,acceptHistoryLocation};
}
export type GalaxyNavigation={pathname:string;search:string;push:(target:string,options?:{scroll?:boolean})=>void;replace:(target:string,options?:{scroll?:boolean})=>void};
const NavigationContext=createContext<GalaxyNavigation|null>(null);
type Session=ReturnType<typeof useSessionState>;
const SessionContext=createContext<Session|null>(null);
export function useGalaxySession(){const value=useContext(SessionContext);if(!value)throw Error("GalaxySessionProvider is required");return value;}
/** Mount browser authority without replacing the already-rendered page subtree. */
const RuntimeSession=React.memo(function RuntimeSession({publish}:{publish:(session:Session)=>void}){
 const session=useSessionState();
 useLayoutEffect(()=>publish(session),[publish,session]);
 return null;
});
function BrowserSession({children,ready}:{children:React.ReactNode;ready:boolean}){
 const [queryClient]=useState(createGalaxyQueryClient),[session,setSession]=useState<Session|null>(null);
 return <QueryClientProvider client={queryClient}><AccountSessionScope endpoint={session?.endpoint}><SessionContext.Provider value={session}>
  {ready&&<RuntimeSession publish={setSession}/>}
  <RetainedRouteSlot>{children}</RetainedRouteSlot>
 </SessionContext.Provider></AccountSessionScope></QueryClientProvider>;
}
export function GalaxySessionProvider({children,navigation}:{children:React.ReactNode;navigation:GalaxyNavigation}){
 const [ready,setReady]=useState(false);useEffect(()=>setReady(true),[]);
 return <NavigationContext.Provider value={navigation}><BrowserSession ready={ready}>{children}</BrowserSession></NavigationContext.Provider>;
}

export function useOptionalGalaxySession(){return useContext(SessionContext);}

function RetainedRouteSlot({children}:{children:React.ReactNode}){
 const session=useOptionalGalaxySession(),navigation=useContext(NavigationContext)!;
 const search=new URLSearchParams(navigation.search).toString(),route=navigation.pathname+(search?'?'+search:'');
 return <RetainedPageSlot route={route} value={session}
  isProtected={origin=>!!session?.selectHistoryLeave(origin)}
  leave={complete=>{if(!session?.draftHistory.current?.leave(complete,true))complete();}}
  restore={origin=>navigation.replace(origin,{scroll:false})}
  onCommit={()=>{session?.acceptHistoryLocation();session?.draftHistory.current?.changed();}}
  wrap={(children,previous,current)=><SessionContext.Provider value={previous&&current?{...previous,runtime:current.runtime,status:current.status,historySavePending:current.historySavePending,error:current.error}:current}>{children}</SessionContext.Provider>}>{children}</RetainedPageSlot>;
}
