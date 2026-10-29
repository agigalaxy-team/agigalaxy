'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useOperationsRead} from '../use-operations-read';
import {operationsRequest,OperationsRequestError} from '../operations-client';
import {applyConversationReceipt} from './conversation-turns';
import {agentOsConversationOperationPath,agentOsConversationPath,type AgentOsCommand,type AgentOsConversation,type AgentOsDomain,type AgentOsNativeRun} from './agentos-client';
import type {AiManagementCapabilities} from './ai-management-capabilities';

export type WorkbenchHistory={domain:AgentOsDomain;conversationId:string|null;runs:AgentOsNativeRun[];contextChanged:boolean;checkedAt:number;readExpiresAt:number};
export type WorkbenchContext=Omit<AgentOsConversation,'runs'|'managementCapabilities'>&{conversationId:string|null;contextChanged:boolean;latestOperation?:{operationId:string;runId:string|null;state:string;knownNativeStatus?:string|null;requiresOriginalLookup:boolean}|null};
export type WorkbenchCards={domain:AgentOsDomain;items:unknown[];checkedAt:number;readExpiresAt:number};
export type WorkbenchManagement={domain:AgentOsDomain;managementCapabilities:AiManagementCapabilities|null;checkedAt:number;readExpiresAt:number};
type Receipt={value:AgentOsCommand;message?:string;retryOfOperationId?:string;conversationId:string|null};
const terminal=new Set(['COMPLETED','ERROR','CANCELLED','PAUSED','REGENERATED']);

// The four resources are independent: no history request is needed to render
// cards or to obtain send/stream qualification. Receipts overlay only their
// own operation so an in-flight snapshot cannot replace a newer turn.
export function useWorkbenchConversationData(domain:AgentOsDomain,enabled:boolean){
 const base=enabled?agentOsConversationPath(domain):null;
 const history=useOperationsRead<WorkbenchHistory>({path:base?base+'/history':null,failureMessage:'对话记录暂时无法取得。',clearOnOffline:true,retryUnavailable:true,renewBeforeMs:20000,invalidateMode:'external'});
 const cards=useOperationsRead<WorkbenchCards>({path:base?base+'/cards':null,failureMessage:'操作记录暂时无法取得。',clearOnOffline:true,retryUnavailable:true,invalidateMode:'external'});
 const context=useOperationsRead<WorkbenchContext>({path:base?base+'/context':null,failureMessage:'沟通条件暂时无法取得。',clearOnOffline:true,retryUnavailable:true,invalidateMode:'external'});
 const management=useOperationsRead<WorkbenchManagement>({path:base&&domain==='overview'?base+'/management-capabilities':null,failureMessage:'总控管理能力暂时无法取得。',clearOnOffline:true,retryUnavailable:true,invalidateMode:'external'});
 const [receipts,setReceipts]=useState<Partial<Record<AgentOsDomain,Record<string,Receipt>>>>({});
 const deniedStatus=[history.rejectionStatus,context.rejectionStatus,cards.rejectionStatus,management.rejectionStatus].find(status=>status===401||status===403)??null,denied=deniedStatus!==null,contextChanged=context.rejectionStatus===409||context.value?.contextChanged===true;
 const lastConversation=useRef<Partial<Record<AgentOsDomain,{id:string|null}>>>({}),[retired,setRetired]=useState<Partial<Record<AgentOsDomain,{id:string|null}>>>({});
 if(!denied&&!contextChanged&&history.rejectionStatus!==409){const current=context.value?.domain===domain?context.value:history.value?.domain===domain?history.value:null;if(current)lastConversation.current[domain]={id:current.conversationId};}
 const oldConversation=retired[domain]??null;
 const requestSequence=useRef(new Map<string,number>()),currentScope=useRef({domain,enabled,rejected:false});currentScope.current={domain,enabled,rejected:denied||history.rejected||contextChanged};
 const historyValue=!denied&&!contextChanged&&history.value?.domain===domain&&(!oldConversation||history.value.conversationId!==oldConversation.id)?history.value:null,contextValue=!denied&&context.value?.domain===domain&&(!oldConversation||context.value.conversationId!==oldConversation.id)?context.value:null;
 const contextUsable=context.verified&&!!contextValue&&!denied&&!contextChanged&&history.rejectionStatus!==409;
 const conversation=useMemo(()=>{
  if(!historyValue&&!contextValue)return null;
  const conversationId=contextValue?.conversationId??historyValue?.conversationId??null;
  const sameHistory=!contextValue||!historyValue||contextValue.conversationId===historyValue.conversationId;
  let value:AgentOsConversation&{contextChanged?:boolean}={domain,conversationId,runs:sameHistory?historyValue?.runs??[]:[],runtimeState:contextValue?.runtimeState??'unavailable',modelState:contextValue?.modelState??'unknown',capabilities:contextValue?.capabilities??{canSend:false},blockedReason:contextValue?.blockedReason??'runtime-unavailable',checkedAt:contextValue?.checkedAt??historyValue?.checkedAt??0,readExpiresAt:contextValue?.readExpiresAt??historyValue?.readExpiresAt??0,contextChanged:contextValue?.contextChanged??historyValue?.contextChanged??false};
  for(const item of Object.values(denied||history.rejected||contextChanged?{}:receipts[domain]??{})){const existing=value.runs.find(run=>run.operationId===item.value.operationId);if((!item.conversationId||item.conversationId===conversationId)&&!terminal.has(existing?.status??''))value=applyConversationReceipt(value,item.value,item.message,item.retryOfOperationId);}
  return value;
 },[domain,historyValue,contextValue,receipts,history.rejected,denied,contextChanged]);
 const applyReceipt=useCallback((target:AgentOsDomain,receipt:AgentOsCommand,message?:string,retryOfOperationId?:string)=>{
  if(currentScope.current.rejected||target!==domain||!receipt.operationId||receipt.state==='context-changed'||receipt.state==='not-started')return;
  const conversationId=target===domain?(contextValue?.conversationId??historyValue?.conversationId??null):null;
  setReceipts(previous=>{const lane=previous[target]??{},prior=lane[receipt.operationId!];if(prior?.value.native&&terminal.has(prior.value.native.status)&&receipt.native&&!terminal.has(receipt.native.status))return previous;
   return {...previous,[target]:{...lane,[receipt.operationId!]:{value:receipt,message:message??prior?.message,retryOfOperationId:retryOfOperationId??prior?.retryOfOperationId,conversationId:conversationId??prior?.conversationId??null}}};});
 },[domain,contextValue?.conversationId,historyValue?.conversationId]);
 const invalidateContext=useCallback(()=>{
  if(currentScope.current.domain!==domain||!currentScope.current.enabled)return;
  currentScope.current.rejected=true;
  const last=lastConversation.current[domain];if(last)setRetired(previous=>previous[domain]?.id===last.id?previous:{...previous,[domain]:last});
  for(const [key,sequence] of requestSequence.current)if(key.startsWith(domain+':'))requestSequence.current.set(key,sequence+1);
  setReceipts(previous=>{if(!previous[domain])return previous;const next={...previous};delete next[domain];return next;});
  history.clear(409);context.clear(409);void context.refresh();
 },[domain,history.clear,context.clear,context.refresh]);
 const readOperation=useCallback(async(operationId:string,message?:string)=>{
  const key=domain+':'+operationId,sequence=(requestSequence.current.get(key)??0)+1;requestSequence.current.set(key,sequence);
  let value:AgentOsCommand;
  try{value=await operationsRequest<AgentOsCommand>(agentOsConversationOperationPath(domain,operationId));}
  catch(error){if(currentScope.current.domain===domain&&currentScope.current.enabled&&!currentScope.current.rejected&&requestSequence.current.get(key)===sequence&&error instanceof OperationsRequestError&&error.status===409)invalidateContext();throw error;}
  if(currentScope.current.domain!==domain||!currentScope.current.enabled||currentScope.current.rejected||requestSequence.current.get(key)!==sequence)return value;
  if(value.operationId!==operationId||value.native&&(value.native.operationId!==operationId||!value.native.runId))throw Error('Invalid original conversation receipt');
  if(value.state==='context-changed'){invalidateContext();return value;}
  applyReceipt(domain,value,message);return value;
 },[domain,invalidateContext,applyReceipt]);
 const clear=useCallback((status:number|null=null)=>{history.clear(status);cards.clear(status);context.clear(status);management.clear(status);setReceipts(previous=>{const next={...previous};delete next[domain];return next;});},[domain,history.clear,cards.clear,context.clear,management.clear]);
 const readAll=useCallback(async()=>{await Promise.all([history.read(),cards.read(),context.read(),management.read()]);},[history.read,cards.read,context.read,management.read]);
 useEffect(()=>{if(deniedStatus!==null)clear(deniedStatus);},[deniedStatus,clear]);
 useEffect(()=>{
  if(!contextChanged&&history.rejectionStatus!==409&&!contextValue?.contextChanged)return;
  const last=lastConversation.current[domain];if(last)setRetired(previous=>previous[domain]?.id===last.id?previous:{...previous,[domain]:last});
  if(contextChanged||contextValue?.contextChanged){if(history.rejectionStatus!==409)history.clear(409);return;}
  if(contextValue){void history.refresh();return;}
  if(!context.refreshing&&!context.error)void (async()=>{const fresh=await context.read();if(fresh&&!fresh.contextChanged)void history.refresh();})();
 },[domain,contextChanged,history.rejectionStatus,history.clear,history.refresh,context.read,context.refreshing,context.error,contextValue]);
 useEffect(()=>{if(oldConversation&&historyValue&&contextValue&&historyValue.conversationId!==oldConversation.id&&contextValue.conversationId===historyValue.conversationId)setRetired(previous=>{const next={...previous};delete next[domain];return next;});},[domain,oldConversation,historyValue,contextValue]);
 useEffect(()=>{if(!enabled||denied||history.rejected||contextChanged||contextValue?.contextChanged)setReceipts(previous=>{if(!previous[domain])return previous;const next={...previous};delete next[domain];return next;});},[domain,enabled,denied,history.rejected,contextChanged,contextValue?.contextChanged]);
 // The lightweight context identifies a live/latest turn independently of a
 // potentially slow history snapshot. Only its exact original operation can
 // supply a run and terminal proof; missing or transient results are retried.
 const latestOperation=contextValue?.latestOperation,latestOperationId=latestOperation?.operationId??'',latestObserved=!!historyValue?.runs.some(run=>run.operationId===latestOperationId)||!!receipts[domain]?.[latestOperationId]?.value.native;
 useEffect(()=>{
  if(!enabled||!contextUsable||contextValue?.contextChanged||!latestOperation?.requiresOriginalLookup||!latestOperationId||latestObserved)return;
  let active=true,timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{try{const value=await readOperation(latestOperationId);if(!active)return;if(value.state==='context-changed'||value.state==='not-started')return;if(!value.native)timer=setTimeout(()=>void poll(),2000);}
   catch(error){if(!active)return;if(error instanceof OperationsRequestError&&[401,403].includes(error.status)){clear(error.status);return;}timer=setTimeout(()=>void poll(),2000);}};
  void poll();return()=>{active=false;if(timer)clearTimeout(timer);};
 },[enabled,contextUsable,contextValue?.contextChanged,latestOperation?.requiresOriginalLookup,latestOperationId,latestObserved,readOperation,clear]);
 useEffect(()=>{
  if(!enabled)return;
  const ownId=contextValue?.conversationId??historyValue?.conversationId??null;
  const refreshOperation=(id:string)=>{void readOperation(id).catch(error=>{if(error instanceof OperationsRequestError&&[401,403].includes(error.status))clear(error.status);});};
  const change=(event:Event)=>{
   const detail=(event as CustomEvent<{kind:'conversation-operation'|'conversation-card'|'conversation-context'|'conversation-tool'|'configuration';objectId?:string;parentId?:string;turnId?:string}>).detail;
   if(!detail)return;
   if(detail.kind==='configuration'){void context.refresh();if(domain==='overview')void management.refresh();return;}
   if(ownId&&detail.parentId&&detail.parentId!==ownId)return;
   if(detail.kind==='conversation-operation'&&detail.objectId)refreshOperation(detail.objectId);
   else if(detail.kind==='conversation-card'){void cards.refresh();if(detail.turnId)refreshOperation(detail.turnId);}
   else if(detail.kind==='conversation-tool'&&detail.turnId)refreshOperation(detail.turnId);
   else if(detail.kind==='conversation-context'){void context.refresh();}
  };
  const resync=()=>{void history.refresh();void cards.refresh();void context.refresh();if(domain==='overview')void management.refresh();};
  window.addEventListener('galaxy:admin-agentos-change',change);window.addEventListener('galaxy:admin-agentos-resync',resync);
  return()=>{window.removeEventListener('galaxy:admin-agentos-change',change);window.removeEventListener('galaxy:admin-agentos-resync',resync);};
 },[enabled,domain,contextValue?.conversationId,historyValue?.conversationId,history.refresh,cards.refresh,context.refresh,management.refresh,readOperation,clear]);
 return {history,cards,context,management,conversation,applyReceipt,readOperation,clear,readAll,denied,contextUsable,contextInvalidated:contextChanged||history.rejectionStatus===409};
}
