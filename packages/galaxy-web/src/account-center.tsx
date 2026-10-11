import React,{useEffect,useMemo,useRef,useState} from 'react';
import {ArrowRight,ArrowUpRight,Award,BookOpen,BriefcaseBusiness,ChevronLeft,FileText,KeyRound,MessageSquare,Pencil,Settings,ShieldCheck,UserRound} from 'lucide-react';
import {createProfileClient} from './profile-client.mjs';
import {HomeContinuityWorkspace} from './home-continuity-workspace';
import {profilePath} from './profile-navigation.mjs';
import './profile-settings.css';
import './person-profile.css';
import type {AccountRuntime,ProfileOverview,HonorBadge,HonorDetail,HonorResponse} from './account-workspace-types';

type Go=(path:string)=>void;
type Props={path:string;search:string;navigate:Go;children:React.ReactNode};
const settings=[['/app/settings/identity','身份与设备'],['/app/settings/identity?section=account','账号验证'],['/app/settings/privacy','数据与隐私'],['/app/settings/summaries','交流笔记'],['/app/settings/trust-package','分享的资料']];
function NavLink({to,navigate,children,...rest}:{to:string;navigate:Go;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){return <a href={to} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(to);}}} {...rest}>{children}</a>;}
export function SettingsLayout({path,search,navigate,children}:Props){
 if(path==='/app/account')return <div className="personal-page">{children}</div>;
 const current=path==='/app/settings/identity'&&new URLSearchParams(search).get('section')==='account'?path+'?section=account':path;
 return <div className="settings-layout"><aside className="settings-sidebar"><NavLink to="/app/account" navigate={navigate} className="settings-title"><ChevronLeft size={16}/>我的银河</NavLink><nav aria-label="设置">{settings.map(([url,title])=><NavLink key={url} to={url} navigate={navigate} aria-current={url===current?'page':undefined}>{title}</NavLink>)}</nav></aside><div className="settings-content">{children}</div></div>;
}
type AccountProps={runtime?:AccountRuntime|null;subjectId?:string;connected:boolean;hasIdentity:boolean;navigate:Go};
type AccountProfile=ProfileOverview&{profileReadExpiresAt?:number};
const withoutProfileDeclaration=(profile:AccountProfile):AccountProfile=>({...profile,displayName:null,about:null,tags:[],profileReadExpiresAt:undefined});
export function AccountOverview(props:AccountProps){
 const binding=props.runtime?.api?.snapshot?.();
 return <AccountSession key={`${props.subjectId??'guest'}:${props.connected}:${binding?.bindingId}:${binding?.generation}`} {...props}/>;
}
function AccountSession({runtime,subjectId,connected,hasIdentity,navigate}:AccountProps){
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
 const destinations=[
  {to:'/app/work',icon:BriefcaseBusiness,title:'我的工作',description:'继续求助和参与的事情'},
  {to:'/app/community?section=owned',icon:MessageSquare,title:'我的帖子',description:'讨论、想法与分享'},
  {to:'/app/history',icon:BookOpen,title:'经历与贡献',description:'看完整过程和实际结果'},
 ];
 return <section className="profile-overview" aria-busy={busy}>
  <header className="profile-heading"><h1 className="small">我的银河</h1><NavLink to="/app/settings/identity" navigate={navigate} className="profile-settings-link"><Settings size={18}/>设置</NavLink></header>
  <div className="profile-intro"><span className="profile-avatar" aria-hidden="true">{profile?.displayName?Array.from(profile.displayName).slice(0,1):<UserRound size={34}/>}</span><div>
   <h2>{profile?.displayName??(hasIdentity?'我的个人资料':'欢迎来到银河')}</h2>
   {profile?.about?<p className="profile-about">{profile.about}</p>:<p>{hasIdentity?'在这里继续自己的交流与工作。':'浏览经验、参与讨论，遇到问题时找到帮助。'}</p>}
   {!!profile?.tags?.length&&<ul className="profile-tags" aria-label="自我介绍中的方向">{profile.tags.slice(0,6).map((tag:string)=><li key={tag}>{tag}</li>)}</ul>}
   {subjectId&&<div className="profile-intro-actions"><NavLink to={profilePath(subjectId)!} navigate={navigate} className="profile-self-view">查看完整个人资料<ArrowRight size={15}/></NavLink><NavLink to={profilePath(subjectId)!+'?edit=1'} navigate={navigate} className="person-edit-link"><Pencil size={14}/>编辑资料</NavLink></div>}
   {!connected&&<NavLink to="/app/settings/identity" navigate={navigate} className="primary-action">{hasIdentity?'继续使用我的身份':'开始使用'}<ArrowRight size={15}/></NavLink>}
  </div></div>
  {error&&<p role="alert" className="profile-inline-error">{error}<button type="button" onClick={()=>{setBusy(!!client);setRefresh(n=>n+1);}}>重试</button></p>}
  {!!profile?.honors?.length&&<div className="profile-honors" aria-label="当前认可">{profile.honors.map((item)=><button type="button" key={item.id} className="honor-badge" onClick={()=>showHonor(item)} aria-expanded={honor?.id===item.id}><Award size={22}/><span>{item.title}</span></button>)}</div>}
  {profile?.honorsError&&<p className="muted">认可资料暂未读到。</p>}
  {honor&&<section className="honor-detail" aria-label={honor.title} aria-busy={honorBusy}><header><h2><Award size={22}/>{honor.title}</h2><button type="button" onClick={()=>{honorRequest.current.sequence++;honorRequest.current.selected=null;setHonor(null);setHonorDetail(null);setHonorBusy(false);}}>收起</button></header>
   <p>这枚标志表示符合“{honor.title}”的具体规则。它的含义以以下依据为限。</p>
   {honorBusy&&!honorDetail&&<output>正在读取依据…</output>}{honorError&&<p role="alert">{honorError}<button type="button" onClick={()=>showHonor(honor)}>重试</button></p>}
   {honorDetail&&<><dl className="profile-key-facts"><div><dt>颁发方</dt><dd>{honorDetail.card.issuer}</dd></div><div><dt>当前规则</dt><dd>{honorDetail.card.rule.title} · {honorDetail.card.rule.version}</dd></div></dl>
    <ul className="honor-evidence">{(honorDetail.items??[]).map((item,index)=><li key={item.id??item.assistanceId??index}><strong>{item.title??item.summary??item.case?.title??(item.eligible===false?'当前未计入的参考记录':item.accepted?'已被接受的参与记录':'支持这项认可的记录')}</strong>{item.participatedAt&&<time>{new Date(item.participatedAt*1000).toLocaleDateString()}</time>}{item.projections?.map((projection,i)=><p key={i}>{projection.projection?.title??projection.projection?.summary??'已获准的参与事实'}</p>)}{item.sourceEvents&&<p>{item.sourceEvents.map((event)=>({request:'发起工作',confirm:'确认参与',deliver:'提交结果',accept:'发起者接受结果',cancel:'取消参与',review:'补充评价'} as Record<string,string>)[event.kind]).filter(Boolean).join(' → ')}</p>}{item.summary&&item.title&&<p>{item.summary}</p>}</li>)}</ul>
    {honorDetail.nextAfter&&<button type="button" disabled={honorBusy} onClick={()=>showHonor(honor,honorDetail.nextAfter??undefined)}>查看更多依据</button>}
    <NavLink to="/app/history" navigate={navigate}>查看完整经历<ArrowRight size={15}/></NavLink></>}
  </section>}
  <nav className="personal-destinations" aria-label="我的内容">{destinations.map(({to,icon:Icon,title,description})=><NavLink key={to} to={to} navigate={navigate}><Icon size={23}/><div><h2>{title}</h2><p>{description}</p></div><ArrowRight size={18}/></NavLink>)}</nav>
  <section className="profile-data-links"><h2>资料与数据</h2><NavLink to="/app/settings/summaries" navigate={navigate}><FileText size={18}/>交流笔记<ArrowRight size={15}/></NavLink><NavLink to="/app/settings/privacy" navigate={navigate}><ShieldCheck size={18}/>数据与隐私<ArrowRight size={15}/></NavLink><NavLink to="/app/settings/identity" navigate={navigate}><KeyRound size={18}/>身份与设备<ArrowRight size={15}/></NavLink></section>
 </section>;
}
export function WorkOverview({runtime,subjectId,connected,navigate}:Pick<AccountProps,'runtime'|'subjectId'|'connected'|'navigate'>){
 return <section className="personal-work"><header className="profile-heading"><h1 className="small">我的工作</h1><NavLink to="/app/publish" navigate={navigate} className="primary-action">发起求助<ArrowUpRight size={16}/></NavLink></header>
  <nav className="work-filter-links" aria-label="查看我的工作">{[['/app/participate?view=requested','我发布的'],['/app/participate?view=participating','我参与的'],['/app/rooms','对话']].map(([to,title])=><NavLink key={to} to={to} navigate={navigate}>{title}</NavLink>)}</nav>
  {!connected?<div className="personal-empty"><BriefcaseBusiness size={32}/><h2>从上次的事情继续</h2><p>使用自己的身份，查看参与的工作和回应。</p><NavLink to="/app/settings/identity" navigate={navigate} className="primary-action">继续使用<ArrowRight size={15}/></NavLink></div>:<HomeContinuityWorkspace runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate}/>}
  <section className="work-library"><h2>继续整理与使用</h2><nav>{[['/app/projects?section=projects','我的项目','持续推进的目标与参与机会'],['/app/projects?section=contacts','邀请与联系人','查看发出和收到的联系'],['/app/capsules?mode=author','我的方法','整理、修订与分享经验'],['/app/history','经历与贡献','回看实际过程和结果'],['/app/information','资料与关注','继续查找和跟进相关信息'],['/app/configurations','工作环境','复用已经记录的配置'],['/app/qualification-permissions','材料使用许可','管理具体材料和使用范围']].map(([to,title,description])=><NavLink key={to} to={to} navigate={navigate}><span><strong>{title}</strong><small>{description}</small></span><ArrowUpRight size={15}/></NavLink>)}</nav></section>
 </section>;
}
