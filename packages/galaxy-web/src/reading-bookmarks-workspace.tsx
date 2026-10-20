import React,{createContext,useContext,useEffect,useEffectEvent,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Bookmark,BookmarkCheck,MessageCircle,FileText} from 'lucide-react';
import type {z} from 'zod/v4';
import {createAccountReadingBookmarksClient} from './reading-bookmarks-client.mjs';
import {readingBookmarkReferenceSchema,readingBookmarkStateSchema,readingBookmarksPageSchema,readingBookmarkKey,readingBookmarkPath} from '../../galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs';
import {directoryReadingState,rememberDirectoryReading,restoreDirectoryReading} from './directory-reading-state.mjs';
import {useOfficialAccountSession,OfficialAccountStatus} from './official-account-panel';
import {rememberBookmarkLogin,readBookmarkLogin,claimBookmarkLogin,finishBookmarkLogin} from './account-bookmark-pending.mjs';
import {useReadTasks} from './use-read-task';
import {LoadingFeedback,ReadFailure} from './interaction-feedback';
import './reading-bookmarks.css';

export type ReadingBookmarkReference=z.infer<typeof readingBookmarkReferenceSchema>;
export type ReadingBookmarksRuntime={api:{endpoint:string}};
type BookmarkState=z.infer<typeof readingBookmarkStateSchema>;
type BookmarkRow=z.infer<typeof readingBookmarksPageSchema>['items'][number];
type AccountModel=ReturnType<typeof useOfficialAccountSession>;
type BookmarkClient=ReturnType<typeof createAccountReadingBookmarksClient>;
type ContextProps={runtime:ReadingBookmarksRuntime|null;connected:boolean;subjectId?:string;onNeedIdentity?:()=>void;account?:AccountModel};
const titles={'forum-post':'帖子',capsule:'方法',project:'项目',person:'人物资料','chat-message':'私聊消息'};
const kinds:ReadingBookmarkReference['kind'][]=['forum-post','chat-message','capsule','project','person'];
const AccountContext=createContext<AccountModel|null>(null);
export function ReadingBookmarksAccountProvider({account,children}:{account:AccountModel;children:React.ReactNode}){
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}
function errorText(error:unknown){
  const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
  if(['official_account_session_expired','official_account_changed'].includes(code))return '账户已变化，请重新登录后继续。';
  if(code==='reading_bookmark_source_unavailable')return '这份内容当前不可读取。';
  if(code==='reading_bookmark_changed')return '收藏已在另一处更新，请重试。';
  return error instanceof Error&&/[\u3400-\u9fff]/.test(error.message)?error.message:'暂时无法读取收藏，请稍后重试。';
}
function scopeOf(props:ContextProps,account:AccountModel|null){
  return JSON.stringify(['account',props.runtime?.api.endpoint,account?.session?.account.id,account?.session?.csrfToken]);
}
function useBookmarkClient(props:ContextProps,account:AccountModel|null):BookmarkClient|null{
  const accountClient=account?.client,accountId=account?.session?.account.id,token=account?.session?.csrfToken;
  const lease=useMemo(()=>({session:account?.session??null}),[accountClient,accountId,token]);
  useLayoutEffect(()=>{lease.session=account?.session??null;return()=>{lease.session=null;};},[lease,account?.session]);
  return useMemo(()=>{
    if(!accountClient||!accountId)return null;
    const endpoint=props.runtime?.api.endpoint??new URL(accountClient.loginUrl()).origin;
    return createAccountReadingBookmarksClient({client:accountClient,endpoint,getSession:()=>lease.session});
  },[props.runtime,accountClient,accountId,lease]);
}

type SaveProps=ContextProps&{reference:ReadingBookmarkReference;onChanged?:(state:BookmarkState)=>void;initialState?:BookmarkState};
export function SaveForLaterButton(props:SaveProps){
  const shared=useContext(AccountContext),account=props.account??shared;
  if(account)return <SaveForLaterSession key={scopeOf(props,account)+':'+readingBookmarkKey(props.reference)} {...props} model={account}/>;
  return <IndependentSaveButton {...props}/>;
}
function IndependentSaveButton(props:SaveProps){
  const account=useOfficialAccountSession(props.runtime?.api.endpoint);
  return <SaveForLaterSession key={scopeOf(props,account)+':'+readingBookmarkKey(props.reference)} {...props} model={account}/>;
}
function SaveForLaterSession(props:SaveProps&{model:AccountModel|null}){
  const {reference,onChanged,initialState,model}=props,client=useBookmarkClient(props,model);
  const [state,setState]=useState<BookmarkState|null>(initialState??null),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const displayed=initialState&&initialState.revision>(state?.revision??-1)?initialState:state;
  const alive=useRef(true),working=useRef(false),intentTried=useRef(false);
  async function refresh(){
    if(!client||working.current||navigator.onLine===false)return;
    working.current=true;
    try{
      await client.resumePending(reference);
      if(!intentTried.current){
        const intent=readBookmarkLogin();
        if(intent&&readingBookmarkKey(intent.reference)===readingBookmarkKey(reference)){
          intentTried.current=true;
          if(claimBookmarkLogin(intent,client.ownerId)){
            const previous=await client.status(reference);
            if(previous.saved===intent.saved)finishBookmarkLogin(intent,reference);
            else {const result=await client.setSaved(reference,intent.saved);if(result.state==='acknowledged')finishBookmarkLogin(intent,reference);}
          }
        }
      }
      const[value,records]=await Promise.all([client.status(reference),client.pending()]);client.current();
      if(alive.current){setState(value);setPending(records.some(row=>readingBookmarkKey(row.command.reference)===readingBookmarkKey(reference)));setError('');onChanged?.(value);}
    }catch(caught){if(alive.current)setError(errorText(caught));}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  const reread=useEffectEvent(()=>{if(!document.hidden)return refresh();});
  useEffect(()=>{
    alive.current=true;
    if(initialState)return()=>{alive.current=false;};
    void reread();
    const observe=()=>void reread(),timer=window.setInterval(observe,15000);
    window.addEventListener('focus',observe);window.addEventListener('online',observe);
    return()=>{alive.current=false;window.clearInterval(timer);window.removeEventListener('focus',observe);window.removeEventListener('online',observe);};
  },[client,!!initialState]);
  function login(){
    if(model?.phase!=='signed-out'||!model.client){void model?.refresh();return;}
    try{const target=rememberBookmarkLogin(reference,{saved:!(displayed?.saved??false)});location.assign(model.client.loginUrl('login',target));}catch(caught){setError(errorText(caught));}
  }
  async function change(retry=false){
    if(!client){login();return;}if(working.current)return;
    working.current=true;setBusy(true);setError('');const desired=!(displayed?.saved??false);
    try{
      if(retry){
        const record=(await client.pending()).find(row=>readingBookmarkKey(row.command.reference)===readingBookmarkKey(reference));
        const result=await client.retry(reference);
        if(record&&result?.state==='absent')await client.setSaved(reference,record.command.saved);
      }else{
        const result=await client.setSaved(reference,desired);client.current();
        if(alive.current&&result.state==='acknowledged'){setState(result.bookmark);onChanged?.(result.bookmark);}
      }
    }catch(caught){if(alive.current){setError(errorText(caught));
      if(caught&&typeof caught==='object'&&'code'in caught&&caught.code==='official_account_session_expired'&&model?.client){
        try{const target=rememberBookmarkLogin(reference,{saved:desired,accountId:client.ownerId});location.assign(model.client.loginUrl('login',target));}catch{void model.refresh();}
      }
    }}
    finally{working.current=false;if(alive.current){setBusy(false);void refresh();}}
  }
  return <span className="reading-bookmark-control">
    <button type="button" className="reading-bookmark-button" aria-pressed={displayed?.saved??false} disabled={busy||pending||!client&&model?.phase==='loading'} onClick={()=>void change()}>
      {displayed?.saved?<BookmarkCheck size={16}/>:<Bookmark size={16}/>}{busy?'正在保存…':displayed?.saved?'取消收藏':'收藏'}
    </button>
    {pending&&<span className="reading-bookmark-message">收藏正在保存。<button type="button" disabled={busy} onClick={()=>void change(true)}>重试</button></span>}
    {error&&<span className="reading-bookmark-message" role="status">{error}<button type="button" disabled={busy} onClick={()=>void change(true)}>重试</button></span>}
  </span>;
}

type WorkspaceProps=ContextProps&{navigate:(path:string)=>void;search?:string};
type Category=''|'community'|'private-chat';
function selection(search:string):{category:Category;kind:ReadingBookmarkReference['kind']|''}{
  const params=new URLSearchParams(search),raw=params.get('category');
  const category:Category=raw==='community'||raw==='private-chat'?raw:'';
  return {category,kind:kinds.find(value=>value===params.get('kind'))??''};
}
export function ReadingBookmarksWorkspace(props:WorkspaceProps){
  const shared=useContext(AccountContext),account=props.account??shared;
  return account?<BookmarksAccountWorkspace {...props} account={account}/>:<IndependentBookmarksWorkspace {...props}/>;
}
function IndependentBookmarksWorkspace(props:WorkspaceProps){
  const account=useOfficialAccountSession(props.runtime?.api.endpoint);
  return <BookmarksAccountWorkspace {...props} account={account}/>;
}
function BookmarksAccountWorkspace(props:WorkspaceProps&{account:AccountModel}){
  const {account,navigate}=props,search=props.search??location.search,{category,kind}=selection(search);
  if(account.phase!=='signed-in'||!account.session)return <section className="reading-bookmarks-page"><header><h1>我的收藏</h1></header><OfficialAccountStatus model={account} navigate={navigate} returnTo={'/app/bookmarks'+search}/></section>;
  return <ReadingBookmarksAccountProvider account={account}><ReadingBookmarksSession key={scopeOf(props,account)+':'+category+':'+kind} {...props} search={search} category={category} kind={kind}/></ReadingBookmarksAccountProvider>;
}
function ReadingBookmarksSession(props:WorkspaceProps&{account:AccountModel;search:string;category:Category;kind:ReadingBookmarkReference['kind']|''}){
  const {runtime,connected,subjectId,navigate,search,category,kind,account}=props,client=useBookmarkClient(props,account);
  const scope=JSON.stringify(['bookmarks',runtime?.api.endpoint,account.session?.account.id,category,kind]),tasks=useReadTasks(scope);
  const initial=directoryReadingState(scope),pages=useRef(initial.depth),restoring=useRef(!!initial.anchorId);
  const [items,setItems]=useState<BookmarkRow[]>([]),[next,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState('');
  const changes=useRef(new Map<string,BookmarkState>());
  function clearPreviews(){setItems(previous=>previous.map(item=>({...item,source:{state:'temporarily-unavailable',reason:'source-check-failed'}})));}
  async function read(more=false){
    if(!client)return;
    if(navigator.onLine===false){clearPreviews();setError('暂时离线，联网后自动恢复。');return;}
    await tasks.run({lane:'list',key:more?'after:'+next:'head'},async({signal})=>{
      await client.resumePending();const collected:BookmarkRow[]=[];let after=more?next:null,count=0;
      for(let page=0;page<(more?1:pages.current);page++){
        const input={...(kind?{kind}:{}),...(category?{category}:{}),...(after?{after}:{}),limit:20};
        const result=await client.query(input,{signal});client.current();
        collected.push(...result.items);count++;if(result.nextAfter===after&&after)throw Error('收藏暂时无法继续读取。');after=result.nextAfter;if(!after)break;
      }return {collected,after,count};
    },{onStart:()=>{setBusy(true);setError('');},onSuccess:({collected,after,count})=>{
      const now=Date.now();
      setItems(previous=>[...new Map((more?[...previous,...collected]:collected).map(item=>[readingBookmarkKey(item.reference),item])).values()]
        .filter(item=>{const changed=changes.current.get(readingBookmarkKey(item.reference));return !changed||changed.saved||changed.revision<item.revision;})
        .map(item=>item.source.state==='available'&&item.source.availableUntil*1000<=now?{...item,source:{state:'temporarily-unavailable',reason:'source-check-failed'}}:item));
      setNext(after);setReady(true);pages.current=more?pages.current+count:count;rememberDirectoryReading(scope,Math.max(1,pages.current),directoryReadingState(scope).anchorId);
    },onError:caught=>{clearPreviews();setError(errorText(caught));},onSettled:()=>setBusy(false)});
  }
  const refresh=useEffectEvent(()=>{if(!document.hidden)return read();});
  useEffect(()=>{
    void refresh();const observe=()=>void refresh(),offline=()=>{tasks.cancel();setBusy(false);clearPreviews();setError('暂时离线，联网后自动恢复。');},timer=window.setInterval(observe,15000);
    window.addEventListener('focus',observe);window.addEventListener('online',observe);window.addEventListener('offline',offline);
    return()=>{tasks.cancel();window.clearInterval(timer);window.removeEventListener('focus',observe);window.removeEventListener('online',observe);window.removeEventListener('offline',offline);};
  },[client,tasks]);
  useLayoutEffect(()=>{if(!ready||!restoring.current)return;restoring.current=false;return restoreDirectoryReading(scope);},[ready,scope]);
  useEffect(()=>{
    const deadlines=items.flatMap(item=>item.source.state==='available'?[item.source.availableUntil*1000]:[]);if(!deadlines.length)return;
    const timer=window.setTimeout(()=>{setItems(previous=>previous.map(item=>item.source.state==='available'&&item.source.availableUntil*1000<=Date.now()?{...item,source:{state:'temporarily-unavailable',reason:'source-check-failed'}}:item));void refresh();},Math.max(0,Math.min(...deadlines)-Date.now()));
    return()=>window.clearTimeout(timer);
  },[items]);
  function choose(value:Category){const params=new URLSearchParams(search);params.delete('kind');if(value)params.set('category',value);else params.delete('category');navigate('/app/bookmarks'+(params.size?'?'+params.toString():''));}
  function open(item:BookmarkRow){rememberDirectoryReading(scope,Math.max(1,pages.current),'directory-bookmarks-'+item.id);navigate(readingBookmarkPath(item.reference));}
  function changed(value:BookmarkState){changes.current.set(readingBookmarkKey(value.reference),value);if(!value.saved)setItems(previous=>previous.filter(item=>readingBookmarkKey(item.reference)!==readingBookmarkKey(value.reference)));}
  return <section className="reading-bookmarks-page"><header><p className="eyebrow">稍后回看</p><h1>我的收藏</h1></header>
    <nav className="reading-bookmarks-kinds" aria-label="收藏来源"><button type="button" aria-pressed={!category} onClick={()=>choose('')}>全部</button><button type="button" aria-pressed={category==='community'} onClick={()=>choose('community')}><FileText size={15}/>社区</button><button type="button" aria-pressed={category==='private-chat'} onClick={()=>choose('private-chat')}><MessageCircle size={15}/>私聊</button></nav>
    {!client?<ReadFailure message="收藏暂时无法读取。" onRetry={()=>void account.refresh()}/>:<>
      <LoadingFeedback active={busy} label={ready?'正在刷新收藏…':'正在读取收藏…'} scopeKey={scope}/>
      {error&&<ReadFailure message={error} onRetry={()=>void read()} retrying={busy}/>}
      {ready&&!items.length&&!error&&<div className="reading-bookmarks-empty"><Bookmark size={27}/><p>{category==='private-chat'?'还没有收藏私聊消息。':'还没有收藏内容。'}</p></div>}
      <ol className="reading-bookmarks-list">{items.map(item=>{
        const source=item.source,path=readingBookmarkPath(item.reference);
        return <li key={readingBookmarkKey(item.reference)} id={'directory-bookmarks-'+item.id}><div className="reading-bookmark-content"><p className="reading-bookmark-kind">{titles[item.reference.kind]}{item.savedAt?' · '+new Date(item.savedAt).toLocaleDateString('zh-CN'):''}</p>
          {source.state==='available'?<><h2><a href={path} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();open(item);}}}>{source.title||titles[item.reference.kind]}</a></h2><p className="reading-bookmark-summary">{source.summary}</p>{source.revision&&source.revision>1&&<span className="reading-bookmark-kind">已编辑</span>}</>:<><h2>收藏的{titles[item.reference.kind]}</h2><p className="reading-bookmark-unavailable">{source.state==='temporarily-unavailable'?'暂时无法读取原文。':source.reason==='source-withdrawn'?'原内容已撤回。':source.reason==='source-expired'?'原内容已到期。':'原内容当前不可读取。'}</p></>}
        </div><SaveForLaterButton runtime={runtime} connected={connected} subjectId={subjectId} account={account} reference={item.reference} initialState={item} onChanged={changed}/></li>;
      })}</ol>{next&&<button className="load-more" type="button" disabled={busy} onClick={()=>void read(true)}>{busy?'正在读取…':'更早的收藏'}</button>}
    </>}
  </section>;
}
