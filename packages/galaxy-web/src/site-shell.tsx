import React,{lazy,Suspense,useEffect,useRef} from 'react';
import {GlobalRail,SiteHeader,ShellSearch,StandardHeaderActions} from './site-chrome.mjs';
import {siteSearchTarget} from './site-search.mjs';
import {CommunityLayout} from './community-navigation';
import {PublicBrowseWorkspace} from './features/discovery/browse';
import {ReadingDetails,ReadingSummary} from './reading-details';
const SettingsLayout=lazy(()=>import('./account-center').then(module=>({default:module.SettingsLayout})));
import {carryHelpOrigin} from './help-origin-client.mjs';
import {workspaceLocation} from './workspace-location.mjs';
import {isPublicReadingRoute} from './features/public-reading/contract.mjs';
import {readAgentIdentityEntry} from './agent-identity-handoff.mjs';
import {AccountSessionScope,useAccountSessionModel} from './account-session-scope';
import {ReadingBookmarksAccountProvider} from "./features/bookmarks/controls";
import type {createWebRuntime} from './runtime.mjs';
import './selected-shell.css';
import {SiteContentTransitionContext,useSiteContentTransition} from './use-site-content-transition';
import './site-content-transition.css';
import {PageLoading} from './interaction-feedback';
export {GalaxyMark} from './galaxy-mark';
export {PageLoading} from './interaction-feedback';

type Props={path:string;search?:string;endpoint?:string;navigate:(path:string)=>void;children:React.ReactNode};
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
export function SiteShell(props:Props){
 return <AccountSessionScope endpoint={props.endpoint}><AccountShell {...props}/></AccountSessionScope>;
}
function AccountShell({path,search='',endpoint,navigate,children}:Props){
 const account=useAccountSessionModel(),content=useRef<HTMLElement>(null);
 const deferPrimary=/^\/app\/community\/(?:posts\/[0-9a-f-]{36}(?:\/versions\/[0-9a-f-]{36})?|replies\/[0-9a-f-]{36})$/.test(path)||/^\/app\/rooms\/[0-9a-f-]{36}$/.test(path);
 const contentTransition=useSiteContentTransition(content,path+search,{deferPrimary});
 const community=path==='/app/community'||path.startsWith('/app/community/');
 const ownedPosts=path==='/app/community'&&new URLSearchParams(search).get('section')==='owned';
 const nativeHandoff=path==='/app/settings/identity'&&!!readAgentIdentityEntry({pathname:path,search,origin:location.origin});
 const settings=!nativeHandoff&&(path==='/app/account'||path==='/app/bookmarks'||path==='/app/feedback'||path==='/app/history'||path.startsWith('/app/settings/')||ownedPosts);
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
   :target==='/app/account'?settings||nativeHandoff||path.startsWith('/app/accounts/')||publicPage&&workspaceLocation(path)==='账户'
  :target==='/app/community'?community&&!ownedPosts
  :path===target||path.startsWith(target+'/');
 const link=(target:string,label:string)=>{const url=new URL(target,location.origin),parameters=new URLSearchParams(search),active=path===url.pathname&&[...url.searchParams].every(([key,value])=>parameters.get(key)===value)&&!(url.pathname==='/app/account'&&!url.search&&parameters.has('section'));return <a key={target} href={target} aria-current={active?'page':undefined} onClick={event=>follow(event,target)}>{label}</a>;};
 const signedIn=account.phase==='signed-in'&&!!account.session?.account.id;
 const accountLinks=[['/app/account','概览'],['/app/community?section=owned','我的帖子'],['/app/bookmarks','收藏'],['/app/account?section=following','关注'],['/app/account?section=settings','设置'],['/app/account?section=access','本机银河'],['/app/feedback','使用反馈']];
 const searchContents=(event:React.SubmitEvent<HTMLFormElement>)=>{
  event.preventDefault();const value=new FormData(event.currentTarget).get('q'),query=typeof value==='string'?value.trim():'';
  if(community){const params=new URLSearchParams(search);for(const key of ['compose','manage','section','before','cursor'])params.delete(key);if(query)params.set('q',query);else params.delete('q');const encoded=params.toString();go('/app/community'+(encoded?'?'+encoded:''));}
  else go(siteSearchTarget(query));
 };
 const publishTarget=carryHelpOrigin('/app/publish',path+search+location.hash);
 const activeTitle=ownedPosts?'账户':workspaceLocation(path);
 useEffect(()=>{if(!publicPage)document.title='银河 · '+activeTitle;},[activeTitle,publicPage]);
 // This delegates native link clicks, including keyboard activation and links rendered in dialogs.
 // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
 return <ReadingBookmarksAccountProvider account={account}><div className={'galaxy-workspace galaxy-site selected-shell'+(publicPage?' selected-public-shell':'')} onClick={followDocumentLink}><a href="#main-content" className="site-skip">跳到内容</a>
  <GlobalRail isCurrent={current} onFollow={follow}/>
  <SiteHeader location={activeTitle}
   searchNode={<ShellSearch onSubmit={searchContents} inputKey={community?search:'public-search'} defaultValue={community?new URLSearchParams(search).get('q')??'':''} placeholder={community?'搜索社区内容':'搜索公开内容'} labels={{searchLabel:community?'搜索社区内容':'搜索银河公开内容'}}/>}
   actionsNode={<StandardHeaderActions onFollow={follow} publishTarget={community?'/app/community?compose=post':publishTarget} publishLabel={community?'写帖子':'发起求助'} directoryNode={
    <ReadingDetails key={path+search} className="selected-function-directory"><ReadingSummary>功能目录</ReadingSummary>
     <div className="selected-directory-groups">{capabilityGroups.map(group=><section key={group.title}><h3>{group.title}</h3><nav>{group.links.map(([target,title])=>link(target,title))}</nav></section>)}<section><h3>账户</h3><nav>{signedIn?accountLinks.map(([target,title])=>link(target,title)):account.phase==='signed-out'&&account.client?<><a href={account.client.loginUrl('login',path+search+location.hash)}>登录</a><a href={account.client.loginUrl('register',path+search+location.hash)}>注册账户</a></>:<a href="/app/account" onClick={event=>follow(event,'/app/account')}>登录银河账户</a>}</nav></section><section><h3>使用与资料</h3><nav><a href="/docs/">文档</a><a href="/privacy/">隐私与数据</a><a href="/status/">服务与版本</a></nav></section></div>
    </ReadingDetails>
   }/>}/>

  <main id="main-content" ref={content} data-site-content-transition="" className={'workspace-main site-content'+(settings?' settings-page':'')+(community?' community-page':'')+(messages?' messages-shell-page':'')+(publicPage?' public-content':'')} tabIndex={-1}><SiteContentTransitionContext.Provider value={contentTransition}>{settings?<Suspense fallback={<PageLoading label="正在打开账户…"/>}><SettingsLayout path={path} search={search} endpoint={endpoint} navigate={navigate}>{children}</SettingsLayout></Suspense>:community?<CommunityLayout path={path} search={search} navigate={navigate}>{children}</CommunityLayout>:children}</SiteContentTransitionContext.Provider></main>
 </div></ReadingBookmarksAccountProvider>;
}
export function StartPage({runtime,navigate}:{runtime:Awaited<ReturnType<typeof createWebRuntime>>|null;navigate:(path:string)=>void}){return <PublicBrowseWorkspace runtime={runtime} navigate={navigate}/>;}
