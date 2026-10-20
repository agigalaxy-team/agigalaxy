import React,{useCallback,useEffect,useLayoutEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {Bookmark,BriefcaseBusiness,FileText,Home,Laptop,MessageSquare,Pencil,Settings,UserRound} from 'lucide-react';
import {OfficialAccountStatus,type OfficialAccountModel,type OfficialSession} from './official-account-panel';
import {AccountSessionScope,useAccountSessionModel} from './account-session-scope';
import {AccountWorkHistory,type AccountWorkCall} from './account-work-history';
import {availableForumContent,type ForumCardView} from './community-forum-view-types';
import {LoadingFeedback,ReadFailure} from './interaction-feedback';
import {useReadTasks} from './use-read-task';
import './profile-settings.css';
import './selected-account.css';

type Go=(path:string)=>void;
type LayoutProps={path:string;search:string;endpoint?:string;navigate:Go;children:React.ReactNode};
function createAccountConnection(client:OfficialAccountModel['client']){
 let current:OfficialAccountModel|null=null,snapshot:{session:OfficialSession|null}={session:null};
 const empty=snapshot,listeners=new Set<()=>void>();
 return {
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  getSnapshot:()=>snapshot,getServerSnapshot:()=>empty,
  update(model:OfficialAccountModel){
   current=model;
   const session=model.phase==='signed-in'?model.session:['offline','unavailable'].includes(model.phase)?snapshot.session:null;
   if(snapshot.session!==session){snapshot={session};for(const listener of listeners)listener();}
  },
  suspend(){current=null;},
  requireSession(accountId:string|null|undefined,csrfToken:string|null|undefined){
   const live=current?.session;
   if(!client||!current||current.client!==client||['offline','unavailable'].includes(current.phase))throw Object.assign(Error('official_account_unavailable'),{code:'official_account_unavailable'});
   if(current.phase!=='signed-in'||!accountId||!live||live.account.id!==accountId||live.csrfToken!==csrfToken||live.expiresAt*1000<=Date.now())throw Object.assign(Error('official_account_changed'),{code:'official_account_changed'});
   return live;
  },
 };
}
/** Retain only the last owner during an outage; network actions require a live session. */
export function useAccountConnection(endpoint:string|undefined,model:OfficialAccountModel){
 const scope=useMemo(()=>({endpoint,authority:createAccountConnection(model.client)}),[endpoint,model.client]);
 const stored=useSyncExternalStore(scope.authority.subscribe,scope.authority.getSnapshot,scope.authority.getServerSnapshot);
 useLayoutEffect(()=>{scope.authority.update(model);return()=>scope.authority.suspend();},[scope,model]);
 const session=model.phase==='signed-in'?model.session:['offline','unavailable'].includes(model.phase)?stored.session:null;
 return {session,authority:scope.authority};
}
function NavLink({to,navigate,children,...rest}:{to:string;navigate:Go;children:React.ReactNode}&Omit<React.ComponentPropsWithoutRef<'a'>,'href'|'onClick'>){return <a href={to} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(to);}}} {...rest}>{children}</a>;}
export function AccountEntryPage({navigate,returnTo=location.pathname+location.search+location.hash}:{navigate:Go;returnTo?:string}){
 const model=useAccountSessionModel();
 return <section className="account-entry-page"><header><h1>{model.phase==='signed-out'?'登录银河':'我的账户'}</h1></header><OfficialAccountStatus model={model} navigate={navigate} returnTo={returnTo} compact/></section>;
}
export function SettingsLayout(props:LayoutProps){return <AccountSessionScope endpoint={props.endpoint}><AccountLayout {...props}/></AccountSessionScope>;}
function AccountLayout({path,search,endpoint,navigate,children}:LayoutProps){
 const model=useAccountSessionModel(),connection=useAccountConnection(endpoint,model),parameters=new URLSearchParams(search),view=parameters.get('view'),section=parameters.get('section');
 const signedIn=model.phase==='signed-in'&&!!model.session?.account.id;
 const preserveDraft=!!connection.session?.account.id&&['offline','unavailable'].includes(model.phase);
 if(!signedIn&&!preserveDraft)return <AccountEntryPage navigate={navigate} returnTo={path+search+location.hash}/>;
 const current=path==='/app/community'&&section==='owned'?'posts':path==='/app/bookmarks'?'bookmarks':path==='/app/settings/identity'||section==='access'?'local':path==='/app/account'&&section==='settings'&&!['work','archives'].includes(view??'')?'settings':'overview';
 const links=[{key:'overview',to:'/app/account',label:'概览',icon:Home},{key:'posts',to:'/app/community?section=owned',label:'我的帖子',icon:MessageSquare},{key:'bookmarks',to:'/app/bookmarks',label:'收藏',icon:Bookmark},{key:'settings',to:'/app/account?section=settings',label:'设置',icon:Settings},{key:'local',to:'/app/account?section=access',label:'本机银河',icon:Laptop}];
 return <div className={'settings-layout selected-account-layout'+(!signedIn?' account-without-directory':'')}>
  {signedIn&&<aside className="settings-sidebar selected-account-sidebar"><h2>账户</h2><nav aria-label="账户栏目">{links.map(({key,to,label,icon:Icon})=><NavLink key={key} to={to} navigate={navigate} aria-current={current===key?'page':undefined}><Icon size={19}/>{label}</NavLink>)}</nav></aside>}
  <div className="settings-content selected-account-content">{children}</div>
 </div>;
}

type AccountProps={endpoint?:string;navigate:Go};
export function AccountOverview(props:AccountProps){return <AccountSessionScope endpoint={props.endpoint}><AccountOverviewContent navigate={props.navigate}/></AccountSessionScope>;}
function AccountOverviewContent({navigate}:{navigate:Go}){
 const model=useAccountSessionModel();
 if(model.phase!=='signed-in'||!model.session?.account.id)return <AccountEntryPage navigate={navigate}/>;
 const account=model.session.account,label=account.displayName||account.email||'我的账户';
 return <section className="profile-overview selected-account"><header className="profile-heading"><h1 className="small">我的内容</h1></header>
  <section className="account-person"><span className="account-person-avatar" aria-hidden="true">{account.displayName?Array.from(account.displayName)[0]:<UserRound size={30}/>}</span><div><h2>{label}</h2>{account.displayName&&account.email&&<p>{account.email}</p>}<div className="account-person-actions"><NavLink to="/app/account?section=settings" navigate={navigate}>编辑资料</NavLink><button type="button" disabled={model.busy} onClick={()=>void model.logout()}>退出账户</button></div></div></section>
  <div className="account-overview-grid"><AccountRecentPosts key={account.id} model={model} navigate={navigate}/><section className="account-content-index"><h2>继续阅读</h2><nav aria-label="我的内容"><NavLink to="/app/bookmarks" navigate={navigate}><Bookmark size={21}/><span>我的收藏</span></NavLink><NavLink to="/app/work" navigate={navigate}><BriefcaseBusiness size={21}/><span>我的工作</span></NavLink><NavLink to="/app/account?section=settings&view=archives" navigate={navigate}><FileText size={21}/><span>私有会话</span></NavLink></nav></section></div>
 </section>;
}
function AccountRecentPosts({model,navigate}:{model:OfficialAccountModel;navigate:Go}){
 const [posts,setPosts]=useState<ForumCardView[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0),[now,setNow]=useState(()=>Math.floor(Date.now()/1000));
 const session=model.session,client=model.client,phase=model.phase,accountId=session?.account.id,csrfToken=session?.csrfToken,tasks=useReadTasks(accountId+':'+csrfToken);
 useEffect(()=>{
  let active=true;
  const read=async()=>{
   await Promise.resolve();if(!active)return;
   if(phase!=='signed-in'||!session?.account.id||!client){tasks.cancel();setPosts([]);setLoading(false);return;}
   await tasks.run({lane:'posts',key:String(revision)},({signal})=>client.call('/v2/community/posts/owned',{}, {session,signal}) as Promise<{items:ForumCardView[]}>,{onStart:()=>setLoading(true),onSuccess:value=>{setPosts(value.items??[]);setError('');setNow(Math.floor(Date.now()/1000));},onError:()=>{setPosts([]);setError('帖子暂时无法加载。');},onSettled:()=>setLoading(false)});
  };
  void read();return()=>{active=false;tasks.cancel('posts');};
 },[client,phase,session,revision,tasks]);
 useEffect(()=>{const refresh=()=>{if(!document.hidden&&navigator.onLine!==false){setNow(Math.floor(Date.now()/1000));setRevision(value=>value+1);}};window.addEventListener('online',refresh);window.addEventListener('focus',refresh);return()=>{window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);};},[]);
 const expiry=Math.min(...posts.flatMap(value=>value.availability==='available'&&typeof value.publishedUntil==='number'?[value.publishedUntil]:[]));
 useEffect(()=>{if(!Number.isFinite(expiry))return;const timer=setTimeout(()=>{const current=Math.floor(Date.now()/1000);setNow(current);setPosts(old=>old.map(value=>typeof value.publishedUntil==='number'&&value.publishedUntil<=current?{...value,payload:undefined,availability:'expired'}:value));setRevision(value=>value+1);},Math.min(2147483647,Math.max(0,expiry*1000-Date.now()+1)));return()=>clearTimeout(timer);},[expiry]);
 return <section className="account-recent-posts" aria-busy={loading}><header><h2>我的帖子</h2><NavLink to="/app/community?compose=post" navigate={navigate} className="primary-action"><Pencil size={15}/>写帖子</NavLink></header>
  <LoadingFeedback active={loading} label="正在加载帖子…" scopeKey={accountId??''}/>{error?<ReadFailure message={error} onRetry={()=>setRevision(value=>value+1)} retrying={loading}/>:posts.length?<ul>{posts.slice(0,4).map(value=>{const readable=availableForumContent(value,now);return <li key={value.locator.postId}><NavLink to={'/app/community/posts/'+value.locator.postId+'?manage=1'} navigate={navigate}><strong>{readable?value.payload.title:'state'in value&&value.state==='withdrawn'?'已撤回的帖子':'当前不可读取的帖子'}</strong>{readable&&<p>{value.payload.body.replace(/\s+/g,' ').slice(0,180)}</p>}</NavLink>{value.updatedAt&&<time>{new Date(value.updatedAt*1000).toLocaleDateString('zh-CN')}</time>}</li>;})}</ul>:!loading&&<p className="account-content-empty">还没有帖子，写下想分享的内容吧。</p>}
  {posts.length>0&&<NavLink to="/app/community?section=owned" navigate={navigate} className="text-link">全部帖子</NavLink>}
 </section>;
}
export function WorkOverview(props:AccountProps){return <AccountSessionScope endpoint={props.endpoint}><WorkOverviewContent {...props}/></AccountSessionScope>;}
function WorkOverviewContent({endpoint,navigate}:AccountProps){
 const official=useAccountSessionModel(),{session,authority}=useAccountConnection(endpoint,official),source=official.client,ownerId=session?.account.id,csrfToken=session?.csrfToken;
 const readCloud=useCallback<AccountWorkCall>(async(path,input,method='POST',options)=>{
  const live=authority.requireSession(ownerId,csrfToken);
  if(!source)throw Object.assign(Error('official_account_unavailable'),{code:'official_account_unavailable'});
  return source.call(path,input,{method,session:live,signal:options?.signal});
 },[authority,ownerId,csrfToken,source]);
 if(!session?.account.id)return <AccountEntryPage navigate={navigate} returnTo="/app/work"/>;
 return <section className="personal-work"><header className="profile-heading"><h1 className="small">我的工作</h1><NavLink to="/app/publish" navigate={navigate} className="primary-action">发起求助</NavLink></header>
  <nav className="work-filter-links" aria-label="我的工作内容">{[['/app/participate?view=requested','我发起的'],['/app/participate?view=participating','我参与的'],['/app/projects?section=projects','我的项目'],['/app/capsules?mode=author','我的方法'],['/app/account?section=settings&view=archives','私有会话']].map(([to,title])=><NavLink key={to} to={to} navigate={navigate}>{title}</NavLink>)}</nav>
  <AccountWorkHistory key={endpoint+':'+session.account.id+':'+session.csrfToken} accountId={session.account.id} call={readCloud} available={official.phase==='signed-in'}/>
 </section>;
}
