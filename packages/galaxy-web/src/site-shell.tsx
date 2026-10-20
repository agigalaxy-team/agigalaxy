import React,{lazy,Suspense,useEffect} from 'react';
import {GlobalRail,SiteHeader,ShellSearch,StandardHeaderActions} from './site-chrome.mjs';
import {siteSearchTarget} from './site-search.mjs';
import {CommunityLayout} from './community-navigation';
import {PublicBrowseWorkspace} from './public-browse-workspace';
import {ReadingDetails,ReadingSummary} from './reading-details';
const SettingsLayout=lazy(()=>import('./account-center').then(module=>({default:module.SettingsLayout})));
import {carryHelpOrigin} from './help-origin-client.mjs';
import {workspaceLocation} from './workspace-location.mjs';
import {isPublicReadingRoute} from './public-reading-contract.mjs';
import type {createWebRuntime} from './runtime.mjs';
import './selected-shell.css';
import {PageLoading} from './interaction-feedback';
export {GalaxyMark} from './galaxy-mark';
export {PageLoading} from './interaction-feedback';

type Props={path:string;search?:string;connected:boolean;subjectId?:string;navigate:(path:string)=>void;onDisconnect?:()=>void;children:React.ReactNode};
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
  else go(siteSearchTarget(query));
 };
 const publishTarget=carryHelpOrigin('/app/publish',path+search+location.hash);
 const activeTitle=workspaceLocation(path);
 useEffect(()=>{if(!publicPage)document.title='银河 · '+activeTitle;},[activeTitle,publicPage]);
 // This delegates native link clicks, including keyboard activation and links rendered in dialogs.
 // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
 return <div className={'galaxy-workspace galaxy-site selected-shell'+(publicPage?' selected-public-shell':'')} onClick={followDocumentLink}><a href="#main-content" className="site-skip">跳到内容</a>
  <GlobalRail isCurrent={current} onFollow={follow}/>
  <SiteHeader location={activeTitle}
   searchNode={<ShellSearch onSubmit={searchContents} inputKey={community?search:'public-search'} defaultValue={community?new URLSearchParams(search).get('q')??'':''} placeholder={community?'搜索社区内容':'搜索公开内容'} labels={{searchLabel:community?'搜索社区内容':'搜索银河公开内容'}}/>}
   actionsNode={<StandardHeaderActions onFollow={follow} publishTarget={community?'/app/community?compose=post':publishTarget} publishLabel={community?'写帖子':'发起求助'} directoryNode={
    <ReadingDetails key={path+search} className="selected-function-directory"><ReadingSummary>功能目录</ReadingSummary>
     <div className="selected-directory-groups">{capabilityGroups.map(group=><section key={group.title}><h3>{group.title}</h3><nav>{group.links.map(([target,title])=>link(target,title))}</nav></section>)}<section><h3>使用与资料</h3><nav>{accountLinks.map(([target,title])=>link(target,title))}<a href="/docs/">文档</a><a href="/privacy/">隐私与数据</a><a href="/status/">服务与版本</a></nav>{connected&&<button type="button" className="text-link" onClick={()=>onDisconnect?.()}>退出本次连接</button>}</section></div>
    </ReadingDetails>
   }/>}/>

  <main id="main-content" className={'workspace-main site-content'+(settings?' settings-page':'')+(community?' community-page':'')+(messages?' messages-shell-page':'')+(publicPage?' public-content':'')} tabIndex={-1}>{community?<CommunityLayout path={path} search={search} navigate={navigate}>{children}</CommunityLayout>:settings?<Suspense fallback={<PageLoading label="正在打开账户与设置…"/>}><SettingsLayout path={path} search={search} subjectId={subjectId} navigate={navigate}>{children}</SettingsLayout></Suspense>:children}</main>
 </div>;
}
export function StartPage({runtime,navigate}:{runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void}){return <PublicBrowseWorkspace runtime={runtime} navigate={navigate}/>;}
