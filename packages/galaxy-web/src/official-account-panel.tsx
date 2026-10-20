import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Cloud,Fingerprint,UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createOfficialAccountClient} from './official-account-client.mjs';
import {loadWebConfiguration} from './runtime.mjs';
import './official-account.css';
import {rememberOfficialAccountReturn} from './official-account-return.mjs';
import {useReadTasks} from './use-read-task';
import {LoadingFeedback,ReadFailure} from './interaction-feedback';

type Client=ReturnType<typeof createOfficialAccountClient>;
export type OfficialSession={state:'signed-in';account:{id:string|null;displayName:string|null;email:string|null;emailVerified:boolean};linkedIds:{subjectId:string;linkedAt:string}[];nextAfter:string|null;expiresAt:number;csrfToken:string;galaxyAuthorization:false};
type Model={phase:'loading'|'signed-in'|'signed-out'|'unavailable'|'offline';session:OfficialSession|null;client:Client|null;busy:boolean;error:string;refresh:()=>Promise<void>;more:()=>Promise<void>;logout:()=>Promise<void>};
export type OfficialAccountModel=Model;
const isOnline=()=>navigator.onLine!==false;

export function OfficialAccountLoginNotice({search=location.search}:{search?:string}){
 const result=new URLSearchParams(search).get('accountLogin');
 const message=result==='cancelled'?'已取消登录，草稿保留。':result==='stale'?'这次登录已过期，请继续当前页面。草稿保留。':result==='failed'?'登录未完成，请重试。草稿保留。':null;
 return message?<p className="official-account-message" role={result==='failed'?'alert':'status'}>{message}</p>:null;
}

export function useOfficialAccountSession(endpoint?:string):Model{
 const tasks=useReadTasks(endpoint??'configured-official-account');
 const [phase,setPhase]=useState<Model['phase']>('loading'),[session,setSession]=useState<OfficialSession|null>(null),[client,setClient]=useState<Client|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const lifecycle=useRef({generation:0,request:0,active:false,requestedEndpoint:endpoint,client:null as Client|null,endpoint:null as string|null,session:null as OfficialSession|null,busy:false});
 const read=useCallback(async(after?:string)=>{
  const current=lifecycle.current;if(!current.active||!current.client||current.busy)return;
  if(!isOnline()){tasks.cancel('session');current.request++;current.busy=false;current.session=null;setBusy(false);setSession(null);setPhase('offline');return;}
  const generation=current.generation,ticket=++current.request,original=current.session;current.busy=true;setBusy(true);setError('');
  const valid=()=>current.active&&current.generation===generation&&current.request===ticket;
  const selectedClient=current.client;
  await tasks.run({lane:'session',key:after??'head'},({signal})=>selectedClient.session({...(after?{after}:{}),signal}),{onSuccess:value=>{
   if(!valid())return;
   if(value.state==='signed-out'){current.session=null;setSession(null);setPhase('signed-out');return;}
   const next=value as OfficialSession;
   if(after){
    if(!original||next.csrfToken!==original.csrfToken){current.session=null;setSession(null);setPhase('unavailable');setError('账户会话已经变化，请重新读取当前账户。');return;}
    next.linkedIds=[...new Map([...original.linkedIds,...next.linkedIds].map(item=>[item.subjectId,item])).values()];
   }
   current.session=next;setSession(next);setPhase('signed-in');
  },onError:()=>{
   if(valid()){current.session=null;setSession(null);setPhase(isOnline()?'unavailable':'offline');setError('暂时无法核对官方账户，请重新读取。');}
  },onSettled:()=>{if(current.active&&current.generation===generation){current.busy=false;setBusy(false);}}});
 },[tasks]);
 const refresh=useCallback(()=>read(),[read]);
 useEffect(()=>{
   const current=lifecycle.current,generation=++current.generation;current.active=true;current.requestedEndpoint=endpoint;current.request++;current.busy=false;current.session=null;current.client=null;current.endpoint=null;
  queueMicrotask(()=>{if(!current.active||generation!==current.generation)return;setClient(null);setSession(null);setBusy(false);setError('');setPhase(isOnline()?'loading':'offline');});
  void (async()=>{await Promise.resolve();try{const deployedEndpoint=endpoint??(await loadWebConfiguration()).endpoint;if(!current.active||generation!==current.generation)return;
   const next=createOfficialAccountClient({endpoint:deployedEndpoint});current.client=next;current.endpoint=deployedEndpoint;setClient(next);await read();
  }catch{if(current.active&&generation===current.generation){setPhase(isOnline()?'unavailable':'offline');setError('账户服务配置暂不可用。');}}})();
  const refreshVisible=()=>{if(document.visibilityState==='visible')void read();};
  const offline=()=>{tasks.cancel('session');current.request++;current.busy=false;current.session=null;setBusy(false);setSession(null);setPhase('offline');setError('');};
  const accountReturn=(event:MessageEvent)=>{if(current.endpoint&&event.origin===current.endpoint&&event.data&&typeof event.data==='object'&&!Array.isArray(event.data)&&event.data.type==='galaxy:identity-account-return')void read();};
  window.addEventListener('focus',refreshVisible);window.addEventListener('online',refreshVisible);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',refreshVisible);
  window.addEventListener('message',accountReturn);
  const timer=window.setInterval(refreshVisible,30000);
  return()=>{tasks.cancel();current.active=false;current.generation++;current.request++;current.session=null;current.endpoint=null;window.clearInterval(timer);window.removeEventListener('focus',refreshVisible);window.removeEventListener('online',refreshVisible);window.removeEventListener('offline',offline);window.removeEventListener('message',accountReturn);document.removeEventListener('visibilitychange',refreshVisible);};
 },[endpoint,read,tasks]);
 useEffect(()=>{if(!session)return;const delay=session.expiresAt*1000-Date.now();const timer=window.setTimeout(()=>{const current=lifecycle.current;if(current.session!==session)return;tasks.cancel('session');current.session=null;current.request++;current.busy=false;setBusy(false);setSession(null);setPhase('signed-out');void read();},Math.max(0,delay));return()=>window.clearTimeout(timer);},[session,read,tasks]);
 const logout=useCallback(async()=>{const current=lifecycle.current,selected=current.session;if(!current.active||!current.client||!selected||current.busy)return;
  const generation=current.generation,ticket=++current.request;current.busy=true;current.session=null;setSession(null);setPhase('loading');setBusy(true);setError('');
  try{await current.client.logout(selected);if(!current.active||current.generation!==generation||current.request!==ticket)return;current.session=null;setSession(null);setPhase('signed-out');}
  catch{if(current.active&&current.generation===generation&&current.request===ticket){setPhase('unavailable');setError('暂时没有确认退出，请重新读取账户。');}}
  finally{if(current.active&&current.generation===generation){current.busy=false;setBusy(false);}}
 },[]);
 const more=useCallback(()=>read(lifecycle.current.session?.nextAfter??undefined),[read]);
  const sameEndpoint=lifecycle.current.requestedEndpoint===endpoint;
  return{phase:sameEndpoint?phase:isOnline()?'loading':'offline',session:sameEndpoint?session:null,client:sameEndpoint?client:null,busy:sameEndpoint&&busy,error:sameEndpoint?error:'',refresh,more,logout};
}

export function OfficialAccountStatus({model,navigate,returnTo='/app/account',resumeTo,showIds=false,compact=false}:{model:Model;navigate:(path:string)=>void;returnTo?:string;resumeTo?:string;showIds?:boolean;compact?:boolean}){
 const {phase,session,client,busy,error}=model;
 const loginFailed=['failed','cancelled','stale'].includes(new URLSearchParams(location.search).get('accountLogin')??'');
 const preserveReturn=(event:React.MouseEvent<HTMLAnchorElement>,mode:'login'|'register')=>{if(client)event.currentTarget.href=client.loginUrl(mode,rememberOfficialAccountReturn(returnTo,resumeTo));};
 return <section className={'official-account-panel'+(compact?' official-account-compact':'')} aria-label="银河账户" aria-busy={busy||phase==='loading'}>
  {!compact&&<header className="official-account-heading"><span className="official-account-symbol"><Cloud size={22}/></span><div><h2>{phase==='signed-in'?'当前账户':'登录银河账户'}</h2></div>{phase==='signed-in'&&<Button variant="ghost" disabled={busy} onClick={()=>void model.logout()}>退出</Button>}</header>}
  <OfficialAccountLoginNotice/>
  <LoadingFeedback active={busy&&phase!=='loading'} label={phase==='signed-in'?'正在刷新账户…':'正在连接账户…'} scopeKey={returnTo}/>
   {phase==='loading'?<LoadingFeedback active label="正在加载账户…" scopeKey={returnTo}/>:phase==='offline'?<div className="official-account-message"><p>暂时离线，联网后自动恢复。</p></div>:phase==='unavailable'?<ReadFailure message={error||'账户暂时无法加载。'} onRetry={()=>{void model.refresh();}} retrying={busy}/>:phase==='signed-out'?<div className="official-account-entry"><p>登录后继续自己的帖子、收藏和资料。</p><div className="button-row">{client&&<><a className="primary-action" href={client.loginUrl('login',returnTo)} onClick={event=>preserveReturn(event,'login')}>{loginFailed?'重新登录':'登录银河账户'}</a><a href={client.loginUrl('register',returnTo)} onClick={event=>preserveReturn(event,'register')}>注册账户</a></>}</div></div>:session&&<>
   <div className="official-account-person"><UserRound size={21}/><div><strong>{session.account.displayName||session.account.email||'已登录银河账户'}</strong>{session.account.email&&session.account.displayName&&<p>{session.account.email}</p>}</div></div>
   {error&&<p className="message error" role="alert">{error}</p>}
   {showIds&&<OfficialAccountIds model={model}/>}
   {compact&&<div className="official-account-session-actions">{!returnTo.startsWith('/app/account?section=settings')&&<button type="button" onClick={()=>navigate('/app/account?section=settings')}>编辑资料</button>}<button type="button" disabled={busy} onClick={()=>void model.logout()}>退出</button></div>}
  </>}
 </section>;
}

export function OfficialAccountIds({model}:{model:Model}){
 const {phase,session,busy}=model;if(phase!=='signed-in'||!session)return null;
 return <section className="official-account-identities"><header><h3>已关联的 ID</h3></header>
   {session.linkedIds.length?<ul>{session.linkedIds.map(item=><li key={item.subjectId}><Fingerprint size={19}/><div><code>{item.subjectId}</code><span>关联于 {new Date(item.linkedAt).toLocaleDateString('zh-CN')}</span></div></li>)}</ul>:<p className="official-account-empty">尚未关联 ID。</p>}
  {session.nextAfter&&<Button variant="ghost" disabled={busy} onClick={()=>void model.more()}>查看更多 ID</Button>}
 </section>;
}

export function OfficialAccountPanel({endpoint,...props}:{endpoint?:string;navigate:(path:string)=>void;returnTo?:string;showIds?:boolean;compact?:boolean}){
 return <OfficialAccountStatus model={useOfficialAccountSession(endpoint)} {...props}/>;
}
