import React,{lazy,Suspense,useEffect} from 'react';
import {Bell,BriefcaseBusiness,Compass,Home,MessageCircle,MessagesSquare,Plus,Search,UserRound} from 'lucide-react';
import {CommunityLayout} from './community-navigation';
import {PublicBrowseWorkspace} from './public-browse-workspace';
import {ReadingDetails,ReadingSummary} from './reading-details';
const SettingsLayout=lazy(()=>import('./account-center').then(module=>({default:module.SettingsLayout})));
import {carryHelpOrigin} from './help-origin-client.mjs';
import {primaryNavigation,workspaceLocation} from './workspace-location.mjs';
import {isPublicReadingRoute} from './public-reading-contract.mjs';
import type {createWebRuntime} from './runtime.mjs';
import './selected-shell.css';

type Props={path:string;search?:string;connected:boolean;subjectId?:string;navigate:(path:string)=>void;onDisconnect?:()=>void;children:React.ReactNode};
const capabilityGroups=[
 {title:'发现与协作',links:[['/app/match','寻找同行'],['/app/projects','浏览项目'],['/app/information','资料与关注'],['/app/hubs','Hub 社区']]},
 {title:'建设与管理',links:[['/app/builders','建设者与接入'],['/app/worker-packs','Worker Pack'],['/app/governance','举报与处理'],['/app/reviews','复核邀请与记录']]},
];
const primaryIcons:Record<string,typeof Home>={home:Home,discover:Compass,community:MessagesSquare,messages:MessageCircle,work:BriefcaseBusiness,account:UserRound};
function workRoute(path:string,search:string){
 const params=new URLSearchParams(search);
 return ['/app/work','/app/publish','/app/configurations','/app/qualification-permissions','/app/information'].includes(path)
  ||path==='/app/participate'&&['requested','participating'].includes(params.get('view')??'')
  ||path==='/app/projects'&&['projects','contacts','recruitment','willingness'].includes(params.get('section')??'')
  ||path==='/app/capsules'&&params.get('mode')==='author'
  ||/^\/app\/tasks\/[0-9a-f-]{36}$/.test(path)&&(params.get('records')==='mine'||params.get('section')==='collaboration');
}
export function GalaxyMark(){return <span className="galaxy-mark" aria-hidden="true"><svg width="31" height="31" viewBox="0 0 32 32" fill="none"><ellipse cx="16" cy="16" rx="13" ry="6" transform="rotate(-36 16 16)" stroke="currentColor" strokeWidth="1.65"/><ellipse cx="16" cy="16" rx="6" ry="13" transform="rotate(-36 16 16)" stroke="currentColor" strokeWidth="1.65"/><circle cx="16" cy="16" r="3.2" fill="currentColor"/><circle cx="26" cy="7" r="2.2" fill="#d8a9be" stroke="#ffffff" strokeWidth="1.5"/></svg></span>;}
export function SiteShell({path,search='',connected,subjectId,navigate,onDisconnect,children}:Props){
 const community=path==='/app/community'||path.startsWith('/app/community/');
 const settings=path==='/app/account'||path==='/app/bookmarks'||path==='/app/history'||path.startsWith('/app/settings/');
 const publicPage=isPublicReadingRoute(path);
 const messages=path==='/app/rooms'||path.startsWith('/app/rooms/')||path==='/app/notifications';
 const go=(target:string)=>navigate(target);
 const follow=(event:React.MouseEvent<HTMLAnchorElement>,target:string)=>{if((target.startsWith('/app')||isPublicReadingRoute(new URL(target,location.origin).pathname))&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();go(target);}};
 const followDocumentLink=(event:React.MouseEvent<HTMLDivElement>)=>{
  if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;
  if(!(anchor instanceof HTMLAnchorElement)||anchor.getAttribute('href')?.startsWith('#')||anchor.hasAttribute('download')||anchor.target&&anchor.target!=='_self')return;
  const target=new URL(anchor.href,location.href);
  if(target.origin!==location.origin||!(target.pathname==='/app'||target.pathname.startsWith('/app/')||isPublicReadingRoute(target.pathname)))return;
  event.preventDefault();go(target.pathname+target.search+target.hash);
 };
 let inWork=workRoute(path,search);
 if(!inWork&&/^\/app\/(tasks|capsules|projects)\/[^/]+/.test(path)&&typeof history.state?.browseReturn==='string'){
  try{const origin=new URL(history.state.browseReturn,location.origin);inWork=origin.origin===location.origin&&workRoute(origin.pathname,origin.search);}catch{/* Invalid locators do not change the active navigation. */}
 }
 const current=(target:string)=>target==='/app/'?!inWork&&(path==='/app'||path==='/app/'||/^\/app\/(participate|tasks|capsules|projects|find|search|match)(\/|$)/.test(path))
  :target==='/app/work'?inWork
  :target==='/app/rooms'?messages
   :target==='/app/account'?settings||path.startsWith('/app/accounts/')||publicPage&&workspaceLocation(path)==='账户'
  :path===target||path.startsWith(target+'/');
 const link=(target:string,label:string)=><a key={target} href={target} aria-current={current(target)?'page':undefined} onClick={event=>follow(event,target)}>{label}</a>;
  const accountLinks=[['/app/account','账户概览'],['/app/account?section=settings','在线账户资料'],['/app/community?section=owned','我的帖子'],['/app/bookmarks','我的收藏'],['/app/account?section=access','接入与 AI'],...(subjectId?[['/app/history','经历与贡献'],['/app/community?section=reports','内容处理记录'],['/app/settings/identity','身份与设备']]:[])];
 const searchContents=(event:React.SubmitEvent<HTMLFormElement>)=>{
  event.preventDefault();const value=new FormData(event.currentTarget).get('q'),query=typeof value==='string'?value.trim():'';
  if(community){const params=new URLSearchParams(search);for(const key of ['compose','manage','section','before','cursor'])params.delete(key);if(query)params.set('q',query);else params.delete('q');const encoded=params.toString();go('/app/community'+(encoded?'?'+encoded:''));}
  else go('/app/find'+(query?'?q='+encodeURIComponent(query):''));
 };
 const publishTarget=carryHelpOrigin('/app/publish',path+search+location.hash);
 const activeTitle=workspaceLocation(path);
 useEffect(()=>{if(!publicPage)document.title='银河 · '+activeTitle;},[activeTitle,publicPage]);
 const railLink=({href:target,label,icon}:{href:string;label:string;icon:string})=>{const Icon=primaryIcons[icon];return <a key={target} href={target} aria-current={current(target)?'page':undefined} onClick={event=>follow(event,target)}><Icon size={22} aria-hidden/><span>{label}</span></a>;};
 // This delegates native link clicks, including keyboard activation and links rendered in dialogs.
 // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
 return <div className={'galaxy-workspace galaxy-site selected-shell'+(publicPage?' selected-public-shell':'')} onClick={followDocumentLink}><a href="#main-content" className="site-skip">跳到内容</a>
  <aside className="selected-global-rail" aria-label="银河全局导航">
   <nav className="selected-rail-primary" aria-label="主要功能">{primaryNavigation.map(railLink)}</nav>
  </aside>
  <header className="site-app-header selected-app-header"><div className="site-header-inner">
   <a href="/" className="selected-header-brand" aria-label="银河首页"><GalaxyMark/></a>
   <p className="selected-context-title" aria-label={'当前位置：银河 · '+activeTitle}><span>银河</span><span className="selected-context-divider" aria-hidden="true">·</span><span>{activeTitle}</span></p>
   <search className="selected-header-search"><form onSubmit={searchContents}><Search size={18}/><input key={community?search:'public-search'} name="q" type="search" maxLength={160} defaultValue={community?new URLSearchParams(search).get('q')??'':''} placeholder={community?'搜索社区内容':'搜索公开内容'} aria-label={community?'搜索社区内容':'搜索银河公开内容'}/></form></search>
   <div className="selected-header-actions">
    <ReadingDetails key={path+search} className="selected-function-directory"><ReadingSummary>功能目录</ReadingSummary>
     <div className="selected-directory-groups">{capabilityGroups.map(group=><section key={group.title}><h3>{group.title}</h3><nav>{group.links.map(([target,title])=>link(target,title))}</nav></section>)}<section><h3>使用与资料</h3><nav>{accountLinks.map(([target,title])=>link(target,title))}<a href="/docs/">文档</a><a href="/privacy/">隐私与数据</a><a href="/status/">服务与版本</a></nav>{connected&&<button type="button" className="text-link" onClick={()=>onDisconnect?.()}>退出本次连接</button>}</section></div>
    </ReadingDetails>
    <a className="selected-notifications" href="/app/notifications" aria-label="通知" onClick={event=>follow(event,'/app/notifications')}><Bell size={20}/></a>
    <a className="site-create" aria-label={community?'写帖子':'发起求助'} href={community?'/app/community?compose=post':publishTarget} onClick={event=>follow(event,community?'/app/community?compose=post':publishTarget)}><Plus size={17}/><span>{community?'写帖子':'发起求助'}</span></a>
    <a className="selected-account-entry" href="/app/account" aria-label="账户中心" onClick={event=>follow(event,'/app/account')}><UserRound size={20}/><span>账户</span></a>
   </div>
  </div></header>
  <main id="main-content" className={'workspace-main site-content'+(settings?' settings-page':'')+(community?' community-page':'')+(messages?' messages-shell-page':'')+(publicPage?' public-content':'')} tabIndex={-1}>{community?<CommunityLayout path={path} search={search} navigate={navigate}>{children}</CommunityLayout>:settings?<Suspense fallback={<PageLoading label="正在打开账户与设置…"/>}><SettingsLayout path={path} search={search} subjectId={subjectId} navigate={navigate}>{children}</SettingsLayout></Suspense>:children}</main>
 </div>;
}
export function PageLoading({label='正在读取当前资料…'}:{label?:string}){return <div className="page-loading"><output className="loading-label"><GalaxyMark/><span>{label}</span></output><div className="skeleton skeleton-title"/><div className="skeleton skeleton-line"/><div className="skeleton skeleton-line short"/><div className="skeleton-pair"><div className="skeleton skeleton-card"/><div className="skeleton skeleton-card"/></div></div>;}
export function StartPage({runtime,navigate}:{runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void}){return <PublicBrowseWorkspace runtime={runtime} navigate={navigate}/>;}
