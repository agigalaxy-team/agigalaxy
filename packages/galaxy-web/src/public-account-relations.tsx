import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createOfficialAccountClient} from './official-account-client.mjs';
import {loadWebConfiguration} from './runtime.mjs';
import {profilePath} from './profile-navigation.mjs';
import './online-account-settings.css';

type Client=ReturnType<typeof createOfficialAccountClient>;
type Page<T>={items:T[];nextAfter:string|null;checkedAt:number};
type Props={endpoint?:string;navigate:(path:string)=>void};
type LinkedId={subjectId:string;linkedAt:string};
type LinkedAccount={accountId:string;uid?:string|null;displayName:string|null;subjectType:'person'|'organization'|'agent'|null;typeSource:'account-owner-statement';linkedAt:string};
type Credential={id:string;title:string;issuer:{name:string;uri:string};subject:{id:string|null;binding:string};scope:string[];issuedAt:string|null;validFrom:string|null;expiresAt:string|null;signature:{state:string};validity:{state:string};revocation:{state:string;source:string|null;checkedAt:string|null;validUntil:string|null};source?:{credentialId:string|null;format:string};galaxyIssued:false};
const at=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未提供';
const typeLabel=(value:LinkedAccount['subjectType'])=>({person:'个人账户',organization:'组织账户',agent:'Agent 账户'})[value??'person'];
function Follow({path,navigate,children}:{path:string;children:React.ReactNode;navigate:Props['navigate']}){return <a href={path} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{children}</a>;}

// Every refresh rereads the visible pages from the current first page. Removed
// relationships and stopped disclosure cannot survive in appended page state.
function usePublicPage<T>(endpoint:string|undefined,identity:string,reader:(client:Client,after?:string)=>Promise<unknown>){
 const operation=useRef(reader);operation.current=reader;
 const pages=useRef(1),reload=useRef<((more?:boolean)=>Promise<void>)|null>(null);
 const [value,setValue]=useState<Page<T>|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true,working=false,serial=0;pages.current=1;setValue(null);setError('');setLoading(true);
  const read=async(more=false)=>{if(!active||working||document.hidden||navigator.onLine===false)return;working=true;const ticket=++serial;setBusy(true);const count=pages.current+(more?1:0),current=()=>active&&ticket===serial&&navigator.onLine!==false;
   try{const authority=endpoint??(await loadWebConfiguration()).endpoint,client=createOfficialAccountClient({endpoint:authority});let cursor:string|undefined;let page:Page<T>|null=null;const items:T[]=[];
    for(let index=0;index<count;index++){const result=await operation.current(client,cursor) as Page<T>;if(!current())return;
     if(!Array.isArray(result.items)||result.items.length>50||result.nextAfter!==null&&typeof result.nextAfter!=='string')throw Error('invalid_public_page');
     page=result;items.push(...result.items);if(!result.nextAfter)break;if(result.nextAfter===cursor)throw Error('invalid_public_cursor');cursor=result.nextAfter;}
    if(current()&&page){pages.current=count;setValue({...page,items});setError('');}
   }catch{if(current()){setValue(null);setError('当前没有可读取的公开资料，或公开范围已经变化。');}}
   finally{if(active&&ticket===serial){working=false;setLoading(false);setBusy(false);}}
  };
  reload.current=read;const refresh=()=>{if(!document.hidden)void read();},offline=()=>{if(active){serial++;working=false;setBusy(false);setLoading(false);setValue(null);setError('暂时离线，联网后重新读取当前公开的资料。');}};
  if(navigator.onLine===false)offline();else void read();const timer=window.setInterval(refresh,30000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);window.addEventListener('online',refresh);window.addEventListener('offline',offline);
  return()=>{active=false;reload.current=null;window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);window.removeEventListener('offline',offline);};
 },[endpoint,identity]);
 return{value,error,loading,busy,refresh:()=>void reload.current?.(),more:()=>void reload.current?.(true)};
}
function ReadingState({state}:{state:ReturnType<typeof usePublicPage>}){return <>{state.loading&&<output>正在读取…</output>}{state.error&&<p role="status">{state.error}<Button type="button" variant="ghost" disabled={state.busy} onClick={state.refresh}>重新读取</Button></p>}</>;}
function More({state,label}:{state:ReturnType<typeof usePublicPage>;label:string}){return state.value?.nextAfter?<Button type="button" variant="outline" disabled={state.busy} onClick={state.more}>{state.busy?'正在读取…':label}</Button>:null;}

export function PublicLinkedIds({accountId,endpoint,navigate}:Props&{accountId:string}){
 const state=usePublicPage<LinkedId>(endpoint,accountId,(client,after)=>client.publicLinkedIds(accountId,{after}));
 return <section className="public-account-relations" aria-busy={state.busy}><h2>关联的 ID</h2><ReadingState state={state}/>{state.value&&<>{state.value.items.length?<ul>{state.value.items.map(item=>{const path=profilePath(item.subjectId);return path?<li key={item.subjectId}><Follow path={path} navigate={navigate}>查看 ID 的公开资料</Follow><code>{item.subjectId}</code><small>关联于 {at(item.linkedAt)}</small></li>:null;})}</ul>:<p>当前没有可展示的关联 ID。</p>}<More state={state} label="更多关联 ID"/></>}</section>;
}
export function PublicIdentityAccounts({subjectId,endpoint,navigate,showProfileLink=false}:Props&{subjectId:string;showProfileLink?:boolean}){
 const state=usePublicPage<LinkedAccount>(endpoint,subjectId,(client,after)=>client.publicAccountsForId(subjectId,{after}));
 return <section className="person-section public-account-relations" aria-busy={state.busy}><h2>关联的开放账户</h2>{showProfileLink&&<Follow path={profilePath(subjectId)!} navigate={navigate}>查看此 ID 的公开资料</Follow>}<ReadingState state={state}/>{state.value&&<>{state.value.items.length?<ul>{state.value.items.map(item=><li key={item.accountId}><Follow path={'/app/accounts/'+item.accountId} navigate={navigate}>{item.displayName||'银河账户'}</Follow><small>{item.subjectType?typeLabel(item.subjectType):'主体类型尚未记录'} · 账户持有者声明</small><small>关联于 {at(item.linkedAt)}</small></li>)}</ul>:<p>当前没有允许展示此关联的账户。</p>}<More state={state} label="更多开放账户"/></>}</section>;
}
export function PublicAccountMatch({accountId,uid,endpoint,navigate}:Props&({accountId:string;uid?:never}|{uid:string;accountId?:never})){
 const state=usePublicPage<Omit<LinkedAccount,'linkedAt'>>(endpoint,uid??accountId!,async client=>({items:[await(uid?client.publicAccountByUid(uid):client.publicAccount(accountId!))],nextAfter:null,checkedAt:Math.floor(Date.now()/1000)}));
 return <section className="public-account-relations" aria-busy={state.busy}><h2>公开账户</h2><ReadingState state={state}/>{state.value?.items.map(item=><p key={item.accountId}><Follow path={'/app/accounts/'+item.accountId} navigate={navigate}>{item.displayName||'银河账户'}</Follow>{item.uid&&<small>UID <code>{item.uid}</code></small>}<small>{item.subjectType?typeLabel(item.subjectType):'主体类型尚未记录'} · 账户持有者声明</small></p>)}</section>;
}
function CredentialFacts({value,now}:{value:Credential;now:number}){
 const validity=value.expiresAt&&Date.parse(value.expiresAt)<=now?'已过期':value.validFrom&&Date.parse(value.validFrom)>now?'尚未到生效时间':({valid:'在材料所述有效期内',expired:'已过期','not-yet-valid':'尚未到生效时间'} as Record<string,string>)[value.validity.state]??'有效期尚无法确认';
 const revocation=value.revocation.validUntil&&Date.parse(value.revocation.validUntil)<=now?'当前无法确认撤销状态':({'not-revoked':'来源本次未标记撤销',revoked:'发行者来源已标记撤销',unknown:'当前无法确认撤销状态'} as Record<string,string>)[value.revocation.state]??'当前无法确认撤销状态';
 return <article className="public-account-credential"><h3>{value.title}</h3><dl><div><dt>出具者</dt><dd>{value.issuer.name}<small>{value.issuer.uri}</small></dd></div><div><dt>签名</dt><dd>{({valid:'签名与配置的发行者公钥匹配',invalid:'签名未通过核对','issuer-unconfigured':'当前服务未配置此发行者'} as Record<string,string>)[value.signature.state]??'尚无法核对'}</dd></div><div><dt>对象</dt><dd>{value.subject.id??'未提供对象标识'}</dd></div><div><dt>有效期</dt><dd>{validity}<small>生效 {at(value.validFrom)} · 到期 {at(value.expiresAt)}</small></dd></div><div><dt>撤销状态</dt><dd>{revocation}{value.revocation.source&&<small>{value.revocation.source}</small>}<small>核对时间 {at(value.revocation.checkedAt)}</small></dd></div><div><dt>签发时间</dt><dd>{at(value.issuedAt)}</dd></div></dl>{value.scope.length>0&&<div><h4>适用范围</h4><ul>{value.scope.map((item,index)=><li key={index}>{item}</li>)}</ul></div>}{value.source&&<p>{value.source.format}{value.source.credentialId?' · '+value.source.credentialId:''}</p>}</article>;
}
export function PublicExternalCredentials({accountId,endpoint}:Omit<Props,'navigate'>&{accountId:string}){
 const state=usePublicPage<Credential>(endpoint,accountId,(client,after)=>client.publicCredentials(accountId,{after})),[now,setNow]=useState(Date.now);
 const deadline=Math.min(...(state.value?.items??[]).flatMap(value=>[value.validFrom,value.expiresAt,value.revocation.validUntil].flatMap(at=>at&&Date.parse(at)>now?[Date.parse(at)]:[])));
 useEffect(()=>{if(!Number.isFinite(deadline))return;const timer=window.setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(0,deadline-Date.now()+1)));return()=>window.clearTimeout(timer);},[deadline]);
 return <section className="public-account-relations" aria-busy={state.busy}><h2>外部凭据与来源</h2><ReadingState state={state}/>{state.value&&<>{state.value.items.length?state.value.items.map(value=><CredentialFacts key={value.id} value={value} now={now}/>):<p>当前没有可展示的本人外部凭据。</p>}<More state={state} label="更多外部凭据"/></>}</section>;
}
