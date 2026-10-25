import { ReadingDetails, ReadingSummary, ReadingSurface } from "../../../reading-details";
import React,{useEffect,useEffectEvent,useId,useMemo,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {createProjectViewClient,projectViewScope,projectQueryMemory,hasIndependentProject} from "../clients/views.mjs";
import {ContactSourceLinks} from "./origin";
import {AccountVerificationPrompt,needsAccountVerification} from "../../../account-verification-prompt";
import {MemberAvatar,memberName,readableTime,useMemberNames} from "../../../conversation-ui";
import "./compose.css";
import type {ProjectRuntime,DiscoveryQuery,DiscoveryPurpose,VisibleOpportunity,ContactView,ProjectContinuation,OperationWait,OriginalProjectOperation} from "../contracts";
import {object,projectErrorText,projectErrorFlag,projectErrorNumber,isDiscoveryPurpose} from "../contracts";
import type {ContactComposeValue,ContactComposeRecord,OpportunityClient} from "../../../help-contact-view-types";
import {checkedContactCompose,contactMessage} from "../../../help-contact-view-types";

const purposeNames:Record<string,string>={conversation:'交流想法',reuse:'了解复用',collaboration:'共同协作',recruitment:'了解招募'};
const states:Record<string,string>={sent:'已发送，等待回应',accepted:'双方已接受交流',declined:'对方已拒绝',withdrawn:'已撤回邀请',expired:'邀请已到期',awaiting_distinct_control:'等待独立控制主体确认'};
const contactWait=(value:OperationWait|null|undefined)=>{if(!value||!['quota-wait','cooldown-wait'].includes(value.reason??''))return '';const until=typeof value.retryAt==='string'&&Number.isFinite(Date.parse(value.retryAt))?new Date(value.retryAt).toLocaleString('zh-CN'):null;return(value.reason==='cooldown-wait'?'暂时还不能向对方发送新的邀请。':value.rejectionCode==='community_restricted'?'当前账号暂时不能发送邀请。':'当前可发送邀请的次数已用完。')+(until?'服务显示可在 '+until+' 后继续。':'请等待服务条件恢复。')+'原邀请内容已保留，页面会继续核对。';};
const contactWaiting=(value:ProjectContinuation|null|undefined)=>!!value&&!!contactWait(value)&&(!value.retryAt||Date.parse(value.retryAt)>Date.now());
type Props={runtime:ProjectRuntime|null;connected:boolean;subjectId?:string|null;query:DiscoveryQuery|null;opportunity:VisibleOpportunity;navigate:(path:string)=>void;onSourceUnavailable?:()=>void;onNeedIdentity?:()=>void;sourceIsCurrentPage?:boolean};
export function OpportunityContactWorkspace(props:Props){return <OpportunityContactView key={projectViewScope(props.runtime,props.connected)+JSON.stringify(props.opportunity?.opportunityRef)} {...props}/>;}
function OpportunityContactView({runtime,connected,subjectId,query,opportunity,navigate,onSourceUnavailable,onNeedIdentity,sourceIsCurrentPage=false}:Props){
 const owner=subjectId??(connected?runtime?.api?.snapshot()?.subjectId:null),scope=projectViewScope(runtime,connected);
 const client:OpportunityClient|null=useMemo(()=>runtime?createProjectViewClient(runtime,{connected,subjectId:owner}):null,[runtime,connected,owner]);
 const draftKey='contact:'+JSON.stringify(opportunity?.opportunityRef),[draft]=useState(()=>{const value:unknown=projectQueryMemory(runtime,connected,draftKey);return object(value)?value:null;});
 const localDraftKey='contact-compose:v1:'+JSON.stringify(opportunity?.opportunityRef);
 const recruitmentId='recruitmentId' in opportunity?opportunity.recruitmentId:undefined;
 const defaultRoomTitle=opportunity.sourceUnavailable?'银河交流':opportunity.project.title;
 const [composing,setComposing]=useState(sourceIsCurrentPage&&connected),[purpose,setPurpose]=useState(typeof draft?.purpose==='string'?draft.purpose:''),[note,setNote]=useState(typeof draft?.note==='string'?draft.note:''),[roomTitle,setRoomTitle]=useState(typeof draft?.roomTitle==='string'?draft.roomTitle:defaultRoomTitle);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[contact,setContact]=useState<ContactView|null>(null),[unknown,setUnknown]=useState<(ProjectContinuation&{operationId:string})|null>(null),[recruit,setRecruit]=useState<Awaited<ReturnType<OpportunityClient['recruitment']>>|null>(null);
 const [receipt,setReceipt]=useState<{operationId?:string;contactId:string}|null>(null),[confirmation,setConfirmation]=useState<{kind:'retry';review:OriginalProjectOperation&{type:'contact';payload:Extract<OriginalProjectOperation['payload'],{kind:'send'}>}}|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),fieldId=useId();
 const names=useMemberNames(runtime,owner??undefined,connected,[opportunity.subjectId]);
 const recipientName=names[opportunity.subjectId]??memberName(opportunity.subjectId);
 useEffect(()=>{if(confirmation)dialog.current?.showModal();else dialog.current?.close();},[confirmation]);
 const [verificationRequired,setVerificationRequired]=useState(false);
 const [pendingLoaded,setPendingLoaded]=useState(false);
 const generation=useRef(0),working=useRef(false),refKey=JSON.stringify(opportunity?.opportunityRef);
 const draftHead=useRef<string|null>(null),draftQueue=useRef<Promise<unknown>>(Promise.resolve()),draftActive=useRef(true);
 const draftValue=useRef({purpose,note,roomTitle}),draftFailure=useRef(false);
 const [draftLoaded,setDraftLoaded]=useState(false),[draftStatus,setDraftStatus]=useState('');
 const draftLease=useMemo(()=>connected&&owner&&runtime?runtime.receiptStatus.captureLease():null,[runtime,owner,connected]);
 const draftReady=!draftLease||draftLoaded;
 const checkDraft=()=>{draftLease?.assertCurrent();if(!draftLease||projectViewScope(runtime,connected)!==scope)throw new Error('身份或连接已变化，请重新打开联系草稿。');};
 const readDraft=checkedContactCompose;
 const restoreDraft=useEffectEvent((isActive:()=>boolean)=>{
  if(!draftLease||!runtime||!client)return Promise.resolve();checkDraft();return runtime.getLocal(localDraftKey,owner).then(async(raw:unknown)=>{let saved=readDraft(raw);checkDraft();
  if(saved?.attempt){const original=saved,operationId=saved.attempt.operationId;const result=await client.reviewPending(operationId);checkDraft();if(result?.state==='acknowledged')saved=readDraft(await runtime.updateLocal(localDraftKey,(raw:unknown)=>{checkDraft();const current=readDraft(raw);return current?.revision===original.revision&&current?.attempt?.operationId===operationId?null:raw;},owner));}
  if(!isActive())return;draftHead.current=saved?.revision??null;
  if(saved){draftValue.current=structuredClone(saved.value);setPurpose(saved.value.purpose);setNote(saved.value.note);setRoomTitle(saved.value.roomTitle);setDraftStatus('已恢复本机草稿。');setComposing(true);}
  const recent=await client.recentContact(opportunity);checkDraft();if(!isActive())return;
  if(recent){const sent=recent.events.find(event=>event.kind==='send');setReceipt({operationId:sent?.operationId,contactId:recent.contactId});if(!saved||saved.attempt?.operationId===sent?.operationId){setContact(recent);setComposing(false);}}
  setDraftLoaded(true);
  });
 });
 const showDraftFailure=useEffectEvent((reason:unknown)=>{draftFailure.current=true;setDraftStatus(contactMessage(reason,'草稿暂未读取成功，请保留本页输入。'));});
 useEffect(()=>{const liveDraft=draftActive;liveDraft.current=true;let active=true;
  void restoreDraft(()=>active).catch((reason:unknown)=>{if(active)showDraftFailure(reason);});
  return()=>{active=false;liveDraft.current=false;};
 },[draftLease,localDraftKey]);
 function changeDraft(patch:Partial<{purpose:string;note:string;roomTitle:string}>){
  const value={...draftValue.current,...patch};draftValue.current=value;setPurpose(value.purpose);setNote(value.note);setRoomTitle(value.roomTitle);
  if(!runtime||!draftReady||draftFailure.current)return;setDraftStatus('正在保存本机草稿…');
  const next=draftQueue.current.then(async()=>{checkDraft();const expected=draftHead.current;
   const saved=await runtime.updateLocal(localDraftKey,(raw:unknown)=>{checkDraft();const current=readDraft(raw);if((current?.revision??null)!==expected)throw new Error('另一页已修改这份草稿，当前输入仍在本页，请重新打开后核对。');return {version:1,revision:crypto.randomUUID(),value};},owner);
   checkDraft();draftHead.current=readDraft(saved)?.revision??null;if(draftActive.current&&draftValue.current===value)setDraftStatus('草稿已保存在本机。');
  });draftQueue.current=next;void next.catch((reason:unknown)=>{draftFailure.current=true;if(draftActive.current)setDraftStatus(contactMessage(reason,'草稿暂未保存，请保留本页输入。'));});
 }
 async function markDraftAttempt(operationId:string,value:ContactComposeValue){await draftQueue.current;checkDraft();if(!runtime)return;const revision=draftHead.current;if(!revision)return;
  await runtime.updateLocal(localDraftKey,(raw:unknown)=>{checkDraft();const current=readDraft(raw);return current?.revision===revision&&JSON.stringify(current.value)===JSON.stringify(value)?{...current,attempt:{operationId}}:current;},owner);checkDraft();
 }
 async function clearSentDraft(operationId:string){await draftQueue.current;checkDraft();if(!runtime)return;const cleared:{value:ContactComposeRecord|null}={value:null};
  const remaining=await runtime.updateLocal(localDraftKey,(raw:unknown)=>{checkDraft();const current=readDraft(raw);if(current?.attempt?.operationId!==operationId)return raw;cleared.value=current;return null;},owner);checkDraft();
  const removed=cleared.value;if(removed&&draftHead.current===removed.revision){draftHead.current=readDraft(remaining)?.revision??null;if(draftActive.current){setDraftStatus('');if(JSON.stringify(draftValue.current)===JSON.stringify(removed.value)){draftValue.current={purpose:'',note:'',roomTitle:defaultRoomTitle};setPurpose('');setNote('');setRoomTitle(defaultRoomTitle);}}}
 }
 useEffect(()=>{const epoch=generation;epoch.current++;return()=>{epoch.current++;};},[scope,refKey]);
 useEffect(()=>{if(projectViewScope(runtime,connected)===scope)projectQueryMemory(runtime,connected,draftKey,{purpose,note,roomTitle});},[runtime,connected,scope,draftKey,purpose,note,roomTitle]);
 const restorePending=useEffectEvent(async(isActive:()=>boolean)=>{
  if(!client||!draftReady)return;const value=await client.pendingContact(opportunity);
  if(value){try{
    const result=await client.resumePending(value.operationId);
    if(result.state==='acknowledged'){
      await clearSentDraft(value.operationId);
      if(isActive()&&!working.current){
        if(!result.objectId)throw Error('contact_receipt_unavailable');
        setUnknown(null);setComposing(false);setReceipt({operationId:value.operationId,contactId:result.objectId});
        const current=await client.contact(result.objectId);if(isActive()&&!working.current)setContact(current);
      }
    }else if(isActive()&&!working.current)setUnknown({...value,...result});
  }catch{if(isActive()&&!working.current)setUnknown(value);}}
  if(isActive()&&!working.current)setPendingLoaded(true);
 });
 const showPendingError=useEffectEvent((reason:unknown)=>setError(contactMessage(reason)));
 useEffect(()=>{let active=true,reading=false;
  const reload=()=>{if(!active||reading||working.current||document.visibilityState!=='visible'||!client||!draftReady)return;reading=true;
    void restorePending(()=>active).catch(reason=>{if(active&&!working.current)showPendingError(reason);}).finally(()=>{reading=false;});};
  reload();const timer=window.setInterval(reload,20000);document.addEventListener('visibilitychange',reload);
  return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',reload);};
 },[client,refKey,draftReady]);
 const purposes:DiscoveryPurpose[]=(opportunity.sourceUnavailable?[]:opportunity.help.purposes).filter(x=>query?.purposes.includes(x));
 const selectedPurpose=purposes.find(value=>value===purpose)??purposes[0]??'';
 async function run(fn:(commit:(action:()=>void)=>void)=>Promise<void>){if(working.current||!client)return;working.current=true;const g=generation.current;
  const commit=(action:()=>void)=>{if(g===generation.current){client.current();action();}};setBusy(true);setError('');setVerificationRequired(false);
  try{await fn(commit);}catch(e:unknown){if(g===generation.current){setConfirmation(null);setVerificationRequired(needsAccountVerification(e));setError(projectErrorFlag(e,'originalOperationRetained')&&contactWait({reason:projectErrorText(e,'reason'),retryAt:projectErrorText(e,'retryAt'),rejectionCode:projectErrorText(e,'code')})?'':projectErrorFlag(e,'sourceUnavailable')?'这项机会的当前资料或联系意愿已经变化，请重新查询。':needsAccountVerification(e)?'发送这项联系前需要关联银河账户。说明仍保留在本机，关联后请重新核对并明确发送。':contactMessage(e));if(projectErrorFlag(e,'sourceUnavailable')){setComposing(false);setRecruit(null);onSourceUnavailable?.();}if(projectErrorFlag(e,'resultUnknown')||projectErrorFlag(e,'originalOperationRetained'))setUnknown({state:'result-unknown',operationId:projectErrorText(e,'operationId'),objectId:projectErrorText(e,'objectId'),reason:projectErrorText(e,'reason'),retryAt:projectErrorText(e,'retryAt'),rejectionCode:projectErrorText(e,'code')});}}
  finally{working.current=false;if(g===generation.current)setBusy(false);}}
 const refreshContact=(id:string,commit:(action:()=>void)=>void)=>client!.contact(id).then(value=>commit(()=>setContact(value))).catch((error:unknown)=>{commit(()=>setContact(null));throw error;});
 async function reconcileOriginal(commit:(action:()=>void)=>void,retry=false){
  if(!unknown)return;const result=await client!.reconcile(unknown.operationId,retry);
  const confirmed=result.state==='acknowledged'||retry&&result.contactId;
  if(confirmed){await clearSentDraft(unknown.operationId);const contactId=result.objectId??result.contactId;if(!contactId)throw Error('contact_receipt_unavailable');commit(()=>{setUnknown(null);setContact(null);setComposing(false);setReceipt({operationId:result.operationId,contactId});});await refreshContact(contactId,commit);}
  else if(result.current){const current=result.current;commit(()=>setContact(current));}
 }
 useEffect(()=>{if(!client||!contact?.contactId)return;const contactId=contact.contactId;let active=true,reading=false;
  const update=()=>{if(!active||reading||working.current||document.hidden)return;reading=true;client.contact(contactId).then(value=>{if(active&&!working.current)setContact(value);}).catch((reason:unknown)=>{if(active&&[403,404].includes(projectErrorNumber(reason)??0)){setContact(null);setError('这次联系当前不可读取，请重新打开项目。');}}).finally(()=>{reading=false;});};
  const timer=window.setInterval(update,20000);document.addEventListener('visibilitychange',update);return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',update);};
 },[client,contact?.contactId]);
 async function sendInvitation(){if(!query||!isDiscoveryPurpose(selectedPurpose))return;changeDraft({purpose:selectedPurpose});const value={purpose:selectedPurpose,note,roomTitle};await run(async commit=>{const operationId=crypto.randomUUID();await markDraftAttempt(operationId,value);const result=await client!.send(query,opportunity,{...value,operationId});await clearSentDraft(operationId);commit(()=>{setReceipt({operationId:result.operationId,contactId:result.contactId});setComposing(false);});await refreshContact(result.contactId,commit);});}
 return <section className="opportunity-contact-section">
  <div className="section-heading"><div><h3>联系 {recipientName}</h3></div></div>
  <div className="button-row">{!sourceIsCurrentPage&&!contact&&hasIndependentProject(opportunity)&&<Button type="button" variant="outline" onClick={()=>navigate('/app/projects/'+opportunity.projectId)}>阅读项目</Button>}
   {recruitmentId&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{const value=await client!.recruitment(recruitmentId);commit(()=>setRecruit(value));})}>了解这项招募</Button>}
   {!opportunity.sourceUnavailable&&!composing&&!contact&&!unknown&&!receipt&&(!onNeedIdentity||connected)&&<Button type="button" disabled={!connected||!owner||!client||busy||!pendingLoaded||!purposes.length||opportunity.subjectId===owner} onClick={()=>{changeDraft({purpose:selectedPurpose});setComposing(true);}}>发起联系</Button>}</div>
  {!hasIndependentProject(opportunity)&&<p className="record-meta">这项介绍来自对方的公开个人资料。</p>}
  {!connected&&<div className="browse-note"><p>向对方发起联系前，请接续已有的银河身份。</p>{onNeedIdentity&&<Button type="button" onClick={onNeedIdentity}>接续已有身份</Button>}</div>}
  {error&&<div className="message error" role="alert">{error}<AccountVerificationPrompt required={verificationRequired} navigate={navigate}/></div>}
  {receipt&&!contact&&!composing&&!unknown&&<output className="message">已有一份联系邀请。<button className="text-link" onClick={()=>navigate('/app/projects?section=contacts&contactId='+encodeURIComponent(receipt.contactId))}>查看原邀请与当前回应</button></output>}
  {opportunity.sourceUnavailable&&<section aria-label="未发送的本地联系草稿"><p>对方的资料或交流意愿已变化。你的说明仍保留在这里，可以返回查询其他机会。</p><label htmlFor={fieldId+'-note-read'}>你的说明<Textarea id={fieldId+'-note-read'} readOnly value={note}/></label><label htmlFor={fieldId+'-room-read'}>聊天名称<Input id={fieldId+'-room-read'} readOnly value={roomTitle}/></label></section>}
  {recruit&&<ReadingSurface open title="招募详情" onClose={()=>setRecruit(null)}><article className="reading-detail recruitment-preview"><h4>{recruit.document?.title??'这项招募当前不可读取'}</h4>{recruit.document&&<><p>{recruit.document.role}</p><p className="reading-prose">{recruit.document.summary}</p>{recruit.document.conditions&&<p>参与条件：{recruit.document.conditions}</p>}</>}
   <p className="record-meta">{({active:'招募中',paused:'已暂停',closed:'已关闭',expired:'已到期'} as Record<string,string>)[recruit.state]??recruit.state}{recruit.expiresAt?' · 截至 '+readableTime(recruit.expiresAt):''} · {recruit.acceptingContacts?'接受联系':'当前不接收新的联系'}</p>
   {recruit.taskLinks?.map((link,index)=><Button type="button" key={link.taskId} variant="outline" onClick={()=>navigate('/app/tasks/'+link.taskId)}>阅读关联工作{(recruit.taskLinks?.length??0)>1?' '+(index+1):''}</Button>)}
   <ReadingDetails className="technical-details"><ReadingSummary>招募来源与联系人</ReadingSummary><p>联系人代表权：{recruit.representativeCurrentlyAuthorized?'当前有效':'当前未确认或已不可用'}</p><p>招募声明来自发布者，实际参与仍需双方明确安排。</p></ReadingDetails>
  </article></ReadingSurface>}
  {composing&&!contact&&!unknown&&!opportunity.sourceUnavailable&&<form className="workspace-form focused-form contact-compose-form" onSubmit={event=>{event.preventDefault();void sendInvitation();}}>
   {draftStatus&&!['正在保存本机草稿…','草稿已保存在本机。','已恢复本机草稿。'].includes(draftStatus)&&<output className="record-meta">{draftStatus}</output>}
   {purposes.length===1?<p className="contact-compose-purpose">交流目的：<strong>{purposeNames[selectedPurpose]??selectedPurpose}</strong></p>:<label htmlFor={fieldId+'-purpose'}>交流目的<select id={fieldId+'-purpose'} required disabled={!draftReady||busy} value={selectedPurpose} onChange={e=>changeDraft({purpose:e.target.value})}>{purposes.map(value=><option key={value} value={value}>{purposeNames[value]??value}</option>)}</select></label>}
   <label htmlFor={fieldId+'-note'}>想对对方说什么<Textarea id={fieldId+'-note'} required disabled={!draftReady||busy} maxLength={2000} value={note} onChange={e=>changeDraft({note:e.target.value})} placeholder="介绍你正在做的事，以及希望如何交流。"/></label>
   <div className="contact-compose-context"><small>随邀请附上的交流背景</small><p>{query?.context.kind==='ephemeral'?query.context.title:'当前项目'}</p>{query?.context.kind==='ephemeral'&&query.context.functions.length>0&&query.context.functions.join('、')!==query.context.title&&<p>{query.context.functions.join('、')}</p>}{query?.context.kind==='ephemeral'&&query.context.technologies?.length>0&&<p>{query.context.technologies.join('、')}</p>}</div>
   <ReadingDetails mode="inline" className="contact-compose-title"><ReadingSummary>聊天名称：{roomTitle}</ReadingSummary><label htmlFor={fieldId+'-room'}>聊天名称<Input id={fieldId+'-room'} required disabled={!draftReady||busy} maxLength={120} value={roomTitle} onChange={e=>changeDraft({roomTitle:e.target.value})}/></label></ReadingDetails>
   <div className="button-row"><Button type="submit" disabled={busy||!draftReady||!pendingLoaded||!selectedPurpose}>{busy?'正在发送…':'发送邀请'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setComposing(false)}>返回</Button></div>
  </form>}
  {contact&&<article className="reading-detail contact-current-state"><h4>{states[contact.state]??contact.state}</h4><ContactSourceLinks runtime={runtime} subjectId={owner} connected={connected} navigate={navigate} contact={contact}/>
   <div className="button-row">{contact.roomId&&<Button type="button" onClick={()=>navigate('/app/rooms/'+contact.roomId)}>进入聊天</Button>}{contact.state==='sent'&&contact.initiatorId===owner&&<Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{await client!.respond(contact,'withdraw');await refreshContact(contact.contactId,commit);})}>撤回邀请</Button>}{['declined','withdrawn','expired'].includes(contact.state)&&<Button type="button" variant="outline" disabled={busy} onClick={()=>{setContact(null);setComposing(true);}}>重新整理联系邀请</Button>}</div>
   <ReadingDetails className="technical-details"><ReadingSummary>联系记录</ReadingSummary><p>{contact.contactId}</p>{receipt?.operationId&&<p>{receipt.operationId}</p>}<button type="button" className="text-link" disabled={busy} onClick={()=>run(commit=>refreshContact(contact.contactId,commit))}>重新读取</button></ReadingDetails>
  </article>}
  {unknown&&<article className="operation-status"><p>{contactWait(unknown)||('上次联系尚待确认，原邀请已保留。'+(unknown.reason==='authorization-review-required'?'请确认原内容后继续。':''))}</p><Button type="button" variant="outline" disabled={busy} onClick={()=>run(async commit=>{const value=await client!.reviewPending(unknown.operationId);if(value&&'authorization' in value&&value.type==='contact'&&value.payload.kind==='send') {const review={...value,payload:value.payload};commit(()=>setConfirmation({kind:'retry',review}));}else if(value?.state==='acknowledged'){commit(()=>{setUnknown(null);setReceipt({operationId:value.operationId,contactId:value.objectId});});await refreshContact(value.objectId,commit);}else commit(()=>setError('当前没有读到这次联系的原记录，请保留原链接。'));})}>查看原邀请</Button><ReadingDetails className="technical-details"><ReadingSummary>原操作记录</ReadingSummary><p>{unknown.operationId}</p></ReadingDetails></article>}
  <dialog ref={dialog} className="galaxy-dialog contact-preview-dialog" onCancel={event=>{if(busy)event.preventDefault();else setConfirmation(null);}}>
   {confirmation?.review&&<><h3>继续原联系邀请</h3>
    <div className="person-line"><MemberAvatar subjectId={confirmation.review.payload.recipientId}/><strong>{recipientName}</strong></div>
    <p>{purposeNames[confirmation.review.payload.purpose]}</p><p className="reading-prose">{confirmation.review.payload.note}</p>
    <dl className="confirmation-facts"><dt>聊天名称</dt><dd>{confirmation.review.payload.roomTitle}</dd><dt>交流背景</dt><dd>{(confirmation.review.payload.context.kind==='ephemeral'?confirmation.review.payload.context.title:'当前项目')}</dd><dt>相关方向</dt><dd>{(confirmation.review.payload.context.kind==='ephemeral'?confirmation.review.payload.context.functions.join('、'):'')}</dd>{confirmation.review.payload.context.kind==='ephemeral'&&confirmation.review.payload.context.technologies?.length>0&&<><dt>相关技术</dt><dd>{confirmation.review.payload.context.technologies.join('、')}</dd></>}</dl>
    {contactWait(confirmation.review)&&<output>{contactWait(confirmation.review)}</output>}
    {!contactWait(confirmation.review)&&<p>{confirmation.review.authorization==='review-required'?'请确认仍向这位接收人发送原来的内容。':'继续发送这份原邀请。'}</p>}
    <ReadingDetails className="technical-details"><ReadingSummary>原邀请记录</ReadingSummary><p>{confirmation.review.payloadHash}</p><pre>{JSON.stringify(confirmation.review.payload,null,2)}</pre></ReadingDetails>
    <div className="button-row"><Button type="button" disabled={busy||contactWaiting(unknown??confirmation.review)} onClick={()=>run(async commit=>{await reconcileOriginal(commit,true);commit(()=>setConfirmation(null));})}>{busy?'正在处理…':'继续发送'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setConfirmation(null)}>返回</Button></div>
   </>}
  </dialog>
 </section>;
}
