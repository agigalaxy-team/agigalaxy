'use client';

import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {type AgentOsDomain} from './agentos-client';
import {conversationEventStream} from './conversation-stream';
import {OperationsRequestError} from './operations-client';

type StreamView={binding:string;operationId:string|null;text:string;phase:'waiting'|'working'|'generating';stopAvailable:boolean;finished:boolean;readExpiresAt:number};
const empty=(binding=''):StreamView=>({binding,operationId:null,text:'',phase:'waiting',stopAvailable:false,finished:false,readExpiresAt:0});
const documentIsHidden=()=>document.visibilityState==='hidden';
type Props={operatorId:string|null;csrfToken:string;domain:AgentOsDomain;operationId:string|null;enabled:boolean;readExpiresAt:number;onResync:()=>void|Promise<unknown>;onDenied:()=>void;onContextChanged:()=>void};

export function useConversationStream({operatorId,csrfToken,domain,operationId,enabled,readExpiresAt,onResync,onDenied,onContextChanged}:Props){
 const binding=JSON.stringify([operatorId,csrfToken,domain,operationId]);
 const data=useRef<StreamView&{cursor:number}>({...empty(),cursor:-1}),callbacks=useRef({onResync,onDenied,onContextChanged});
 const [view,setView]=useState<StreamView>(empty);
 useLayoutEffect(()=>{callbacks.current={onResync,onDenied,onContextChanged};});
 useEffect(()=>{
  let alive=true,active:AbortController|null=null,reconnect:ReturnType<typeof setTimeout>|undefined,publishTimer:ReturnType<typeof setTimeout>|undefined,expiryTimer:ReturnType<typeof setTimeout>|undefined,connecting=false,ended=false,failures=0;
  const publish=()=>{if(alive)setView({...data.current});};
  const flush=()=>{clearTimeout(publishTimer);publishTimer=undefined;publish();};
  const schedulePublish=()=>{if(!publishTimer)publishTimer=setTimeout(flush,100);};
  const clear=()=>{data.current={...empty(binding),cursor:-1};flush();};
  if(!enabled||!operatorId||!csrfToken||!operationId||readExpiresAt<=Math.floor(Date.now()/1000)){
   clear();return()=>{alive=false;clearTimeout(publishTimer);};
  }
  if(data.current.binding!==binding)data.current={...empty(binding),operationId,cursor:-1};
  data.current.operationId=operationId;data.current.readExpiresAt=readExpiresAt;publish();
  const reread=()=>{void Promise.resolve(callbacks.current.onResync()).catch(()=>{});};
  const lease=(until:number)=>{
   data.current.readExpiresAt=Math.min(readExpiresAt,until);
   clearTimeout(expiryTimer);
   expiryTimer=setTimeout(()=>{ended=true;active?.abort();clear();reread();},Math.max(0,data.current.readExpiresAt*1000-Date.now()));
  };
  lease(readExpiresAt);
  const observe=async()=>{
   if(!alive||ended||connecting||!navigator.onLine||documentIsHidden()||data.current.readExpiresAt*1000<=Date.now())return;
   connecting=true;const controller=new AbortController();active=controller;let hasLease=false;
   try{
    for await(const event of conversationEventStream(domain,operationId,{after:data.current.cursor,signal:controller.signal})){
     if(!alive||controller.signal.aborted)return;
     if(event.kind==='lease'){
      hasLease=true;lease(event.readExpiresAt);data.current.stopAvailable=event.stopAvailable;
      if(data.current.readExpiresAt*1000<=Date.now()){ended=true;clear();reread();return;}
      failures=0;flush();continue;
     }
     if(!hasLease)throw new OperationsRequestError(503,'operations_agentos_response_invalid');
     if('readExpiresAt'in event&&typeof event.readExpiresAt==='number')lease(Math.min(data.current.readExpiresAt,event.readExpiresAt));
     if(data.current.readExpiresAt*1000<=Date.now()){ended=true;clear();reread();return;}
     if(event.eventIndex!==null)data.current.cursor=event.eventIndex;
     if(event.kind==='text'){data.current.text+=event.text;data.current.phase='generating';schedulePublish();}
     else if(event.kind==='reset'){data.current.text='';data.current.phase='working';flush();}
     else if(event.kind==='phase'){data.current.phase=event.phase;schedulePublish();}
     else if(event.kind==='blocked'){ended=true;clear();callbacks.current.onDenied();return;}
     else if(event.kind==='context-changed'){ended=true;clear();callbacks.current.onContextChanged();reread();return;}
     else if(event.kind==='terminal'){
      ended=true;data.current.finished=true;data.current.stopAvailable=false;if(event.status==='ERROR')data.current.text='';flush();reread();return;
     }else if(event.kind==='resync'){data.current.phase='waiting';flush();reread();break;}
    }
   }catch(error){
    if(!alive||controller.signal.aborted)return;
    if(error instanceof OperationsRequestError&&[401,403].includes(error.status)){ended=true;clear();callbacks.current.onDenied();return;}
    if(error instanceof OperationsRequestError&&error.status===409){ended=true;clear();callbacks.current.onContextChanged();reread();return;}
    failures++;data.current.phase='waiting';flush();reread();
   }finally{
    if(active===controller)active=null;connecting=false;
    if(alive&&!ended&&navigator.onLine&&!documentIsHidden()&&data.current.readExpiresAt*1000>Date.now()){
     reread();reconnect=setTimeout(()=>void observe(),Math.min(8000,1000*2**Math.min(failures,3)));
    }
   }
  };
  const offline=()=>{active?.abort();clearTimeout(reconnect);clear();};
  const resume=()=>{if(documentIsHidden()){active?.abort();return;}reread();if(navigator.onLine)void observe();};
  window.addEventListener('offline',offline);window.addEventListener('online',resume);window.addEventListener('focus',resume);document.addEventListener('visibilitychange',resume);
  void observe();
  return()=>{alive=false;active?.abort();clearTimeout(reconnect);clearTimeout(publishTimer);clearTimeout(expiryTimer);window.removeEventListener('offline',offline);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);};
 },[binding,enabled,readExpiresAt,operatorId,csrfToken,domain,operationId]);
 return enabled&&view.binding===binding&&view.operationId===operationId&&view.readExpiresAt*1000>Date.now()?view:empty(binding);
}
