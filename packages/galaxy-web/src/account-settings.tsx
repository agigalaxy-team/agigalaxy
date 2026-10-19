import React,{useEffect,useEffectEvent,useRef,useState} from 'react';
import {Cloud,Fingerprint,ShieldCheck} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {ReadingDetails,ReadingSummary} from './reading-details';
import {IdentityRelationshipDiagram} from './account-access';
import {LocalGalaxyEntry} from './local-galaxy-entry';
import {OfficialAccountStatus,useOfficialAccountSession,OfficialAccountIds} from './official-account-panel';
import type {AccountRuntime} from './account-workspace-types';

type Props={runtime:AccountRuntime|null;connected:boolean;hasIdentity?:boolean;navigate?:(path:string)=>void;returnTo?:string};
type Link={id:string;providerId:string;state:string;revokedAt?:string|null};
type Original={id:string;state?:string;issuer?:string|null};
type Lease={assertCurrent:()=>void};
const stateNames:Record<string,string>={linked:'已关联',revoked:'已解除','binding-inactive':'原设备连接已失效','provider-unavailable':'账户服务暂不可核对',
 'awaiting-login':'原登录尚未完成','awaiting-local-signature':'等待本机插件确认',pending:'原登录尚未完成',exchanging:'正在核对原登录',expired:'已到期',canceled:'已取消',cancelled:'已取消',failed:'原登录未完成',unavailable:'结果暂不可核对'};

/** Old browser journals remain queryable, but cannot start or sign an account
 * association. The installed Native client owns reviewed link/unlink intents. */
function PreviousAccountRecords({runtime,connected}:{runtime:AccountRuntime;connected:boolean}){
 const [links,setLinks]=useState<Link[]>([]),[originals,setOriginals]=useState<Original[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const state=useRef({active:false,generation:0,request:0,lease:null as Lease|null});
 async function read(){
  const current=state.current;if(!current.active||!connected||navigator.onLine===false)return;
  const generation=current.generation,ticket=++current.request;setBusy(true);setError('');
  const valid=()=>{if(!current.active||current.generation!==generation||current.request!==ticket)return false;try{current.lease?.assertCurrent();return !!current.lease;}catch{return false;}};
  try{
   current.lease=runtime.accounts.captureLease();
   const values=await Promise.all([runtime.accounts.query({}),runtime.accounts.originals(),runtime.accounts.pending()]);
   if(!valid())return;
   setLinks(values[0].items as Link[]);const pending=values[2] as Original|null;
   setOriginals([...new Map([...(values[1] as Original[]),...(pending?[pending]:[])].map(item=>[item.id,item])).values()]);
  }catch{if(current.active&&current.generation===generation){setLinks([]);setOriginals([]);setError('原网页记录暂时无法核对，已有材料仍保留。');}}
  finally{if(current.active&&current.generation===generation)setBusy(false);}
 }
 const readCurrent=useEffectEvent(()=>read());
 useEffect(()=>{
  const current=state.current;current.active=true;current.generation++;queueMicrotask(()=>void readCurrent());
  const offline=()=>{current.request++;setLinks([]);setOriginals([]);setError('暂时离线，联网后可重新核对原记录。');},online=()=>void readCurrent();
  window.addEventListener('offline',offline);window.addEventListener('online',online);
  return()=>{current.active=false;current.generation++;current.request++;current.lease=null;window.removeEventListener('offline',offline);window.removeEventListener('online',online);};
 },[runtime,connected]);
 async function query(id:string){const current=state.current,generation=current.generation,ticket=++current.request;setBusy(true);setNotice('');setError('');
  try{current.lease?.assertCurrent();const value=await runtime.accounts.status(id);current.lease?.assertCurrent();if(current.active&&current.generation===generation&&current.request===ticket)setNotice(stateNames[value.state]??'已读到原记录，当前状态需要继续核对。');}
  catch{if(current.active&&current.generation===generation)setError('暂时无法核对这条原记录，不会创建替代关联。');}
  finally{if(current.active&&current.generation===generation)setBusy(false);}
 }
 if(!connected)return <p>连接原网页身份后，可核对这个设备保存的旧关联记录。新关联仍由本机插件完成。</p>;
 return <section className="previous-account-records" aria-busy={busy}><p>这些是此网页保存的原操作。它们不会证明本机插件当前在线，也不会授予其他 ID 的控制权。</p>
  {error&&<p className="message error" role="alert">{error}</p>}{notice&&<output>{notice}</output>}
  {!busy&&!error&&!links.length&&!originals.length&&<p>没有读到此网页的旧关联记录。</p>}
  {!!links.length&&<><h3>原身份的关联</h3><ul>{links.map(item=><li key={item.id}><strong>{item.providerId}</strong><span>{item.revokedAt?'已解除':stateNames[item.state]??'当前状态暂不可核对'}</span></li>)}</ul></>}
  {!!originals.length&&<><h3>原登录与关联流程</h3><ul>{originals.map(item=><li key={item.id}><span>{stateNames[item.state??'']??'原关联记录'}</span><Button variant="ghost" disabled={busy} onClick={()=>void query(item.id)}>核对原结果</Button></li>)}</ul></>}
  <Button variant="outline" disabled={busy||navigator.onLine===false} onClick={()=>void read()}>重新读取原记录</Button>
 </section>;
}

export function AccountSettings({runtime,connected,hasIdentity=false,navigate=(path)=>{location.href=path;},returnTo}:Props){
 const official=useOfficialAccountSession(runtime?.api.endpoint),[showPrevious,setShowPrevious]=useState(false);
 const [online,setOnline]=useState(()=>navigator.onLine!==false);
 useEffect(()=>{const changed=()=>setOnline(navigator.onLine!==false);window.addEventListener('online',changed);window.addEventListener('offline',changed);return()=>{window.removeEventListener('online',changed);window.removeEventListener('offline',changed);};},[]);
 return <section className="account-settings account-link-page"><header className="account-page-heading"><h1>银河账户关联</h1></header>
 <OfficialAccountStatus model={official} navigate={navigate} returnTo="/app/settings/identity?section=account" resumeTo={returnTo} showIds={false} compact/>
 <div className="account-association-workspace"><section className="account-association-current" aria-labelledby="account-local-association"><h2 id="account-local-association">关联本机 ID</h2><p className="account-local-explanation">让本机银河关联所用账户，继续同步资料或在本机操作官网。</p><LocalGalaxyEntry purpose="association" introduction={false} hasIdentity={hasIdentity} returnTo={returnTo}/>
 {official.phase==='signed-in'&&<OfficialAccountIds model={official}/>}
 {runtime&&connected&&<ReadingDetails className="verification-source" onOpenChange={setShowPrevious}><ReadingSummary>之前的关联记录</ReadingSummary>{showPrevious&&<PreviousAccountRecords runtime={runtime} connected={connected}/>}</ReadingDetails>}
 </section><aside className="account-association-explainer"><h2>ID 与账户</h2><p>本机 ID 积累经历，在线账户接收你选择同步的资料。多个 ID 与账户可以分别关联。</p><IdentityRelationshipDiagram compact/></aside></div>
 </section>;
}
