import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Award,Bookmark,BookOpen,BriefcaseBusiness,Home,FileText,KeyRound,MessageSquare,Pencil,Settings,ShieldCheck,UserRound} from 'lucide-react';
import {createProfileClient} from './profile-client.mjs';
import {HomeContinuityWorkspace} from './home-continuity-workspace';
import {profilePath} from './profile-navigation.mjs';
import './profile-settings.css';
import './person-profile.css';
import './settings-visual.css';
import './selected-account.css';
import {ReadingDetails,ReadingSummary} from './reading-details';
import type {AccountRuntime,ProfileOverview,HonorBadge,HonorDetail,HonorResponse} from './account-workspace-types';
import {OfficialAccountStatus,useOfficialAccountSession,type OfficialSession} from './official-account-panel';
import {AccountWorkHistory,type AccountWorkCall} from './account-work-history';
import {availableForumContent,type ForumCardView} from './community-forum-view-types';


type Go=(path:string)=>void;
type Props={path:string;search:string;subjectId?:string;navigate:Go;children:React.ReactNode};
const settings=[['/app/account?section=access','接入与 AI'],['/app/settings/identity','身份与设备'],['/app/settings/identity?section=account','银河账户关联'],['/app/settings/privacy','数据与隐私'],['/app/settings/summaries','交流笔记'],['/app/settings/trust-package','分享的资料']];
function NavLink({to,navigate,children,...rest}:{to:string;navigate:Go;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){return <a href={to} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(to);}}} {...rest}>{children}</a>;}
export function SettingsLayout({path,search,subjectId,navigate,children}:Props){
 const section=new URLSearchParams(search).get('section');
 const current=path==='/app/settings/identity'&&section==='account'?path+'?section=account':path==='/app/account'&&['access','settings'].includes(section??'')?path+'?section='+section:path;
 const profile=profilePath(subjectId);
 const personal=[['/app/account','概览',Home],['/app/account?section=settings','在线账户资料',UserRound],...(profile?[[profile+'?edit=1','本机 ID 资料',UserRound] as const]:[]),['/app/work','我的工作',BriefcaseBusiness],['/app/community?section=owned','我的帖子',MessageSquare],['/app/bookmarks','我的收藏',Bookmark],['/app/history','经历与贡献',BookOpen]] as const;
 return <div className="settings-layout selected-account-layout"><aside className="settings-sidebar selected-account-sidebar"><h2>账户</h2><nav aria-label="账户栏目">{personal.map(([url,title,Icon])=><NavLink key={url+'-'+title} to={url} navigate={navigate} aria-current={url===current?'page':undefined}><Icon size={19}/>{title}</NavLink>)}</nav><nav className="selected-account-settings" aria-label="账户设置">{settings.map(([url,title])=><NavLink key={url} to={url} navigate={navigate} aria-current={url===current?'page':undefined}>{title}</NavLink>)}</nav></aside><div className={'settings-content'+(path==='/app/account'?' selected-account-content':'')}>{children}</div></div>;
}

type AccountProps={runtime?:AccountRuntime|null;subjectId?:string;connected:boolean;hasIdentity:boolean;navigate:Go};
type AccountProfile=ProfileOverview&{profileReadExpiresAt?:number};
const withoutProfileDeclaration=(profile:AccountProfile):AccountProfile=>({...profile,displayName:null,about:null,tags:[],profileReadExpiresAt:undefined});
export function AccountOverview(props:AccountProps){
 const binding=props.runtime?.api?.snapshot?.();
 return <AccountSession key={`${props.subjectId??'guest'}:${props.connected}:${binding?.bindingId}:${binding?.generation}`} {...props}/>;
}
function AccountSession({runtime,subjectId,connected,hasIdentity,navigate}:AccountProps){
 const official=useOfficialAccountSession(runtime?.api.endpoint);
 const client=useMemo(()=>runtime&&subjectId?createProfileClient(runtime,{subjectId,authenticated:connected}):null,[runtime,subjectId,connected]);
 const [profile,setProfile]=useState<AccountProfile|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(!!client),[refresh,setRefresh]=useState(0),declarationRead=useRef(0);
 const [honor,setHonor]=useState<HonorBadge|null>(null),[honorDetail,setHonorDetail]=useState<HonorDetail|null>(null),[honorError,setHonorError]=useState(''),[honorBusy,setHonorBusy]=useState(false);
 const honorRequest=useRef({sequence:0,active:true,selected:null as HonorBadge|null});
 useEffect(()=>{let active=true;
  if(client)client.overview().then(value=>{if(active){declarationRead.current++;const unavailable=navigator.onLine===false||!!value.profileReadExpiresAt&&value.profileReadExpiresAt*1000<=Date.now();setProfile(unavailable?withoutProfileDeclaration(value):value);setError(unavailable?'个人介绍需要重新读取，连接恢复后会继续核对。':'');const selection=honorRequest.current;
   if(selection.selected&&!value.honors.some((item:HonorBadge)=>item.id===selection.selected?.id)){selection.sequence++;selection.selected=null;setHonor(null);setHonorDetail(null);setHonorBusy(false);}}}).catch(()=>{if(active){declarationRead.current++;setProfile(null);setError('资料暂时没有读到，请稍后重试。');honorRequest.current.sequence++;honorRequest.current.selected=null;setHonor(null);setHonorDetail(null);setHonorBusy(false);}}).finally(()=>{if(active)setBusy(false);});
  return()=>{active=false;};
 },[client,refresh]);
 useEffect(()=>{const selection=honorRequest.current;selection.active=true;const reread=()=>{if(document.visibilityState==='visible'&&navigator.onLine!==false)setRefresh(n=>n+1);},offline=()=>{declarationRead.current++;setProfile(value=>value?withoutProfileDeclaration(value):null);setError('暂时离线，个人介绍会在连接恢复后重新读取。');};document.addEventListener('visibilitychange',reread);window.addEventListener('focus',reread);window.addEventListener('online',reread);window.addEventListener('offline',offline);return()=>{document.removeEventListener('visibilitychange',reread);window.removeEventListener('focus',reread);window.removeEventListener('online',reread);window.removeEventListener('offline',offline);client?.close();selection.active=false;selection.sequence++;};},[client]);
 useEffect(()=>{const expiresAt=profile?.profileReadExpiresAt;if(!profile||!expiresAt)return;const remaining=expiresAt*1000-Date.now(),sequence=declarationRead.current,reread=remaining>5000?window.setTimeout(()=>setRefresh(value=>value+1),remaining-5000):null;
  const expire=window.setTimeout(()=>{if(sequence!==declarationRead.current)return;declarationRead.current++;setProfile(value=>value===profile?withoutProfileDeclaration(value):value);setError('个人介绍需要重新核对当前可见范围。');if(navigator.onLine!==false)setRefresh(value=>value+1);},Math.max(0,remaining));return()=>{if(reread!==null)window.clearTimeout(reread);window.clearTimeout(expire);};
 },[profile]);
 async function showHonor(item:HonorBadge,after?:string){const selection=honorRequest.current,token=++selection.sequence;selection.selected=item;setHonor(item);setHonorError('');setHonorBusy(true);if(!after)setHonorDetail(null);
  try{const response:HonorResponse=await client!.honor(item,{after,expectedFingerprint:after?honorDetail?.sourceFingerprint:undefined}),detail={...response,items:response.items??response.contributions??[],nextAfter:response.nextAfter??response.pagination?.contributions?.nextAfter??null,sourceFingerprint:response.sourceFingerprint??response.card?.sourceFingerprint};
   if(!selection.active||token!==selection.sequence)return;
   if(detail.card?.status!=='active'){setHonorDetail(null);setHonorError('这项认可的当前依据已变化。');setRefresh(n=>n+1);return;}
   setHonorDetail(old=>after&&old?{...detail,items:[...old.items,...detail.items]}:detail);
  }catch{if(selection.active&&token===selection.sequence){setHonorDetail(null);setHonorError('当前依据暂时不可读取，请重试。');}}
  finally{if(selection.active&&token===selection.sequence)setHonorBusy(false);}
 }
 return <section className="profile-overview selected-account" aria-busy={busy}>
  <header className="profile-heading"><h1 className="small">我的账户</h1><NavLink to="/app/account?section=settings" navigate={navigate} className="profile-settings-link"><Settings size={18}/>设置</NavLink></header>
  <OfficialAccountStatus model={official} navigate={navigate} compact/>
  {official.phase==='signed-in'&&<AccountRecentPosts key={official.session?.account.id+':'+official.session?.csrfToken} model={official} navigate={navigate}/>}
  {connected&&error&&<p role="alert" className="profile-inline-error">{error}<button type="button" onClick={()=>{setBusy(!!client);setRefresh(n=>n+1);}}>重试</button></p>}
  {!!profile?.honors?.length&&<div className="profile-honors" aria-label="当前身份的荣誉">{profile.honors.map(item=><ReadingDetails key={item.id} className="account-honor-reading" onOpenChange={open=>{if(open)void showHonor(item);else if(honorRequest.current.selected?.id===item.id){honorRequest.current.sequence++;honorRequest.current.selected=null;setHonor(null);setHonorDetail(null);setHonorBusy(false);}}}><ReadingSummary><Award size={20}/>{item.title}</ReadingSummary>{honor?.id===item.id&&<section className="honor-detail" aria-label={honor.title} aria-busy={honorBusy}>
   
   {honorBusy&&!honorDetail&&<output>正在读取依据…</output>}{honorError&&<p role="alert">{honorError}<button type="button" onClick={()=>showHonor(honor)}>重试</button></p>}
   {honorDetail&&<><dl className="profile-key-facts"><div><dt>颁发方</dt><dd>{honorDetail.card.issuer}</dd></div><div><dt>当前规则</dt><dd>{honorDetail.card.rule.title} · {honorDetail.card.rule.version}</dd></div></dl>
    <ul className="honor-evidence">{(honorDetail.items??[]).map((item,index)=><li key={item.id??item.assistanceId??index}><strong>{item.title??item.summary??item.case?.title??(item.eligible===false?'当前未计入的参考记录':item.accepted?'已被接受的参与记录':'支持这项认可的记录')}</strong>{item.participatedAt&&<time>{new Date(item.participatedAt*1000).toLocaleDateString()}</time>}{item.projections?.map((projection,i)=><p key={i}>{projection.projection?.title??projection.projection?.summary??'已获准的参与事实'}</p>)}{item.sourceEvents&&<p>{item.sourceEvents.map((event)=>({request:'发起工作',confirm:'确认参与',deliver:'提交结果',accept:'发起者接受结果',cancel:'取消参与',review:'补充评价'} as Record<string,string>)[event.kind]).filter(Boolean).join(' · ')}</p>}{item.summary&&item.title&&<p>{item.summary}</p>}</li>)}</ul>
    {honorDetail.nextAfter&&<button type="button" disabled={honorBusy} onClick={()=>showHonor(honor,honorDetail.nextAfter??undefined)}>查看更多依据</button>}
    <NavLink to="/app/history" navigate={navigate}>查看完整经历</NavLink></>}
  </section>}</ReadingDetails>)}</div>}
  {profile?.honorsError&&<p className="muted">认可资料暂未读到。</p>}

  {connected&&<section className="account-continue"><header><h2>继续工作</h2></header><HomeContinuityWorkspace runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate}/></section>}
  {official.phase==='signed-in'&&<nav className="account-content-shortcuts" aria-label="我的资料"><NavLink to="/app/bookmarks" navigate={navigate}><Bookmark size={19}/>我的收藏</NavLink><NavLink to="/app/account?section=settings&view=work" navigate={navigate}><BriefcaseBusiness size={19}/>工作资料</NavLink><NavLink to="/app/account?section=settings&view=archives" navigate={navigate}><FileText size={19}/>私有会话</NavLink></nav>}

 </section>;
}
function AccountRecentPosts({model,navigate}:{model:ReturnType<typeof useOfficialAccountSession>;navigate:Go}){
 const [posts,setPosts]=useState<ForumCardView[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const accountId=model.session?.account.id,csrfToken=model.session?.csrfToken;
 useEffect(()=>{let active=true;const session=model.session,client=model.client;if(!session?.account.id||!client)return;
  setLoading(true);void client.call('/v2/community/posts/owned',{}, {session}).then(value=>{if(active){setPosts((value as {items:ForumCardView[]}).items??[]);setError('');}}).catch(()=>{if(active){setPosts([]);setError('帖子暂时无法加载。');}}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
 },[model.client,accountId,csrfToken,revision]);
 useEffect(()=>{const refresh=()=>{if(!document.hidden&&navigator.onLine!==false)setRevision(value=>value+1);};window.addEventListener('online',refresh);window.addEventListener('focus',refresh);return()=>{window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);};},[]);
 const expiry=Math.min(...posts.flatMap(value=>value.availability==='available'&&typeof value.publishedUntil==='number'?[value.publishedUntil]:[]));
 useEffect(()=>{if(!Number.isFinite(expiry))return;const timer=setTimeout(()=>{setPosts(old=>old.map(value=>typeof value.publishedUntil==='number'&&value.publishedUntil*1000<=Date.now()?{...value,payload:undefined,availability:'expired'}:value));setRevision(value=>value+1);},Math.max(0,expiry*1000-Date.now()+1));return()=>clearTimeout(timer);},[expiry]);
 return <section className="account-recent-posts" aria-busy={loading}><header><h2>我的帖子</h2><NavLink to="/app/community?compose=post" navigate={navigate} className="primary-action"><Pencil size={15}/>写帖子</NavLink></header>
 {error?<p role="alert">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试</button></p>:loading&&!posts.length?<output>正在加载帖子…</output>:posts.length?<ul>{posts.slice(0,4).map(value=>{const readable=availableForumContent(value,Math.floor(Date.now()/1000));return <li key={value.locator.postId}><NavLink to={'/app/community/posts/'+value.locator.postId+'?manage=1'} navigate={navigate}><strong>{readable?value.payload.title:'state'in value&&value.state==='withdrawn'?'已撤回的帖子':'当前不可读取的帖子'}</strong>{readable&&<p>{value.payload.body.replace(/\s+/g,' ').slice(0,180)}</p>}</NavLink>{value.updatedAt&&<time>{new Date(value.updatedAt*1000).toLocaleDateString('zh-CN')}</time>}</li>;})}</ul>:<p>还没有帖子，写下第一段想分享的内容吧。</p>}
 {posts.length>0&&<NavLink to="/app/community?section=owned" navigate={navigate} className="text-link">全部帖子</NavLink>}</section>;
}
export function WorkOverview({runtime,subjectId,connected,navigate}:Pick<AccountProps,'runtime'|'subjectId'|'connected'|'navigate'>){
  const official=useOfficialAccountSession(runtime?.api.endpoint),local=useRef<{endpoint:string|undefined;session:OfficialSession|null}>({endpoint:runtime?.api.endpoint,session:null});
  if(local.current.endpoint!==runtime?.api.endpoint||official.phase==='signed-out'||official.phase==='loading')local.current={endpoint:runtime?.api.endpoint,session:null};
  if(official.phase==='signed-in')local.current={endpoint:runtime?.api.endpoint,session:official.session};
  const session=official.session??(['offline','unavailable'].includes(official.phase)?local.current.session:null);
  const readCloud:AccountWorkCall=async(path,input,method='POST')=>{
    if(official.phase!=='signed-in'||!official.client||!official.session||official.session.account.id!==session?.account.id)throw Object.assign(Error('official_account_session_expired'),{code:'official_account_session_expired'});
    return official.client.call(path,input,{method,session:official.session});
  };
 return <section className="personal-work"><header className="profile-heading"><h1 className="small">工作概览</h1><NavLink to="/app/publish" navigate={navigate} className="primary-action">发起求助</NavLink></header>
  <nav className="work-filter-links" aria-label="查看我的工作">{[['/app/participate?view=requested','我发布的'],['/app/participate?view=participating','我参与的'],['/app/rooms','对话']].map(([to,title])=><NavLink key={to} to={to} navigate={navigate}>{title}</NavLink>)}</nav>
  {!connected&&!session&&<OfficialAccountStatus model={official} navigate={navigate} returnTo="/app/work" compact/>}{session?.account.id&&<AccountWorkHistory key={runtime?.api.endpoint+':'+session.account.id+':'+session.csrfToken} accountId={session.account.id} call={readCloud} available={official.phase==='signed-in'}/>} {connected&&<HomeContinuityWorkspace runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate}/> }
  <section className="work-library"><h2>继续整理与使用</h2><nav>{[['/app/projects?section=projects','我的项目','持续推进的目标与参与机会'],['/app/projects?section=contacts','邀请与联系人','查看发出和收到的联系'],['/app/capsules?mode=author','我的方法','整理、修订与分享经验'],['/app/history','经历与贡献','回看实际过程和结果'],['/app/information','资料与关注','继续查找和跟进相关信息'],['/app/configurations','工作环境','复用已经记录的配置'],['/app/qualification-permissions','材料使用许可','管理具体材料和使用范围']].map(([to,title,description])=><NavLink key={to} to={to} navigate={navigate}><span><strong>{title}</strong><small>{description}</small></span></NavLink>)}</nav></section>
 </section>;
}
