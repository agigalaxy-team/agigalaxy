'use client';

import {Fragment,createContext,useCallback,useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ReactNode,RefObject} from 'react';
import {SettingsDraftLinkActivationContext} from '../lib/settings-draft-link-activation';
import {flushSync} from 'react-dom';
import {Form,LeaveWithoutSaving,useAuth,useForm,useModal} from '@payloadcms/ui';
import {usePathname,useSearchParams} from 'next/navigation';
import {settingsDraftMemory,settingsOperatorId,type SettingsDraftSession} from '../lib/settings-draft-memory';
import {SettingsDraftMemoryContext} from '../lib/use-settings-draft-memory';
import './settings-draft.css';

type DraftState={dirty:boolean;pending:boolean};
const DraftContext=createContext<((state:DraftState)=>void)|null>(null);
const noFields:never[]=[];
const noState={};
const nativeModal='leave-without-saving';

/** Report only lifecycle flags. Configuration, request bodies and keys stay in the owning page. */
export function useSettingsDraftState(dirty:boolean,pending:boolean){
 const report=useContext(DraftContext);
 useLayoutEffect(()=>{report?.({dirty,pending});},[report,dirty,pending]);
}

type QueuedLink={element:HTMLAnchorElement;href:string;internal:boolean};
type ActivatedLink={element:HTMLAnchorElement;href:string;scope:string;resetKey:string;identity:string;container:HTMLDivElement};
function DraftGuard({scope,resetKey,identity,state,activation,container}:{scope:string;resetKey:string;identity:string|null;state:DraftState;activation:RefObject<ActivatedLink|null>;container:RefObject<HTMLDivElement|null>}){
 const {setModified}=useForm(),{closeModal,openModal}=useModal();
 const route=usePathname()+'?'+useSearchParams().toString();
 const [intercept,setIntercept]=useState<QueuedLink|null>(null),[bypass,setBypass]=useState(false);
 const [nativeHold,setNativeHold]=useState<{resetKey:string;route:string}|null>(null);
 const queued=useRef<QueuedLink|null>(null),alive=useRef(false),latest=useRef({scope,resetKey,identity,state,route});
 latest.current={scope,resetKey,identity,state,route};
 useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;queued.current=null;activation.current=null;};},[]);
 useLayoutEffect(()=>{setModified(state.dirty||state.pending);},[setModified,state.dirty,state.pending]);
 useLayoutEffect(()=>{activation.current=null;queued.current=null;setIntercept(null);setNativeHold(null);setBypass(false);closeModal(nativeModal);},[resetKey,scope,identity,closeModal,activation]);

 const prevent=useCallback((href:string|null)=>{
  // Payload stops the click at document capture, before a React container can
  // observe it. A programmatic trigger must supply its actual Link synchronously;
  // visible anchors keep Payload's existing activeElement/href contract.
  const holdOriginal=()=>{if(latest.current.state.pending){queued.current=null;setIntercept(null);setNativeHold({resetKey:latest.current.resetKey,route:latest.current.route});}};
  const activated=activation.current;activation.current=null;
  let element:HTMLAnchorElement;
  if(activated){
   const current=latest.current;
   if(activated.scope!==current.scope||activated.resetKey!==current.resetKey||activated.identity!==current.identity||activated.container!==container.current||!activated.element.isConnected||!activated.container.contains(activated.element)||activated.element.href!==activated.href||href&&href!==activated.href){holdOriginal();return;}
   element=activated.element;
  }else{
   const active=document.activeElement;
   if(!(active instanceof HTMLAnchorElement)||!href||!active.isConnected||active.href!==href){holdOriginal();return;}
   element=active;
  }
  let target:URL;try{target=new URL(element.href);}catch{holdOriginal();return;}
  if(target.origin!==location.origin){holdOriginal();return;}
  const internal=target.pathname===latest.current.scope;
  if(!internal&&!latest.current.state.pending)return;
  const value={element,href:element.href,internal};setNativeHold(null);queued.current=value;setIntercept(value);
 },[activation,container]);

 useLayoutEffect(()=>{
  if(!intercept)return;
  // The native guard already cancelled this click. Same-module query changes
  // retain the editor; a pending operation keeps its owner mounted until known.
  closeModal(nativeModal);
  if(intercept.internal)setBypass(true);
 },[intercept,closeModal]);
 useLayoutEffect(()=>{
  if(!nativeHold)return;
  if(nativeHold.resetKey!==resetKey||nativeHold.route!==route){setNativeHold(null);return;}
  if(state.pending)closeModal(nativeModal);
  else{setNativeHold(null);openModal(nativeModal);}
 },[nativeHold,state.pending,resetKey,route,closeModal,openModal]);
 useEffect(()=>{
  const value=queued.current;if(!value)return;
  if(value.internal&&!bypass||!value.internal&&state.pending)return;
  const key=resetKey;
  queueMicrotask(()=>{
   if(!alive.current||latest.current.resetKey!==key||queued.current!==value)return;
   queued.current=null;setIntercept(null);
   const valid=value.element.isConnected&&value.element.href===value.href&&new URL(value.href).origin===location.origin;
   try{if(valid)value.element.click();}
   finally{
    // End the one-link release before the browser can process another user
    // event. Cross-module replay is never released: the native guard still
    // asks about any draft that remains after the operation result is known.
    if(value.internal&&alive.current)flushSync(()=>setBypass(false));
   }
  });
 },[bypass,resetKey,state.pending]);
 const stay=()=>{queued.current=null;setIntercept(null);setNativeHold(null);setBypass(false);closeModal(nativeModal);};

 return <><LeaveWithoutSaving key={resetKey+'|'+route} disablePreventLeave={bypass} onPrevent={prevent}/>{state.pending&&(nativeHold||intercept&&!intercept.internal)&&<p role="status" className="settings-draft-wait"><span>正在读取处理结果，随后切换页面。</span><button type="button" onClick={stay}>留在当前页面</button></p>}</>;
}

/** Payload's existing Form/leave lifecycle, without a second HTML form or submit path. */
export function SettingsDraftBoundary({scope,resetKey,children}:{scope:string;resetKey:string;children:ReactNode}){
 const [state,setState]=useState<DraftState>({dirty:false,pending:false});
 const {user}=useAuth(),identity=settingsOperatorId(user),[session,setSession]=useState<SettingsDraftSession|null>(null);
 useLayoutEffect(()=>{if(!identity){settingsDraftMemory.observeIdentity(null);setSession(null);}else setSession(settingsDraftMemory.open(identity,resetKey));},[identity,resetKey]);
 const activation=useRef<ActivatedLink|null>(null),container=useRef<HTMLDivElement|null>(null),current=useRef({scope,resetKey,identity});
 current.current={scope,resetKey,identity};
 const activate=useCallback((element:HTMLAnchorElement|null)=>{
  if(!element?.isConnected)return;
  const owner=container.current,live=current.current;
  // Do not let a retained callback register against another mounted owner.
  if(live.scope!==scope||live.resetKey!==resetKey||live.identity!==identity)return;
  if(!owner||!identity||!owner.contains(element)){element.click();return;}
  let target:URL;try{target=new URL(element.href);}catch{return;}
  if(target.origin!==location.origin){element.click();return;}
  const value:ActivatedLink={element,href:element.href,scope,resetKey,identity,container:owner};
  activation.current=value;
  try{element.click();}finally{if(activation.current===value)activation.current=null;}
 },[scope,resetKey,identity]);
 const report=useCallback((next:DraftState)=>setState(previous=>previous.dirty===next.dirty&&previous.pending===next.pending?previous:next),[]);
 return <Form el="div" fields={noFields} initialState={noState} onSubmit={()=>{}} className="settings-draft-boundary">
  <div className="settings-draft-content" ref={container} onSubmit={event=>event.stopPropagation()}>
   <DraftContext.Provider value={report}><DraftGuard scope={scope} resetKey={resetKey} identity={identity} state={state} activation={activation} container={container}/><SettingsDraftLinkActivationContext.Provider value={activate}><SettingsDraftMemoryContext.Provider value={session}><Fragment key={(identity??'signed-out')+'|'+resetKey}>{children}</Fragment></SettingsDraftMemoryContext.Provider></SettingsDraftLinkActivationContext.Provider></DraftContext.Provider>
  </div>
 </Form>;
}
