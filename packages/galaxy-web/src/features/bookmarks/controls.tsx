import React,{createContext,useContext,useEffect,useEffectEvent,useLayoutEffect,useMemo,useRef,useState} from "react";
import {Bookmark,BookmarkCheck} from "lucide-react";
import type {z} from "zod/v4";
import {createAccountReadingBookmarksClient} from "./client.mjs";
import {createPublicCommunityFeedback} from "../discovery/public-feedback.mjs";
import {readingBookmarkReferenceSchema,readingBookmarkStateSchema,readingBookmarkKey} from "../../../../galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs";
import {useOfficialAccountSession} from "../accounts/official-account-panel";
import {rememberBookmarkLogin,readBookmarkLogin,claimBookmarkLogin,finishBookmarkLogin} from "./account-bookmark-pending.mjs";
import './workspace.css';

// One shared account context and the original save control; this module does not import the full bookmarks page.
export type ReadingBookmarkReference=z.infer<typeof readingBookmarkReferenceSchema>;

export type ReadingBookmarksRuntime={api:{endpoint:string}};

export type BookmarkState=z.infer<typeof readingBookmarkStateSchema>;

export type AccountModel=ReturnType<typeof useOfficialAccountSession>;

type BookmarkClient=ReturnType<typeof createAccountReadingBookmarksClient>;

export type ContextProps={runtime:ReadingBookmarksRuntime|null;connected:boolean;subjectId?:string;onNeedIdentity?:()=>void;account?:AccountModel};

export const AccountContext=createContext<AccountModel|null>(null);

export function ReadingBookmarksAccountProvider({account,children}:{account:AccountModel;children:React.ReactNode}){
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

export function errorText(error:unknown){
  const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
  if(['official_account_session_expired','official_account_changed'].includes(code))return '账户已变化，请重新登录后继续。';
  if(code==='reading_bookmark_source_unavailable')return '这份内容当前不可读取。';
  if(code==='reading_bookmark_changed')return '收藏已在另一处更新，请重试。';
  return error instanceof Error&&/[\u3400-\u9fff]/.test(error.message)?error.message:'暂时无法读取收藏，请稍后重试。';
}

export function scopeOf(props:ContextProps,account:AccountModel|null){
  return JSON.stringify(['account',props.runtime?.api.endpoint,account?.session?.account.id,account?.session?.csrfToken]);
}

export function useBookmarkClient(props:ContextProps,account:AccountModel|null):BookmarkClient|null{
  const accountClient=account?.client,accountId=account?.session?.account.id,token=account?.session?.csrfToken;
  const leaseKey=JSON.stringify([accountId,token]);
  const lease=useMemo(()=>({key:leaseKey,client:accountClient,session:null as AccountModel['session']}),[accountClient,leaseKey]);
  useLayoutEffect(()=>{lease.session=account?.session??null;return()=>{lease.session=null;};},[lease,account?.session]);
  return useMemo(()=>{
    if(!accountClient||!accountId)return null;
    const endpoint=props.runtime?.api.endpoint??new URL(accountClient.loginUrl()).origin;
    const feedback=createPublicCommunityFeedback({endpoint,accountId,websiteOrigin:location.origin});
    return createAccountReadingBookmarksClient({client:accountClient,endpoint,getSession:()=>lease.session,onAcknowledged:feedback.bookmark});
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
  const hasInitialState=!!initialState;
  const reread=useEffectEvent(()=>{if(!document.hidden)return refresh();});
  useEffect(()=>{
    alive.current=true;
    if(hasInitialState)return()=>{alive.current=false;};
    void reread();
    const observe=()=>void reread(),timer=window.setInterval(observe,15000);
    window.addEventListener('focus',observe);window.addEventListener('online',observe);
    return()=>{alive.current=false;window.clearInterval(timer);window.removeEventListener('focus',observe);window.removeEventListener('online',observe);};
  },[client,hasInitialState]);
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
    {error&&<output className="reading-bookmark-message" >{error}<button type="button" disabled={busy} onClick={()=>void change(true)}>重试</button></output>}
  </span>;
}
