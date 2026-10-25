import React,{useEffect,useRef,useState} from 'react';
import {CheckCircle2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {AccountEntryPage,useAccountConnection} from '../../account-center';
import {useAccountSessionModel} from '../../account-session-scope';
import {OfficialAccountStatus,type OfficialAccountModel} from '../../official-account-panel';
import {LoadingFeedback} from '../../interaction-feedback';
import {FeedbackAttachmentField,type FeedbackDraftAttachment} from './attachment-field';
import {feedbackDraftAttachmentsSchema,feedbackAttachmentError} from './attachments-client.mjs';
import './form.css';

type Category='problem'|'suggestion';
type Submission={operationId:string;body:string;category:Category;module:'other';attachments?:{id:string;sha256:string}[]};
type Draft={operationId:string;body:string;category:Category;attachments:FeedbackDraftAttachment[];pending:Submission|null};
type SubmissionReceipt={feedbackId:string;operationId:string;submittedAt:string;deleted?:boolean};
type Connection=ReturnType<typeof useAccountConnection>;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const category=(value:unknown):value is Category=>value==='problem'||value==='suggestion';
const freshDraft=():Draft=>({operationId:crypto.randomUUID(),body:'',category:'problem',attachments:[],pending:null});

function readDraft(key:string):Draft{
 try{
  const value=JSON.parse(sessionStorage.getItem(key)??'null');
  if(!value||!uuid(value.operationId)||typeof value.body!=='string'||value.body.length>6000||!category(value.category))return freshDraft();
  const parsed=feedbackDraftAttachmentsSchema.safeParse(value.attachments??[]);if(!parsed.success||parsed.data.some(item=>item.operationId!==value.operationId))return freshDraft();
  const attachments=parsed.data,references=attachments.map(item=>({id:item.id,sha256:item.sha256}));
  const pending=value.pending;
  if(pending!==null&&(!pending||pending.operationId!==value.operationId||pending.body!==value.body.trim()||!pending.body||pending.category!==value.category||pending.module!=='other'))return freshDraft();
  if(pending&&JSON.stringify(pending.attachments??[])!==JSON.stringify(references))return freshDraft();
  return {operationId:value.operationId,body:value.body,category:value.category,attachments,pending:pending?{operationId:pending.operationId,body:pending.body,category:pending.category,module:'other',...(references.length?{attachments:references}:{})}:null};
 }catch{return freshDraft();}
}
function saveDraft(key:string,draft:Draft){try{sessionStorage.setItem(key,JSON.stringify(draft));return true;}catch{return false;}}
function submissionReceipt(value:unknown,operationId:string,original=false):SubmissionReceipt|null{
 if(!value||typeof value!=='object')return null;
 const result=value as Record<string,unknown>;
 if(!uuid(result.feedbackId)||result.operationId!==operationId||typeof result.submittedAt!=='string'||!Number.isFinite(Date.parse(result.submittedAt))
  ||original&&(result.state!=='recorded'||typeof result.deleted!=='boolean')||!original&&typeof result.replayed!=='boolean')return null;
 return{feedbackId:result.feedbackId,operationId,submittedAt:result.submittedAt,deleted:result.deleted===true};
}
function failureMessage(reason:unknown,uncertain:boolean){
 const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
 if(code.startsWith('attachment_')||code.startsWith('feedback_attachment_'))return feedbackAttachmentError(reason);
 return ({feedback_rate_limited:'提交较频繁，请稍后再试。',feedback_daily_limit:'最近提交较多，请稍后再试。',invalid_feedback_request:'请填写 1 至 6000 字的反馈内容。',feedback_operation_conflict:'本次反馈未提交，请重新提交。',official_account_session_expired:'登录已过期，内容已保留。请重新登录后继续。',official_account_changed:'登录账户已经变化，原内容已保留。',official_account_unavailable:'账户暂时无法连接，内容已保留。',account_csrf_invalid:'登录状态已更新，内容已保留。请刷新账户后重试。'} as Record<string,string>)[code]??(uncertain?'正在确认提交结果，内容已保留。':'这次反馈未提交，内容已保留，请重试。');
}

/** The existing account scope supplies authority; a local Galaxy ID is not required. */
export function FeedbackForm({endpoint,navigate}:{endpoint?:string;navigate:(path:string)=>void}){
 const model=useAccountSessionModel(),connection=useAccountConnection(endpoint,model),ownerId=connection.session?.account.id,client=model.client;
 if(!ownerId||!client)return <AccountEntryPage navigate={navigate} returnTo="/app/feedback"/>;
 const key='galaxy:web:feedback:v1:'+new URL(client.loginUrl()).origin+':'+ownerId;
 return <FeedbackEditor key={key} draftKey={key} ownerId={ownerId} model={model} connection={connection} client={client} navigate={navigate}/>;
}
function FeedbackEditor({draftKey,ownerId,model,connection,client,navigate}:{draftKey:string;ownerId:string;model:OfficialAccountModel;connection:Connection;client:NonNullable<OfficialAccountModel['client']>;navigate:(path:string)=>void}){
 const [draft,setDraft]=useState(()=>readDraft(draftKey)),[busy,setBusy]=useState(false),[attachmentBusy,setAttachmentBusy]=useState(false),[error,setError]=useState(''),[submitted,setSubmitted]=useState(false),[deleted,setDeleted]=useState(false),[storageFailed,setStorageFailed]=useState(false);
 const current=useRef(draft),active=useRef(false),working=useRef(false),attachmentWorking=useRef(false),request=useRef<AbortController|null>(null);
 const available=model.phase==='signed-in',csrf=connection.session?.csrfToken;
 useEffect(()=>{active.current=true;return()=>{active.current=false;request.current?.abort();};},[]);
 function retain(next:Draft){current.current=next;setDraft(next);setStorageFailed(!saveDraft(draftKey,next));}
 function edit(patch:Partial<Pick<Draft,'body'|'category'>>){if(working.current||current.current.pending)return;retain({...current.current,...patch});setError('');}
 function editAttachments(attachments:FeedbackDraftAttachment[]){if(working.current||current.current.pending)return;retain({...current.current,attachments});setError('');}
 function fileBusy(value:boolean){attachmentWorking.current=value;setAttachmentBusy(value);}
 function complete(value:SubmissionReceipt){
  if(!active.current)return;
  try{sessionStorage.removeItem(draftKey);}catch{/* An unresolved stored intent resumes through its original GET only. */}
  setDeleted(value.deleted===true);setSubmitted(true);setError('');
 }
 useEffect(()=>{
  const pending=draft.pending;
  if(!pending||submitted||busy||!available)return;
  let closed=false,checking=false,attempt=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController();
  const schedule=()=>{if(!closed)timer=setTimeout(()=>void readOriginal(),Math.min(10000,1500*++attempt));};
  async function readOriginal(){
   if(closed||checking)return;
   if(timer)clearTimeout(timer);
   if(navigator.onLine===false||document.visibilityState==='hidden'){schedule();return;}
   checking=true;
   try{
    const session=connection.authority.requireSession(ownerId,csrf);
    const value=await client.call('/v1/account/feedback/operations/'+pending!.operationId,undefined,{method:'GET',session,signal:controller.signal});
    if(closed||!active.current||current.current.pending?.operationId!==pending!.operationId)return;
    const recorded=submissionReceipt(value,pending!.operationId,true);
    if(recorded){complete(recorded);return;}
    const original=value as {state?:unknown;operationId?:unknown}|null;
    if(original?.state!=='not-recorded'||original.operationId!==pending!.operationId)throw Error('feedback_response_invalid');
    setError('');
   }catch(reason){
    if(closed||!active.current)return;
    setError(failureMessage(reason,true));
    const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
    if(['official_account_session_expired','official_account_changed','account_csrf_invalid'].includes(code))void model.refresh();
   }finally{checking=false;if(!closed)schedule();}
  }
  const wake=()=>{if(!closed&&!checking){if(timer)clearTimeout(timer);timer=setTimeout(()=>void readOriginal(),0);}};
  window.addEventListener('online',wake);document.addEventListener('visibilitychange',wake);
  schedule();
  return()=>{closed=true;if(timer)clearTimeout(timer);controller.abort();window.removeEventListener('online',wake);document.removeEventListener('visibilitychange',wake);};
 },[draft.pending?.operationId,submitted,busy,available,ownerId,csrf]);
 async function submit(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();if(working.current||attachmentWorking.current||!available||current.current.pending)return;
  const original=current.current;
  if(!original.body.trim()){setError('请写下你的问题或建议。');return;}
  if(!original.pending&&original.attachments.some(item=>item.state!=='available')){setError('请等待附件扫描完成，或移除暂不可用的附件后提交。');return;}
  const references=original.attachments.map(item=>({id:item.id,sha256:item.sha256}));
  const payload={operationId:original.operationId,body:original.body.trim(),category:original.category,module:'other' as const,...(references.length?{attachments:references}:{})};
  try{connection.authority.requireSession(ownerId,csrf);}catch(reason){setError(failureMessage(reason,false));void model.refresh();return;}
  working.current=true;setBusy(true);setError('');retain({...original,pending:payload});
  const controller=new AbortController();request.current=controller;
  let sent=false;
  try{
   const session=connection.authority.requireSession(ownerId,csrf);sent=true;
   const value=await client.call('/v1/account/feedback',payload,{session,signal:controller.signal});
   const recorded=submissionReceipt(value,payload.operationId);
   if(!recorded)throw Error('feedback_response_invalid');
   complete(recorded);
  }catch(reason){
   if(!active.current)return;
   const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
   const rejected=reason&&typeof reason==='object'&&'outcome'in reason&&reason.outcome==='rejected'&&'status'in reason&&typeof reason.status==='number'&&reason.status>=400&&reason.status<500;
   const uncertain=sent&&!rejected;
   if(!uncertain)retain({...original,operationId:code==='feedback_operation_conflict'?crypto.randomUUID():original.operationId,attachments:code==='feedback_operation_conflict'?[]:original.attachments,pending:null});
   setError(code==='feedback_operation_conflict'&&original.attachments.length?'原提交记录已变化，文字内容已保留。请重新添加附件后提交。':failureMessage(reason,uncertain));
   if(['official_account_session_expired','official_account_changed','account_csrf_invalid'].includes(code))void model.refresh();
  }finally{working.current=false;if(active.current){setBusy(false);request.current=null;}}
 }
 return <section className="feedback-page"><header className="account-page-heading"><h1>使用反馈</h1><p>告诉我们遇到的问题，或你希望改进的地方。</p></header>
  {!available&&<OfficialAccountStatus model={model} navigate={navigate} returnTo="/app/feedback" compact/>}
  {submitted?<div className="feedback-submitted" role="status"><CheckCircle2 size={30} aria-hidden="true"/><h2>{deleted?'这份反馈已删除':'反馈已提交'}</h2><p>{deleted?'没有重新提交。':'感谢你的反馈。'}</p><div className="button-row"><Button variant="outline" onClick={()=>navigate('/app/account')}>返回账户</Button><button className="text-link" type="button" onClick={()=>{retain(freshDraft());setSubmitted(false);setDeleted(false);setError('');}}>再写一条</button></div></div>:<form className="feedback-form" onSubmit={event=>void submit(event)} aria-busy={busy}>
   <fieldset className="feedback-kind" disabled={busy||!!draft.pending}><legend>反馈类型</legend>{([['problem','问题'],['suggestion','建议']] as const).map(([value,label])=><label key={value}><input type="radio" name="feedback-category" value={value} checked={draft.category===value} onChange={()=>edit({category:value})}/><span>{label}</span></label>)}</fieldset>
   <label className="feedback-body-label" htmlFor="feedback-body">反馈内容</label><textarea id="feedback-body" name="body" required maxLength={6000} rows={10} value={draft.body} onChange={event=>edit({body:event.target.value})} disabled={busy||!!draft.pending} aria-describedby="feedback-body-help" placeholder="可以描述出现问题的位置、操作经过，或希望改进的内容。"/>
   <div className="feedback-body-help" id="feedback-body-help"><span>请勿填写密码或验证码。</span><span>{draft.body.length} / 6000</span></div>
   <FeedbackAttachmentField key={draft.operationId} operationId={draft.operationId} attachments={draft.attachments} ownerId={ownerId} csrf={csrf} client={client} connection={connection} available={available} disabled={busy||!!draft.pending} onChange={editAttachments} onBusy={fileBusy}/>
   {storageFailed&&<p className="feedback-storage-warning" role="status">当前无法暂存草稿，请保留此页面。</p>}
   {error&&<p className="feedback-error" role="alert">{error}</p>}
   {!error&&draft.pending&&!busy&&<p className="feedback-pending" role="status">正在确认提交结果，连接恢复后会继续，原内容已保留。</p>}
   <footer className="feedback-actions"><Button type="submit" disabled={busy||!!draft.pending||attachmentBusy||!available||!draft.body.trim()||draft.attachments.some(item=>item.state!=='available')}>{busy?'正在提交…':draft.pending?'正在确认…':'提交反馈'}</Button><LoadingFeedback active={busy} label="正在提交反馈…" detail="正在确认提交结果，请稍候。" scopeKey={draft.operationId}/></footer>
  </form>}
 </section>;
}
