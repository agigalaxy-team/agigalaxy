import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {createOfficialAccountClient,publicGrowth,publicContributions,publicLegacyHonors} from './official-account-client.mjs';
import {createCurrentOfficialAccount} from './official-account-reading.mjs';
import {loadWebConfiguration} from "../../runtime.mjs";
import {profilePath} from "../profiles/profile-navigation.mjs";
import {Award} from 'lucide-react';
import {forumTopics,forumUnclassifiedTopic} from '../../../../galaxy-contracts/src/community-forum-topics-v1.mjs';
import {useAccountQueryScope,useAccountSessionModel} from './account-session-scope';
import {useServiceQuery} from '../../shared/runtime/use-service-query';
import {definitiveReadFailure} from '../../shared/reading/read-failure';
import './online-account-settings.css';
import '../profiles/person-recognitions.css';

type Client=ReturnType<typeof createOfficialAccountClient>;
type Page<T>={items:T[];nextAfter:string|null;checkedAt:number;readExpiresAt?:number|null;knownDeadlines?:number[]};
type Props={endpoint?:string;navigate:(path:string)=>void};
type LinkedId={subjectId:string;linkedAt:string};
type LinkedAccount={accountId:string;uid?:string|null;displayName:string|null;subjectType:'person'|'organization'|'agent'|null;typeSource:'account-owner-statement'|'operator-recorded-statement';linkedAt:string};
type Credential={id:string;title:string;issuer:{name:string;uri:string};subject:{id:string|null;binding:string};scope:string[];issuedAt:string|null;validFrom:string|null;expiresAt:string|null;signature:{state:string};validity:{state:string};revocation:{state:string;source:string|null;checkedAt:string|null;validUntil:string|null};source?:{credentialId:string|null;format:string};galaxyIssued:false};
const at=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未提供';
const typeLabel=(value:LinkedAccount['subjectType'])=>({person:'个人账户',organization:'组织账户',agent:'Agent 账户'})[value??'person'];
function Follow({path,navigate,children}:{path:string;children:React.ReactNode;navigate:Props['navigate']}){return <a href={path} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(path);}}}>{children}</a>;}

// A source deadline is a known expiry, not a complete authorization lease.
function useKnownDeadline(key:string,deadlines:readonly number[],onDue:()=>void){
 const latest=useRef(onDue),seen=useRef<{key:string;deadlines:Set<number>}>({key,deadlines:new Set()}),[,setTick]=useState(0);latest.current=onDue;
 if(seen.current.key!==key)seen.current={key,deadlines:new Set()};
 const deadline=deadlines.filter(value=>!seen.current.deadlines.has(value)).reduce<number|null>((first,value)=>first===null||value<first?value:first,null);
 useEffect(()=>{if(deadline===null)return;let timer:ReturnType<typeof setTimeout>|undefined,active=true;
  const fire=()=>{if(!active)return;const remaining=deadline*1000-Date.now();if(remaining>0){timer=setTimeout(fire,Math.min(2147483647,remaining));return;}if(document.hidden){document.addEventListener('visibilitychange',visible);return;}for(const value of deadlines)if(value*1000<=Date.now())seen.current.deadlines.add(value);setTick(value=>value+1);latest.current();};
  function visible(){if(!document.hidden){document.removeEventListener('visibilitychange',visible);fire();}}
  fire();return()=>{active=false;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[key,deadline]);
}

// Every refresh rereads the visible pages from the current first page. Removed
// relationships and stopped disclosure cannot survive in appended page state.
function usePublicPage<T>(endpoint:string|undefined,identity:string,reader:(client:Client,after?:string)=>Promise<unknown>,module='account',objectId?:string,ownerOnly=false,maxItems=50){
 const operation=useRef(reader);operation.current=reader;
 const {scope}=useAccountQueryScope();
 const pages=useRef(1),reload=useRef<((more?:boolean)=>Promise<void>)|null>(null),previousIdentity=useRef(identity);
 const [value,setValue]=useState<Page<T>|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const reads=useServiceQuery(scope??{endpoint:endpoint??'',identity:ownerOnly?'unavailable':'anonymous',surface:'web'},module,()=>{void reload.current?.();},objectId);
 useKnownDeadline(identity,identity.includes(':growth:')?value?.knownDeadlines??[]:[],()=>void reload.current?.());
 useEffect(()=>{let active=true,working=false,queued=false,serial=0;pages.current=1;if(!ownerOnly||previousIdentity.current!==identity)setValue(null);previousIdentity.current=identity;setError('');setLoading(true);
  const read=async(more=false,fresh=true)=>{if(!active)return;if(working){if(!more)queued=true;return;}if(document.hidden||navigator.onLine===false||ownerOnly&&(!scope||scope.identity!==objectId))return;working=true;const ticket=++serial;setBusy(true);const count=pages.current+(more?1:0),current=()=>active&&ticket===serial&&navigator.onLine!==false;
   try{const authority=endpoint??(await loadWebConfiguration()).endpoint,client=createOfficialAccountClient({endpoint:authority});let cursor:string|undefined;let page:Page<T>|null=null;const items:T[]=[],deadlines:number[]=[];
    for(let index=0;index<count;index++){const requestedCursor=cursor,result=await reads.read([objectId??identity,identity,requestedCursor??'first'],()=>operation.current(client,requestedCursor),{fresh:objectId?fresh:true,publicRead:true}) as Page<T>;if(!current())return;
     if(!Array.isArray(result.items)||result.items.length>maxItems||result.nextAfter!==null&&typeof result.nextAfter!=='string')throw Error('invalid_public_page');
     page=result;items.push(...result.items);if(typeof result.readExpiresAt==='number')deadlines.push(result.readExpiresAt);if(!result.nextAfter)break;if(result.nextAfter===cursor)throw Error('invalid_public_cursor');cursor=result.nextAfter;}
    if(current()&&page){pages.current=count;const readExpiresAt=deadlines.length?Math.min(...deadlines):null;setValue({...page,items,...(identity.includes(':growth:')?{readExpiresAt,knownDeadlines:deadlines}:{})});setError(readExpiresAt!==null&&readExpiresAt*1000<=Date.now()?'当前资料暂时无法更新。':'');}
   }catch(reason){if(current()){if(!objectId||definitiveReadFailure(reason))setValue(null);setError('当前资料暂时无法读取。');}}
   finally{if(active&&ticket===serial){working=false;setLoading(false);setBusy(false);if(queued){queued=false;if(document.hidden)document.addEventListener('visibilitychange',initialVisible);else queueMicrotask(()=>void read());}}}
  };
  reload.current=read;const refresh=()=>{if(!document.hidden)void read();},offline=()=>{if(active){serial++;working=false;setBusy(false);setLoading(false);if(!objectId)setValue(null);setError('暂时离线，联网后重新读取当前公开的资料。');}};
  let timer:number|undefined;
  function initialVisible(){if(!document.hidden){document.removeEventListener('visibilitychange',initialVisible);void read(false,false);}}
  if(navigator.onLine===false)offline();else if(ownerOnly&&(!scope||scope.identity!==objectId)){setLoading(false);setError('账户暂时无法连接。');}else if(objectId&&document.hidden)document.addEventListener('visibilitychange',initialVisible);else void read(false,!objectId);
  if(!objectId){timer=window.setInterval(refresh,30000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);window.addEventListener('online',refresh);}window.addEventListener('offline',offline);
  return()=>{active=false;reload.current=null;if(timer)window.clearInterval(timer);document.removeEventListener('visibilitychange',initialVisible);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);window.removeEventListener('offline',offline);};
 },[endpoint,identity,reads]);
 return{value,error,loading,busy,refresh:()=>void reload.current?.(),more:()=>void reload.current?.(true)};
}
function ReadingState({state}:{state:ReturnType<typeof usePublicPage>}){return <>{state.loading&&<output>正在读取…</output>}{state.error&&<p ><output>{state.error}<Button type="button" variant="ghost" disabled={state.busy} onClick={state.refresh}>重新读取</Button></output></p>}</>;}
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


type PublicFollow={profile:{accountId:string;displayName:string|null;uid:string|null;subjectType:'person'|'organization'|'agent'|null};followedAt:string};
export function PublicSocialRelations({accountId,endpoint,navigate}:Props&{accountId:string}){
 const [direction,setDirection]=useState<'following'|'followers'>('following');
 const state=usePublicPage<PublicFollow>(endpoint,accountId+':'+direction,(client,after)=>client.publicFollows(accountId,direction,{after}),'public-follows',accountId);
 const count=(state.value as (Page<PublicFollow>&{count?:number})|null)?.count;
 return <section className="public-account-relations" aria-busy={state.busy}><h2>社区关系</h2><nav aria-label="公开关系"><Button type="button" variant="ghost" aria-pressed={direction==='following'} onClick={()=>setDirection('following')}>关注{direction==='following'&&count!==undefined?' '+count:''}</Button><Button type="button" variant="ghost" aria-pressed={direction==='followers'} onClick={()=>setDirection('followers')}>粉丝{direction==='followers'&&count!==undefined?' '+count:''}</Button></nav><ReadingState state={state}/>{state.value&&<>{state.value.items.length?<ul>{state.value.items.map(item=><li key={item.profile.accountId}><Follow path={'/app/accounts/'+item.profile.accountId} navigate={navigate}>{item.profile.displayName||item.profile.uid||'银河账户'}</Follow></li>)}</ul>:<p>暂无公开{direction==='following'?'关注':'粉丝'}。</p>}<More state={state} label="查看更多"/></>}</section>;
}

type Growth={accountId:string;readExpiresAt:number|null;experience:number;level:{level:number;label:string;minimum:number};nextLevel:{level:number;label:string;minimum:number}|null;domains:{domain:string;experience:number}[];honors:{id:string;name:string;description:string}[]};
type Contribution={sourceKind:string;sourceId:string;title:string;objectKind:string;objectId:string;experience:number};
type LegacyHonor={subjectId:string;card:{id:string;title:string}};
function LegacyHonors({accountId,endpoint,navigate,ownerOnly,owner}:{accountId:string;endpoint?:string;navigate:Props['navigate'];ownerOnly:boolean;owner:ReturnType<typeof createCurrentOfficialAccount>|null}){
 const state=usePublicPage<LegacyHonor>(endpoint,accountId+':legacy-honors:'+(ownerOnly?'own':'public'),async(client,after)=>ownerOnly?publicLegacyHonors(await owner!.call('/v2/community/growth/me/legacy-honors?'+new URLSearchParams({limit:'1',...(after?{after}:{})}),null,{method:'GET'}),accountId):client.communityLegacyHonors(accountId,{after}),'growth',accountId,ownerOnly,Infinity);
 return <section className="public-account-relations" aria-busy={state.busy}><h3>关联身份荣誉</h3><ReadingState state={state}/>{state.value&&<>{state.value.items.length?<div className="person-recognition-links">{state.value.items.map(item=>{const path=profilePath(item.subjectId);return path?<Follow key={item.subjectId+':'+item.card.id} path={path+'?'+new URLSearchParams({section:'recognition',honor:item.card.id})} navigate={navigate}><Award size={25}/><span>{item.card.title}</span></Follow>:null;})}</div>:!state.value.nextAfter&&<p>暂无可展示的身份荣誉。</p>}<More state={state} label="查看更多"/></>}</section>;
}
export function PublicCommunityGrowth({accountId,endpoint,navigate,ownerOnly=false}:Props&{accountId:string;ownerOnly?:boolean}){
 const [growth,setGrowth]=useState<Growth|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0),forceRead=useRef(false);
 useKnownDeadline(accountId+':'+(ownerOnly?'own':'public'),growth?.readExpiresAt==null?[]:[growth.readExpiresAt],()=>{forceRead.current=true;setAttempt(value=>value+1);});
 const model=useAccountSessionModel(),latest=useRef(model);latest.current=model;
 const csrf=model.session?.csrfToken,source=model.client,owner=useMemo(()=>ownerOnly&&source&&csrf?createCurrentOfficialAccount({client:source,accountId,csrfToken:csrf,getCurrent:()=>latest.current}):null,[ownerOnly,source,csrf,accountId]);
 const {scope}=useAccountQueryScope(),growthReads=useServiceQuery(scope??{endpoint:endpoint??'',identity:ownerOnly?'unavailable':'anonymous',surface:'web'},'growth',()=>setAttempt(value=>value+1),accountId);
 const contributions=usePublicPage<Contribution>(endpoint,accountId+':growth:'+(ownerOnly?'own':'public'),async(client,after)=>ownerOnly?publicContributions(await owner!.call('/v2/community/growth/me/contributions'+(after?'?'+new URLSearchParams({after}):''),null,{method:'GET'}),accountId):client.communityContributions(accountId,{after}),'growth',accountId,ownerOnly);
 useEffect(()=>{let active=true;if(ownerOnly&&(!owner||!scope||scope.identity!==accountId))return;void (async()=>{try{const authority=endpoint??(await loadWebConfiguration()).endpoint,value=await growthReads.read([accountId,ownerOnly?'own':'public','overview'],async()=>ownerOnly?publicGrowth(await owner!.call('/v2/community/growth/me',null,{method:'GET'}),accountId):createOfficialAccountClient({endpoint:authority}).communityGrowth(accountId),{fresh:forceRead.current,publicRead:true}) as Growth;if(value.accountId!==accountId||!value.level||!Array.isArray(value.domains)||!Array.isArray(value.honors))throw Error();if(active){forceRead.current=false;setGrowth(value);setError(value.readExpiresAt!==null&&value.readExpiresAt*1000<=Date.now());}}catch(reason){if(active){if(definitiveReadFailure(reason))setGrowth(null);setError(true);}}})();return()=>{active=false;};},[endpoint,accountId,attempt,growthReads,ownerOnly,owner,scope]);
 return <section className="public-account-relations"><h2>社区成长</h2>{error&&<p>成长资料暂时无法读取。 <Button variant="ghost" onClick={()=>{forceRead.current=true;setAttempt(value=>value+1);}}>重试</Button></p>}{growth&&<><p>{growth.level.label||('等级 '+growth.level.level)} · {growth.experience} 经验{growth.nextLevel&&' / '+growth.nextLevel.minimum}</p>{growth.domains.length>0&&<><h3>领域积累</h3><ul>{growth.domains.map(item=><li key={item.domain}>{[...forumTopics,forumUnclassifiedTopic].find(topic=>topic.id===item.domain)?.label??item.domain} · {item.experience} 经验</li>)}</ul></>}<h3>荣誉</h3>{growth.honors.length?<ul>{growth.honors.map(item=><li key={item.id}><strong>{item.name}</strong>{item.description&&<p>{item.description}</p>}</li>)}</ul>:<p>暂无荣誉。</p>}</>}<LegacyHonors accountId={accountId} endpoint={endpoint} navigate={navigate} ownerOnly={ownerOnly} owner={owner}/><h3>社区贡献</h3><ReadingState state={contributions}/>{contributions.value&&<>{contributions.value.items.length?<ul>{contributions.value.items.map(item=>{const path=item.objectKind==='post'?'/app/community/posts/'+item.objectId:item.objectKind==='reply'?'/app/community/replies/'+item.objectId:null;return <li key={item.sourceKind+':'+item.sourceId}>{path?<Follow path={path} navigate={navigate}>{item.title||'查看贡献'}</Follow>:item.title} · {item.experience} 经验</li>;})}</ul>:<p>暂无可展示的贡献。</p>}<More state={contributions} label="更多贡献"/></>}</section>;
}
