import {ReadingDetails,ReadingSummary} from "./reading-details";
import {independentTaskLabel} from "./task-material-client.mjs";
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FactWorkspace } from "./features/work-records/workspace";
import {readTaskResult,taskResultPath} from "./features/work-records/result-navigation.mjs";
import {selectedTaskMaterial,taskMaterialPath} from "./task-context-reading.mjs";
import { ContextWorkspace } from "./context-workspace";
import { TaskContactWorkspace } from "./task-contact-workspace";
import { RequesterFeedback } from "./requester-feedback";
import {qualificationEvaluationView} from "./task-bounty-client.mjs";
import {ApplicationTerms,QualificationSummary} from "./task-application";
import {localDateTime,taskWriteError} from "./task-bounty-client.mjs";
import {TaskAgentIdentityPrompt} from "./task-agent-identity-prompt";
import {MemberAvatar,MemberLink,useMemberNames} from "./conversation-ui";
import {FileText,MessageCircle,Plus,Search,Settings,Users,X} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import * as z from 'zod/v4';
import {participationEventV2Schema,taskEventV2Schema} from "../../galaxy-official/src/shared/task-schema-v2.mjs";
import {readOperationReceipt} from "./task-operation-state";
import {useChoiceViewLease,type ChoiceViewLease} from "./choice-retained-operations";
import type {WorkProps,WorkParticipation,WorkDelivery} from "./work-task-types";
import "./task-help-continuation.css";

const roles: Record<string, string> = { contribution:'一起参与',diagnosis: '诊断', advice: '建议', context: '补充背景', tool: '引入工具', patch: '补丁', review: '复核', verification: '验证', takeover: '接管', 'main-responsible': '主要负责人' };
const states: Record<string, string> = { 'awaiting-counterparty': '等待参与者确认', active: '正在参与', declined: '已婉拒', withdrawn: '已退出', delivered: '已分享本段结果', accepted: '本次交付已确认', disputed: '存在争议', closed: '本次参与已结束' };

type ActionKind='confirm'|'decline'|'withdraw'|'accept'|'propose-scope'|'confirm-scope'|'decline-scope'|'dispute'|'propose-resolution'|'confirm-resolution'|'cancel'|'close'|'invitation-reply'|'revoke-invitation'|'withdraw-application';
type PendingAcceptance={taskId:string;eventId:string;payloadHash:string;participationId:string;deliveryId:string};
type Action={kind:ActionKind;participant?:WorkParticipation|null;deliveryId?:string;invitationId?:string;applicationId?:string;recipientId?:string;response?:string;outcome?:'close'|'resume-work';pendingOperation?:PendingAcceptance};
const invitationStates:Record<string,string>={pending:'等待回应',interested:'愿意了解',question:'有问题待沟通',declined:'已婉拒',revoked:'已撤回',expired:'已到期'};
const actionTitles:Record<ActionKind,string>={confirm:'确认参与',decline:'婉拒参与',withdraw:'退出这次参与',accept:'填写验收意见','propose-scope':'调整参与范围','confirm-scope':'接受新范围','decline-scope':'维持原范围',dispute:'提出争议','propose-resolution':'提出处理办法','confirm-resolution':'确认处理办法',cancel:'取消求助',close:'结束征集','invitation-reply':'回应邀请','revoke-invitation':'撤回邀请','withdraw-application':'撤回帮助意向'};
const pendingAcceptanceSchema=z.object({taskId:z.string(),path:z.string(),eventId:z.string(),payloadHash:z.string(),payloadJson:z.string()});
function requestedView(){const value=new URLSearchParams(location.search).get('view');return value&&['people','work','materials','rooms','contacts','manage'].includes(value)?value:'people';}
export function TaskCollaboration(props:WorkProps){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return props.task.schemaVersion===2&&props.connected&&props.subjectId&&view.lease?<CollaborationSession key={props.task.taskId+':'+view.key} {...props} subjectId={props.subjectId} lease={view.lease}/>:null;
}
function CollaborationSession({task,runtime,subjectId,connected,navigate,refresh,lease}:WorkProps&{subjectId:string;lease:ChoiceViewLease}){
 const [action,setAction]=useState<Action|null>(null),[reason,setReason]=useState(''),[scope,setScope]=useState(''),
  [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const working=useRef(false),epoch=useRef(0),inputId=useId(),actionPanel=useRef<HTMLDialogElement>(null);
 const [view,setViewState]=useState(requestedView),[visited,setVisited]=useState<Record<string,boolean>>(()=>({[requestedView()]:true})),[agentReady,setAgentReady]=useState(false),
  [qualification,setQualification]=useState<{applicationId:string;value:unknown}|null>(null),[extension,setExtension]=useState(''),[clock,setClock]=useState(Date.now);
 useEffect(()=>{const viewEpoch=epoch;viewEpoch.current++;return()=>{viewEpoch.current++;};},[]);
 const check=useCallback((token:number)=>{lease.assertCurrent();if(epoch.current!==token)throw Error('协作页面已关闭或身份已变化。');},[lease]);
 function setView(next:string){lease.assertCurrent();setViewState(next);setVisited(current=>({...current,[next]:true}));const url=new URL(location.href);url.searchParams.set('section','collaboration');url.searchParams.set('view',next);if(next!=='materials')url.searchParams.delete('material');window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);window.dispatchEvent(new Event('galaxy:route-view-changed'));}
 function changeMaterialReading(grantId:string|null){lease.assertCurrent();const path=taskMaterialPath(task.taskId,grantId,location);if(path&&path!==location.pathname+location.search+location.hash)navigate(path);}
 const routeSearch=location.search;
 const readingResult=view==='work'&&new URLSearchParams(routeSearch).get('record')==='results'&&readTaskResult(routeSearch).selected;
 useEffect(()=>{const read=()=>{const desired=requestedView();setViewState(desired);setVisited(current=>current[desired]?current:{...current,[desired]:true});};read();window.addEventListener('popstate',read);window.addEventListener('galaxy:route-view-changed',read);return()=>{window.removeEventListener('popstate',read);window.removeEventListener('galaxy:route-view-changed',read);};},[routeSearch]);
 useEffect(()=>{const update=()=>setClock(Date.now()),timer=window.setInterval(update,15000);window.addEventListener('focus',update);return()=>{window.clearInterval(timer);window.removeEventListener('focus',update);};},[]);
 useEffect(()=>{if(action)actionPanel.current?.showModal();else actionPanel.current?.close();},[action]);
 const requester=task.requesterId===subjectId,legacyTerms=task.request.collaboration==='basic-bounty'||!!task.request.qualification,
  enrollmentOpen=task.enrollmentOpen??(task.state==='open'&&task.request.enrollmentExpiresAt>clock/1000);
 useEffect(()=>{
  const operation=action?.pendingOperation;if(!operation||!connected||operation.taskId!==task.taskId)return;
  const participant=task.participations?.find(item=>item.participationId===operation.participationId),delivery=participant?.deliveries?.find(item=>item.deliveryId===operation.deliveryId);
  if(delivery?.acceptance?.eventId!==operation.eventId)return;
  let active=true;const token=epoch.current;
  void runtime.api.call('/v2/tasks/receipt',{taskId:operation.taskId,eventId:operation.eventId,payloadHash:operation.payloadHash}).then((value:unknown)=>{
   check(token);const receipt=readOperationReceipt(value);
   if(active&&receipt.state==='acknowledged'&&receipt.taskId===operation.taskId&&receipt.eventId===operation.eventId&&receipt.payloadHash===operation.payloadHash){setAction(draft=>draft===action?null:draft);setNotice('验收意见已送达。');}
  }).catch(()=>{ /* Retain the original draft until its exact receipt is available. */ });
  return()=>{active=false;};
 },[task,action,runtime,connected,check]);
 async function run(fn:(checkCurrent:()=>void)=>Promise<unknown>){
  if(working.current)return;const token=epoch.current,checkCurrent=()=>check(token);checkCurrent();working.current=true;setBusy(true);setError('');setNotice('');
  let committed=false;
  try{await fn(checkCurrent);checkCurrent();committed=true;await refresh();checkCurrent();}
  catch(error){try{checkCurrent();}catch{return;}if(committed)setNotice('这一步已经收到服务回执，但最新任务状态暂时未刷新；请稍后刷新或查询原操作，不要重复提交。');else setError(taskWriteError(error));}
  finally{try{checkCurrent();working.current=false;setBusy(false);}catch{/* A later view owns its controls. */}}
 }
 const choose=(kind:ActionKind,participant?:WorkParticipation|null,extra:Omit<Partial<Action>,'kind'|'participant'>={})=>{lease.assertCurrent();setError('');setAction({kind,participant,...extra});setReason('');};
 async function commitAction(checkCurrent:()=>void,selected:Action|null=action,explanation=reason){
  if(!selected||selected.pendingOperation)return;checkCurrent();
  const {kind,participant}=selected;
  if(participant){
   const event=participationEventV2Schema.parse({eventId:crypto.randomUUID(),kind,expectedParticipationVersion:participant.version,
    ...(kind==='confirm'?{scopeVersion:participant.scopeVersion}:{}),
    ...(['decline','withdraw','dispute','decline-scope'].includes(kind)?{reason:explanation}:{}),
    ...(['confirm-scope','decline-scope'].includes(kind)?{proposalId:participant.pendingScope?.eventId}:{}),
    ...(kind==='accept'?{deliveryId:selected.deliveryId,summary:explanation}:{}),
    ...(kind==='propose-scope'?{scopeVersion:participant.scopeVersion+1,agreedScope:scope,reason:'更新参与内容。'}:{}),
    ...(kind==='propose-resolution'?{summary:explanation,outcome:selected.outcome}:{}),
    ...(kind==='confirm-resolution'?{proposalId:participant.disputeResolution?.eventId}:{})});
   try{await runtime.participationEvent(task.taskId,participant.participationId,event,{confirmed:true,viewers:[...new Set([participant.subjectId,task.requesterId])]});checkCurrent();}
   catch(error){
    if(event.kind==='accept')try{
     const raw:unknown=await runtime.getLocal(`task-event:${task.taskId}`);checkCurrent();const queued=pendingAcceptanceSchema.safeParse(raw);
     if(queued.success){
      const saved=participationEventV2Schema.safeParse(JSON.parse(queued.data.payloadJson));
      if(saved.success&&saved.data.kind==='accept'&&queued.data.taskId===task.taskId&&queued.data.path===`/v2/participations/${participant.participationId}/events`&&queued.data.eventId===saved.data.eventId&&saved.data.expectedParticipationVersion===participant.version&&saved.data.deliveryId===event.deliveryId&&saved.data.summary===event.summary){
       setAction(current=>current===selected?{...current,pendingOperation:{taskId:task.taskId,eventId:queued.data.eventId,payloadHash:queued.data.payloadHash,participationId:participant.participationId,deliveryId:event.deliveryId}}:current);setNotice('验收内容已保留，正在确认提交结果。');
      }
     }
    }catch{/* An unverified durable operation cannot replace the draft. */}
    throw error;
   }
  }else{
   const event=taskEventV2Schema.parse({eventId:crypto.randomUUID(),kind,expectedTaskVersion:task.version,
    ...(kind==='invitation-reply'?{invitationId:selected.invitationId,response:selected.response,message:explanation}:{reason:explanation,...(selected.applicationId?{applicationId:selected.applicationId}:{}),...(selected.invitationId?{invitationId:selected.invitationId}:{})})});
   await runtime.taskEvent(task.taskId,event,{confirmed:true,viewers:[...new Set([task.requesterId,...(selected.recipientId?[selected.recipientId]:[])])]});checkCurrent();
  }
  setAction(current=>current===selected?null:current);setNotice(kind==='confirm'?'你已加入，可以继续讨论、共享资料或记录结果。':kind==='close'?'已停止接受新回应，已有工作可以继续。':kind==='accept'?'你的反馈已送达。':'已保存。');
 }
 function act(kind:ActionKind,participant?:WorkParticipation|null,extra:Omit<Partial<Action>,'kind'|'participant'>={},explanation=actionTitles[kind]+'。'){void run(checkCurrent=>commitAction(checkCurrent,{kind,participant,...extra},explanation));}
 function proposeTogether(subject:string,agreedScope:string,applicationId?:string){void run(async checkCurrent=>{await runtime.proposeParticipation(task.taskId,{subjectId:subject,...(applicationId?{applicationId}:{}),expectedTaskVersion:task.version,role:'contribution',agreedScope},{confirmed:true});checkCurrent();setNotice('共同工作邀请已发出，对方同意后即可一起参与。');});}
 function openResults(delivery:WorkDelivery){navigate(taskResultPath(task.taskId,delivery.resultRef??null,delivery.deliveryId));setViewState('work');setVisited(current=>({...current,work:true}));}
 const applications=task.contacts?.responses?.applications??[],invitations=task.contacts?.responses?.invitations??[],participations=task.participations??[],
  displayNames=useMemberNames(runtime,subjectId,connected,[task.requesterId,...applications.map(item=>item.subjectId),...invitations.map(item=>item.recipientId),...participations.map(item=>item.subjectId)]),
  ownPending=applications.some(item=>item.subjectId===subjectId&&item.state==='pending');
 const pastParticipant=(participant:WorkParticipation)=>['declined','withdrawn','closed'].includes(participant.state);
 const currentParticipants=participations.filter(participant=>!pastParticipant(participant)),pastParticipants=participations.filter(pastParticipant);
 const visibleApplications=applications.filter(application=>(requester||application.subjectId===subjectId)&&application.state==='pending');
 const pastApplications=applications.filter(application=>(requester||application.subjectId===subjectId)&&application.state==='withdrawn');
 const visibleInvitations=invitations.filter(invite=>!['revoked','expired','declined'].includes(invite.state));
 const pastInvitations=invitations.filter(invite=>['revoked','expired','declined'].includes(invite.state));
 const existingParticipant=(subject:string)=>currentParticipants.some(participant=>participant.subjectId===subject);
 const hasHistory=pastParticipants.length+pastApplications.length+pastInvitations.length>0;
 const needsParticipationIdentity=currentParticipants.some(participant=>participant.subjectId===subjectId&&participant.state==='awaiting-counterparty')||requester&&(visibleApplications.length>0||visibleInvitations.some(invite=>invite.state==='interested'));
 const tabs:[string,string,LucideIcon][]=[['people','回应与参与',Users],['work','进展与结果',FileText],['materials','共享资料',FileText],['rooms','对话',MessageCircle]];
 const person=(id:string)=><MemberLink subjectId={id} ownId={subjectId} name={displayNames[id]??undefined} navigate={navigate}/>;
 function participantRow(participant:WorkParticipation){return <article className="collaboration-person" key={participant.participationId}>
  <MemberAvatar subjectId={participant.subjectId} own={participant.subjectId===subjectId}/>
  <div>
   <header>{person(participant.subjectId)}<span>{states[participant.state]??participant.state}</span></header>
   {participant.role!=='contribution'&&<p className="collaboration-role">{roles[participant.role]??participant.role}</p>}
   <p className="collaboration-scope">{participant.agreedScope??'这份参与内容当前不可读取。'}</p>
   {participant.state==='awaiting-counterparty'&&participant.subjectId!==subjectId&&<p className="application-note">邀请已发出，由对方决定是否加入。</p>}
   <div className="button-row">
    {participant.subjectId===subjectId&&participant.state==='awaiting-counterparty'&&<><Button disabled={busy||legacyTerms||!agentReady} onClick={()=>act('confirm',participant)}>加入一起做</Button><Button variant="ghost" disabled={busy} onClick={()=>act('decline',participant)}>暂不参与</Button></>}
    {participant.subjectId===subjectId&&['active','delivered','accepted','disputed'].includes(participant.state)&&<><Button variant="outline" onClick={()=>setView('work')}>记录进展或结果</Button><Button variant="ghost" disabled={busy} onClick={()=>act('withdraw',participant)}>退出参与</Button></>}
    {requester&&['active','delivered','accepted'].includes(participant.state)&&!participant.pendingScope&&<Button variant="ghost" disabled={busy} onClick={()=>{setScope(participant.agreedScope??'');choose('propose-scope',participant);}}>更新一起做的内容</Button>}
   </div>
   {participant.pendingScope&&<section className="collaboration-change"><h4>对方提出更新参与内容</h4><p>{participant.pendingScope.agreedScope}</p>{participant.pendingScope.reason!=='更新参与内容。'&&<p>{participant.pendingScope.reason}</p>}{participant.subjectId===subjectId&&<div className="button-row"><Button disabled={busy} onClick={()=>act('confirm-scope',participant)}>按新内容继续</Button><Button variant="outline" disabled={busy} onClick={()=>act('decline-scope',participant)}>继续原来的内容</Button></div>}</section>}
   {(participant.deliveries??[]).map(delivery=><section className="collaboration-delivery" id={'delivery-'+delivery.deliveryId} key={delivery.deliveryId}>
    <header><h4>工作结果</h4><span>{delivery.acceptance?'对方已确认':'已分享'}</span></header><p>{delivery.summary??'这份结果当前不可读取。'}</p>
    {delivery.acceptance?.summary&&<p className="collaboration-scope">对方的反馈：{delivery.acceptance.summary}</p>}
    <div className="button-row"><Button variant="outline" disabled={!delivery.resultRef} onClick={()=>openResults(delivery)}>查看结果</Button>{requester&&!delivery.acceptance&&<Button variant="ghost" disabled={busy} onClick={()=>choose('accept',participant,{deliveryId:delivery.deliveryId})}>确认收到的结果</Button>}</div>
    <ReadingDetails className="source-locator"><ReadingSummary>结果依据</ReadingSummary><p>结果：{delivery.resultRef?`${delivery.resultRef.id} · 版本 ${delivery.resultRef.version}`:'当前不可读'}</p><p>相关工作：{(delivery.interventionRefs??[]).map(ref=>`${ref.id} · 版本 ${ref.version}`).join('；')||'未附加'}</p><p>相关证据：{(delivery.evidenceRefs??[]).map(ref=>typeof ref==='string'?`${ref} · 历史第一版`:`${ref.id} · 版本 ${ref.version}`).join('；')||'未附加'}</p></ReadingDetails>
   </section>)}
   {participant.dispute&&<section className="collaboration-change"><h4>原有待处理事项</h4><p>{participant.dispute.reason}</p>{participant.state==='disputed'&&<div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>choose('propose-resolution',participant,{outcome:'resume-work'})}>提议继续合作</Button><Button variant="outline" disabled={busy} onClick={()=>choose('propose-resolution',participant,{outcome:'close'})}>提议结束参与</Button></div>}</section>}
   {participant.disputeResolution&&<section className="collaboration-change"><h4>处理提议</h4><p>{participant.disputeResolution.summary}</p>{participant.state==='disputed'&&participant.disputeResolution.actorId!==subjectId&&<Button disabled={busy} onClick={()=>act('confirm-resolution',participant)}>同意这个办法</Button>}</section>}
   <RequesterFeedback runtime={runtime} task={task} participant={participant} subjectId={subjectId} connected={connected} onChanged={async()=>{await refresh();}}/>
  </div>
 </article>;}
 return <section className="task-collaboration">
  {error&&<div className="message error" role="alert">{error}</div>}{notice&&<div className="message"><output>{notice}</output></div>}
  {!readingResult&&<><header className="collaboration-overview-heading"><h2>一起推进这件事</h2>{requester&&<div className="button-row"><Button variant="ghost" onClick={()=>setView('contacts')} aria-current={view==='contacts'?'page':undefined}><Search size={16}/>寻找帮助</Button><Button variant="ghost" onClick={()=>setView('manage')} aria-current={view==='manage'?'page':undefined}><Settings size={16}/>求助设置</Button></div>}</header>
  <nav className="collaboration-tabs" aria-label="一起做事">{tabs.map(([id,title,Icon])=><button key={id} onClick={()=>setView(id)} aria-current={view===id?'page':undefined}><Icon size={15}/>{title}</button>)}</nav></>}
  {view==='people'&&<div className="collaboration-people">
   <div className="collaboration-discussion-entry"><MessageCircle size={20}/><div><strong>先聊聊这件事</strong><p>想法、问题和建议可以直接在讨论中交流。</p></div><Button variant="outline" onClick={()=>navigate(`/app/tasks/${task.taskId}?section=comments`)}>参与讨论</Button></div>
   {legacyTerms&&<p className="application-note">这份历史求助保留原有参与条件。已有工作可以继续记录。</p>}
   {needsParticipationIdentity&&<TaskAgentIdentityPrompt {...{runtime,subjectId,connected,navigate}} onReady={setAgentReady}/>}
   {visibleApplications.length>0&&<section className="collaboration-group"><h3>{requester?'愿意提供帮助的人':'我的帮助意向'}</h3>{visibleApplications.map(application=><article className="collaboration-person" key={application.applicationId}>
    <MemberAvatar subjectId={application.subjectId} own={application.subjectId===subjectId}/><div><header>{person(application.subjectId)}</header><p>{application.proposal}</p>{application.scope&&<p className="collaboration-scope">{application.scope}</p>}
    {task.request.collaboration==='basic-bounty'&&<ApplicationTerms application={application} request={task.request}/>}
    <div className="button-row">{requester?<>
     {!existingParticipant(application.subjectId)&&<Button variant="outline" disabled={legacyTerms||busy||!enrollmentOpen||!agentReady} onClick={()=>proposeTogether(application.subjectId,[application.proposal,application.scope].filter(Boolean).join('\n\n'),application.applicationId)}>邀请一起做</Button>}
     <Button variant="ghost" onClick={()=>navigate(`/app/tasks/${task.taskId}?section=comments`)}>先在讨论中交流</Button>
     {task.request.qualification&&<Button variant="ghost" disabled={busy} onClick={()=>run(async(checkCurrent)=>{if(!task.request.qualification)return;const {profile,...policy}=task.request.qualification,modern=profile==='facts-v2';const input=modern?{taskId:task.taskId,subjectId:application.subjectId,evidence:application.qualificationEvidence,includeSimulation:false}:{...policy,capabilityId:task.request.capabilityId,subjectId:application.subjectId,evidence:application.qualificationEvidence};const result=await runtime.api.call(modern?'/v2/qualification/evaluate':'/v1/qualification/evaluate',input,{authenticated:true});checkCurrent();setQualification({applicationId:application.applicationId,value:qualificationEvaluationView(result)});})}>查看原任务条件</Button>}
    </>:<><span className="application-note">已送达，等待对方回应。</span><Button variant="ghost" disabled={busy} onClick={()=>act('withdraw-application',null,{applicationId:application.applicationId})}>撤回</Button></>}</div>
    {qualification?.applicationId===application.applicationId&&<QualificationSummary value={qualification.value}/>}</div>
   </article>)}</section>}
   {visibleInvitations.length>0&&<section className="collaboration-group"><h3>{requester?'发出的邀请':'收到的邀请'}</h3>{visibleInvitations.map(invite=><article className="collaboration-person" key={invite.invitationId}>
    <MemberAvatar subjectId={requester?invite.recipientId:task.requesterId}/><div><header>{person(requester?invite.recipientId:task.requesterId)}<span>{invitationStates[invite.state]??invite.state}</span></header><p>{invite.note}</p><div className="button-row">
     {!requester&&invite.recipientId===subjectId&&<><Button variant="outline" disabled={busy||invite.state==='interested'} onClick={()=>act('invitation-reply',null,{invitationId:invite.invitationId,response:'interested'},'愿意进一步交流。')}>有兴趣</Button><Button variant="ghost" onClick={()=>navigate(`/app/tasks/${task.taskId}?section=comments`)}>先聊聊</Button><Button variant="ghost" disabled={busy} onClick={()=>act('invitation-reply',null,{invitationId:invite.invitationId,response:'declined'},'暂不参与这次邀请。')}>暂不参与</Button></>}
     {requester&&invite.state==='interested'&&!legacyTerms&&!existingParticipant(invite.recipientId)&&<Button variant="outline" disabled={busy||!enrollmentOpen||!agentReady} onClick={()=>proposeTogether(invite.recipientId,invite.note)}>邀请一起做</Button>}
     {requester&&<Button variant="ghost" disabled={busy} onClick={()=>act('revoke-invitation',null,{invitationId:invite.invitationId,recipientId:invite.recipientId})}>撤回邀请</Button>}
    </div></div>
   </article>)}</section>}
   {currentParticipants.length>0&&<section className="collaboration-group"><h3>共同参与</h3>{currentParticipants.map(participantRow)}</section>}
   {!visibleApplications.length&&!visibleInvitations.length&&!currentParticipants.length&&<div className="collaboration-empty"><Users size={26}/><h3>{requester?'还没有新的回应':'还没有共同参与的工作'}</h3><p>{requester?'收到帮助意向后会出现在这里。你也可以继续原工作，或在讨论中获得一条建议。':'可以直接参与讨论，或告诉发起者你能提供什么帮助。'}</p>{!enrollmentOpen&&<p>这份求助已结束征集，已有讨论和记录仍可继续。</p>}{requester&&task.state==='open'&&enrollmentOpen&&<Button variant="ghost" disabled={busy} onClick={()=>act('close')}>停止接受新回应</Button>}{!requester&&!ownPending&&enrollmentOpen&&<Button variant="outline" onClick={()=>navigate(`/app/tasks/${task.taskId}?section=apply`)}>我可以提供帮助</Button>}</div>}
   {hasHistory&&<ReadingDetails className="collaboration-history"><ReadingSummary>已结束的参与和邀请</ReadingSummary><div id={inputId+'-past'}>
    {pastParticipants.length>0&&<section className="collaboration-group"><h3>已结束的参与</h3>{pastParticipants.map(participantRow)}</section>}
    {(pastApplications.length>0||pastInvitations.length>0)&&<section className="collaboration-group"><h3>已撤回或结束的回应</h3>{pastApplications.map(application=><article className="collaboration-person" key={application.applicationId}><MemberAvatar subjectId={application.subjectId}/><div><header>{person(application.subjectId)}<span>已撤回</span></header><p>{application.proposal}</p>{application.scope&&<p>{application.scope}</p>}</div></article>)}{pastInvitations.map(invite=><article className="collaboration-person" key={invite.invitationId}><MemberAvatar subjectId={requester?invite.recipientId:task.requesterId}/><div><header>{person(requester?invite.recipientId:task.requesterId)}<span>{invitationStates[invite.state]??invite.state}</span></header><p>{invite.note}</p></div></article>)}</section>}
   </div></ReadingDetails>}
  </div>}
  {view==='contacts'&&requester&&<section className="collaboration-purpose"><header><div><h3>寻找愿意交流的人</h3><p>从相关经历和对方表达的意愿中，找到适合这件事的人。</p></div></header><TaskContactWorkspace key={`contacts:${task.taskId}:${subjectId}`} task={task} runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} refresh={refresh}/></section>}
  {visited.work&&<div hidden={view!=='work'}><FactWorkspace key={`facts:${task.taskId}:${subjectId}`} task={task} runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} refresh={refresh}/></div>}
  {view==='materials'&&<section className="collaboration-purpose"><header><div><h3>共享资料</h3><p>选择需要的资料和可以使用它的人。</p></div></header><ContextWorkspace key={`context:${task.taskId}:${subjectId}`} task={task} runtime={runtime} subjectId={subjectId} connected={connected} initialGrantId={selectedTaskMaterial(task.taskId,location)} onReadingChange={changeMaterialReading}/></section>}
  {view==='rooms'&&<section className="collaboration-purpose"><header><div><h3>一起讨论</h3><p>接着已有对话聊，或为这件事开一个房间。</p></div><Button variant="outline" disabled={busy} onClick={()=>run(async(checkCurrent)=>{const room=await runtime.chat.create({title:independentTaskLabel(task,'任务讨论'),taskRefs:[task.taskId]},{confirmed:true});checkCurrent();navigate(`/app/rooms/${room.roomId}`);})}><Plus size={15}/>新建对话</Button></header><TaskContactWorkspace key={`task-rooms:${task.taskId}:${subjectId}`} section="rooms" task={task} runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} refresh={refresh}/></section>}
  {view==='manage'&&requester&&<section className="collaboration-purpose task-management"><header><div><h3>求助设置</h3><p>{enrollmentOpen?'接受新回应至 ':'本次征集截止于 '}{new Date(task.request.enrollmentExpiresAt*1000).toLocaleString('zh-CN')}。</p></div></header>{task.state==='open'&&<>
   <form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(async(checkCurrent)=>{const deadline=Math.floor(Date.parse(extension)/1000);if(!Number.isSafeInteger(deadline)||deadline<=Math.max(task.request.enrollmentExpiresAt,Date.now()/1000))throw Error('新的截止时间需要晚于当前截止和现在。');await runtime.taskEvent(task.taskId,{kind:'extend-enrollment',expectedTaskVersion:task.version,enrollmentExpiresAt:deadline},{confirmed:true,viewers:[task.requesterId]});checkCurrent();setExtension('');setNotice('已延长接受新回应的时间。');});}}><label htmlFor={inputId+'-extension'}>继续接受回应至<Input id={inputId+'-extension'} required type="datetime-local" min={localDateTime(Math.max(task.request.enrollmentExpiresAt,clock/1000)+60)} value={extension} onChange={event=>setExtension(event.target.value)}/></label><Button type="submit" variant="outline" disabled={busy}>保存时间</Button></form>
   <div className="task-management-actions"><div><strong>停止接受新回应</strong><p>已有的交流与共同工作继续。</p></div><Button variant="outline" disabled={busy} onClick={()=>act('close')}>结束征集</Button></div>
   <div className="task-management-actions"><div><strong>取消这项求助</strong><p>保留已经发生的工作与结果。</p></div><Button variant="ghost" disabled={busy} onClick={()=>choose('cancel')}>取消求助</Button></div>
  </>}</section>}
  <dialog ref={actionPanel} className="workspace-dialog collaboration-dialog" onCancel={()=>setAction(null)}>{action&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(commitAction);}}>
   <header className="dialog-heading"><h2>{action.kind==='accept'?'确认收到的结果':action.kind==='propose-scope'?'更新一起做的内容':actionTitles[action.kind]??'继续这件事'}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={()=>setAction(null)}><X size={19}/></button></header>
   {action.kind==='cancel'?<p>取消求助并保留已有工作记录。这份说明会发送给相关参与者。</p>:action.participant&&<p>{person(action.participant.subjectId)}</p>}
   <fieldset disabled={busy||!!action.pendingOperation}>
    {action.kind==='propose-scope'?<label htmlFor={inputId+'-action-scope'}>一起做什么<Textarea aria-label="一起做什么" id={inputId+'-action-scope'} required maxLength={3002} value={scope} onChange={event=>setScope(event.target.value)}/><small>对方同意后更新，原有内容在此之前继续有效。</small></label>:<label htmlFor={inputId+'-reason'}>{action.kind==='accept'?'关于这个结果的反馈':'说明'}<Textarea aria-label={action.kind==='accept'?'关于这个结果的反馈':'说明'} id={inputId+'-reason'} required maxLength={1500} value={reason} onChange={event=>setReason(event.target.value)} placeholder={action.kind==='accept'?'说说结果怎样帮助了这件事，或有哪些需要对方了解的内容。':undefined}/></label>}
   </fieldset>
   {action.pendingOperation&&<p><output>内容已保留，正在确认提交结果。</output></p>}{error&&<p className="message error" role="alert">{error}</p>}
   <footer className="dialog-actions"><Button type="button" variant="ghost" onClick={()=>setAction(null)}>返回</Button><Button type="submit" disabled={busy||!!action.pendingOperation}>{action.kind==='accept'?'确认结果并发送反馈':action.kind==='propose-scope'?'发送更新':'发送说明'}</Button></footer>
  </form>}</dialog>
 </section>;
}
