import {createAgentIdentityHandoff,readAgentIdentityEntry} from './agent-identity-handoff.mjs';
import type {createWebRuntime} from './runtime.mjs';
import type {AgentConnectionContext} from './agent-identity-presentation';

export type AgentIdentityRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
export type AgentIdentityEntry=NonNullable<ReturnType<typeof readAgentIdentityEntry>>;
type Lease=ReturnType<AgentIdentityRuntime['receiptStatus']['captureLease']>;
type ConnectedIdentity={subjectId:string;deviceId:string;targetPath:string;operationId:string|null};
type DraftPreview=NonNullable<Awaited<ReturnType<AgentIdentityRuntime['visitorDrafts']['preview']>>>;
type DraftChoice=ConnectedIdentity&{preview:DraftPreview;lease:Lease};
type HandoffState={phase:string;context?:AgentConnectionContext|null;fingerprint?:string|null;code?:string|null;additionalDeviceApproval?:boolean};
type ViewState={handoff:HandoffState;draft:DraftChoice|null;error:string;busy:boolean};
type Callbacks={navigate:(path:string)=>void;onChange:()=>void|Promise<void>;onManual:()=>void};
type Controller=ReturnType<typeof createAgentIdentityHandoff>;

export function agentIdentityErrorCode(reason:unknown){
 return typeof reason==='object'&&reason!==null&&'code' in reason&&typeof reason.code==='string'?reason.code:'';
}
function checkCompleted(result:ConnectedIdentity,lease:Lease){
 lease.assertCurrent();
 if(lease.subjectId!==result.subjectId||lease.deviceId!==result.deviceId)
  throw Object.assign(new Error(),{code:'agent_handoff_browser_identity_changed'});
}

// The handoff and its lease are external runtime state. React subscribes to one
// stable snapshot; an ended generation cannot publish into the next handoff.
export function createAgentIdentityView(runtime:AgentIdentityRuntime|null,entry:AgentIdentityEntry,readable:(reason:unknown)=>string){
 const listeners=new Set<()=>void>();
 let snapshot:ViewState={handoff:{phase:'waiting'},draft:null,error:'',busy:false};
 let callbacks:Callbacks={navigate:()=>{},onChange:()=>{},onManual:()=>{}};
 let controller:Controller|null=null,completed:{result:ConnectedIdentity;lease:Lease}|null=null;
 let generation=0,alive=false,timer:number|null=null;
 const publish=(change:Partial<ViewState>)=>{snapshot={...snapshot,...change};for(const listener of listeners)listener();};
 const stopWithError=(reason:unknown)=>{
  completed=null;publish({draft:null,error:readable(reason),handoff:{phase:'stopped',code:'agent_handoff_browser_identity_changed'}});
 };
 function verifyCurrent(){
  if(!alive||!completed)return;
  try{checkCompleted(completed.result,completed.lease);}catch(reason){stopWithError(reason);}
 }
 function start(){
  const token=++generation;alive=true;completed=null;
  publish({handoff:{phase:'waiting'},draft:null,error:'',busy:false});
  if(!runtime)return;
  const valid=()=>alive&&token===generation;
  const next=createAgentIdentityHandoff({runtime,entry,
   onUpdate:(handoff?:HandoffState)=>{if(valid()&&handoff)publish({handoff});},
   onConnected:async(result?:ConnectedIdentity)=>{
    if(!valid()||!result)return;
    try{
     const lease=runtime.receiptStatus.captureLease();checkCompleted(result,lease);completed={result,lease};
     await callbacks.onChange();if(!valid())return;checkCompleted(result,lease);
     const original=new URL(result.targetPath,location.origin);
     const candidate=original.pathname==='/app/publish'?await runtime.visitorDrafts.preview():null;
     if(!valid())return;checkCompleted(result,lease);
     if(candidate){
      if(candidate.subjectId!==result.subjectId)throw Object.assign(new Error(),{code:'agent_handoff_browser_identity_changed'});
      publish({draft:{...result,preview:candidate,lease}});return;
     }
     callbacks.navigate(result.targetPath);
    }catch(reason){if(valid())stopWithError(reason);}
   }});
  controller=next;next.start();
  timer=window.setInterval(verifyCurrent,1000);
  document.addEventListener('visibilitychange',verifyCurrent);
 }
 function close(){
  alive=false;generation++;completed=null;
  if(timer!==null)window.clearInterval(timer);timer=null;
  document.removeEventListener('visibilitychange',verifyCurrent);
  const previous=controller;controller=null;previous?.close();
 }
 async function adopt(){
  const selected=snapshot.draft;
  if(!alive||!runtime||snapshot.busy||!selected)return;
  const token=generation;publish({busy:true,error:''});
  try{
   checkCompleted(selected,selected.lease);
   const result=await runtime.visitorDrafts.adopt(selected.preview,{confirmed:true});
   if(!alive||token!==generation)return;checkCompleted(selected,selected.lease);
   if(result.currentIdentityChanged)throw Object.assign(new Error(),{code:'agent_handoff_browser_identity_changed'});
   callbacks.navigate(selected.targetPath);
  }catch(reason){
   if(alive&&token===generation)publish({draft:null,error:agentIdentityErrorCode(reason)==='local_draft_changed'
    ?'草稿已在其他页面改变，请重新核对后采纳。':readable(reason)});
  }finally{if(alive&&token===generation)publish({busy:false});}
 }
 function keep(){
  try{const selected=snapshot.draft;if(!alive||!selected)return;checkCompleted(selected,selected.lease);callbacks.navigate(selected.targetPath);}
  catch(reason){publish({draft:null,error:readable(reason)});}
 }
 return {
  subscribe(this:void,listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  snapshot:()=>snapshot,
  setCallbacks(value:Callbacks){callbacks=value;},
  start,close,verifyCurrent,adopt,keep,
  cancel:()=>controller?.cancel(),
  manual:()=>callbacks.onManual(),
  returnToOrigin:()=>callbacks.navigate(entry.valid?entry.targetPath:'/app/'),
 };
}
