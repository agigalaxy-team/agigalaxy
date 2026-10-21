'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {operationsFailure,operationsRequest,OperationsRequestError} from './operations-client';

type ReadState<T>={path:string|null;value:T|null;loading:boolean;error:string;checkedAt:number|null};
export function useOperationsRead<T>({path,initial=null,initialError='',failureMessage,clearOnOffline=false}:{path:string|null;initial?:T|null;initialError?:string;failureMessage:string;clearOnOffline?:boolean}){
  const [state,setState]=useState<ReadState<T>>(()=>({path,value:initial,loading:false,error:initialError,checkedAt:initial?Date.now():null}));
  const active=useRef<AbortController|null>(null),generation=useRef(0),alive=useRef(false);
  const read=useCallback(async():Promise<T|undefined>=>{
    if(!path||!alive.current)return undefined;
    active.current?.abort();const controller=new AbortController(),version=++generation.current;active.current=controller;
    setState(previous=>({path,value:previous.path===path?previous.value:null,loading:true,error:'',checkedAt:previous.path===path?previous.checkedAt:null}));
    try{
      const value=await operationsRequest<T>(path,{signal:controller.signal});
      if(!alive.current||controller.signal.aborted||version!==generation.current)return undefined;
      setState({path,value,loading:false,error:'',checkedAt:Date.now()});return value;
    }catch(error){
      if(!alive.current||controller.signal.aborted||version!==generation.current)return undefined;
      const denied=error instanceof OperationsRequestError&&[401,403].includes(error.status);
      setState(previous=>({path,value:!denied&&!clearOnOffline&&previous.path===path?previous.value:null,loading:false,error:operationsFailure(error,failureMessage),checkedAt:null}));return undefined;
    }finally{if(active.current===controller)active.current=null;}
  },[path,failureMessage,clearOnOffline]);
  const clear=useCallback(()=>{generation.current++;active.current?.abort();active.current=null;setState({path,value:null,loading:false,error:'',checkedAt:null});},[path]);
  useLayoutEffect(()=>{
    alive.current=true;
    return()=>{alive.current=false;generation.current++;active.current?.abort();active.current=null;};
  },[path]);
  useEffect(()=>{
    if(!path)return;
    const offline=()=>{generation.current++;active.current?.abort();active.current=null;setState(previous=>({path,value:!clearOnOffline&&previous.path===path?previous.value:null,loading:false,error:'网络已断开，恢复后可继续读取。',checkedAt:null}));};
    const visible=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void read();else if(clearOnOffline&&document.visibilityState==='hidden')clear();};
    if(!navigator.onLine)offline();else if(clearOnOffline&&document.visibilityState==='hidden')clear();else if(!initial)void read();
    window.addEventListener('offline',offline);window.addEventListener('online',visible);window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',visible);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
  },[path,initial,read,clearOnOffline,clear]);
  useEffect(()=>{if(!clearOnOffline||!state.value||state.checkedAt===null)return;const timer=setTimeout(()=>{clear();if(navigator.onLine&&document.visibilityState==='visible')void read();},Math.max(0,state.checkedAt+30000-Date.now()));return()=>clearTimeout(timer);},[clearOnOffline,state.value,state.checkedAt,clear,read]);
  const current=state.path===path?state:{path,value:null,loading:!!path,error:'',checkedAt:null};
  return {...current,read,clear,verified:current.checkedAt!==null&&!current.error};
}
