'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useOperationsRead} from '../use-operations-read';
import {operationsRequest,OperationsRequestError} from '../operations-client';
import {applyConversationReceipt} from './conversation-turns';
import {agentOsConversationOperationPath,agentOsConversationPath,type AgentOsCommand,type AgentOsConversation,type AgentOsDomain,type AgentOsNativeRun} from './agentos-client';
import type {AiManagementCapabilities} from './ai-management-capabilities';

export type WorkbenchHistory={domain:AgentOsDomain;conversationId:string|null;runs:AgentOsNativeRun[];hasMore?:boolean;nextCursor?:string|null;contextChanged:boolean;checkedAt:number;readExpiresAt?:number};
export type WorkbenchContext=Omit<AgentOsConversation,'runs'|'managementCapabilities'>&{conversationId:string|null;contextChanged:boolean;latestOperation?:{operationId:string;runId:string|null;state:string;knownNativeStatus?:string|null;requiresOriginalLookup:boolean}|null};
export type WorkbenchCards={domain:AgentOsDomain;items:unknown[];checkedAt:number;readExpiresAt:number};
export type WorkbenchManagement={domain:AgentOsDomain;managementCapabilities:AiManagementCapabilities|null;checkedAt:number;readExpiresAt:number};
type Receipt={value:AgentOsCommand;message?:string;retryOfOperationId?:string;conversationId:string|null;feedback?:{parentOperationId:string;logicalTurnId?:string}};
type OperationFlight={epoch:number;dirty:boolean;message?:string;promise:Promise<AgentOsCommand|undefined>};
const terminal=new Set(['COMPLETED','ERROR','CANCELLED','PAUSED','REGENERATED']);
// Keep the ordering of the first observed snapshot while replacing an existing
// run with the latest version, including when its operation is represented by
// a different run id in a later response.
function mergeHistoryRuns(...lists:readonly AgentOsNativeRun[][]){
 const result:AgentOsNativeRun[]=[],byRun=new Map<string,number>(),byOperation=new Map<string,number>();
 for(const run of lists.flat()){const index=byRun.get(run.runId)??(run.operationId?byOperation.get(run.operationId):undefined);if(index===undefined){const next=result.length;result.push(run);byRun.set(run.runId,next);if(run.operationId)byOperation.set(run.operationId,next);}else{const previous=result[index];result[index]=run;byRun.set(run.runId,index);byRun.set(previous.runId,index);if(previous.operationId)byOperation.set(previous.operationId,index);if(run.operationId)byOperation.set(run.operationId,index);}}
 return result;
} 


// The four resources are independent: no history request is needed to render
// cards or to obtain send/stream qualification. Receipts overlay only their
// own operation so an in-flight snapshot cannot replace a newer turn.
export function useWorkbenchConversationData(domain:AgentOsDomain,enabled:boolean,sessionKey:string|null=null){
 const base=enabled?agentOsConversationPath(domain):null;
 const history=useOperationsRead<WorkbenchHistory>({path:base?base+'/history':null,failureMessage:'历史加载失败',invalidateMode:'external',resumeOnReconnect:false});
 const cards=useOperationsRead<WorkbenchCards>({path:base?base+'/cards':null,failureMessage:'操作记录加载失败',clearOnOffline:true,retryUnavailable:true,invalidateMode:'external'});
 const context=useOperationsRead<WorkbenchContext>({path:base?base+'/context':null,failureMessage:'连接失败',clearOnOffline:true,retryUnavailable:true,invalidateMode:'external'});
 const management=useOperationsRead<WorkbenchManagement>({path:base&&domain==='overview'?base+'/management-capabilities':null,failureMessage:'管理权限加载失败',clearOnOffline:true,retryUnavailable:true,invalidateMode:'external'});
 const [loaded,setLoaded]=useState<{domain:AgentOsDomain;sessionKey:string|null;conversationId:string|null;runs:AgentOsNativeRun[];hasMore:boolean;nextCursor:string|null}|null>(null);
 const [older,setOlder]=useState<{domain:AgentOsDomain;sessionKey:string|null;conversationId:string|null;runs:AgentOsNativeRun[];hasMore:boolean;nextCursor:string|null}|null>(null);
 const [moreLoading,setMoreLoading]=useState(false),[moreError,setMoreError]=useState('');
 const [pageCards,setPageCards]=useState<{domain:AgentOsDomain;sessionKey:string|null;conversationId:string|null;items:unknown[]}|null>(null);
 const [pageCardError,setPageCardError]=useState(''),[cardRefresh,setCardRefresh]=useState(0),[pageCardsLoading,setPageCardsLoading]=useState(false);
 const pageEpoch=useRef(0),moreFlight=useRef(false);
 useEffect(()=>{pageEpoch.current++;moreFlight.current=false;setMoreError('');setPageCardError('');setMoreLoading(false);setPageCardsLoading(false);},[domain,enabled,sessionKey]);
 useEffect(()=>{setLoaded(null);setOlder(null);setPageCards(null);},[domain,sessionKey]);
 const [receipts,setReceipts]=useState<Partial<Record<AgentOsDomain,Record<string,Receipt>>>>({});
 const deniedStatus=[history.rejectionStatus,context.rejectionStatus,cards.rejectionStatus,management.rejectionStatus].find(status=>status===401||status===403)??null,denied=deniedStatus!==null,contextChanged=context.rejectionStatus===409||context.value?.contextChanged===true;
 const lastConversation=useRef<Partial<Record<AgentOsDomain,{id:string|null}>>>({}),[retired,setRetired]=useState<Partial<Record<AgentOsDomain,{id:string|null}>>>({});
 if(!denied&&!contextChanged&&history.rejectionStatus!==409){const current=context.value?.domain===domain?context.value:history.value?.domain===domain?history.value:null;if(current)lastConversation.current[domain]={id:current.conversationId};}
 const oldConversation=retired[domain]??null;
 const requestSequence=useRef(new Map<string,number>()),operationFlights=useRef(new Map<string,OperationFlight>()),currentScope=useRef({domain,enabled,sessionKey,rejected:false,epoch:0});
 const rejected=denied||history.rejected||contextChanged,previousScope=currentScope.current;
 currentScope.current={domain,enabled,sessionKey,rejected,epoch:previousScope.epoch+Number(previousScope.domain!==domain||previousScope.enabled!==enabled||previousScope.sessionKey!==sessionKey||previousScope.rejected!==rejected)};
 const historyValue=!denied&&!contextChanged&&history.value?.domain===domain&&(!oldConversation||history.value.conversationId!==oldConversation.id)?history.value:null,contextValue=!denied&&context.value?.domain===domain&&(!oldConversation||context.value.conversationId!==oldConversation.id)?context.value:null;
 const olderValue=older?.domain===domain&&older.sessionKey===sessionKey&&older.conversationId===historyValue?.conversationId?older:null;
 const loadedValue=loaded?.domain===domain&&loaded.sessionKey===sessionKey&&loaded.conversationId===historyValue?.conversationId?loaded:null;
 useEffect(()=>{
  if(denied||history.rejected||contextChanged||contextValue?.contextChanged){setLoaded(null);setOlder(null);return;}
  if(!enabled||!historyValue||contextValue&&contextValue.conversationId!==historyValue.conversationId)return;
  setLoaded(previous=>{const same=previous?.domain===domain&&previous.sessionKey===sessionKey&&previous.conversationId===historyValue.conversationId;return {domain,sessionKey,conversationId:historyValue.conversationId,runs:mergeHistoryRuns(same?previous!.runs:[],historyValue.runs),hasMore:same?previous!.hasMore:historyValue.hasMore===true,nextCursor:same?previous!.nextCursor:historyValue.nextCursor??null};});
 },[enabled,denied,history.rejected,contextChanged,contextValue?.contextChanged,contextValue?.conversationId,historyValue,domain,sessionKey]);
 const historyRuns=useMemo(()=>mergeHistoryRuns(olderValue?.runs??[],loadedValue?.runs??[],historyValue?.runs??[]),[olderValue,loadedValue,historyValue]);
 const frontier=olderValue??loadedValue??historyValue;
 const loadMore=useCallback(async()=>{
  const cursor=frontier?.nextCursor,hasMore=frontier?.hasMore;
  if(!base||!cursor||!hasMore||moreFlight.current||!historyValue)return false;
  moreFlight.current=true;setMoreLoading(true);setMoreError('');const epoch=pageEpoch.current,conversationId=historyValue.conversationId;
  try{const page=await operationsRequest<WorkbenchHistory>(base+'/history?'+new URLSearchParams({before:cursor}));
   if(epoch!==pageEpoch.current||page.domain!==domain||page.conversationId!==conversationId||page.contextChanged)return false;
   setOlder(previous=>{const unique=new Map<string,AgentOsNativeRun>();for(const run of [...page.runs,...(previous?.domain===domain&&previous.sessionKey===sessionKey&&previous.conversationId===conversationId?previous.runs:[])])unique.set(run.runId,run);return {domain,sessionKey,conversationId,runs:[...unique.values()],hasMore:page.hasMore===true,nextCursor:page.nextCursor??null};});return true;
  }catch(error){if(epoch===pageEpoch.current){if(error instanceof OperationsRequestError&&[401,403].includes(error.status)){history.clear(error.status);context.clear(error.status);cards.clear(error.status);}else setMoreError('历史加载失败');}return false;
  }finally{if(epoch===pageEpoch.current){moreFlight.current=false;setMoreLoading(false);}}
 },[base,domain,sessionKey,historyValue,frontier,history.clear,context.clear,cards.clear]);
 // Historical text never starts card, receipt or recovery reads.
 const cardTurnIds=Object.keys(receipts[domain]??{}).join(',');
 useEffect(()=>{
  if(!base||!historyValue||!cardTurnIds)return;
  const epoch=pageEpoch.current,conversationId=historyValue.conversationId,ids=[...new Set(cardTurnIds.split(','))];let alive=true;setPageCardsLoading(true);
  void (async()=>{try{const pages:WorkbenchCards[]=[];for(let i=0;i<ids.length;i+=50){const params=new URLSearchParams();ids.slice(i,i+50).forEach(id=>params.append('turnId',id));pages.push(await operationsRequest<WorkbenchCards>(base+'/cards?'+params));}
   if(!alive||epoch!==pageEpoch.current||pages.some(page=>page.domain!==domain))return;
   setPageCards(previous=>{const unique=new Map<string,unknown>();for(const item of [...(previous?.domain===domain&&previous.sessionKey===sessionKey&&previous.conversationId===conversationId?previous.items:[]),...pages.flatMap(page=>page.items)])if(item&&typeof item==='object'&&'cardId' in item&&typeof item.cardId==='string')unique.set(item.cardId,item);return {domain,sessionKey,conversationId,items:[...unique.values()]};});setPageCardError('');
  }catch(error){if(!alive||epoch!==pageEpoch.current)return;if(error instanceof OperationsRequestError&&[401,403].includes(error.status)){history.clear(error.status);context.clear(error.status);cards.clear(error.status);}else setPageCardError('部分操作记录暂时无法读取，请重试。');}finally{if(alive&&epoch===pageEpoch.current)setPageCardsLoading(false);}})();
  return()=>{alive=false;};
 },[base,domain,sessionKey,historyValue?.conversationId,cardTurnIds,cardRefresh,history.clear,context.clear,cards.clear]);
 const refreshPageCards=useCallback(()=>{if(cardTurnIds)setPageCardsLoading(true);setCardRefresh(value=>value+1);},[cardTurnIds]);
 const contextUsable=context.verified&&!!contextValue&&!denied&&!contextChanged&&history.rejectionStatus!==409;
 const conversation=useMemo(()=>{
  if(!historyValue&&!contextValue)return null;
  const conversationId=contextValue?.conversationId??historyValue?.conversationId??null;
  const sameHistory=!contextValue||!historyValue||contextValue.conversationId===historyValue.conversationId;
  let value:AgentOsConversation&{contextChanged?:boolean}={domain,conversationId,runs:sameHistory?historyRuns:[],runtimeState:contextValue?.runtimeState??'unavailable',modelState:contextValue?.modelState??'unknown',capabilities:contextValue?.capabilities??{canSend:false},blockedReason:contextValue?contextValue.blockedReason:'runtime-unavailable',checkedAt:contextValue?.checkedAt??historyValue?.checkedAt??0,readExpiresAt:contextValue?.readExpiresAt??historyValue?.readExpiresAt??0,contextChanged:contextValue?.contextChanged??historyValue?.contextChanged??false};
  for(const item of Object.values(denied||history.rejected||contextChanged?{}:receipts[domain]??{})){const existing=value.runs.find(run=>run.operationId===item.value.operationId);if((!item.conversationId||item.conversationId===conversationId)&&!terminal.has(existing?.status??'')){value=applyConversationReceipt(value,item.value,item.message,item.retryOfOperationId);if(item.feedback)value={...value,runs:value.runs.map(run=>run.operationId===item.value.operationId?{...run,origin:'operation-feedback',parentOperationId:item.feedback!.parentOperationId,logicalTurnId:item.feedback!.logicalTurnId??run.logicalTurnId}:run)};}}
  return value;
 },[domain,historyValue,historyRuns,contextValue,receipts,history.rejected,denied,contextChanged]);
 const applyReceipt=useCallback((target:AgentOsDomain,receipt:AgentOsCommand,message?:string,retryOfOperationId?:string,feedback?:{parentOperationId:string;logicalTurnId?:string})=>{
  if(currentScope.current.rejected||target!==domain||!receipt.operationId||receipt.state==='context-changed'||receipt.state==='not-started')return;
  const conversationId=target===domain?(contextValue?.conversationId??historyValue?.conversationId??null):null;
  setReceipts(previous=>{const lane=previous[target]??{},prior=lane[receipt.operationId!];if(prior?.value.native&&terminal.has(prior.value.native.status)&&(!receipt.native||!terminal.has(receipt.native.status)))return previous;
   return {...previous,[target]:{...lane,[receipt.operationId!]:{value:receipt,message:message??prior?.message,retryOfOperationId:retryOfOperationId??prior?.retryOfOperationId,conversationId:conversationId??prior?.conversationId??null,feedback:feedback??prior?.feedback}}};});
 },[domain,contextValue?.conversationId,historyValue?.conversationId]);
 const invalidateContext=useCallback(()=>{
  if(currentScope.current.domain!==domain||!currentScope.current.enabled)return;
  currentScope.current.rejected=true;
  const last=lastConversation.current[domain];if(last)setRetired(previous=>previous[domain]?.id===last.id?previous:{...previous,[domain]:last});
  for(const [key,sequence] of requestSequence.current)if(key.startsWith(domain+':'))requestSequence.current.set(key,sequence+1);
  setReceipts(previous=>{if(!previous[domain])return previous;const next={...previous};delete next[domain];return next;});
  history.clear(409);context.clear(409);void context.refresh();
 },[domain,history.clear,context.clear,context.refresh]);
 const readOperation=useCallback((operationId:string,message?:string):Promise<AgentOsCommand|undefined>=>{
  const key=domain+':'+operationId,scope=currentScope.current,existing=operationFlights.current.get(key);
  if(existing&&existing.epoch===scope.epoch){existing.dirty=true;if(message)existing.message=message;return existing.promise;}
  const sequence=(requestSequence.current.get(key)??0)+1;requestSequence.current.set(key,sequence);
  const flight:OperationFlight={epoch:scope.epoch,dirty:false,message,promise:undefined as unknown as Promise<AgentOsCommand|undefined>};
  const isCurrent=()=>currentScope.current.domain===domain&&currentScope.current.enabled&&!currentScope.current.rejected&&currentScope.current.epoch===flight.epoch&&requestSequence.current.get(key)===sequence;
  flight.promise=(async()=>{try{
   for(;;){
    flight.dirty=false;let value:AgentOsCommand;
    try{value=await operationsRequest<AgentOsCommand>(agentOsConversationOperationPath(domain,operationId));}
    catch(error){if(!isCurrent())return undefined;if(error instanceof OperationsRequestError&&error.status===409)invalidateContext();if(isCurrent()&&flight.dirty&&(!(error instanceof OperationsRequestError)||![401,403,409].includes(error.status)))continue;throw error;}
    if(!isCurrent())return undefined;
    if(value.operationId!==operationId||value.native&&(value.native.operationId!==operationId||!value.native.runId))throw Error('Invalid original conversation receipt');
    if(value.state==='context-changed'){invalidateContext();return undefined;}
    applyReceipt(domain,value,flight.message);
    if(!flight.dirty)return value;
   }
  }finally{if(operationFlights.current.get(key)===flight)operationFlights.current.delete(key);}})();
  operationFlights.current.set(key,flight);return flight.promise;
 },[domain,invalidateContext,applyReceipt]);
 const clear=useCallback((status:number|null=null)=>{setLoaded(null);setOlder(null);history.clear(status);cards.clear(status);context.clear(status);management.clear(status);setReceipts(previous=>{const next={...previous};delete next[domain];return next;});},[domain,history.clear,cards.clear,context.clear,management.clear]);
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
 const latestOperation=contextValue?.latestOperation,latestOperationId=latestOperation?.operationId??'',latestRun=receipts[domain]?.[latestOperationId]?.value.native??historyValue?.runs.find(run=>run.operationId===latestOperationId),latestObserved=!!latestRun&&(['PENDING','RUNNING'].includes(latestRun.status)||terminal.has(latestRun.status));
 useEffect(()=>{
  if(!enabled||!contextUsable||contextValue?.contextChanged||!latestOperation?.requiresOriginalLookup||!latestOperationId||latestObserved)return;
  let active=true,timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{try{const value=await readOperation(latestOperationId);if(!active||!value)return;if(value.state==='context-changed'||value.state==='not-started')return;if(!value.native||!['PENDING','RUNNING'].includes(value.native.status)&&!terminal.has(value.native.status))timer=setTimeout(()=>void poll(),2000);}
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
   else if(detail.kind==='conversation-card'){void cards.refresh();refreshPageCards();if(detail.turnId)refreshOperation(detail.turnId);}
   else if(detail.kind==='conversation-tool'&&detail.turnId)refreshOperation(detail.turnId);
   else if(detail.kind==='conversation-context'){void context.refresh();}
  };
  const resync=()=>{void history.refresh();void cards.refresh();void context.refresh();if(domain==='overview')void management.refresh();};
  window.addEventListener('galaxy:admin-agentos-change',change);window.addEventListener('galaxy:admin-agentos-resync',resync);
  return()=>{window.removeEventListener('galaxy:admin-agentos-change',change);window.removeEventListener('galaxy:admin-agentos-resync',resync);};
 },[enabled,domain,contextValue?.conversationId,historyValue?.conversationId,history.refresh,cards.refresh,context.refresh,management.refresh,readOperation,clear,refreshPageCards]);
 return {history,cards,context,management,conversation,olderHasMore:frontier?.hasMore===true,olderCursor:frontier?.nextCursor,hasLoadedOlder:!!olderValue,loadMore,moreLoading,moreError,pageCards:pageCards?.domain===domain&&pageCards.sessionKey===sessionKey&&pageCards.conversationId===historyValue?.conversationId?pageCards.items:[],pageCardError,pageCardsLoading,pageCardsVerified:!!pageCards&&pageCards.domain===domain&&pageCards.sessionKey===sessionKey&&pageCards.conversationId===historyValue?.conversationId&&!pageCardsLoading&&!pageCardError,refreshPageCards,applyReceipt,readOperation,clear,readAll,denied,contextUsable,contextInvalidated:contextChanged||history.rejectionStatus===409};
}

// Keep reconciling only the already admitted operation. A lost stream terminal
// or a failed first original GET must never trigger a second command POST.
export function useActiveConversationReconciliation({enabled,operationId,readOperation,clear}:{enabled:boolean;operationId:string|null;readOperation:(operationId:string)=>Promise<AgentOsCommand|undefined>;clear:(status?:number|null)=>void}){
 useEffect(()=>{
  if(!enabled||!operationId)return;
  let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{
   if(!alive)return;
   if(navigator.onLine&&document.visibilityState==='visible')try{await readOperation(operationId);}
   catch(error){if(error instanceof OperationsRequestError&&[401,403].includes(error.status))clear(error.status);}
   if(alive)timer=setTimeout(()=>void poll(),4000);
  };
  timer=setTimeout(()=>void poll(),4000);
  return()=>{alive=false;if(timer)clearTimeout(timer);};
 },[enabled,operationId,readOperation,clear]);
}
