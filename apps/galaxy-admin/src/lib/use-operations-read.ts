'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {operationsFailure,operationsMayRetryRead,operationsRequest,OperationsRequestError} from './operations-client';
import {useClientReady} from './use-client-ready';
import {operationsReadsSuspended,operationsReadServerSnapshot,subscribeOperationsReadLifecycle} from './operations-read-lifecycle';

type ReadState<T>={path:string|null;value:T|null;loading:boolean;refreshing:boolean;error:string;checkedAt:number|null;attemptedAt:number|null};
function sourceCheckedAt(value:unknown){
  return value&&typeof value==='object'&&'checkedAt' in value&&typeof value.checkedAt==='number'&&Number.isFinite(value.checkedAt)?value.checkedAt*1000:null;
}
function expiresAt(value:unknown,checkedAt:number|null){
  if(value&&typeof value==='object'&&'readExpiresAt' in value&&typeof value.readExpiresAt==='number'&&Number.isFinite(value.readExpiresAt))return value.readExpiresAt*1000;
  return checkedAt===null?0:checkedAt+30000;
}
const readRetryDelays=[1000,3000] as const;
function waitForReadRetry(delay:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delay);
    signal.addEventListener('abort',abort,{once:true});
  });
}
export function useOperationsRead<T>({path,initial=null,initialError='',failureMessage,clearOnOffline=false,retryUnavailable=false,renewBeforeMs}:{path:string|null;initial?:T|null;initialError?:string;failureMessage:string;clearOnOffline?:boolean;retryUnavailable?:boolean;renewBeforeMs?:number}){
  // Hydration must render the exact server snapshot, even when downloading JS
  // outlives its lease. Only the mounted client can validate or renew that lease.
  const ready=useClientReady();
  const logoutPending=useSyncExternalStore(subscribeOperationsReadLifecycle,operationsReadsSuspended,operationsReadServerSnapshot),resumeFresh=useRef(false);
  const [state,setState]=useState<ReadState<T>>(()=>({path,value:initial,loading:!!path&&!initial&&!initialError,refreshing:false,error:initialError,checkedAt:sourceCheckedAt(initial),attemptedAt:null}));
  const retryable=useRef(false),active=useRef<AbortController|null>(null),inFlight=useRef<{path:string;controller:AbortController;promise:Promise<T|undefined>}|null>(null),generation=useRef(0),alive=useRef(false);
  const performRead=useCallback((background=false):Promise<T|undefined>=>{
    if(!path||!alive.current||operationsReadsSuspended())return Promise.resolve(undefined);
    if(background&&inFlight.current?.path===path&&!inFlight.current.controller.signal.aborted)return inFlight.current.promise;
    active.current?.abort();const controller=new AbortController(),version=++generation.current;active.current=controller;retryable.current=false;
    setState(previous=>{
      const keep=previous.path===path&&(!clearOnOffline||expiresAt(previous.value,previous.checkedAt)>Date.now()),value=keep?previous.value:null;
      return{path,value,loading:value===null,refreshing:true,error:'',checkedAt:keep?previous.checkedAt:null,attemptedAt:Date.now()};
    });
    const promise=(async()=>{
      try{
        let value:T;
        for(let retry=0;;retry++){
          try{value=await operationsRequest<T>(path,{signal:controller.signal});break;}
          catch(error){
            // Ordinary leased reads get a small transport-only recovery budget.
            // The explicit long-running recovery surface keeps its existing policy.
            if(!clearOnOffline||retryUnavailable||retry>=readRetryDelays.length||!operationsMayRetryRead(error)||!alive.current||controller.signal.aborted||operationsReadsSuspended()||version!==generation.current||!navigator.onLine||document.visibilityState!=='visible')throw error;
            await waitForReadRetry(readRetryDelays[retry],controller.signal);
            if(!alive.current||controller.signal.aborted||operationsReadsSuspended()||version!==generation.current||!navigator.onLine||document.visibilityState!=='visible')throw error;
          }
        }
        if(!alive.current||controller.signal.aborted||operationsReadsSuspended()||version!==generation.current)return undefined;
        const now=Date.now();
        if(clearOnOffline&&expiresAt(value,now)<=now)throw new OperationsRequestError(410,'operations_read_expired');
        setState({path,value,loading:false,refreshing:false,error:'',checkedAt:now,attemptedAt:now});return value;
      }catch(error){
        if(!alive.current||controller.signal.aborted||operationsReadsSuspended()||version!==generation.current)return undefined;
        const invalidated=error instanceof OperationsRequestError&&error.status>=400&&error.status<500&&![408,429].includes(error.status);
        retryable.current=!invalidated;
        setState(previous=>{
          const keep=!invalidated&&previous.path===path&&(!clearOnOffline||expiresAt(previous.value,previous.checkedAt)>Date.now());
          return{path,value:keep?previous.value:null,loading:false,refreshing:false,error:operationsFailure(error,failureMessage),checkedAt:keep?previous.checkedAt:null,attemptedAt:previous.attemptedAt};
        });return undefined;
      }finally{
        if(active.current===controller)active.current=null;
        if(inFlight.current?.controller===controller)inFlight.current=null;
      }
    })();
    inFlight.current={path,controller,promise};return promise;
  },[path,failureMessage,clearOnOffline,retryUnavailable]);
  const read=useCallback(()=>performRead(),[performRead]);
  const renew=useCallback(()=>performRead(true),[performRead]);
  const clear=useCallback(()=>{generation.current++;active.current?.abort();active.current=null;inFlight.current=null;setState({path,value:null,loading:false,refreshing:false,error:'',checkedAt:null,attemptedAt:null});},[path]);
  useLayoutEffect(()=>{
    alive.current=true;
    return()=>{alive.current=false;generation.current++;active.current?.abort();active.current=null;inFlight.current=null;};
  },[path]);
  useLayoutEffect(()=>{
    // A soft navigation can supply a fresh snapshot for another object. Adopt
    // it before deciding whether a request is needed; otherwise the old path
    // stays masked until its renewal timer fires. Keep the source's own lease.
    setState(previous=>previous.path===path?previous:{path,value:initial,loading:!!path&&!initial&&!initialError,refreshing:false,error:initialError,checkedAt:sourceCheckedAt(initial),attemptedAt:null});
  },[path,initial,initialError]);
  useLayoutEffect(()=>{
    if(!logoutPending)return;
    resumeFresh.current=true;clear();
  },[logoutPending,clear]);
  useEffect(()=>{
    if(!path||logoutPending)return;
    const offline=()=>{generation.current++;active.current?.abort();active.current=null;inFlight.current=null;setState(previous=>({path,value:!clearOnOffline&&previous.path===path?previous.value:null,loading:false,refreshing:false,error:'网络已断开，恢复后可继续读取。',checkedAt:null,attemptedAt:null}));};
    const visible=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void performRead(true);};
    const initialFresh=initial!==null&&(!clearOnOffline||expiresAt(initial,sourceCheckedAt(initial))>Date.now());
    const freshAfterFailure=resumeFresh.current;resumeFresh.current=false;
    if(!navigator.onLine)offline();else if((freshAfterFailure||!initialFresh||sourceCheckedAt(initial)===null)&&document.visibilityState==='visible')void performRead(true);
    window.addEventListener('offline',offline);window.addEventListener('online',visible);window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',visible);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
  },[path,initial,read,performRead,clearOnOffline,clear,logoutPending]);
  useEffect(()=>{
    if(!ready||logoutPending||!clearOnOffline||state.value===null||state.checkedAt===null)return;
    // Mask the expired snapshot without cancelling an already-running renewal.
    // The response must still supply its own current lease before it can appear.
    const end=expiresAt(state.value,state.checkedAt),timer=setTimeout(()=>{
      setState(previous=>previous.path===path&&expiresAt(previous.value,previous.checkedAt)<=Date.now()?{...previous,value:null,checkedAt:null,loading:previous.refreshing}:previous);
      if(navigator.onLine&&document.visibilityState==='visible')void performRead(true);
    },Math.max(0,end-Date.now()));
    return()=>clearTimeout(timer);
  },[ready,clearOnOffline,state.value,state.checkedAt,path,performRead,logoutPending]);
  useEffect(()=>{
    if(!ready||logoutPending||!clearOnOffline||state.value===null||state.checkedAt===null||state.refreshing)return;
    const end=expiresAt(state.value,state.checkedAt);if(end<=Date.now())return;
    const usualLead=Math.min(5000,Math.max(250,(end-state.checkedAt)*.2));
    // A slow current-conversation read needs time to finish before the source
    // expires. This only starts its GET earlier; the original expiry still wins.
    const earlyLead=typeof renewBeforeMs==='number'&&Number.isFinite(renewBeforeMs)?Math.max(0,Math.min(20000,renewBeforeMs)):0;
    const lead=Math.max(usualLead,Math.min(earlyLead,Math.max(250,(end-state.checkedAt)*.8))),next=Math.max(end-lead,(state.attemptedAt??state.checkedAt)+3000);
    const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void performRead(true);},Math.max(0,next-Date.now()));
    return()=>clearTimeout(timer);
  },[ready,clearOnOffline,state.value,state.checkedAt,state.attemptedAt,state.refreshing,performRead,logoutPending,renewBeforeMs]);
  useEffect(()=>{
    // Opt-in for a long-running operation's read surface. A transient API
    // outage can outlive a lease; keep the original GET recoverable without
    // retaining expired material or permitting a second command.
    if(logoutPending||!retryUnavailable||!path||state.path!==path||state.value!==null||state.loading||state.refreshing||!state.error||!retryable.current)return;
    const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void performRead(true);},4000);
    return()=>clearTimeout(timer);
  },[retryUnavailable,path,state.path,state.value,state.loading,state.refreshing,state.error,state.attemptedAt,performRead,logoutPending]);
  const current=state.path===path?state:{path,value:null,loading:!!path,refreshing:false,error:'',checkedAt:null,attemptedAt:null};
  const valid=!ready||!clearOnOffline||expiresAt(current.value,current.checkedAt)>Date.now();
  return{...current,value:!logoutPending&&valid?current.value:null,loading:!logoutPending&&current.loading,refreshing:!logoutPending&&current.refreshing,error:logoutPending?'':current.error,read,renew,clear,ready,verified:!logoutPending&&ready&&valid&&current.checkedAt!==null};
}
