'use client';

import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type KeyboardEvent} from 'react';
import Link from 'next/link';
import {createPortal} from 'react-dom';
import {useRouter,useSearchParams} from 'next/navigation';
import {shanghaiMinute} from '../../lib/shanghai-time.mjs';
import {AutonomyTaskResult} from "../autonomy/AutonomyTaskResult";
import "../autonomy/autonomy.css";
import type {AutonomyTaskRead} from "../autonomy/autonomy-types";
import {autonomyTaskHref,autonomyStates} from "../../lib/autonomy/autonomy-view-model";
import {AdminIcon} from '../AdminIcons';
import {AdminTabs} from '../AdminTabs';
import {useOperationsRead} from '../../lib/use-operations-read';
import {ReadStatus} from '../OperationControls';
import {WorkbenchModelNotice} from './WorkbenchModelNotice';
import {WorkbenchManagementCapabilities} from './WorkbenchManagementCapabilities';
import {WorkbenchActionHistory} from './WorkbenchActionHistory';
import {useWorkbenchInteraction} from './WorkbenchInteraction';
import {WorkbenchActionCards} from './WorkbenchActionCards';
import {WorkbenchMessageQueue} from './WorkbenchMessageQueue';
import {authorizedCommandMatches} from "../../lib/workbench/authorized-preparation-model";
import {workbenchActionCards,workbenchCardPath,type WorkbenchActionCard} from "../../lib/workbench/workbench-action-cards";
import {useWorkbenchCommand,clearWorkbenchIntents} from "../../lib/workbench/use-workbench-command";
import {useWorkbenchMessageQueue} from '../../lib/workbench/use-workbench-message-queue';
import {useWorkbenchCardFeedback} from '../../lib/workbench/use-workbench-card-feedback';
import {queueLaneMatches,messageQueueStorageKey} from '../../lib/workbench/workbench-message-queue';
import {WorkbenchReplyProgress,WorkbenchAnswer,replyProgressLabel} from './WorkbenchReply';
import {useConversationScroll} from '../../lib/workbench/use-conversation-scroll';
import {useConversationStream} from "../../lib/workbench/use-conversation-stream";
import {useActiveConversationReconciliation,useWorkbenchConversationData} from '../../lib/workbench/use-workbench-conversation-data';
import {agentOsCanUseDomain,agentOsConversationPath,agentOsConversationOperationPath,agentOsConversationCancelPath,nativeConversationFailure,nativeConversationRetryMessage,nativeConversationDisplayRuns,nativeConversationPreviousAttempts,nativeConversationFailureLabel,type AgentOsDomain,type AgentOsSession,type AgentOsNativeRun} from "../../lib/workbench/agentos-client";

const domains=[{id:'overview',label:'总控'},{id:'governance',label:'治理'},{id:'messaging',label:'消息'},{id:'discovery',label:'数据与发现'},{id:'maintenance',label:'运维'}];
const queries=[{label:'今天的变化',text:'总结今天的运营变化，并说明需要关注的事项。'},{label:'待办原因',text:'梳理当前待办的原因，以及需要人工处理的事项。'},{label:'处理进展',text:'查看最近处理进展和仍未解决的问题。'}];

type WaitingReply={retryOfOperationId?:string;operationId:string;runId:string|null;text:string;csrfToken:string};
type StoppingReply={operationId:string;parentOperationId:string;csrfToken:string};
type UnsentReply={operationId:string;text:string};
type PanelMemory={focused:boolean;positions:Record<string,{top:number;follow:boolean}>;waiting:Partial<Record<AgentOsDomain,WaitingReply>>;stopping:Partial<Record<AgentOsDomain,StoppingReply>>;unsent?:Partial<Record<AgentOsDomain,UnsentReply[]>>};
const retainedPanels=new Map<string,PanelMemory>();
function panelMemory(operatorId:string|null):PanelMemory{if(!operatorId)return {focused:false,positions:{},waiting:{},stopping:{}};let value=retainedPanels.get(operatorId);if(!value){value={focused:false,positions:{},waiting:{},stopping:{}};retainedPanels.set(operatorId,value);}return value;}
function saveDrafts(key:string,domain:string,drafts:Record<string,string>){
  try{window.sessionStorage.setItem(key,JSON.stringify({domain,drafts}));return true;}catch{return false;}
}
function MessageTime({value}:{value:number|null|undefined}){if(typeof value!=='number'||!Number.isFinite(value)||value<=0)return null;const date=new Date(value*1000);if(!Number.isFinite(date.getTime()))return null;const full=shanghaiMinute(date);return <time dateTime={date.toISOString()} title={full}>{full}</time>;}
function UserMessage({text,sentAt}:{text:string;sentAt?:number|null}){return <div className="wb-run-input"><strong>你</strong><div style={{whiteSpace:'pre-wrap'}}>{text}</div>{sentAt!=null&&<div className="wb-answer-time"><MessageTime value={sentAt}/></div>}</div>;}
function successfulRetryOf(runs:AgentOsNativeRun[],operationId:string){const byId=new Map(runs.filter(run=>!!run.operationId).map(run=>[run.operationId!,run]));for(const run of runs){if(run.status!=='COMPLETED')continue;let parent=run.retryOfOperationId;const visited=new Set<string>();while(parent&&!visited.has(parent)){if(parent===operationId)return true;visited.add(parent);parent=byId.get(parent)?.retryOfOperationId;}}return false;}

type Props={connection:'connected'|'not-connected'|'unavailable'|'loading';focused:boolean;onFocusChange:(focused:boolean)=>void;operatorId:string|null;onIdentityChange:(operatorId:string|null)=>void;signedOut:boolean};
export function WorkbenchCommunication(props:Props){const previous=useRef(props.operatorId);useEffect(()=>{const old=previous.current;if(old&&old!==props.operatorId){try{window.sessionStorage.removeItem(messageQueueStorageKey(old));}catch{}clearWorkbenchIntents(old);retainedPanels.delete(old);}previous.current=props.operatorId;},[props.operatorId]);return <WorkbenchCommunicationForOperator key={props.operatorId??'signed-out'} {...props}/>;}
function WorkbenchCommunicationForOperator({connection,focused,onFocusChange,operatorId,onIdentityChange,signedOut}:Props){
  const {source:logSource,actionsTarget}=useWorkbenchInteraction();
  const router=useRouter(),search=useSearchParams(),requestedTask=search.get('taskId')??'',taskId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedTask)?requestedTask:'';
  const task=useOperationsRead<AutonomyTaskRead>({path:operatorId&&taskId?'/v1/operations/autonomy/tasks/'+taskId:null,clearOnOffline:true,failureMessage:'接续任务暂时无法读取。'}),linkedTask=task.available?task.value?.task:null,appliedTask=useRef('');
  const [domain,setDomain]=useState<AgentOsDomain>('overview'),[drafts,setDrafts]=useState<Record<string,string>>({}),[draftStorageError,setDraftStorageError]=useState(false);
  const draftsRef=useRef<Record<string,string>>({}),domainRef=useRef('overview');
  const memory=useRef(panelMemory(operatorId)),composing=useRef(false),animatedTurns=useRef(new Set<string>()),revealDomain=useRef<AgentOsDomain>('overview'),outputStarted=useRef(new Set<string>()),lastSubmission=useRef<{domain:AgentOsDomain;message:string}|null>(null);
  const [readRecoveryBusy,setReadRecoveryBusy]=useState(false);
  const [waiting,setWaiting]=useState(memory.current.waiting),[stopping,setStopping]=useState(memory.current.stopping??{}),[contextNotices,setContextNotices]=useState<Partial<Record<AgentOsDomain,boolean>>>({});
  const [unsent,setUnsent]=useState(memory.current.unsent??{});
  const input=useRef<HTMLTextAreaElement>(null),panelId=useId(),inputId=useId();
  const conversationElement=useRef<HTMLDivElement>(null),conversationContent=useRef<HTMLDivElement>(null),scrollPositions=useRef(memory.current.positions);
  const storageKey=operatorId?'galaxy:operations:workbench:drafts:v1:'+operatorId:null;
  const session=useOperationsRead<AgentOsSession>({path:operatorId?'/v1/operations/session':null,failureMessage:'登录状态检查失败',clearOnOffline:true,retryUnavailable:true});
  const checkedSession=session.available?session.value:null;
  const identityEnded=!!checkedSession&&(checkedSession.state==='signed-out'||checkedSession.operator.id!==operatorId);
  const verifiedSession=!signedOut&&checkedSession?.state==='signed-in'&&checkedSession.operator.id===operatorId?checkedSession:null;
  const permittedDomains=domains.map(item=>item.id as AgentOsDomain).filter(item=>agentOsCanUseDomain(verifiedSession,item)),canUseDomain=permittedDomains.includes(domain);
  const data=useWorkbenchConversationData(domain,canUseDomain&&(focused||logSource==='actions'),verifiedSession?.csrfToken??null);
  const conversation=data.context,currentConversation=canUseDomain?data.conversation:null;
  const actionCards=useMemo(()=>[...new Map(workbenchActionCards(!data.denied?[...data.cards.value?.domain===domain?data.cards.value.items:[],...data.pageCards]:[],domain).sort((a,b)=>a.checkedAt-b.checkedAt).map(card=>[card.cardId,card])).values()],[data.cards.value,data.pageCards,data.denied,domain]);
  const [,tickCardClock]=useState(0),cardNow=Math.floor(Date.now()/1000);
  useEffect(()=>{
    if(!data.cards.verified||!actionCards.length)return;
    const expiresAt=Math.min(...actionCards.filter(card=>card.readExpiresAt>Math.floor(Date.now()/1000)).map(card=>card.readExpiresAt));if(!Number.isFinite(expiresAt))return;
    const timer=setTimeout(()=>{tickCardClock(value=>value+1);void data.cards.refresh();},Math.max(0,expiresAt*1000-Date.now()));return()=>clearTimeout(timer);
  },[actionCards,data.cards.verified,data.cards.refresh]);
  const interactive=session.ready&&operatorId!==null&&!identityEnded&&!signedOut;
  const waitingReply=canUseDomain&&verifiedSession&&!currentConversation?.contextChanged&&waiting[domain]?.csrfToken===verifiedSession.csrfToken?waiting[domain]:undefined;
  const waitingRun=waitingReply?currentConversation?.runs.find(run=>run.operationId===waitingReply.operationId||run.runId===(waitingReply.runId??waitingReply.operationId)):undefined;
  const replying=!!waitingReply||!!currentConversation?.runs.some(run=>['PENDING','RUNNING'].includes(run.status));
  useEffect(()=>{if(memory.current.focused){onFocusChange(true);requestAnimationFrame(()=>input.current?.scrollIntoView({block:'nearest'}));}},[onFocusChange]);
  useEffect(()=>{memory.current.focused=focused;},[focused]);
  useEffect(()=>{
    if(!data.contextInvalidated&&!data.denied)return;
    setWaiting(previous=>{if(!previous[domain])return previous;const next={...previous};delete next[domain];memory.current.waiting=next;return next;});
    setStopping(previous=>{if(!previous[domain])return previous;const next={...previous};delete next[domain];memory.current.stopping=next;return next;});
    if(data.contextInvalidated)setContextNotices(previous=>previous[domain]?previous:{...previous,[domain]:true});
  },[data.contextInvalidated,data.denied,domain]);
  useEffect(()=>{
    if(!verifiedSession)return;
    setWaiting(previous=>{const next={...previous};let changed=false;for(const [key,value] of Object.entries(previous))if(value&&value.csrfToken!==verifiedSession.csrfToken){delete next[key as AgentOsDomain];changed=true;}if(!changed)return previous;memory.current.waiting=next;return next;});
  },[verifiedSession?.csrfToken]);
  useEffect(()=>{
    if(!waitingRun||!['COMPLETED','ERROR','CANCELLED','REGENERATED','PAUSED'].includes(waitingRun.status))return;
    setWaiting(previous=>{const next={...previous};delete next[domain];memory.current.waiting=next;return next;});
  },[domain,waitingRun]);
  const currentToken=async(targetDomain:AgentOsDomain)=>{const current=await session.read();return current?.state==='signed-in'&&current.operator.id===operatorId&&agentOsCanUseDomain(current,targetDomain)?current.csrfToken:null;};
  const queue=useWorkbenchMessageQueue(operatorId);
  const denyConversation=()=>{session.clear();data.clear();void session.read();};
  useWorkbenchCardFeedback({enabled:!!verifiedSession&&canUseDomain&&data.contextUsable&&(data.cards.verified||data.pageCardsVerified)&&!data.pageCardsLoading&&!data.pageCardError,operatorId,csrfToken:verifiedSession?.csrfToken??'',domain,cards:actionCards,runs:currentConversation?.runs??[],currentToken,onReceipt:data.applyReceipt,onDenied:denyConversation});
  const reread=()=>{void data.context.refresh();void data.cards.refresh();data.refreshPageCards();};
  const restoreUnsent=(sentDomain:AgentOsDomain,operationId:string,text:string)=>{
    if(!draftsRef.current[sentDomain]){const next={...draftsRef.current,[sentDomain]:text};draftsRef.current=next;setDrafts(next);if(storageKey)setDraftStorageError(!saveDrafts(storageKey,domainRef.current,next));}
    else setUnsent(previous=>{const next={...previous,[sentDomain]:[...(previous[sentDomain]??[]),{operationId,text}]};memory.current.unsent=next;return next;});
  };
  const command=useWorkbenchCommand({operatorId,csrfToken:verifiedSession?.csrfToken??'',canWrite:canUseDomain,domain,permittedDomains,currentToken,onProgress:conversation.renew,validateResult:authorizedCommandMatches,onConflict:reread,onDenied:denyConversation,
    onQueued:intent=>{
      const sentDomain=domains.find(item=>intent.path===agentOsConversationPath(item.id as AgentOsDomain)+'/runs')?.id;
      if(!sentDomain||typeof intent.body.message!=='string'||intent.body.retryOfOperationId)return;
      if(draftsRef.current[sentDomain]===intent.body.message){const next={...draftsRef.current,[sentDomain]:''};draftsRef.current=next;setDrafts(next);if(storageKey)setDraftStorageError(!saveDrafts(storageKey,domainRef.current,next));}
    },
    onRejected:intent=>{
      const sentDomain=domains.find(item=>intent.path===agentOsConversationPath(item.id as AgentOsDomain)+'/runs')?.id as AgentOsDomain|undefined;
      if(!sentDomain||typeof intent.body.message!=='string'||intent.body.retryOfOperationId)return;
      restoreUnsent(sentDomain,String(intent.body.operationId),intent.body.message);
    },
    onCommitted:async(value,path,body)=>{
      const dismissedCard=path.endsWith('/dismiss')&&typeof body.cardId==='string'?document.querySelector('[data-workbench-card="'+body.cardId+'"]'):null;
      const returnToInput=!!dismissedCard&&(document.activeElement===document.body||dismissedCard.contains(document.activeElement));
      const sentDomain=domains.find(item=>path===agentOsConversationPath(item.id as AgentOsDomain)+'/runs')?.id as AgentOsDomain|undefined;
      if(sentDomain)lastSubmission.current=null;
      if(sentDomain&&['context-changed','not-started'].includes(value.state??'')&&typeof body.message==='string'&&!body.retryOfOperationId)restoreUnsent(sentDomain,String(body.operationId),body.message);
      if(sentDomain&&value.state==='context-changed'){
        setWaiting(previous=>{const next={...previous};delete next[sentDomain];memory.current.waiting=next;return next;});
        setContextNotices(previous=>({...previous,[sentDomain]:true}));
      }else if(sentDomain&&typeof body.message==='string'&&value.state!=='not-started'){
        animatedTurns.current.add(String(body.operationId));
        setContextNotices(previous=>{if(!previous[sentDomain])return previous;const next={...previous};delete next[sentDomain];return next;});
        setWaiting(previous=>{const next={...previous};if(['COMPLETED','ERROR','CANCELLED','PAUSED'].includes(value.state??''))delete next[sentDomain];else next[sentDomain]={operationId:String(body.operationId),runId:value.runId??null,text:String(body.message),...(typeof body.retryOfOperationId==='string'?{retryOfOperationId:body.retryOfOperationId}:{}),csrfToken:verifiedSession?.csrfToken??''};memory.current.waiting=next;return next;});
      }
      if(sentDomain&&value.state!=='context-changed'&&value.state!=='not-started'){
        data.applyReceipt(sentDomain,value,typeof body.message==='string'?body.message:undefined,typeof body.retryOfOperationId==='string'?body.retryOfOperationId:undefined);
        await data.context.renew();
      }else if(sentDomain)await data.context.refresh();else {await data.cards.refresh();data.refreshPageCards();}
      if(returnToInput&&(document.activeElement===document.body||dismissedCard?.contains(document.activeElement)))input.current?.focus({preventScroll:true});
    }});
  const queueCommand=useWorkbenchCommand({operatorId,csrfToken:verifiedSession?.csrfToken??'',canWrite:canUseDomain,domain,permittedDomains,memoryLane:'message-queue',currentToken,onProgress:conversation.renew,validateResult:authorizedCommandMatches,onConflict:reread,onDenied:denyConversation,
    beforePost:intent=>queue.attempted(String(intent.body.operationId)),
    onConversationBusy:(intent,busy)=>queue.returnBusy(String(intent.body.operationId),busy.blockingOperationId,busy.conversationId),
    onRejected:(intent,originalWriteRejected)=>{if(originalWriteRejected||!intent.attempted)queue.settle(String(intent.body.operationId),true);},
    onCommitted:async(value,path,body)=>{
      const sentDomain=domains.find(item=>path===agentOsConversationPath(item.id as AgentOsDomain)+'/runs')?.id as AgentOsDomain|undefined;
      if(!sentDomain)return;
      if(value.state==='not-started')queue.settle(String(body.operationId),true);
      if(value.state==='context-changed'){setContextNotices(previous=>({...previous,[sentDomain]:true}));await data.context.refresh();return;}
      if(value.state==='not-started'){await data.context.refresh();return;}
      animatedTurns.current.add(String(body.operationId));
      setWaiting(previous=>{const next={...previous};if(['COMPLETED','ERROR','CANCELLED','PAUSED'].includes(value.state??''))delete next[sentDomain];else next[sentDomain]={operationId:String(body.operationId),runId:value.runId??null,text:String(body.message),csrfToken:verifiedSession?.csrfToken??''};memory.current.waiting=next;return next;});
      data.applyReceipt(sentDomain,value,typeof body.message==='string'?body.message:undefined);
      const journal=queue.current.current.active.find(item=>item.operationId===body.operationId);
      if(journal?.item.conversationId===null){const fresh=await data.context.read();if(fresh?.conversationId&&fresh.latestOperation?.operationId===body.operationId&&!fresh.contextChanged)queue.bind(String(body.operationId),fresh.conversationId);}
      else await data.context.renew();
    }});
  const dismissCommand=useWorkbenchCommand({operatorId,csrfToken:verifiedSession?.csrfToken??'',canWrite:canUseDomain,domain,permittedDomains,memoryLane:'card-dismissal',currentToken,onProgress:conversation.renew,onConflict:reread,onDenied:denyConversation,
    validateResult:(value,intent)=>value.operationId===intent.body.operationId&&(value as typeof value&{cardId?:unknown}).cardId===intent.body.cardId,
    onCommitted:async(_value,_path,body)=>{
      const card=typeof body.cardId==='string'?document.querySelector('[data-workbench-card="'+body.cardId+'"]'):null;
      const restoreFocus=!!card&&(document.activeElement===document.body||card.contains(document.activeElement));
      await data.cards.refresh();data.refreshPageCards();
      // The original confirm lane settles only by observing this same card's
      // durable cancelled result. Do not clear or replace its pending intent.
      if(restoreFocus&&(document.activeElement===document.body||card?.contains(document.activeElement)))input.current?.focus({preventScroll:true});
    }});
  const workLocked=command.locked||dismissCommand.locked;
  const stopCommand=useWorkbenchCommand({operatorId,csrfToken:verifiedSession?.csrfToken??'',canWrite:canUseDomain,domain,permittedDomains,memoryLane:'stop-generation',currentToken,onProgress:conversation.renew,onConflict:reread,onDenied:denyConversation,
    validateResult:(value,intent)=>value.cancelledOperationId===intent.path.match(/\/operations\/([0-9a-f-]{36})\/cancel$/)?.[1],
    onCommitted:async(value,path,body)=>{
      const stoppedDomain=domains.find(item=>path.startsWith(agentOsConversationPath(item.id as AgentOsDomain)+'/operations/'))?.id as AgentOsDomain|undefined;
      if(stoppedDomain&&value.cancelledOperationId){setStopping(previous=>{const next={...previous};if(value.state==='context-changed'||['COMPLETED','ERROR','CANCELLED','PAUSED'].includes(value.state??''))delete next[stoppedDomain];else next[stoppedDomain]={operationId:String(body.operationId),parentOperationId:value.cancelledOperationId!,csrfToken:verifiedSession?.csrfToken??''};memory.current.stopping=next;return next;});}
      if(!stoppedDomain||!value.cancelledOperationId||stoppedDomain!==domain||!await data.readOperation(value.cancelledOperationId))return;
      await data.context.renew();
    }});
  const activeRun=[...(currentConversation?.runs??[])].reverse().find(run=>['PENDING','RUNNING'].includes(run.status));
  // A local intent may still be awaiting fresh authorization, before any POST.
  // Stream only a server-observed run or an ACK/original-GET-admitted reply.
  const activeTurn=activeRun?.operationId??waitingReply?.operationId??null;
  const refreshActiveTurn=useCallback(async()=>{
    if(!activeTurn)return data.context.refresh();
    const value=await data.readOperation(activeTurn,waiting[domain]?.text);
    if(value)return data.context.renew();
  },[activeTurn,domain,data.context.refresh,data.context.renew,data.readOperation,waiting]);
  const stream=useConversationStream({operatorId,csrfToken:verifiedSession?.csrfToken??'',domain,operationId:activeTurn,enabled:focused&&canUseDomain&&data.contextUsable&&!!currentConversation?.capabilities.canStream&&!currentConversation?.contextChanged&&!!activeTurn,readExpiresAt:Math.min(currentConversation?.readExpiresAt??0,session.value?.state==='signed-in'?session.value.expiresAt:Number.MAX_SAFE_INTEGER),onResync:refreshActiveTurn,onRenew:conversation.renew,onDenied:denyConversation,onContextChanged:()=>{setWaiting(previous=>{const next={...previous};delete next[domain];memory.current.waiting=next;return next;});setContextNotices(previous=>({...previous,[domain]:true}));}});
  useActiveConversationReconciliation({enabled:focused&&canUseDomain&&data.contextUsable,operationId:activeTurn,readOperation:data.readOperation,clear:data.clear});
  const storedStop=stopping[domain]?.csrfToken===verifiedSession?.csrfToken&&stopping[domain]?.parentOperationId===activeTurn?stopping[domain]:undefined;
  const stopInProgress=!!activeRun?.cancellation||!!storedStop||stopCommand.pending?.domain===domain;
  const canStop=canUseDomain&&data.contextUsable&&!!currentConversation?.capabilities.canCancel&&!!activeTurn&&!stream.finished&&(stream.stopAvailable||!!activeRun?.runId)&&!stopInProgress&&!stopCommand.locked;
  const stopGenerating=()=>{if(!canStop||!activeTurn)return;void stopCommand.submit(agentOsConversationCancelPath(domain,activeTurn),{},'',operationId=>agentOsConversationOperationPath(domain,operationId));};
  useEffect(()=>{
    if(!verifiedSession)return;
    setStopping(previous=>{const next={...previous};let changed=false;for(const [key,value]of Object.entries(previous))if(value&&(value.csrfToken!==verifiedSession.csrfToken||currentConversation?.domain===key&&(currentConversation.contextChanged||currentConversation.runs.some(run=>run.operationId===value.parentOperationId&&['COMPLETED','ERROR','CANCELLED','PAUSED'].includes(run.status))))){delete next[key as AgentOsDomain];changed=true;}if(!changed)return previous;memory.current.stopping=next;return next;});
  },[verifiedSession?.csrfToken,currentConversation]);
  const scrolling=useConversationScroll({viewport:conversationElement,content:conversationContent,scope:domain,enabled:focused&&!!currentConversation,positions:scrollPositions});
  useLayoutEffect(()=>{if(revealDomain.current!==domain){animatedTurns.current.clear();outputStarted.current.clear();revealDomain.current=domain;}if(activeTurn)animatedTurns.current.add(activeTurn);},[domain,activeTurn]);
  useLayoutEffect(()=>{if(activeTurn&&stream.text)outputStarted.current.add(activeTurn);},[activeTurn,stream.text]);
  useLayoutEffect(()=>{
    if(!identityEnded||!checkedSession)return;
    command.cancel();queueCommand.cancel();dismissCommand.cancel();stopCommand.cancel();data.clear();
    queue.clear();
    draftsRef.current={};setDrafts({});setWaiting({});setStopping({});memory.current.waiting={};memory.current.stopping={};
    if(operatorId)retainedPanels.delete(operatorId);
    onIdentityChange(checkedSession.state==='signed-in'?checkedSession.operator.id:null);
  },[identityEnded,checkedSession,operatorId,onIdentityChange,command.cancel,queueCommand.cancel,dismissCommand.cancel,stopCommand.cancel,data.clear]);
  useEffect(()=>{if(signedOut){command.cancel();queueCommand.cancel();queue.clear();}},[signedOut,command.cancel,queueCommand.cancel,queue.clear]);

  const taskReady=!taskId||task.verified&&!!linkedTask&&linkedTask.domain===domain&&!['stopped','completed','failed'].includes(linkedTask.state);
  useLayoutEffect(()=>{
    const pending=queueCommand.pending;if(!pending?.queueItemId)return;
    const journal=queue.current.current.active.find(item=>item.item.id===pending.queueItemId);
    if(!journal)return;
    const bootstrapPending=journal.item.conversationId===null&&journal.attempted;
    if(journal.item.domain!==domain||journal.item.taskId!==(taskId||null)||!bootstrapPending&&!!currentConversation?.conversationId&&journal.item.conversationId!==currentConversation.conversationId){
      queueCommand.cancel();pumpLock.current=false;if(!journal.attempted)queue.unreserve(journal.operationId);
    }
  },[domain,taskId,currentConversation?.conversationId,queueCommand.pending,queueCommand.cancel,queue.unreserve]);
  const sendMessage=async(message:string,retryOfOperationId?:string)=>{if(!taskReady||!canUseDomain||!verifiedSession||workLocked||queueCommand.locked||replying||!data.contextUsable||currentConversation?.domain!==domain||!currentConversation.capabilities.canSend||!message.trim()||message.length>12000)return;
    scrolling.jumpToLatest();
    const path=agentOsConversationPath(domain)+'/runs';
    lastSubmission.current={domain,message};
    const submission=command.submit(path,{message,...(taskId?{taskId}:{}),...(retryOfOperationId?{retryOfOperationId}:{})},'',operationId=>agentOsConversationOperationPath(domain,operationId));
    input.current?.focus({preventScroll:true});await submission;
  };
  const send=()=>{const message=draftsRef.current[domain]??'';const bootstrap=queue.current.current.active.some(item=>item.item.domain===domain&&item.item.taskId===(taskId||null)&&item.item.conversationId===null);const conversationId=bootstrap?null:currentConversation?.conversationId??null;if(!queue.ready||!verifiedSession||!canUseDomain||!data.contextUsable||!currentConversation||!taskReady||!message.trim()||message.length>12000)return;if(queue.enqueue({id:crypto.randomUUID(),domain,conversationId,taskId:taskId||null,text:message,enqueuedAt:Date.now()})){updateDraft('');scrolling.jumpToLatest();input.current?.focus({preventScroll:true});}};
  const pumpLock=useRef(false),terminalBarrier=useRef(false),editingQueueItem=useRef<string|null>(null),[pumpEpoch,setPumpEpoch]=useState(0);
  const setQueueEditing=(id:string|null)=>{editingQueueItem.current=id;setPumpEpoch(value=>value+1);};
  useEffect(()=>{const wake=()=>setPumpEpoch(value=>value+1);window.addEventListener('online',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);return()=>{window.removeEventListener('online',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};},[]);
  useEffect(()=>{
    const journal=queue.current.current.active.find(item=>item.item.domain===domain&&item.item.conversationId===currentConversation?.conversationId&&item.item.taskId===(taskId||null));
    if(!queue.ready||!journal)return;
    const run=currentConversation?.runs.find(value=>value.operationId===journal.operationId);
    if(run&&['COMPLETED','ERROR','CANCELLED','REGENERATED'].includes(run.status)){
      if(terminalBarrier.current)return;terminalBarrier.current=true;
      void (async()=>{try{const fresh=await data.context.read();if(fresh&&fresh.conversationId===journal.item.conversationId&&!fresh.contextChanged){if(['ERROR','CANCELLED','REGENERATED'].includes(run.status))queue.pause(journal.operationId);else queue.settle(journal.operationId);}}catch{/* Keep the original journal until fresh context can be verified. */}finally{terminalBarrier.current=false;}})();
    }
    else if(!journal.attempted&&!queueCommand.locked&&!pumpLock.current)queue.unreserve(journal.operationId);
  },[queue.ready,queue.state.active,currentConversation,domain,taskId,queueCommand.locked,queue.settle,queue.pause,queue.unreserve,pumpEpoch]);
  useEffect(()=>{
    const journal=queue.state.active.find(item=>item.item.domain===domain&&item.item.conversationId===currentConversation?.conversationId&&item.item.taskId===(taskId||null));
    const run=currentConversation?.runs.find(value=>value.operationId===journal?.operationId);
    if(!journal||run?.status!=='PAUSED'||!focused||!data.contextUsable)return;
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    const observe=async()=>{try{if(navigator.onLine&&document.visibilityState!=='hidden'){const result=await data.readOperation(journal.operationId);if(alive&&result)await data.context.renew();}}catch{/* Preserve the original paused run until it can be read. */}if(alive)timer=setTimeout(()=>void observe(),4000);};
    timer=setTimeout(()=>void observe(),4000);return()=>{alive=false;if(timer)clearTimeout(timer);};
  },[queue.state.active,currentConversation,domain,taskId,focused,data.contextUsable,data.readOperation,data.context.renew]);
  useEffect(()=>{
    const lane=queue.state.paused.find(value=>value.domain===domain&&value.conversationId===(currentConversation?.conversationId??null)&&value.taskId===(taskId||null));
    if(!lane||!currentConversation||!data.contextUsable||!successfulRetryOf(currentConversation.runs,lane.operationId))return;
    let alive=true;void (async()=>{try{const fresh=await data.context.read();if(alive&&fresh&&fresh.conversationId===lane.conversationId&&!fresh.contextChanged)queue.resume(lane);}catch{/* Keep the pause until current context can be verified. */}})();return()=>{alive=false;};
  },[queue.state.paused,currentConversation,domain,taskId,data.contextUsable,queue.resume]);
  useEffect(()=>{
    const lane=queue.state.busy.find(value=>value.domain===domain&&value.taskId===(taskId||null)&&(value.conversationId===null||value.conversationId===(currentConversation?.conversationId??null))&&!value.ready);
    if(!lane||!focused||!canUseDomain||!data.contextUsable||!navigator.onLine||document.visibilityState==='hidden')return;
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    const observe=async()=>{try{const fresh=await data.context.read();const original=lane.blockingOperationId;if(!alive)return;if(fresh&&!fresh.contextChanged&&fresh.domain===lane.domain&&fresh.conversationId===lane.observedConversationId){const result=await data.readOperation(original);if(!alive)return;if(result?.native&&['COMPLETED','ERROR','CANCELLED','REGENERATED'].includes(result.native.status)){const checked=await data.context.read();if(alive&&checked&&!checked.contextChanged&&checked.conversationId===fresh.conversationId&&checked.conversationId)queue.busyReady(lane,checked.conversationId);}}}catch{/* Keep this lane blocked until the original result can be observed. */}if(alive)timer=setTimeout(()=>void observe(),2000);};
    void observe();return()=>{alive=false;if(timer)clearTimeout(timer);};
  },[queue.state.busy,domain,taskId,currentConversation?.conversationId,focused,canUseDomain,data.contextUsable,queue.busyReady,pumpEpoch]);
  useEffect(()=>{
    const conversationId=currentConversation?.conversationId??null;
    const currentCommandBusy=command.locked&&(!command.pending||command.pending.domain===domain)||dismissCommand.locked&&(!dismissCommand.pending||dismissCommand.pending.domain===domain)||stopCommand.locked&&(!stopCommand.pending||stopCommand.pending.domain===domain);
    if(pumpLock.current||terminalBarrier.current||!queue.ready||!verifiedSession||!focused||!canUseDomain||!data.contextUsable||!currentConversation||currentConversation.contextChanged||!navigator.onLine||document.visibilityState==='hidden'||queueCommand.locked||currentCommandBusy)return;
    const journal=queue.current.current.active.find(item=>item.item.domain===domain&&item.item.taskId===(taskId||null)&&(item.item.conversationId===conversationId||item.item.conversationId===null&&item.attempted));
    if(journal){
      const observed=currentConversation?.runs.find(value=>value.operationId===journal.operationId);
      if(journal.item.conversationId!==null&&observed&&['COMPLETED','ERROR','CANCELLED','REGENERATED','PAUSED'].includes(observed.status))return;
      if(!journal.attempted||journal.item.conversationId!==null&&(activeRun?.operationId===journal.operationId||waitingReply?.operationId===journal.operationId))return;
      pumpLock.current=true;
      const submission=queueCommand.trySubmit(agentOsConversationPath(domain)+'/runs',{message:journal.item.text,...(journal.item.taskId?{taskId:journal.item.taskId}:{})},'',id=>agentOsConversationOperationPath(domain,id),journal.operationId,{queueItemId:journal.item.id,attempted:true});
      if(!submission.admitted)pumpLock.current=false;else void submission.promise.finally(()=>{pumpLock.current=false;});
      return;
    }
    if(!taskReady||replying||activeRun||waitingReply||!currentConversation?.capabilities.canSend)return;
    const busyLane=queue.current.current.busy.find(value=>value.domain===domain&&value.taskId===(taskId||null)&&(value.conversationId===conversationId||value.conversationId===null));
    if(busyLane&&(!busyLane.ready||busyLane.observedConversationId!==conversationId))return;
    if(queue.current.current.paused.some(value=>value.domain===domain&&value.conversationId===conversationId&&value.taskId===(taskId||null)))return;
    const item=queue.current.current.items.find(value=>queueLaneMatches(value,domain,conversationId,taskId||null)||!!busyLane?.ready&&busyLane.conversationId===null&&queueLaneMatches(value,domain,null,taskId||null));
    if(!item||item.needsReview||editingQueueItem.current===item.id)return;
    pumpLock.current=true;const operationId=item.reservedOperationId??crypto.randomUUID();
    if(!queue.reserve(item.id,operationId)){pumpLock.current=false;return;}
    const submission=queueCommand.trySubmit(agentOsConversationPath(domain)+'/runs',{message:item.text,...(item.taskId?{taskId:item.taskId}:{})},'',id=>agentOsConversationOperationPath(domain,id),operationId,{queueItemId:item.id,attempted:false});
    if(!submission.admitted){queue.unreserve(operationId);pumpLock.current=false;}else void submission.promise.finally(()=>{pumpLock.current=false;});
  },[queue.ready,queue.state,verifiedSession,focused,canUseDomain,data.contextUsable,currentConversation,taskReady,command.pending,command.locked,dismissCommand.pending,dismissCommand.locked,stopCommand.pending,stopCommand.locked,queueCommand.locked,replying,activeRun,waitingReply,domain,taskId,pumpEpoch]);
  const retryReply=(runId:string)=>{if(!data.contextUsable||currentConversation?.contextChanged)return;const message=nativeConversationRetryMessage(currentConversation,runId);if(message!==null){const original=currentConversation?.runs.find(run=>run.runId===runId);if(original?.operationId)void sendMessage(message,original.operationId);}};
  const confirmCard=(card:WorkbenchActionCard)=>{if(workLocked||queueCommand.locked&&queueCommand.pending?.domain===domain||!canUseDomain||!verifiedSession||!(data.cards.verified||data.pageCardsVerified)||data.pageCardsLoading||!!data.pageCardError||!card.capability.canConfirm||card.readExpiresAt<=Math.floor(Date.now()/1000))return;const path=workbenchCardPath(domain,card.cardId);lastSubmission.current=null;void command.submit(path+'/confirm',{cardId:card.cardId},'',()=>path,card.operationId);};
  const canDismissPending=(card:WorkbenchActionCard)=>command.pending?.domain===domain&&command.pending.path===workbenchCardPath(domain,card.cardId)+'/confirm'&&command.pending.body.cardId===card.cardId&&command.pending.body.operationId===card.operationId;
  const dismissCard=(card:WorkbenchActionCard)=>{if(!canUseDomain||!verifiedSession||!(data.cards.verified||data.pageCardsVerified)||data.pageCardsLoading||!!data.pageCardError||dismissCommand.locked||queueCommand.locked&&queueCommand.pending?.domain===domain||command.locked&&!canDismissPending(card)||!['prepared','not-available'].includes(card.state)||!card.capability.canDismiss||card.readExpiresAt<=Math.floor(Date.now()/1000))return;const path=workbenchCardPath(domain,card.cardId);void dismissCommand.submit(path+'/dismiss',{cardId:card.cardId},'',()=>path,card.operationId);};
  useEffect(()=>{
    if(!storageKey)return;
    if(Object.values(draftsRef.current).some(Boolean)){setDraftStorageError(!saveDrafts(storageKey,domainRef.current,draftsRef.current));return;}
    try{
      const saved=window.sessionStorage.getItem(storageKey);if(!saved)return;
      const value:unknown=JSON.parse(saved);if(!value||typeof value!=='object')return;
      const stored=value as {domain?:unknown;drafts?:unknown};
      if(!stored.drafts||typeof stored.drafts!=='object'||Array.isArray(stored.drafts))return;
      const restored=Object.fromEntries(Object.entries(stored.drafts).filter(([id,text])=>domains.some(item=>item.id===id)&&typeof text==='string').map(([id,text])=>[id,String(text).slice(0,12000)]));
      draftsRef.current=restored;setDrafts(restored);
      if(typeof stored.domain==='string'&&domains.some(item=>item.id===stored.domain)){domainRef.current=stored.domain;setDomain(stored.domain as AgentOsDomain);}
    }catch{setDraftStorageError(true);}
  },[storageKey]);
  useEffect(()=>{
    if(!linkedTask||appliedTask.current===linkedTask.id)return;
    appliedTask.current=linkedTask.id;domainRef.current=linkedTask.domain;setDomain(linkedTask.domain);onFocusChange(true);
    if(!draftsRef.current[linkedTask.domain]){const next={...draftsRef.current,[linkedTask.domain]:'请查看并接续这项任务，核实当前状态；需要业务写入时准备具体操作卡。'};draftsRef.current=next;setDrafts(next);if(storageKey)setDraftStorageError(!saveDrafts(storageKey,linkedTask.domain,next));}
  },[linkedTask,storageKey,onFocusChange]);
  const updateDraft=(value:string)=>{
    const next={...draftsRef.current,[domain]:value};draftsRef.current=next;setDrafts(next);
    if(storageKey)setDraftStorageError(!saveDrafts(storageKey,domain,next));
  };
  const fillReplyDraft=(value:string)=>{
    if(!canUseDomain||!verifiedSession)return;
    updateDraft([draftsRef.current[domain]??"",value].filter(Boolean).join("\n\n"));
    requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));
  };
  const changeDomain=(id:string)=>{
    if(!domains.some(item=>item.id===id))return;const element=conversationElement.current;if(element&&data.contextUsable&&verifiedSession&&currentConversation)scrollPositions.current[domain]={top:element.scrollTop,follow:scrolling.following};domainRef.current=id;setDomain(id as AgentOsDomain);
    if(storageKey)setDraftStorageError(!saveDrafts(storageKey,id,draftsRef.current));
  };
  const open=()=>{onFocusChange(true);requestAnimationFrame(()=>{input.current?.focus({preventScroll:true});input.current?.scrollIntoView({block:'nearest'});});};
  const state=conversation.value?.runtimeState??(connection==='connected'?'connected':connection==='loading'?'loading':'unavailable'),modelState=conversation.value?.modelState??'unknown';
  const status=signedOut?'请重新登录':data.denied?'无权使用此 AI':!verifiedSession?(session.error?'登录状态检查失败':'正在连接…'):!canUseDomain?'无权使用此 AI':currentConversation?.blockedReason==='runtime-not-ready'?'正在连接':state==='connected'?(modelState==='configured'?'已连接':modelState==='not-configured'?'未配置模型':'模型状态未知'):state==='not-configured'?'服务未配置':conversation.loading||connection==='loading'?'正在连接…':'连接失败';
  const current=domains.find(item=>item.id===domain)??domains[0];
  const sendReady=queue.ready&&taskReady&&canUseDomain&&data.contextUsable&&!!currentConversation&&!!(drafts[domain]??'').trim();
  const confirmingCard=typeof command.pending?.body.cardId==='string',sendingConversation=!!command.pending?.path.includes('/conversations/')&&!confirmingCard;
  const pendingCardVisible=canUseDomain&&data.cards.available&&actionCards.some(card=>card.cardId===command.pending?.body.cardId&&card.readExpiresAt>cardNow);
  const onComposerKeyDown=(event:KeyboardEvent<HTMLTextAreaElement>)=>{if(event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey||composing.current||event.nativeEvent.isComposing||event.keyCode===229)return;event.preventDefault();if(!event.repeat&&primaryReady)activatePrimary();};
  const showCards=(cards:WorkbenchActionCard[],label:string,readOnly=false)=>{
    const groups:WorkbenchActionCard[][]=[],seen=new Set<string>();
    for(const card of cards){if(seen.has(card.cardId))continue;const choice=card.choice,peers=choice?.count===3&&choice.exclusive?cards.filter(other=>other.choice?.groupId===choice.groupId&&other.choice.count===3&&other.choice.exclusive):[];const grouped=peers.length===3&&new Set(peers.map(item=>item.choice!.index)).size===3?peers.sort((a,b)=>a.choice!.index-b.choice!.index):[card];grouped.forEach(item=>seen.add(item.cardId));groups.push(grouped);}
    return groups.map(group=><WorkbenchActionCards key={group[0].cardId} readOnly={readOnly} cards={group} label={label} now={cardNow} available={canUseDomain&&!data.denied&&(data.cards.available||data.pageCardsVerified)} verified={canUseDomain&&!data.denied&&(data.cards.verified||data.pageCardsVerified)} busy={workLocked||data.pageCardsLoading||!!data.pageCardError||queueCommand.locked&&queueCommand.pending?.domain===domain} pendingCardId={typeof dismissCommand.pending?.body.cardId==='string'?dismissCommand.pending.body.cardId:typeof command.pending?.body.cardId==='string'?command.pending.body.cardId:null} pendingDismissCardId={group.find(card=>card.capability.canDismiss&&canDismissPending(card))?.cardId??null} dismissBusy={dismissCommand.locked} onConfirm={confirmCard} onDismiss={dismissCard}/>);
  };
  const latestRun=currentConversation?.runs.at(-1);
  const latestFailure=data.contextUsable&&!waitingReply&&!command.pending&&!queueCommand.pending&&latestRun?.status==='ERROR'?latestRun:null;
  const outgoing=queueCommand.pending??command.pending;
  const pendingOutgoing=canUseDomain&&conversation.available&&outgoing?.domain===domain&&outgoing.path===agentOsConversationPath(domain)+'/runs'&&!outgoing.body.retryOfOperationId&&typeof outgoing.body.message==='string'&&!waitingReply&&!currentConversation?.runs.some(run=>run.operationId===outgoing?.body.operationId)?outgoing:null;
  const logicalRuns=nativeConversationDisplayRuns((currentConversation?.runs??[]).filter(run=>run.origin!=='operation-feedback'));
  const visibleRuns=logicalRuns;
  const feedbackRuns=(currentConversation?.runs??[]).filter(run=>run.origin==='operation-feedback');
  const historyAnchor=useRef<{node:Element;offset:number}|null>(null);
  useLayoutEffect(()=>{const anchor=historyAnchor.current,viewport=conversationElement.current;if(!anchor||!viewport||!anchor.node.isConnected)return;viewport.scrollTop+=anchor.node.getBoundingClientRect().top-viewport.getBoundingClientRect().top-anchor.offset;historyAnchor.current=null;},[data.olderCursor]);
  const loadHistory=async()=>{const viewport=conversationElement.current;if(!viewport)return;const top=viewport.getBoundingClientRect().top,node=[...viewport.querySelectorAll('.wb-run')].find(item=>item.getBoundingClientRect().bottom>top);scrolling.pauseFollowing();historyAnchor.current=node?{node,offset:node.getBoundingClientRect().top-top}:null;if(!await data.loadMore())historyAnchor.current=null;};
  const qualificationError=!verifiedSession?session.error:(!data.contextUsable||!currentConversation?.capabilities.canSend?conversation.error:'');
  const headerError=queueCommand.error||command.error||dismissCommand.error||stopCommand.error||qualificationError;
  const retryRead=!!qualificationError&&!data.denied&&(!verifiedSession||canUseDomain)&&!workLocked&&!replying&&!signedOut;
  const retryModel=!!latestFailure&&nativeConversationFailure(latestFailure).canRetry&&!(drafts[domain]??'').trim();
  const retrySend=!!command.error&&lastSubmission.current?.domain===domain&&lastSubmission.current.message===(drafts[domain]??'');
  const primaryRetry=retryRead||retryModel||retrySend;
  const primaryReady=!readRecoveryBusy&&(retryRead?!!operatorId&&!signedOut:retryModel?taskReady&&canUseDomain&&data.contextUsable&&!!currentConversation?.capabilities.canSend&&!currentConversation.contextChanged&&!workLocked&&!replying:sendReady);
  const recoverReading=async()=>{setReadRecoveryBusy(true);try{await Promise.all([session.read(),conversation.read()]);}finally{setReadRecoveryBusy(false);}};
  const activatePrimary=()=>{if(!primaryReady)return;if(retryRead)void recoverReading();else if(retryModel&&latestFailure)retryReply(latestFailure.runId);else void send();};
  const primaryRetrying=readRecoveryBusy||sendingConversation&&!!command.pending?.body.retryOfOperationId;
  const blockedMessage=currentConversation?.blockedReason==='model-not-configured'?'未配置模型':currentConversation?.blockedReason==='runtime-unavailable'?'连接失败':'';
  return <section id="operations-ai" className={'wb-communication'+(focused?' wb-communication--focused':'')} aria-labelledby={panelId}>
    <header className="wb-section-heading"><h2 id={panelId}><AdminIcon name="sparkles" size={19}/>运营AI · {current.label}</h2><div className="wb-communication-controls">{data.contextUsable&&!waitingReply&&latestRun?.status==="COMPLETED"&&!!latestRun.modelFallbacks?.length&&<span className="wb-model-notice wb-model-notice--recovered" role="status">备用模型已接续</span>}<button type="button" className="wb-view-toggle" disabled={!interactive} aria-expanded={focused} aria-controls={panelId+'-conversation'} onClick={()=>focused?onFocusChange(false):open()}><AdminIcon name={focused?'workspace':'comment'} size={16}/><span>{focused?'返回仪表':interactive?'打开沟通':'准备沟通…'}</span></button></div></header>
    {actionsTarget&&createPortal(<WorkbenchActionHistory domain={domain} label={current.label} cards={actionCards} verified={!!verifiedSession&&canUseDomain&&!data.denied&&data.cards.available} loading={session.loading||data.cards.loading} denied={data.denied||!!verifiedSession&&!canUseDomain||signedOut} error={data.cards.error||session.error} now={cardNow} renderCard={card=>showCards([card],'所选AI操作',true)} feedback={null} retry={data.cards.read}/>,actionsTarget)}
    <AdminTabs items={interactive?domains:domains.map(item=>({...item,disabled:true}))} active={domain} onChange={changeDomain} ariaLabel="运营AI领域" className="wb-ai-domains"/>
    <p className="wb-connection" role="status"><i className="wb-status-dot"/>{status}</p>
    {signedOut&&<a className="wb-text-link" href="/admin/login?redirect=%2Fadmin">重新登录</a>}
    <div className="wb-conversation-frame" hidden={!focused}>
    <div ref={conversationElement} id={panelId+'-conversation'} className="wb-conversation" hidden={!focused}>
      <div ref={conversationContent} className="wb-conversation-content">
      {data.olderHasMore&&<button type="button" className="wb-text-button" disabled={data.moreLoading} onClick={()=>void loadHistory()}>{data.moreLoading?'正在读取…':'更多历史记录'}</button>}
      {data.moreError&&<p role="alert">{data.moreError}</p>}{data.pageCardError&&<p role="alert">{data.pageCardError} <button type="button" className="wb-text-button" onClick={data.refreshPageCards}>重试</button></p>}
      <ReadStatus loading={data.history.loading} error={data.history.error} retry={data.history.read}/>
      {domain==='overview'&&<><ReadStatus loading={data.management.loading} error={data.management.error} retry={data.management.read}/>{!data.denied&&data.management.available&&<WorkbenchManagementCapabilities value={data.management.value?.managementCapabilities??null}/>}</>}
      <div className="wb-query-presets" aria-label="预设查询">{queries.map(query=><button type="button" key={query.label} disabled={!canUseDomain} onClick={()=>{updateDraft(query.text);input.current?.focus();}}>{query.label}</button>)}</div>
      {contextNotices[domain]&&<p className="wb-reply-state" role="status">相关内容已有变化，后续对话使用当前资料。</p>}
      <div>{visibleRuns.map(run=>{
        const pending=['PENDING','RUNNING'].includes(run.status),live=pending&&run.operationId===activeTurn&&currentConversation?.capabilities.canStream===true;
        const content=['ERROR','CANCELLED'].includes(run.status)?null:live?stream.text:run.content;
        const showProgress=pending&&!content&&!outputStarted.current.has(run.operationId??run.runId)&&!(stopInProgress&&run.operationId===activeTurn);
        const previousAttempts=nativeConversationPreviousAttempts(currentConversation?.runs??[],run);
        const turnIds=new Set([run.operationId,run.runId,...previousAttempts.flatMap(attempt=>[attempt.operationId,attempt.runId])].filter(Boolean));
        const feedback=feedbackRuns.filter(item=>item.logicalTurnId&&item.logicalTurnId===run.logicalTurnId||!!item.parentOperationId&&turnIds.has(item.parentOperationId));
        const turnCards=actionCards.filter(card=>!!card.turnId&&turnIds.has(card.turnId));
        return <article className="wb-run" key={run.runId}>{!!previousAttempts.length&&<details className="wb-retry-history"><summary>重试记录</summary>{previousAttempts.map(attempt=><p key={attempt.runId}>{nativeConversationFailureLabel(attempt)}</p>)}</details>}{run.userInput&&<UserMessage text={run.userInput} sentAt={run.sentAt}/>}{run.userInput&&(content||pending)&&<hr className="wb-message-divider"/>}{content&&<><strong>AI</strong><WorkbenchAnswer content={content} binding={run.runId} animate={pending||!!run.operationId&&animatedTurns.current.has(run.operationId)} streaming={live} onDraft={fillReplyDraft} completedTime={!pending&&run.completedAt!=null?<MessageTime value={run.completedAt}/>:null}/></>}<WorkbenchReplyProgress active={showProgress} label={replyProgressLabel(live?stream.phase:'waiting',live&&stream.finished)}/>{showCards(turnCards,'本轮处理方案')}{feedback.map(item=>{const liveFeedback=item.operationId===activeTurn&&['PENDING','RUNNING'].includes(item.status)&&currentConversation?.capabilities.canStream===true,answer=liveFeedback?stream.text:item.content;return <div key={item.runId} className="wb-operation-feedback"><strong>AI</strong>{answer&&<WorkbenchAnswer content={answer} binding={item.runId} animate={liveFeedback} streaming={liveFeedback} onDraft={fillReplyDraft} completedTime={!liveFeedback&&item.completedAt!=null?<MessageTime value={item.completedAt}/>:null}/>}<WorkbenchReplyProgress active={['PENDING','RUNNING'].includes(item.status)&&!answer} label="正在处理"/>{showCards(actionCards.filter(card=>!!item.operationId&&card.turnId===item.operationId),'本次反馈的处理方案')}</div>;})}</article>;
      })}</div>

      {!!currentConversation&&waitingReply&&!waitingRun&&<article className="wb-run wb-run--waiting">{!waitingReply.retryOfOperationId&&<UserMessage text={waitingReply.text}/>}{!waitingReply.retryOfOperationId&&<hr className="wb-message-divider"/>}{stream.text&&<WorkbenchAnswer content={stream.text} binding={waitingReply.operationId} animate streaming/>}<WorkbenchReplyProgress active={!stream.text&&!outputStarted.current.has(waitingReply.operationId)&&!stopInProgress} label={replyProgressLabel(stream.phase,stream.finished)}/></article>}
      {pendingOutgoing&&<article className="wb-run wb-run--waiting"><UserMessage text={String(pendingOutgoing.body.message)}/><WorkbenchReplyProgress active label="正在发送"/></article>}

      {data.history.available&&data.contextUsable&&currentConversation?.runs.length===0&&currentConversation.capabilities.canSend&&!conversation.loading&&!conversation.error&&!session.error&&!waitingReply&&command.pending?.domain!==domain&&<div className="wb-empty wb-conversation-empty" role="status"><p><strong>开始对话</strong></p><p>询问这个领域的情况，或使用预设问题。</p></div>}
      </div>
    </div>
    {focused&&!scrolling.following&&<button type="button" className="wb-jump-latest" onClick={scrolling.jumpToLatest}><AdminIcon name="down" size={14}/>回到最新</button>}
    </div>
    {taskId&&<div className="wb-task-context" role="status"><div><strong>{linkedTask?.title||'接续原任务'}</strong><span>{linkedTask?autonomyStates[linkedTask.state]??'状态待核对':task.error||'正在核对任务…'}</span>{linkedTask&&<Link href={autonomyTaskHref(linkedTask)} prefetch={false}>任务详情</Link>}</div><div>{linkedTask&&linkedTask.domain!==domain&&<button type="button" disabled={workLocked||replying} onClick={()=>changeDomain(linkedTask.domain)}>切换到对应岗位</button>}<button type="button" disabled={workLocked||replying} onClick={()=>{const next=new URLSearchParams(search);next.delete('taskId');router.replace('/admin'+(next.size?'?'+next:''),{scroll:false});}}>结束任务沟通</button></div></div>}
    {linkedTask&&<AutonomyTaskResult task={linkedTask}/>}
    <div className="wb-compose-region"><div className="wb-compose-status" aria-live="polite">{command.pending?!permittedDomains.includes(command.pending.domain)?<p role="status">无权查看处理结果</p>:confirmingCard?pendingCardVisible?null:<p role="status">正在确认结果…</p>:pendingOutgoing?null:<p role="status">{sendingConversation?'正在确认发送…':'正在处理…'}</p>:command.message?<output>{command.message}</output>:null}</div>{(headerError||latestFailure||blockedMessage||queue.error)&&<div className="wb-compose-feedback">{queue.error?<div className="wb-compose-notice" role="alert">{queue.error}</div>:headerError?<div className="wb-compose-notice" role="alert">{headerError}</div>:latestFailure?<WorkbenchModelNotice run={latestFailure}/>:<div className="wb-compose-notice" role="status">{blockedMessage}</div>}</div>}
      {(unsent[domain]??[]).map(item=><article className="wb-run" key={item.operationId}><UserMessage text={item.text}/><p role="status">未发送。<button type="button" className="wb-text-button" onClick={()=>{fillReplyDraft(item.text);setUnsent(previous=>{const next={...previous,[domain]:(previous[domain]??[]).filter(row=>row.operationId!==item.operationId)};memory.current.unsent=next;return next;});}}>放回输入框</button></p></article>)}
    <WorkbenchMessageQueue items={queue.state.items.filter(item=>item.domain===domain)} active={queue.state.active.filter(item=>item.item.domain===domain&&(item.item.conversationId!==currentConversation?.conversationId||item.item.taskId!==(taskId||null)||!currentConversation?.runs.some(run=>run.operationId===item.operationId)&&queueCommand.pending?.body.operationId!==item.operationId&&waitingReply?.operationId!==item.operationId))} paused={!replying&&!command.locked&&!queueCommand.locked&&!queue.state.active.some(item=>queueLaneMatches(item.item,domain,currentConversation?.conversationId??null,taskId||null))?queue.state.paused.find(item=>item.domain===domain&&item.conversationId===(currentConversation?.conversationId??null)&&item.taskId===(taskId||null))??null:null} conversationId={currentConversation?.conversationId??null} taskId={taskId||null} provisionalWaiting={queue.state.busy.some(item=>item.domain===domain&&item.taskId===(taskId||null)&&item.conversationId===null&&item.observedConversationId===currentConversation?.conversationId)} onEditingChange={setQueueEditing} onContinue={queue.resume} onEdit={queue.edit} onRemove={queue.remove}/>
    <div className="wb-compose"><label className="wb-visually-hidden" htmlFor={inputId}>{current.label}领域的运营问题</label><textarea ref={input} id={inputId} rows={focused?3:1} value={identityEnded?'':drafts[domain]??''} maxLength={12000} disabled={!interactive||!canUseDomain} placeholder={verifiedSession&&!canUseDomain?'无权使用此 AI':interactive?'输入你的问题…':signedOut?'请重新登录后继续':'正在准备沟通…'} title="Enter 发送，Shift+Enter 换行" onFocus={()=>{if(!focused)open();}} onChange={event=>updateDraft(event.target.value)} onKeyDown={onComposerKeyDown} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}/><div className="wb-compose-actions">{replying&&!stream.finished&&currentConversation?.capabilities.canCancel&&(stream.stopAvailable||activeRun||stopInProgress)&&<button type="button" className="wb-stop-generation" disabled={!canStop} aria-busy={stopInProgress} onClick={stopGenerating} title="仅停止这次回复的后续生成，已完成的处理不会撤回。">{stopInProgress?'正在停止…':'停止生成'}</button>}<button type="button" className="wb-send" disabled={!primaryReady} aria-busy={readRecoveryBusy} onClick={activatePrimary}><AdminIcon name={primaryRetry||primaryRetrying?'refresh':'send'} size={16}/>{primaryRetrying?'重试中…':primaryRetry?'重试':workLocked||replying||queue.state.active.some(item=>item.item.domain===domain)||queue.state.busy.some(item=>item.domain===domain)||queue.state.paused.some(item=>item.domain===domain)?'加入队列':'发送'}</button></div></div>{draftStorageError&&<p className="wb-draft-storage-error" role="status">草稿保存失败</p>}</div>
  </section>;
}
