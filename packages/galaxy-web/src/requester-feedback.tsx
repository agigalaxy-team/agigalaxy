import React,{useCallback,useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {requesterFeedbackAvailable,createRequesterFeedbackClient} from './requester-feedback-client.mjs';
import {useGovernanceDraft} from './governance-presentation';
import {errorField,operationSessionKey,readFeedbackLocator,readFeedbackPending,readOperationReceipt,readStoppedOperation,readStoppedOperations,readStopPreview} from './task-operation-state';
import type {FeedbackInput,FeedbackLocator,FeedbackParticipant,FeedbackPending,FeedbackRecord,FeedbackTask,OperationReceipt,OperationRuntime,StoppedOperation,StopPreview} from './task-operation-state';
import './requester-feedback.css';

const clarity:Record<string,string>={clear:'清楚','partly-clear':'部分清楚',unclear:'不清楚'};
const initialInput=(previous:FeedbackRecord|null|undefined):FeedbackInput=>({descriptionClarity:previous?.descriptionClarity??'',scopeMatched:previous?previous.scopeMatched?'yes':'no':'',note:previous?.note??'',reason:'',baseFeedbackId:previous?.eventId??null,editing:false});
const feedbackError=(error:unknown)=>typeof error==='object'&&error!==null&&'issues' in error?'请填写具体情况和必要的选择；修订时也请说明原因。':(/[\u3400-\u9fff]/.test(errorField(error,'message'))?errorField(error,'message'):'暂时未能保存反馈，原内容仍保留。');
const pendingText=(reason:string)=>({
  'business-rejected':'服务未接受上次反馈，已停止自动发送。原内容仍保留。',
  'authorization-expired':'上次提交的许可已经到期。先核对原内容与阅读范围，再决定是否继续。',
  'authorization-revoked':'上次提交的许可已撤回。原稿保留，继续前需要重新选择。',
  'binding-changed':'当前连接已改变，继续前请核对原反馈和阅读范围。',
  'reauthorization-required':'继续原反馈需要重新确认阅读范围。',
  'selection-expired':'上次提交的选择已到期。原稿保留，继续前需要重新确认。',
  'participation-changed':'这次参与或反馈已有变化，原提交不能直接继续。请保留原稿，核对当前内容。',
  'participation-unavailable':'这次参与当前不能提交反馈，原稿仍保留。',
  'original-authorization-unavailable':'上次提交的许可目前无法核对，原稿仍保留。',
  'original-binding-unavailable':'原连接依据目前不可用，继续前需要重新核对。',
  'operation-conflict':'原反馈的保存记录存在差异，当前不会另建反馈。',
} as Record<string,string>)[reason]??'正在确认上次反馈的保存结果，原内容会继续保留。';

type Props={runtime:OperationRuntime;task:FeedbackTask;participant:FeedbackParticipant;subjectId?:string;connected:boolean;onChanged?:()=>void|Promise<void>};
function FeedbackReading({previous,participant}:{previous:FeedbackRecord|null|undefined;participant:FeedbackParticipant}){return previous?<div className="feedback-reading">
  <p className="feedback-summary">描述{clarity[previous.descriptionClarity]??'当前不可读'} · 工作范围{previous.scopeMatched?'相符':'有差异'}</p>
  <p className="reading-prose">{previous.note}</p>
  <details className="feedback-source"><summary>反馈来源</summary><dl><dt>作者</dt><dd>{participant.subjectId}</dd><dt>本次参与</dt><dd>{participant.participationId}</dd><dt>反馈记录</dt><dd>{previous.eventId}</dd>{previous.supersedes&&<><dt>修订自</dt><dd>{previous.supersedes}</dd></>}{previous.reason&&<><dt>修订原因</dt><dd>{previous.reason}</dd></>}</dl><p>修订追加新记录，原反馈保留。</p></details>
</div>:null;}

export function RequesterFeedback(props:Props){
  const {runtime,task,participant,subjectId,connected}=props;
  const sessionKey=useCallback(()=>operationSessionKey(runtime,subjectId,connected,task.taskId,participant.participationId),[runtime,subjectId,connected,task.taskId,participant.participationId]);
  const [,setObserved]=useState(sessionKey);
  useEffect(()=>{const read=()=>setObserved(sessionKey()),timer=window.setInterval(read,1000);document.addEventListener('visibilitychange',read);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[sessionKey]);
  const available=connected&&!!subjectId&&requesterFeedbackAvailable(task,participant,subjectId);
  if(!participant.feedback&&!available)return null;
  if(!available||!subjectId)return <section className="requester-feedback"><h4>这次合作的反馈</h4><FeedbackReading previous={participant.feedback} participant={participant}/><p className="feedback-visibility">由参与者提供，仅参与者本人和请求者可读。</p></section>;
  return <FeedbackEditor key={sessionKey()} {...props} subjectId={subjectId}/>;
}

function FeedbackEditor({runtime,task,participant,subjectId,onChanged}:Props&{subjectId:string}){
  const [initial]=useState(()=>initialInput(participant.feedback)),previous=participant.feedback;
  const client=useMemo(()=>createRequesterFeedbackClient(runtime,task.taskId,participant.participationId,{subjectId}),[runtime,task.taskId,participant.participationId,subjectId]);
  const lease=useMemo(()=>{const value=runtime.receiptStatus.captureLease();if(value.subjectId!==subjectId)throw Error('当前反馈身份已变化。');return value;},[runtime,subjectId]);
  const draft=useGovernanceDraft<FeedbackInput,FeedbackLocator>(runtime,subjectId,true,'requester-feedback-input:v1:'+JSON.stringify([runtime.api.endpoint,subjectId,task.taskId,participant.participationId]),initial),input=draft.value;
  const [editingOverride,setEditing]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState<FeedbackPending|null>(null),[recovery,setRecovery]=useState<OperationReceipt|null>(null),[review,setReview]=useState<FeedbackPending|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [stopReview,setStopReview]=useState<StopPreview|null>(null),[stopped,setStopped]=useState<StoppedOperation|null>(null);
  const session=useRef<{active:boolean;working:boolean;reading:boolean;finished:string|null}>({active:false,working:false,reading:false,finished:null});
  const editing=editingOverride??input.editing;
  const sourceChanged=(input.baseFeedbackId??null)!==(previous?.eventId??null);
  const current=()=>{if(!session.current.active)return false;try{lease.assertCurrent();return true;}catch{return false;}};
  async function receiptFor(locator:FeedbackLocator){if(locator.kind!=='requester-feedback')return null;return readOperationReceipt(await client.receiptFor({eventId:locator.eventId,payloadHash:locator.payloadHash}));}
  async function finish(receipt:OperationReceipt){
    if(!current()||receipt?.state!=='acknowledged')return;
    const retired=await draft.settle(async locator=>{const result=await receiptFor(locator);return result?.state?{state:result.state}:null;});if(!current())return;
    setPending(null);setRecovery(null);setReview(null);setStopReview(null);setStopped(null);setError('');setMessage('合作反馈已保存。');if(retired)setEditing(false);
    if(session.current.finished!==receipt.eventId&&receipt.eventId){session.current.finished=receipt.eventId;try{await onChanged?.();}catch{if(current())setMessage('合作反馈已保存，最新页面暂时未读取完成。');}}
  }
  async function refresh(){
    if(!current()||session.current.reading||!draft.ready)return;session.current.reading=true;
    try{
      let retained=readFeedbackPending(await client.readPending());if(!current())return;
      if(retained){const result=readOperationReceipt(await client.resumePending());if(!current())return;if(result.state==='acknowledged'){await finish(result);return;}setRecovery(result);retained=readFeedbackPending(await client.readPending());if(!current())return;}
      setPending(retained);if(!retained)setRecovery(null);
      if(!retained&&draft.attempt){const locator=draft.attempt,receipt=await receiptFor(locator);if(!current())return;if(receipt?.state==='acknowledged'){await finish(receipt);return;}const records=readStoppedOperations(await runtime.stoppedTaskOperations(task.taskId));if(current())setStopped(records.find(record=>record.eventId===locator.eventId&&record.payloadHash===locator.payloadHash)??null);}
    }catch(e){if(current())setError(feedbackError(e));}finally{session.current.reading=false;}
  }
  const readCurrent=useEffectEvent(()=>refresh());
  useEffect(()=>{session.current.active=true;const state=session.current;return()=>{state.active=false;client.close();};},[client,session]);
  useEffect(()=>{if(!draft.ready)return;const read=()=>{if(!document.hidden&&!session.current.working)void readCurrent();};read();const timer=window.setInterval(read,5000);document.addEventListener('visibilitychange',read);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[draft.ready,client,session]);
  function change(patch:Partial<FeedbackInput>){draft.change({...patch,editing:true});setError('');setMessage('');}
  function begin(){if(!draft.ready||pending)return;if(!input.editing&&!draft.attempt)draft.change({...initialInput(previous),editing:true});setEditing(true);setMessage('');}
  async function run(action:()=>Promise<void>){if(session.current.working)return;session.current.working=true;setBusy(true);setError('');try{await action();}catch(e){if(current()){setError(feedbackError(e));await refresh();}}finally{session.current.working=false;if(current())setBusy(false);}}
  async function save(){
    if(sourceChanged)throw Error('已有较新的反馈，请先阅读当前内容，再决定如何修订。');
    let snapshot=await draft.snapshot();if(!current())return;
    if(!snapshot.revision){draft.change({...snapshot.value,editing:true});snapshot=await draft.snapshot();if(!current())return;}
    const retained=await client.readPending();if(!current())return;
    if(retained||draft.attempt){await refresh();return;}
    const receipt=readOperationReceipt(await client.submit(task,participant,snapshot.value,{confirmed:true,onJournal:async(locator:unknown)=>{if(!current())throw Error('当前身份或工作已变化。');await draft.attach(readFeedbackLocator(locator),snapshot.revision);}}));
    if(current())await finish(receipt);
  }
  async function reviewOriginal(){const value:unknown=await client.reviewAuthorization();if(!current())return;const result=readOperationReceipt(value);if(result.state==='acknowledged'){await finish(result);return;}if(result.state==='none'){setReview(null);return;}setReview(readFeedbackPending(value));}
  async function continueOriginal(){if(!review)return;const receipt=readOperationReceipt(await client.reauthorize(review,{confirmed:true}));if(current()){if(receipt.state==='acknowledged')await finish(receipt);else{setReview(null);await refresh();}}}
  async function reviewStop(){const original=readFeedbackPending(await client.readPending());if(!current()||!original)return;const value:unknown=await runtime.reviewTaskStop(task.taskId);if(!current())return;const receipt=readOperationReceipt(value);if(receipt.eventId!==original.eventId||receipt.payloadHash!==original.payloadHash)throw Error('待处理的反馈已变化，请重新打开。');if(receipt.state==='acknowledged'){await finish(receipt);return;}if(receipt.state==='stop-local-preview'){setReview(null);setStopReview(readStopPreview(value));}}
  async function stop(){if(!stopReview)return;const value:unknown=await runtime.stopTaskOperation(stopReview,{taskId:task.taskId,confirmed:true});if(!current())return;const receipt=readOperationReceipt(value);if(receipt.state==='acknowledged'){await finish(receipt);return;}if(receipt.state==='stopped-local'){setPending(null);setRecovery(null);setReview(null);setStopReview(null);setStopped(readStoppedOperation(value));setMessage('已停止本机继续发送，你填写的文字仍保留。');}}
  const reviewedPayload=review?.payload??review?.event??null;
  const disabled=busy||!draft.ready||!!pending||!!draft.attempt;
  return <section className="requester-feedback" aria-label="这次合作的反馈">
    <header><h4>这次合作的反馈</h4>{!editing&&!pending&&<Button variant="ghost" disabled={busy||!draft.ready} onClick={begin}>{input.editing?'继续我的反馈':previous?'修订我的反馈':'留下我的反馈'}</Button>}</header>
    <FeedbackReading previous={previous} participant={participant}/>
    {message&&<p className="feedback-notice"><output>{message}</output></p>}{error&&<p className="message error" role="alert">{error}</p>}
    {!draft.ready&&<p><output>{draft.status||'正在打开本机原稿…'}</output></p>}
    {pending&&!stopReview&&<aside className="feedback-pending"><p><output>{pendingText(recovery?.reason??recovery?.state??'')}</output></p><div className="button-row"><Button variant="outline" disabled={busy} onClick={()=>void run(reviewOriginal)}>查看原反馈并继续</Button><Button variant="ghost" disabled={busy} onClick={()=>void run(reviewStop)}>停止继续发送</Button></div></aside>}
    {stopReview&&<aside className="feedback-original"><h5>停止继续发送这份反馈</h5><p>服务已经接收的反馈仍可能完成，当前文字会保留在本机。</p><div className="button-row"><Button disabled={busy} onClick={()=>void run(stop)}>停止继续发送</Button><Button variant="ghost" disabled={busy} onClick={()=>setStopReview(null)}>继续保留</Button></div></aside>}
    {stopped&&<aside className="feedback-original"><p>这次提交已停止在本机继续发送，原结果仍会自动核对。</p><Button variant="outline" disabled={busy} onClick={()=>{draft.change({...input,baseFeedbackId:previous?.eventId??null,editing:true});setStopped(null);setEditing(true);setError('');}}>按当前反馈重新编辑</Button></aside>}
    {review&&<section className="feedback-original"><h5>继续保存原反馈</h5>{reviewedPayload&&<><p>{clarity[reviewedPayload.descriptionClarity]??'原选择保留'} · 工作范围{reviewedPayload.scopeMatched?'相符':'有差异'}</p><p className="reading-prose">{reviewedPayload.note}</p>{reviewedPayload.reason&&<p>修订原因：{reviewedPayload.reason}</p>}</>}<p className="feedback-visibility">仍只给本人和这项工作的请求者阅读。</p>{review.canContinue===false&&<p><output>{pendingText(review.reason??'')}</output></p>}{review.originalExpiresAt&&review.originalExpiresAt!==review.expiresAt&&<p className="feedback-visibility">原读取许可已于 {new Date(review.originalExpiresAt*1000).toLocaleString('zh-CN')} 到期。</p>}{review.expiresAt&&<p className="feedback-visibility">本次读取许可至 {new Date(review.expiresAt*1000).toLocaleString('zh-CN')}。</p>}<div className="button-row"><Button disabled={busy||!reviewedPayload||review.canContinue!==true} onClick={()=>void run(continueOriginal)}>按原内容继续保存</Button><Button variant="ghost" disabled={busy} onClick={()=>setReview(null)}>稍后处理</Button></div></section>}
    {editing&&!review&&<form className="feedback-form" onSubmit={event=>{event.preventDefault();void run(save);}}>
      {sourceChanged&&<aside className="feedback-source-change"><p>已有较新的反馈，上方已显示当前内容。你的未发送文字仍保留。</p><Button type="button" variant="outline" disabled={disabled} onClick={()=>change({baseFeedbackId:previous?.eventId??null})}>基于当前反馈继续修改</Button></aside>}
      <fieldset disabled={disabled} className="feedback-choice"><legend>任务描述是否清楚？</legend>{Object.entries(clarity).map(([value,label])=><label key={value}><input type="radio" name={'feedback-clarity-'+participant.participationId} value={value} required checked={input.descriptionClarity===value} onChange={()=>change({descriptionClarity:value})}/>{label}</label>)}</fieldset>
      <fieldset disabled={disabled} className="feedback-choice"><legend>实际工作是否符合约定范围？</legend>{[['yes','相符'],['no','存在差异']].map(([value,label])=><label key={value}><input type="radio" name={'feedback-scope-'+participant.participationId} value={value} required checked={input.scopeMatched===value} onChange={()=>change({scopeMatched:value})}/>{label}</label>)}</fieldset>
      <label htmlFor={'feedback-note-'+participant.participationId}>具体合作情况<Textarea id={'feedback-note-'+participant.participationId} disabled={disabled} required maxLength={1500} value={input.note} onChange={event=>change({note:event.target.value})} placeholder="说说这次实际合作的情况。"/></label>
      {previous&&<label htmlFor={'feedback-reason-'+participant.participationId}>这次为什么修订？<Textarea id={'feedback-reason-'+participant.participationId} disabled={disabled} required maxLength={1500} value={input.reason} onChange={event=>change({reason:event.target.value})}/></label>}
      <p className="feedback-visibility">仅你和本次请求者可读。</p><footer><span className="feedback-draft-status"><output>{draft.status}</output></span><div className="button-row"><Button type="button" variant="ghost" disabled={busy} onClick={()=>setEditing(false)}>稍后继续</Button><Button type="submit" disabled={disabled||sourceChanged}>{busy?'正在保存…':previous?'保存修订':'保存反馈'}</Button></div></footer>
    </form>}
  </section>;
}
