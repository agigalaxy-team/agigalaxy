'use client';
import {useEffect,useRef} from 'react';
import {operationsRequest,OperationsRequestError} from '../operations-client';
import {workbenchCardPath,type WorkbenchActionCard} from './workbench-action-cards';
import type {AgentOsCommand,AgentOsDomain,AgentOsNativeRun} from './agentos-client';

type Props={enabled:boolean;operatorId:string|null;csrfToken:string;domain:AgentOsDomain;cards:WorkbenchActionCard[];runs:AgentOsNativeRun[];currentToken:(domain:AgentOsDomain)=>Promise<string|null>;onReceipt:(domain:AgentOsDomain,value:AgentOsCommand,message?:string,retryOfOperationId?:string,feedback?:{parentOperationId:string;logicalTurnId?:string})=>void;onDenied:()=>void};
type Lane={operationId?:string;ambiguous:boolean;done:boolean};
const terminal=new Set(['COMPLETED','ERROR','CANCELLED','PAUSED']);
// A card owns one server-assigned feedback operation. An uncertain POST is
// persisted before dispatch and can only be reconciled by GET, even on reload.
export function useWorkbenchCardFeedback(props:Props){
 const latest=useRef(props);latest.current=props;
 const lanes=useRef(new Map<string,Lane>());
 const eligible=props.cards.filter(card=>card.confirmationAttempted&&card.feedbackEligible&&(card.stored||card.readExpiresAt>Math.floor(Date.now()/1000))&&['completed','not-available'].includes(card.state)&&!!card.turnId);
 const key=eligible.map(card=>card.cardId+':'+card.turnId).sort().join(',');
 useEffect(()=>{
  if(!props.enabled||!props.operatorId||!props.csrfToken||!key)return;
  let alive=true,timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController(),operator=props.operatorId,domain=props.domain,token=props.csrfToken;
  const loop=async()=>{
   if(!alive)return;
   for(const card of latest.current.cards.filter(item=>item.confirmationAttempted&&item.feedbackEligible&&(item.stored||item.readExpiresAt>Math.floor(Date.now()/1000))&&['completed','not-available'].includes(item.state)&&!!item.turnId)){
    if(!alive||!navigator.onLine||document.visibilityState==='hidden')break;
    const storageKey='galaxy:workbench:card-feedback:'+operator+':'+domain+':'+card.cardId,laneKey=storageKey;
    let lane=lanes.current.get(laneKey);
    if(!lane){let ambiguous=true;try{ambiguous=sessionStorage.getItem(storageKey)==='attempted';}catch{}lane={ambiguous,done:false};lanes.current.set(laneKey,lane);}
    if(lane.done)continue;
    const path=workbenchCardPath(domain,card.cardId)+'/feedback';
    try{
     let value=await operationsRequest<AgentOsCommand>(path,{signal:controller.signal});
     if(!alive)return;
     if(!value.operationId||lane.operationId&&lane.operationId!==value.operationId)throw Error('Feedback operation changed');
     lane.operationId=value.operationId;
     if(value.state==='not-started'&&!lane.ambiguous){
      const fresh=await latest.current.currentToken(domain);if(!alive||fresh!==token)continue;
      // If persistence fails, do not make an unrecoverable ambiguous POST.
      try{sessionStorage.setItem(storageKey,'attempted');}catch{continue;}
      lane.ambiguous=true;
      try{value=await operationsRequest<AgentOsCommand>(path,{csrfToken:token,body:{},signal:controller.signal});}
      catch(error){if(error instanceof OperationsRequestError&&error.status===409&&error.code==='operations_agentos_conversation_busy'){lane.ambiguous=false;try{sessionStorage.removeItem(storageKey);}catch{} }throw error;}
      if(!alive)return;
      if(value.operationId!==lane.operationId)throw Error('Feedback operation changed');
     }
     if(value.state==='unknown'){lane.ambiguous=true;try{sessionStorage.setItem(storageKey,'attempted');}catch{}continue;}
     if(value.state==='not-started'||!value.runId&&!value.native?.runId)continue;
     const parent=value.parentOperationId??card.turnId!,run=latest.current.runs.find(item=>item.operationId===parent);
     latest.current.onReceipt(domain,value,undefined,undefined,{parentOperationId:parent,logicalTurnId:value.logicalTurnId??run?.logicalTurnId});
     if(value.native&&terminal.has(value.native.status))lane.done=true;
    }catch(error){if(!alive)return;if(error instanceof OperationsRequestError&&[401,403].includes(error.status)){latest.current.onDenied();return;}}
   }
   if(alive)timer=setTimeout(()=>void loop(),4000);
  };
  void loop();return()=>{alive=false;controller.abort();if(timer)clearTimeout(timer);};
 },[props.enabled,props.operatorId,props.csrfToken,props.domain,key]);
}
