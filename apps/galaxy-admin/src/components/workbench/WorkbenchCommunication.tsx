'use client';

import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import Link from 'next/link';
import {createPortal} from 'react-dom';
import {useRouter,useSearchParams} from 'next/navigation';
import type {AutonomyTaskRead} from '../autonomy-types';
import {autonomyTaskHref,autonomyStates} from '../../lib/autonomy-view-model';
import {AdminIcon} from '../AdminIcons';
import {AdminTabs} from '../AdminTabs';
import {useOperationsRead} from '../../lib/use-operations-read';
import {ReadStatus} from '../OperationControls';
import {WorkbenchMarkdown} from './WorkbenchMarkdown';
import {WorkbenchModelNotice} from './WorkbenchModelNotice';
import {WorkbenchManagementCapabilities} from './WorkbenchManagementCapabilities';
import {WorkbenchActionHistory} from './WorkbenchActionHistory';
import {useWorkbenchInteraction} from './WorkbenchInteraction';
import {WorkbenchActionCards} from './WorkbenchActionCards';
import {authorizedCommandMatches} from '../../lib/authorized-preparation-model';
import {workbenchActionCards,workbenchCardPath,type WorkbenchActionCard} from '../../lib/workbench-action-cards';
import {useWorkbenchCommand} from '../../lib/use-workbench-command';
import {useConversationStream} from '../../lib/use-conversation-stream';
import {agentOsCanUseDomain,agentOsConversationPath,agentOsConversationOperationPath,agentOsConversationCancelPath,nativeRunLabel,nativeConversationRetryMessage,nativeConversationDisplayRuns,nativeConversationPreviousAttempts,nativeConversationFailureLabel,type AgentOsConversation,type AgentOsDomain,type AgentOsSession,type AgentOsStatus} from '../../lib/agentos-client';

const domains=[{id:'overview',label:'总控'},{id:'governance',label:'治理'},{id:'messaging',label:'消息'},{id:'discovery',label:'数据与发现'},{id:'maintenance',label:'运维'}];
const queries=[{label:'今天的变化',text:'总结今天的运营变化，并说明需要关注的事项。'},{label:'待办原因',text:'梳理当前待办的原因，以及需要人工处理的事项。'},{label:'处理进展',text:'查看最近处理进展和仍未解决的问题。'}];

type WorkbenchConversation=AgentOsConversation&{toolCards?:unknown;contextChanged?:boolean};
type WaitingReply={retryOfOperationId?:string;operationId:string;runId:string|null;text:string;csrfToken:string};
type StoppingReply={operationId:string;parentOperationId:string;csrfToken:string};
type PanelMemory={focused:boolean;positions:Record<string,{top:number;follow:boolean}>;waiting:Partial<Record<AgentOsDomain,WaitingReply>>;stopping:Partial<Record<AgentOsDomain,StoppingReply>>};
const retainedPanels=new Map<string,PanelMemory>();
function panelMemory(operatorId:string|null):PanelMemory{if(!operatorId)return {focused:false,positions:{},waiting:{},stopping:{}};let value=retainedPanels.get(operatorId);if(!value){value={focused:false,positions:{},waiting:{},stopping:{}};retainedPanels.set(operatorId,value);}return value;}
function saveDrafts(key:string,domain:string,drafts:Record<string,string>){
  try{window.sessionStorage.setItem(key,JSON.stringify({domain,drafts}));return true;}catch{return false;}
}

type Props={connection:'connected'|'not-connected'|'unavailable'|'loading';focused:boolean;onFocusChange:(focused:boolean)=>void;operatorId:string|null;onIdentityChange:(operatorId:string|null)=>void;signedOut:boolean};
export function WorkbenchCommunication(props:Props){return <WorkbenchCommunicationForOperator key={props.operatorId??'signed-out'} {...props}/>;}
function WorkbenchCommunicationForOperator({connection,focused,onFocusChange,operatorId,onIdentityChange,signedOut}:Props){
  const {source:logSource,actionsTarget}=useWorkbenchInteraction();
  const router=useRouter(),search=useSearchParams(),requestedTask=search.get('taskId')??'',taskId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedTask)?requestedTask:'';
  const task=useOperationsRead<AutonomyTaskRead>({path:operatorId&&taskId?'/v1/operations/autonomy/tasks/'+taskId:null,clearOnOffline:true,failureMessage:'接续任务暂时无法读取。'}),linkedTask=task.verified?task.value?.task:null,appliedTask=useRef('');
  const [domain,setDomain]=useState<AgentOsDomain>('overview'),[drafts,setDrafts]=useState<Record<string,string>>({}),[draftStorageError,setDraftStorageError]=useState(false);
  const draftsRef=useRef<Record<string,string>>({}),domainRef=useRef('overview');
  const memory=useRef(panelMemory(operatorId)),composing=useRef(false);
  const [waiting,setWaiting]=useState(memory.current.waiting),[stopping,setStopping]=useState(memory.current.stopping??{}),[contextNotices,setContextNotices]=useState<Partial<Record<AgentOsDomain,boolean>>>({});
  const input=useRef<HTMLTextAreaElement>(null),panelId=useId(),inputId=useId();
  const conversationElement=useRef<HTMLDivElement>(null),scrollPositions=useRef(memory.current.positions);
  const storageKey=operatorId?'galaxy:operations:workbench:drafts:v1:'+operatorId:null;
  const session=useOperationsRead<AgentOsSession>({path:operatorId?'/v1/operations/session':null,failureMessage:'当前管理登录暂时无法核对。',clearOnOffline:true});
  const checkedSession=session.verified?session.value:null;
  const identityEnded=!!checkedSession&&(checkedSession.state==='signed-out'||checkedSession.operator.id!==operatorId);
  const verifiedSession=!signedOut&&checkedSession?.state==='signed-in'&&checkedSession.operator.id===operatorId?checkedSession:null;
  const permittedDomains=domains.map(item=>item.id as AgentOsDomain).filter(item=>agentOsCanUseDomain(verifiedSession,item)),canUseDomain=permittedDomains.includes(domain);
  const runtime=useOperationsRead<AgentOsStatus>({path:permittedDomains.length?'/v1/operations/agentos/status':null,failureMessage:'运行服务状态暂时无法取得。',clearOnOffline:true});
  const conversation=useOperationsRead<WorkbenchConversation>({path:canUseDomain&&(focused||logSource==='actions')?agentOsConversationPath(domain):null,failureMessage:'当前对话暂时无法取得。',clearOnOffline:true,retryUnavailable:true,renewBeforeMs:20000});
  const currentConversation=canUseDomain&&conversation.value?.domain===domain?conversation.value:null;
  const actionCards=workbenchActionCards(currentConversation?.toolCards,domain),cardsWaiting=actionCards.some(card=>['processing','unknown'].includes(card.state));
  const [,tickCardClock]=useState(0),cardNow=Math.floor(Date.now()/1000);
  useEffect(()=>{
    if(!conversation.verified||!actionCards.length)return;
    const expiresAt=Math.min(...actionCards.filter(card=>card.readExpiresAt>Math.floor(Date.now()/1000)).map(card=>card.readExpiresAt));if(!Number.isFinite(expiresAt))return;
    const timer=setTimeout(()=>{tickCardClock(value=>value+1);void conversation.renew();},Math.max(0,expiresAt*1000-Date.now()));return()=>clearTimeout(timer);
  },[actionCards,conversation.verified,conversation.renew]);
  const interactive=session.ready&&operatorId!==null&&!identityEnded&&!signedOut;
  const waitingReply=canUseDomain&&verifiedSession&&!currentConversation?.contextChanged&&waiting[domain]?.csrfToken===verifiedSession.csrfToken?waiting[domain]:undefined;
  const waitingRun=waitingReply?currentConversation?.runs.find(run=>run.operationId===waitingReply.operationId||run.runId===(waitingReply.runId??waitingReply.operationId)):undefined;
  const replying=!!waitingReply||!!currentConversation?.runs.some(run=>['PENDING','RUNNING'].includes(run.status));
  useEffect(()=>{if(memory.current.focused){onFocusChange(true);requestAnimationFrame(()=>input.current?.scrollIntoView({block:'nearest'}));}},[onFocusChange]);
  useEffect(()=>{memory.current.focused=focused;},[focused]);
  useEffect(()=>{
    if(!conversation.verified||!currentConversation?.contextChanged)return;
    setWaiting(previous=>{if(!previous[domain])return previous;const next={...previous};delete next[domain];memory.current.waiting=next;return next;});
    setContextNotices(previous=>previous[domain]?previous:{...previous,[domain]:true});
  },[conversation.verified,currentConversation,domain]);
  useEffect(()=>{
    if(!verifiedSession)return;
    setWaiting(previous=>{const next={...previous};let changed=false;for(const [key,value] of Object.entries(previous))if(value&&value.csrfToken!==verifiedSession.csrfToken){delete next[key as AgentOsDomain];changed=true;}if(!changed)return previous;memory.current.waiting=next;return next;});
  },[verifiedSession?.csrfToken]);
  useEffect(()=>{
    if(!waitingRun||!['COMPLETED','ERROR','CANCELLED','REGENERATED','PAUSED'].includes(waitingRun.status))return;
    setWaiting(previous=>{const next={...previous};delete next[domain];memory.current.waiting=next;return next;});
  },[domain,waitingRun]);
  const currentToken=async(targetDomain:AgentOsDomain)=>{const current=await session.read();return current?.state==='signed-in'&&current.operator.id===operatorId&&agentOsCanUseDomain(current,targetDomain)?current.csrfToken:null;};
  const denyConversation=()=>{session.clear();conversation.clear();void session.read();};
  const reread=()=>{void conversation.read();void runtime.read();};
  const command=useWorkbenchCommand({operatorId,csrfToken:verifiedSession?.csrfToken??'',canWrite:canUseDomain,domain,permittedDomains,currentToken,onProgress:conversation.renew,validateResult:authorizedCommandMatches,onConflict:reread,onDenied:denyConversation,
    onCommitted:async(value,path,body)=>{
      const dismissedCard=path.endsWith('/dismiss')&&typeof body.cardId==='string'?document.querySelector('[data-workbench-card="'+body.cardId+'"]'):null;
      const returnToInput=!!dismissedCard&&(document.activeElement===document.body||dismissedCard.contains(document.activeElement));
      const sentDomain=domains.find(item=>path===agentOsConversationPath(item.id as AgentOsDomain)+'/runs')?.id as AgentOsDomain|undefined;
      if(sentDomain&&value.state==='context-changed'){
        setWaiting(previous=>{const next={...previous};delete next[sentDomain];memory.current.waiting=next;return next;});
        setContextNotices(previous=>({...previous,[sentDomain]:true}));
      }else if(sentDomain&&typeof body.message==='string'&&value.state!=='not-started'){
        setContextNotices(previous=>{if(!previous[sentDomain])return previous;const next={...previous};delete next[sentDomain];return next;});
        setWaiting(previous=>{const next={...previous};if(['COMPLETED','ERROR','CANCELLED','PAUSED'].includes(value.state??''))delete next[sentDomain];else next[sentDomain]={operationId:String(body.operationId),runId:value.runId??null,text:String(body.message),...(typeof body.retryOfOperationId==='string'?{retryOfOperationId:body.retryOfOperationId}:{}),csrfToken:verifiedSession?.csrfToken??''};memory.current.waiting=next;return next;});
        if(!body.retryOfOperationId&&draftsRef.current[sentDomain]===body.message){const next={...draftsRef.current,[sentDomain]:''};draftsRef.current=next;setDrafts(next);if(storageKey)setDraftStorageError(!saveDrafts(storageKey,domainRef.current,next));}
      }
      await conversation.read();
      if(returnToInput&&(document.activeElement===document.body||dismissedCard?.contains(document.activeElement)))input.current?.focus({preventScroll:true});
    }});
  const dismissCommand=useWorkbenchCommand({operatorId,csrfToken:verifiedSession?.csrfToken??'',canWrite:canUseDomain,domain,permittedDomains,memoryLane:'card-dismissal',currentToken,onProgress:conversation.renew,onConflict:reread,onDenied:denyConversation,
    validateResult:(value,intent)=>value.operationId===intent.body.operationId&&(value as typeof value&{cardId?:unknown}).cardId===intent.body.cardId,
    onCommitted:async(_value,_path,body)=>{
      const card=typeof body.cardId==='string'?document.querySelector('[data-workbench-card="'+body.cardId+'"]'):null;
      const restoreFocus=!!card&&(document.activeElement===document.body||card.contains(document.activeElement));
      await conversation.read();
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
      await conversation.read();
    }});
  const activeRun=[...(currentConversation?.runs??[])].reverse().find(run=>['PENDING','RUNNING'].includes(run.status));
  // A local intent may still be awaiting fresh authorization, before any POST.
  // Stream only a server-observed run or an ACK/original-GET-admitted reply.
  const activeTurn=activeRun?.operationId??waitingReply?.operationId??null;
  const stream=useConversationStream({operatorId,csrfToken:verifiedSession?.csrfToken??'',domain,operationId:activeTurn,enabled:focused&&canUseDomain&&conversation.verified&&!!currentConversation?.capabilities.canStream&&!currentConversation?.contextChanged&&!!activeTurn,readExpiresAt:Math.min(currentConversation?.readExpiresAt??0,session.value?.state==='signed-in'?session.value.expiresAt:Number.MAX_SAFE_INTEGER),onResync:conversation.renew,onDenied:denyConversation,onContextChanged:()=>{setWaiting(previous=>{const next={...previous};delete next[domain];memory.current.waiting=next;return next;});setContextNotices(previous=>({...previous,[domain]:true}));}});
  const storedStop=stopping[domain]?.csrfToken===verifiedSession?.csrfToken&&stopping[domain]?.parentOperationId===activeTurn?stopping[domain]:undefined;
  const stopInProgress=!!activeRun?.cancellation||!!storedStop||stopCommand.pending?.domain===domain;
  const canStop=canUseDomain&&conversation.verified&&!!currentConversation?.capabilities.canCancel&&!!activeTurn&&!stream.finished&&(stream.stopAvailable||!!activeRun?.runId)&&!stopInProgress&&!stopCommand.locked;
  const stopGenerating=()=>{if(!canStop||!activeTurn)return;void stopCommand.submit(agentOsConversationCancelPath(domain,activeTurn),{},'',operationId=>agentOsConversationOperationPath(domain,operationId));};
  useEffect(()=>{
    if(!verifiedSession)return;
    setStopping(previous=>{const next={...previous};let changed=false;for(const [key,value]of Object.entries(previous))if(value&&(value.csrfToken!==verifiedSession.csrfToken||currentConversation?.domain===key&&(currentConversation.contextChanged||currentConversation.runs.some(run=>run.operationId===value.parentOperationId&&['COMPLETED','ERROR','CANCELLED','PAUSED'].includes(run.status))))){delete next[key as AgentOsDomain];changed=true;}if(!changed)return previous;memory.current.stopping=next;return next;});
  },[verifiedSession?.csrfToken,currentConversation]);
  useLayoutEffect(()=>{
    const element=conversationElement.current;if(!element||!focused||!currentConversation)return;
    const position=scrollPositions.current[domain];
    if(position&&!position.follow){element.scrollTop=position.top;return;}
    element.scrollTop=element.scrollHeight;
  },[domain,focused,currentConversation,stream.text]);
  useLayoutEffect(()=>{
    if(!identityEnded||!checkedSession)return;
    command.cancel();dismissCommand.cancel();stopCommand.cancel();conversation.clear();
    draftsRef.current={};setDrafts({});setWaiting({});setStopping({});memory.current.waiting={};memory.current.stopping={};
    if(operatorId)retainedPanels.delete(operatorId);
    onIdentityChange(checkedSession.state==='signed-in'?checkedSession.operator.id:null);
  },[identityEnded,checkedSession,operatorId,onIdentityChange,command.cancel,dismissCommand.cancel,stopCommand.cancel,conversation.clear]);
  useEffect(()=>{if((!focused&&logSource!=='actions')||!conversation.verified||!currentConversation||!replying&&!cardsWaiting)return;const timer=setTimeout(()=>{if(navigator.onLine&&document.visibilityState==='visible')void conversation.renew();},2000);return()=>clearTimeout(timer);},[focused,logSource,conversation.verified,currentConversation,replying,cardsWaiting,conversation.renew]);
  const taskReady=!taskId||!!linkedTask&&linkedTask.domain===domain&&!['stopped','completed','failed'].includes(linkedTask.state);
  const sendMessage=async(message:string,retryOfOperationId?:string)=>{if(!taskReady||!canUseDomain||!verifiedSession||workLocked||replying||!conversation.verified||conversation.value?.domain!==domain||!conversation.value.capabilities.canSend||!message.trim()||message.length>12000)return;
    scrollPositions.current[domain]={top:conversationElement.current?.scrollTop??0,follow:true};
    const path=agentOsConversationPath(domain)+'/runs';
    await command.submit(path,{message,...(taskId?{taskId}:{}),...(retryOfOperationId?{retryOfOperationId}:{})},'',operationId=>agentOsConversationOperationPath(domain,operationId));
  };
  const send=()=>sendMessage(drafts[domain]??'');
  const retryReply=(runId:string)=>{if(!conversation.verified||currentConversation?.contextChanged)return;const message=nativeConversationRetryMessage(currentConversation,runId);if(message!==null){const original=currentConversation?.runs.find(run=>run.runId===runId);if(original?.operationId)void sendMessage(message,original.operationId);}};
  const confirmCard=(card:WorkbenchActionCard)=>{if(workLocked||!canUseDomain||!verifiedSession||!conversation.verified||!card.capability.canConfirm||card.readExpiresAt<=Math.floor(Date.now()/1000))return;const path=workbenchCardPath(domain,card.cardId);void command.submit(path+'/confirm',{cardId:card.cardId},'',()=>path,card.operationId);};
  const canDismissPending=(card:WorkbenchActionCard)=>command.pending?.domain===domain&&command.pending.path===workbenchCardPath(domain,card.cardId)+'/confirm'&&command.pending.body.cardId===card.cardId&&command.pending.body.operationId===card.operationId;
  const dismissCard=(card:WorkbenchActionCard)=>{if(!canUseDomain||!verifiedSession||!conversation.verified||dismissCommand.locked||command.locked&&!canDismissPending(card)||!['prepared','not-available'].includes(card.state)||!card.capability.canDismiss||card.readExpiresAt<=Math.floor(Date.now()/1000))return;const path=workbenchCardPath(domain,card.cardId);void dismissCommand.submit(path+'/dismiss',{cardId:card.cardId},'',()=>path,card.operationId);};
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
    if(!domains.some(item=>item.id===id))return;const element=conversationElement.current;if(element&&conversation.verified&&verifiedSession&&currentConversation)scrollPositions.current[domain]={top:element.scrollTop,follow:element.scrollHeight-element.clientHeight-element.scrollTop<24};domainRef.current=id;setDomain(id as AgentOsDomain);
    if(storageKey)setDraftStorageError(!saveDrafts(storageKey,id,draftsRef.current));
  };
  const open=()=>{onFocusChange(true);requestAnimationFrame(()=>{input.current?.focus({preventScroll:true});input.current?.scrollIntoView({block:'nearest'});});};
  const state=currentConversation?.runtimeState??runtime.value?.state,modelState=currentConversation?.modelState??runtime.value?.modelState;
  const status=signedOut?'管理登录已结束，请重新登录。':!verifiedSession?(session.error?'管理登录状态暂时无法取得。':'正在核对管理登录…'):!canUseDomain?'当前未获准使用本领域 AI。':currentConversation?.blockedReason==='runtime-not-ready'?'沟通服务尚未就绪，输入会保留':state==='connected'?(modelState==='configured'?'运行服务已连接 · 模型已配置':modelState==='not-configured'?'本领域暂未配置模型':'本领域模型状态暂不可用'):state==='not-configured'?'运行服务尚未配置':runtime.loading||conversation.loading||connection==='loading'?'正在读取连接状态':'连接状态暂时无法取得';
  const current=domains.find(item=>item.id===domain)??domains[0];
  const sendReady=taskReady&&canUseDomain&&conversation.verified&&!!currentConversation?.capabilities.canSend&&!workLocked&&!replying&&!!(drafts[domain]??'').trim();
  const confirmingCard=typeof command.pending?.body.cardId==='string',sendingConversation=!!command.pending?.path.includes('/conversations/')&&!confirmingCard;
  const pendingCardVisible=canUseDomain&&conversation.verified&&actionCards.some(card=>card.cardId===command.pending?.body.cardId&&card.readExpiresAt>cardNow);
  const onComposerKeyDown=(event:KeyboardEvent<HTMLTextAreaElement>)=>{if(event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey||composing.current||event.nativeEvent.isComposing||event.keyCode===229)return;event.preventDefault();if(!event.repeat&&sendReady)void send();};
  const showCards=(cards:WorkbenchActionCard[],label:string)=><WorkbenchActionCards cards={cards} label={label} now={cardNow} verified={canUseDomain&&conversation.verified} busy={workLocked} pendingCardId={typeof dismissCommand.pending?.body.cardId==='string'?dismissCommand.pending.body.cardId:typeof command.pending?.body.cardId==='string'?command.pending.body.cardId:null} pendingDismissCardId={cards.find(card=>card.capability.canDismiss&&canDismissPending(card))?.cardId??null} dismissBusy={dismissCommand.locked} onConfirm={confirmCard} onDismiss={dismissCard}/>;
  const latestRun=currentConversation?.runs.at(-1);
  const latestFailure=conversation.verified&&!waitingReply&&latestRun?.status==='ERROR'?latestRun:null;
  const headerError=command.error||dismissCommand.error||stopCommand.error||conversation.error||session.error;
  return <section id="operations-ai" className={'wb-communication'+(focused?' wb-communication--focused':'')} aria-labelledby={panelId}>
    <header className="wb-section-heading"><h2 id={panelId}><AdminIcon name="sparkles" size={19}/>运营AI · {current.label}</h2><div className="wb-communication-controls">{latestFailure&&<WorkbenchModelNotice run={latestFailure} canSend={canUseDomain&&conversation.verified&&!currentConversation?.contextChanged&&!!currentConversation?.capabilities.canSend} busy={workLocked||replying} onRetry={()=>retryReply(latestFailure.runId)}/>}{conversation.verified&&!waitingReply&&latestRun?.status==="COMPLETED"&&!!latestRun.modelFallbacks?.length&&<span className="wb-model-notice wb-model-notice--recovered" role="status">备用模型已接续</span>}<button type="button" className="wb-view-toggle" disabled={!interactive} aria-expanded={focused} aria-controls={panelId+'-conversation'} onClick={()=>focused?onFocusChange(false):open()}><AdminIcon name={focused?'workspace':'comment'} size={16}/><span>{focused?'返回仪表':interactive?'打开沟通':'准备沟通…'}</span></button></div></header>
    {headerError&&<div className="wb-header-feedback" role="alert">{headerError}</div>}
    {actionsTarget&&createPortal(<WorkbenchActionHistory domain={domain} label={current.label} cards={actionCards} verified={!!verifiedSession&&canUseDomain&&conversation.verified} loading={session.loading||conversation.loading} denied={!!verifiedSession&&!canUseDomain||signedOut} error={conversation.error||session.error} now={cardNow} renderCard={card=>showCards([card],'所选AI操作')} feedback={null}/>,actionsTarget)}
      <div className="wb-header-command-feedback" aria-live="polite">{command.pending?!permittedDomains.includes(command.pending.domain)?<p role="status">原操作结果尚未取得，当前无法继续读取。</p>:confirmingCard?pendingCardVisible?null:<p role="status">原操作的结果尚未确认，恢复读取后会继续查询。</p>:<p role="status">{sendingConversation?'正在发送…':'正在处理…'}</p>:command.message?<output>{command.message}</output>:null}</div>
    <AdminTabs items={interactive?domains:domains.map(item=>({...item,disabled:true}))} active={domain} onChange={changeDomain} ariaLabel="运营AI领域" className="wb-ai-domains"/>
    <p className="wb-connection" role="status"><i className="wb-status-dot"/>{status}</p>
    {signedOut&&<a className="wb-text-link" href="/admin/login?redirect=%2Fadmin">重新登录</a>}
    <div ref={conversationElement} id={panelId+'-conversation'} className="wb-conversation" hidden={!focused} onScroll={event=>{if(!conversation.verified||!verifiedSession||!currentConversation)return;const element=event.currentTarget;scrollPositions.current[domain]={top:element.scrollTop,follow:element.scrollHeight-element.clientHeight-element.scrollTop<24};}}>
      <ReadStatus loading={conversation.loading} error={''} retry={async()=>{await conversation.read();await session.read();await runtime.read();}}/>
      {domain==='overview'&&conversation.verified&&currentConversation&&<WorkbenchManagementCapabilities value={currentConversation.managementCapabilities??null}/>}
      <div className="wb-query-presets" aria-label="预设查询">{queries.map(query=><button type="button" key={query.label} disabled={!canUseDomain} onClick={()=>{updateDraft(query.text);input.current?.focus();}}>{query.label}</button>)}</div>
      {contextNotices[domain]&&<p className="wb-reply-state" role="status">相关内容已有变化，后续对话使用当前资料。</p>}
      <div>{nativeConversationDisplayRuns(currentConversation?.runs??[]).map(run=>{
        const pending=['PENDING','RUNNING'].includes(run.status),live=pending&&run.operationId===activeTurn&&currentConversation?.capabilities.canStream===true;
        const content=['ERROR','CANCELLED'].includes(run.status)?null:live?stream.text:run.content;
        const stateText=run.status==='CANCELLED'?'已停止生成':pending?(stopInProgress&&run.operationId===activeTurn?'正在停止生成…':live&&stream.finished?'正在读取完整回复…':live&&stream.phase==='working'?'正在核对资料…':'正在回复…'):nativeRunLabel(run.status);
        const previousAttempts=nativeConversationPreviousAttempts(currentConversation?.runs??[],run);
        return <article className="wb-run" key={run.runId}>{!!previousAttempts.length&&<details className="wb-retry-history"><summary>重试记录</summary>{previousAttempts.map(attempt=><p key={attempt.runId}>{nativeConversationFailureLabel(attempt)}</p>)}</details>}{run.userInput&&<p className="wb-run-input" style={{whiteSpace:'pre-wrap'}}><strong>你</strong><br/>{run.userInput}</p>}{content&&<div className="wb-run-output" aria-live="off"><strong className="wb-answer-author">运营助手</strong><WorkbenchMarkdown content={content} onDraft={fillReplyDraft}/></div>}{pending&&<p className="wb-reply-state" role="status">{stateText}</p>}</article>;
      })}</div>

      {conversation.verified&&waitingReply&&!waitingRun&&<article className="wb-run wb-run--waiting">{!waitingReply.retryOfOperationId&&<p className="wb-run-input" style={{whiteSpace:'pre-wrap'}}><strong>你</strong><br/>{waitingReply.text}</p>}{stream.text&&<div className="wb-run-output" aria-live="off"><strong className="wb-answer-author">运营助手</strong><WorkbenchMarkdown content={stream.text}/></div>}<p className="wb-reply-state" role="status">{stopInProgress?'正在停止生成…':stream.finished?'正在读取完整回复…':stream.phase==='working'?'正在核对资料…':stream.text?'正在回复…':'等待回复…'}</p></article>}
      {currentConversation?.blockedReason==='model-not-configured'&&<p>本领域暂未配置模型，输入会保留。</p>}
      {currentConversation?.blockedReason==='runtime-unavailable'&&<p>沟通服务暂时不可用，输入会保留。</p>}

      {conversation.verified&&currentConversation?.runs.length===0&&currentConversation.capabilities.canSend&&!conversation.loading&&!conversation.error&&!session.error&&!waitingReply&&command.pending?.domain!==domain&&<div className="wb-empty wb-conversation-empty" role="status"><p><strong>开始对话</strong></p><p>询问这个领域的情况，或使用预设问题。</p></div>}
    </div>
    {taskId&&<div className="wb-task-context" role="status"><div><strong>{linkedTask?.title||'接续原任务'}</strong><span>{linkedTask?autonomyStates[linkedTask.state]??'状态待核对':task.error||'正在核对任务…'}</span>{linkedTask&&<Link href={autonomyTaskHref(linkedTask)} prefetch={false}>任务详情</Link>}</div><div>{linkedTask&&linkedTask.domain!==domain&&<button type="button" disabled={workLocked||replying} onClick={()=>changeDomain(linkedTask.domain)}>切换到对应岗位</button>}<button type="button" disabled={workLocked||replying} onClick={()=>{const next=new URLSearchParams(search);next.delete('taskId');router.replace('/admin'+(next.size?'?'+next:''),{scroll:false});}}>结束任务沟通</button></div></div>}
    <div className="wb-compose"><label className="wb-visually-hidden" htmlFor={inputId}>{current.label}领域的运营问题</label><textarea ref={input} id={inputId} rows={focused?3:1} value={identityEnded?'':drafts[domain]??''} maxLength={12000} disabled={!interactive||!canUseDomain} placeholder={verifiedSession&&!canUseDomain?'当前未获准使用本领域 AI':interactive?'输入你的问题…':signedOut?'请重新登录后继续':'正在准备沟通…'} title="Enter 发送，Shift+Enter 换行" onFocus={()=>{if(!focused)open();}} onChange={event=>updateDraft(event.target.value)} onKeyDown={onComposerKeyDown} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}/><div className="wb-compose-actions">{replying&&!stream.finished&&currentConversation?.capabilities.canCancel&&(stream.stopAvailable||activeRun||stopInProgress)&&<button type="button" className="wb-stop-generation" disabled={!canStop} aria-busy={stopInProgress} onClick={stopGenerating} title="仅停止这次回复的后续生成，已完成的处理不会撤回。">{stopInProgress?'正在停止…':'停止生成'}</button>}<button type="button" className="wb-send" disabled={!sendReady} aria-busy={workLocked||replying} onClick={()=>void send()}>{!canUseDomain?'发送':sendingConversation?'发送中…':replying?(stream.finished?'读取回复中…':'等待回复'):'发送'}</button></div></div>{draftStorageError&&<p className="wb-draft-storage-error" role="status">草稿暂时只能保留在当前页面。</p>}
  </section>;
}
