import React,{lazy,Suspense,useEffect,useRef} from 'react';
import {BriefcaseBusiness,ChevronDown,Compass,Menu,MessageCircle,MessagesSquare,Orbit,Plus,Search,UserRound,X} from 'lucide-react';
import {CommunityLayout} from './community-navigation';
import {PublicBrowseWorkspace} from './public-browse-workspace';
const SettingsLayout=lazy(()=>import('./account-center').then(module=>({default:module.SettingsLayout})));
import {carryHelpOrigin} from './help-origin-client.mjs';
import type {createWebRuntime} from './runtime.mjs';

type Props={path:string;search?:string;connected:boolean;subjectId?:string;navigate:(path:string)=>void;onDisconnect?:()=>void;children:React.ReactNode};
const mainLinks=[['/app/','发现'],['/app/community','社区'],['/app/work','我的工作'],['/app/rooms','消息']];
const capabilityGroups=[
 {title:'发现与协作',links:[['/app/match','寻找同行'],['/app/projects','浏览项目'],['/app/information','资料与关注'],['/app/hubs','Hub 社区']]},
 {title:'建设与管理',links:[['/app/builders','建设者与接入'],['/app/worker-packs','Worker Pack'],['/app/governance','举报与处理'],['/app/reviews','复核邀请与记录']]},
];
function workRoute(path:string,search:string){
 const params=new URLSearchParams(search);
 return ['/app/work','/app/publish','/app/configurations','/app/qualification-permissions','/app/information'].includes(path)
  ||path==='/app/participate'&&['requested','participating'].includes(params.get('view')??'')
  ||path==='/app/projects'&&['projects','contacts','recruitment','willingness'].includes(params.get('section')??'')
  ||path==='/app/capsules'&&params.get('mode')==='author'
  ||/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&(params.get('records')==='mine'||params.get('section')==='collaboration');
}
export function GalaxyMark(){return <span className="galaxy-mark" aria-hidden="true"><svg width="31" height="31" viewBox="0 0 32 32" fill="none"><ellipse cx="16" cy="16" rx="13" ry="6" transform="rotate(-36 16 16)" stroke="currentColor" strokeWidth="1.65"/><ellipse cx="16" cy="16" rx="6" ry="13" transform="rotate(-36 16 16)" stroke="currentColor" strokeWidth="1.65"/><circle cx="16" cy="16" r="3.2" fill="currentColor"/><circle cx="26" cy="7" r="2.2" fill="var(--g-accent)" stroke="var(--g-canvas)" strokeWidth="1.5"/></svg></span>;}
export function SiteShell({path,search='',connected,subjectId,navigate,onDisconnect,children}:Props){
 const mobile=useRef<HTMLDialogElement>(null),personal=useRef<HTMLDetailsElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const community=path==='/app/community'||path.startsWith('/app/community/');
 const searchCommunity=(event:React.SubmitEvent<HTMLFormElement>)=>{event.preventDefault();const value=new FormData(event.currentTarget).get('q');const query=typeof value==='string'?value.trim():'';const params=new URLSearchParams(search);for(const key of ['compose','manage','section','before','cursor'])params.delete(key);if(query)params.set('q',query);else params.delete('q');const queryString=params.toString();navigate('/app/community'+(queryString?'?'+queryString:''));};
 const go=(target:string)=>{mobile.current?.close();if(personal.current)personal.current.open=false;navigate(target);};
 const follow=(event:React.MouseEvent<HTMLAnchorElement>,target:string)=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();go(target);}};
 useEffect(()=>{mobile.current?.close();if(personal.current)personal.current.open=false;},[path,search]);
 useEffect(()=>{const outside=(e:PointerEvent)=>{if(personal.current&&!personal.current.contains(e.target as Node))personal.current.open=false;};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&personal.current?.open){personal.current.open=false;personal.current.querySelector('summary')?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[]);
 let inWork=workRoute(path,search);
 if(!inWork&&/^\/app\/(tasks|capsules|projects)\/[^/]+/.test(path)&&typeof history.state?.browseReturn==='string'){
  try{const origin=new URL(history.state.browseReturn,location.origin);inWork=origin.origin===location.origin&&workRoute(origin.pathname,origin.search);}catch{/* An invalid return locator does not change the current section. */}
 }
 const current=(target:string)=>target==='/app/'?!inWork&&(path==='/app'||path==='/app/'||/^\/app\/(participate|tasks|capsules|projects|find|search|match)(\/|$)/.test(path))
  :target==='/app/work'?inWork
  :target==='/app/rooms'?path===target||path.startsWith(target+'/')||path==='/app/notifications'
  :target==='/app/account'?path===target||path.startsWith('/app/settings/')||path==='/app/history'||path==='/app/bookmarks'
  :path===target||path.startsWith(target+'/');
 const link=(target:string,label:string)=><a key={target} href={target} aria-current={current(target)?'page':undefined} onClick={event=>follow(event,target)}>{label}</a>;
 const brand=<a href="/" className="site-brand" aria-label="银河首页"><GalaxyMark/><span>银河<small>GALAXY</small></span></a>;
 const accountLinks=connected?[['/app/account','我的资料'],['/app/bookmarks','我的收藏'],['/app/history','经历与贡献'],['/app/community?section=owned','我的帖子'],['/app/community?section=reports','内容处理记录'],['/app/settings/identity','设置']]:[['/app/settings/identity',subjectId?'连接已有身份':'登录 / 开始使用'],['/app/account','我的银河']];
 const settings=path==='/app/account'||path.startsWith('/app/settings/');
 const helpTarget=carryHelpOrigin('/app/search',path+search+location.hash),publishTarget=carryHelpOrigin('/app/publish',path+search+location.hash);
 return <div className="galaxy-workspace galaxy-site"><a href="#main-content" className="site-skip">跳到内容</a>
  <header className="site-app-header"><div className="site-header-inner">{brand}{community?<search className="community-header-search"><form onSubmit={searchCommunity}><Search size={18}/><input key={search} name="q" type="search" maxLength={160} defaultValue={new URLSearchParams(search).get('q')??''} placeholder="搜索社区内容" aria-label="搜索社区内容"/></form></search>:<nav className="site-primary-nav" aria-label="主要功能">{mainLinks.map(([target,title])=>link(target,title))}</nav>}
   <div className="site-header-actions">{!community&&<a className="site-help" href={helpTarget} onClick={event=>follow(event,helpTarget)}>找帮助</a>}<a className="site-create" aria-label={community?'写帖子':'发起求助'} href={community?'/app/community?compose=post':publishTarget} onClick={event=>follow(event,community?'/app/community?compose=post':publishTarget)}><Plus size={15}/><span>{community?'写帖子':'发起求助'}</span></a>
    <details ref={personal} className="personal-menu"><summary aria-label={connected?'我的账号':'登录与账号'}><span className="nav-avatar"><UserRound size={18}/></span><span>{connected?'我的':'登录'}</span><ChevronDown size={13}/></summary><div className="personal-menu-content"><p>{connected?'我的银河':subjectId?'已有身份，连接后继续参与':'阅读无需登录'}</p>{accountLinks.map(([target,title])=>link(target,title))}{connected&&<button onClick={()=>{personal.current!.open=false;onDisconnect?.();}}>退出本次连接</button>}</div></details>
    <button ref={trigger} className="mobile-nav-toggle" aria-label="打开菜单" onClick={()=>mobile.current?.showModal()}><Menu size={22}/></button>
   </div></div></header>
  <main id="main-content" className={'workspace-main site-content'+(settings?' settings-page':'')+(community?' community-page':'')} tabIndex={-1}>{community?<CommunityLayout path={path} search={search} navigate={navigate}>{children}</CommunityLayout>:settings?<Suspense fallback={<PageLoading label="正在打开账号与设置…"/>}><SettingsLayout path={path} search={search} navigate={navigate}>{children}</SettingsLayout></Suspense>:children}</main>
  <nav className="site-mobile-dock" aria-label="手机常用导航">{([['/app/','发现',Compass],['/app/community','社区',MessagesSquare],['/app/work','工作',BriefcaseBusiness],['/app/rooms','消息',MessageCircle],['/app/account','我的',UserRound]] as const).map(([target,label,Icon])=><a key={target} href={target} aria-current={current(target)?'page':undefined} onClick={event=>follow(event,target)}><Icon size={20}/><span>{label}</span></a>)}</nav>
  <footer className="site-app-footer"><div className="site-footer-main"><div>{brand}<p>让每一步，有更多可能。</p></div><div className="site-footer-links"><a href="/how-it-works/">如何工作</a><a href="/network/">开放网络</a><a href="/downloads/">连接你的 AI</a><a href="/docs/">文档</a><a href="/privacy/">隐私与数据</a><a href="/status/">服务与版本</a></div></div>
   <div className="site-capability-groups">{capabilityGroups.map(group=><nav key={group.title} aria-label={group.title}><h2>{group.title}</h2><div>{group.links.map(([target,title])=>link(target,title))}</div></nav>)}</div><div className="site-footer-bottom"><span>© 2026 银河 · GALAXY NETWORK</span><span>从真实工作出发，由你决定下一步。</span></div>
  </footer>
  <dialog ref={mobile} className="site-menu-dialog" aria-labelledby="mobile-menu-title" onClose={()=>trigger.current?.focus()}><header><h2 id="mobile-menu-title">银河</h2><button aria-label="关闭菜单" onClick={()=>mobile.current?.close()}><X size={22}/></button></header><nav aria-label="移动端主要功能">{mainLinks.map(([target,title])=>link(target,title))}{link(helpTarget,'找帮助')}{link(publishTarget,'发起求助')}</nav><div className="mobile-personal"><p>{connected?'我的银河':'账号'}</p>{accountLinks.map(([target,title])=>link(target,title))}{connected&&<button onClick={()=>{mobile.current?.close();onDisconnect?.();}}>退出本次连接</button>}</div><div className="mobile-menu-footer"><a href="/how-it-works/">了解银河</a><a href="/downloads/">连接你的 AI</a><a href="/app/builders" onClick={event=>follow(event,'/app/builders')}>建设者与接入</a></div></dialog>
 </div>;
}
export function PageLoading({label='正在读取当前资料…'}:{label?:string}){return <div className="page-loading"><output className="loading-label"><Orbit size={19}/><span>{label}</span></output><div className="skeleton skeleton-title"/><div className="skeleton skeleton-line"/><div className="skeleton skeleton-line short"/><div className="skeleton-pair"><div className="skeleton skeleton-card"/><div className="skeleton skeleton-card"/></div></div>;}
export function StartPage({runtime,navigate}:{runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void}){return <PublicBrowseWorkspace runtime={runtime} navigate={navigate}/>;}
