import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Cloud,Fingerprint,UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {createOfficialAccountClient} from './official-account-client.mjs';
import {loadWebConfiguration} from './runtime.mjs';
import './official-account.css';
import {rememberOfficialAccountReturn} from './official-account-return.mjs';

type Client=ReturnType<typeof createOfficialAccountClient>;
export type OfficialSession={state:'signed-in';account:{displayName:string|null;email:string|null;emailVerified:boolean};linkedIds:{subjectId:string;linkedAt:string}[];nextAfter:string|null;expiresAt:number;csrfToken:string;galaxyAuthorization:false};
type Model={phase:'loading'|'signed-in'|'signed-out'|'unavailable'|'offline';session:OfficialSession|null;client:Client|null;busy:boolean;error:string;refresh:()=>Promise<void>;more:()=>Promise<void>;logout:()=>Promise<void>};
const isOnline=()=>navigator.onLine!==false;

export function useOfficialAccountSession(endpoint?:string):Model{
 const [phase,setPhase]=useState<Model['phase']>('loading'),[session,setSession]=useState<OfficialSession|null>(null),[client,setClient]=useState<Client|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const lifecycle=useRef({generation:0,request:0,active:false,client:null as Client|null,session:null as OfficialSession|null,busy:false});
 const read=useCallback(async(after?:string)=>{
  const current=lifecycle.current;if(!current.active||!current.client||current.busy)return;
  if(!isOnline()){current.request++;current.session=null;setSession(null);setPhase('offline');return;}
  const generation=current.generation,ticket=++current.request,original=current.session;current.busy=true;setBusy(true);setError('');
  const valid=()=>current.active&&current.generation===generation&&current.request===ticket;
  try{
   const value=await current.client.session(after?{after}:{});if(!valid())return;
   if(value.state==='signed-out'){current.session=null;setSession(null);setPhase('signed-out');return;}
   const next=value as OfficialSession;
   if(after){
    if(!original||next.csrfToken!==original.csrfToken){current.session=null;setSession(null);setPhase('unavailable');setError('账户会话已经变化，请重新读取当前账户。');return;}
    next.linkedIds=[...new Map([...original.linkedIds,...next.linkedIds].map(item=>[item.subjectId,item])).values()];
   }
   current.session=next;setSession(next);setPhase('signed-in');
  }catch{
   if(valid()){current.session=null;setSession(null);setPhase(isOnline()?'unavailable':'offline');setError('暂时无法核对官方账户，请重新读取。');}
  }finally{if(current.active&&current.generation===generation){current.busy=false;setBusy(false);}}
 },[]);
 const refresh=useCallback(()=>read(),[read]);
 useEffect(()=>{
  const current=lifecycle.current,generation=++current.generation;current.active=true;current.request++;current.busy=false;current.session=null;current.client=null;
  queueMicrotask(()=>{if(!current.active||generation!==current.generation)return;setClient(null);setSession(null);setBusy(false);setError('');setPhase(isOnline()?'loading':'offline');});
  void (async()=>{await Promise.resolve();try{const deployedEndpoint=endpoint??(await loadWebConfiguration()).endpoint;if(!current.active||generation!==current.generation)return;
   const next=createOfficialAccountClient({endpoint:deployedEndpoint});current.client=next;setClient(next);await read();
  }catch{if(current.active&&generation===current.generation){setPhase(isOnline()?'unavailable':'offline');setError('账户服务配置暂不可用。');}}})();
  const refreshVisible=()=>{if(document.visibilityState==='visible')void read();};
  const offline=()=>{current.request++;current.session=null;setSession(null);setPhase('offline');setError('');};
  window.addEventListener('focus',refreshVisible);window.addEventListener('online',refreshVisible);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',refreshVisible);
  const timer=window.setInterval(refreshVisible,30000);
  return()=>{current.active=false;current.generation++;current.request++;current.session=null;window.clearInterval(timer);window.removeEventListener('focus',refreshVisible);window.removeEventListener('online',refreshVisible);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',refreshVisible);};
 },[endpoint,read]);
 useEffect(()=>{if(!session)return;const delay=session.expiresAt*1000-Date.now();const timer=window.setTimeout(()=>{const current=lifecycle.current;if(current.session!==session)return;current.session=null;current.request++;setSession(null);setPhase('signed-out');void read();},Math.max(0,delay));return()=>window.clearTimeout(timer);},[session,read]);
 const logout=useCallback(async()=>{const current=lifecycle.current,selected=current.session;if(!current.active||!current.client||!selected||current.busy)return;
  const generation=current.generation,ticket=++current.request;current.busy=true;current.session=null;setSession(null);setPhase('loading');setBusy(true);setError('');
  try{await current.client.logout(selected);if(!current.active||current.generation!==generation||current.request!==ticket)return;current.session=null;setSession(null);setPhase('signed-out');}
  catch{if(current.active&&current.generation===generation&&current.request===ticket){setPhase('unavailable');setError('暂时没有确认退出，请重新读取账户。');}}
  finally{if(current.active&&current.generation===generation){current.busy=false;setBusy(false);}}
 },[]);
 const more=useCallback(()=>read(lifecycle.current.session?.nextAfter??undefined),[read]);
 return{phase,session,client,busy,error,refresh,more,logout};
}

export function OfficialAccountStatus({model,navigate,returnTo='/app/account',resumeTo,showIds=true}:{model:Model;navigate:(path:string)=>void;returnTo?:string;resumeTo?:string;showIds?:boolean}){
 const {phase,session,client,busy,error}=model;
 const loginFailed=new URLSearchParams(location.search).get('accountLogin')==='failed';
 const preserveReturn=(event:React.MouseEvent<HTMLAnchorElement>,mode:'login'|'register')=>{if(client)event.currentTarget.href=client.loginUrl(mode,rememberOfficialAccountReturn(returnTo,resumeTo));};
 return <section className="official-account-panel" aria-label="银河官方账户" aria-busy={busy||phase==='loading'}>
  <header className="official-account-heading"><span className="official-account-symbol"><Cloud size={22}/></span><div><span className="account-section-label">银河官方线上基础服务</span><h2>{phase==='signed-in'?'当前银河账户':'登录银河账户'}</h2></div>{phase==='signed-in'&&<Button variant="ghost" disabled={busy} onClick={()=>void model.logout()}>退出官网账户</Button>}</header>
  {loginFailed&&<p className="official-account-message" role="alert">这次账户登录未完成或已过期，原页面与草稿保留。{client&&phase!=='signed-out'&&<a href={client.loginUrl('login',returnTo)} onClick={event=>preserveReturn(event,'login')}>重新登录</a>}</p>}
  {phase==='loading'?<output className="official-account-message">正在核对账户登录状态…</output>:phase==='offline'?<div className="official-account-message"><p>暂时离线，联网后重新核对账户与已关联 ID。</p></div>:phase==='unavailable'?<div className="official-account-message"><p>{error||'账户状态暂不可核对。'}</p><Button variant="outline" disabled={busy} onClick={()=>void model.refresh()}>重新读取账户</Button></div>:phase==='signed-out'?<div className="official-account-entry"><p>登录后查看已关联的银河 ID。账户登录不会创建 ID，也不授予 ID 的控制权。</p><div className="button-row">{client&&<><a className="primary-action" href={client.loginUrl('login',returnTo)} onClick={event=>preserveReturn(event,'login')}>{loginFailed?'重新登录银河账户':'登录银河账户'}</a><a href={client.loginUrl('register',returnTo)} onClick={event=>preserveReturn(event,'register')}>注册银河账户</a></>}</div></div>:session&&<>
   <div className="official-account-person"><UserRound size={21}/><div><strong>{session.account.displayName||session.account.email||'已登录银河账户'}</strong>{session.account.email&&session.account.displayName&&<p>{session.account.email}</p>}</div></div>
   {error&&<p className="message error" role="alert">{error}</p>}
   {showIds&&<OfficialAccountIds model={model}/>}
   <button type="button" className="official-account-access-link" onClick={()=>navigate('/app/account?section=access')}>与本机银河插件接洽</button>
  </>}
 </section>;
}

export function OfficialAccountIds({model}:{model:Model}){
 const {phase,session,busy}=model;if(phase!=='signed-in'||!session)return null;
 return <section className="official-account-identities"><header><h3>这个账户已关联的 ID</h3><button type="button" disabled={busy} onClick={()=>void model.refresh()}>重新读取</button></header>
  {session.linkedIds.length?<ul>{session.linkedIds.map(item=><li key={item.subjectId}><Fingerprint size={19}/><div><code>{item.subjectId}</code><span>关联于 {new Date(item.linkedAt).toLocaleDateString('zh-CN')}</span></div></li>)}</ul>:<p className="official-account-empty">还没有关联银河 ID。请在当前设备的银河插件中选择或创建 ID，再完成关联。</p>}
  {session.nextAfter&&<Button variant="ghost" disabled={busy} onClick={()=>void model.more()}>查看更多 ID</Button>}
  <p className="official-account-boundary">这里只列出关联关系。使用某个 ID，仍需当前设备的本机银河插件授权。</p>
 </section>;
}

export function OfficialAccountPanel({endpoint,...props}:{endpoint?:string;navigate:(path:string)=>void;returnTo?:string;showIds?:boolean}){
 return <OfficialAccountStatus model={useOfficialAccountSession(endpoint)} {...props}/>;
}
