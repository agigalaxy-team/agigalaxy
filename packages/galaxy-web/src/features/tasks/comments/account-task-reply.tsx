import React,{useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {useAccountSessionModel} from '../../accounts/account-session-scope';
import type {CommentView} from './task-comment-view-types';
import {sendAccountOperation} from './account-operation';
type Kind='create'|'edit'|'correct'|'retract';
type Payload={schemaVersion:2;id:string;commentId:string;taskId:string;expectedRevision:number;kind:Kind;body?:string;visibility?:'inherit-task';replyTo?:{id:string;revision:number}|null;reason?:string};
export type AccountCommentAction={kind:Kind;comment?:CommentView};
type Saved={text:string;reason:string;action:AccountCommentAction;pending:Payload|null};
export function AccountTaskReply({taskId,endpoint,onSent,action,clearAction}:{taskId:string;endpoint:string;onSent:()=>void;action:AccountCommentAction|null;clearAction:()=>void}){
 const account=useAccountSessionModel(),id=account.session?.account.id;
 if(account.phase!=='signed-in'||!id||!account.client||!account.session)return <p className="discussion-connect">登录在线账户后即可回复。{account.client&&<a className="text-link" href={account.client.loginUrl('login',location.pathname+location.search+location.hash)}>登录账户</a>}</p>;
 return <AccountReplyForm key={id+':'+taskId} taskId={taskId} endpoint={endpoint} accountId={id} account={account} onSent={onSent} action={action} clearAction={clearAction}/>;
}
function AccountReplyForm({taskId,endpoint,accountId,account,onSent,action,clearAction}:{taskId:string;endpoint:string;accountId:string;account:ReturnType<typeof useAccountSessionModel>;onSent:()=>void;action:AccountCommentAction|null;clearAction:()=>void}){
 const key=`task-account-reply:${endpoint}:${accountId}:${taskId}`,initial:Saved={text:'',reason:'',action:{kind:'create'},pending:null};
 const [saved,setSaved]=useState<Saved>(()=>{try{const v=JSON.parse(localStorage.getItem(key)??'null');if(typeof v?.text==='string'&&v.action?.kind&&(!v.pending||v.pending.taskId===taskId))return v;}catch{}return initial;});
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),editor=useRef<HTMLFormElement>(null);
 const save=(value:Saved)=>{localStorage.setItem(key,JSON.stringify(value));setSaved(value);};
 useEffect(()=>{if(!action)return;if(saved.pending||saved.text.trim()||saved.reason.trim()){setMessage('请先完成或清除当前草稿，再选择另一条评论。');}else try{save({text:action.kind==='edit'?action.comment?.body??'':'',reason:'',action,pending:null});}catch{setMessage('无法保存草稿，请检查浏览器存储。');}clearAction();requestAnimationFrame(()=>{editor.current?.scrollIntoView({block:'center'});editor.current?.querySelector<HTMLElement>('textarea:not(:disabled),input:not(:disabled),button[type=submit]')?.focus({preventScroll:true});});},[action]);
 const finish=(p:Payload,result:any)=>{if(result?.operationId!==p.id||result?.commentId!==p.commentId)throw Error('reply_result_mismatch');localStorage.removeItem(key);setSaved(initial);setMessage('操作已完成。');onSent();};
 const submit=async()=>{if(busy||!account.client||!account.session)return;setBusy(true);setMessage('');
  try{
   let payload=saved.pending;
   if(!payload){const kind=saved.action.kind,comment=saved.action.comment;if(kind!=='create'&&!comment)throw Error('missing_source');if(kind!=='retract'&&!saved.text.trim())throw Error('missing_text');if(kind==='correct'&&!saved.reason.trim())throw Error('missing_reason');
    payload={schemaVersion:2,id:crypto.randomUUID(),commentId:kind==='create'?crypto.randomUUID():comment!.commentId,taskId,expectedRevision:kind==='create'?0:comment!.revision,kind,...(kind==='retract'?{}:{body:saved.text.trim(),visibility:'inherit-task' as const}),...(kind==='create'?{replyTo:comment?{id:comment.commentId,revision:comment.revision}:null}:{}),...(kind==='correct'?{reason:saved.reason.trim()}: {})};}
   const result=await sendAccountOperation({pending:saved.pending,payload,call:(path,input)=>account.client!.call(path,input,{session:account.session!}),receiptPath:'/v2/account-comments/receipt',eventPath:'/v2/account-comments/events',remember:value=>save({...saved,pending:value}),release:()=>save({...saved,pending:null}),isAcknowledged:value=>!!value&&typeof value==='object'&&'acknowledged'in value&&value.acknowledged===true});finish(payload,result);
  }catch(reason){const code=reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';const errors:Record<string,string>={comment_revision_conflict:'评论已有更新，请查看当前版本后再操作。',comment_reply_unavailable:'所回复的评论已变化或无法读取。',task_enrollment_closed:'这项求助已停止接受新回应。',community_restricted:'当前账户暂时不能发表评论。',community_quota_exceeded:'今天的评论额度已用完。',community_cooldown:'发送过于频繁，请稍后再试。',comment_conflict:'暂时无法发送，请稍后重试。',official_account_session_expired:'登录已过期，请重新登录。'};setMessage(errors[code]??'暂时无法发送，请稍后重试。');}finally{setBusy(false);}
 };
 const labels={create:'回复建议',edit:'修改评论',correct:'追加更正',retract:'撤回评论'};
 const submitLabels={create:'发送回复',edit:'保存修改',correct:'提交更正',retract:'确认撤回'},busyLabels={create:'正在发送…',edit:'正在保存…',correct:'正在提交…',retract:'正在撤回…'};
 return <form ref={editor} className="discussion-editor workspace-form" onSubmit={e=>{e.preventDefault();void submit();}}><header><div><h3>{labels[saved.action.kind]}</h3></div></header>{saved.action.comment&&<p>原评论：{saved.action.comment.body??'当前内容不可读取'}（第 {saved.action.comment.revision} 版）</p>}{saved.action.kind!=='retract'&&<label>你的回应<Textarea value={saved.text} maxLength={6000} disabled={busy||!!saved.pending} onChange={e=>{try{save({...saved,text:e.target.value});setMessage('');}catch{setMessage('草稿未能保存，请保持页面并重试。');}}}/></label>}{saved.action.kind==='correct'&&<label>更正原因<Textarea value={saved.reason} maxLength={600} disabled={busy||!!saved.pending} onChange={e=>save({...saved,reason:e.target.value})}/></label>}{message&&<p role="status">{message}</p>}<footer>{!saved.pending&&(saved.text||saved.reason||saved.action.kind!=='create')&&<Button type="button" variant="ghost" onClick={()=>{localStorage.removeItem(key);setSaved(initial);setMessage('');}}>清除草稿</Button>}<Button type="submit" disabled={busy||(!saved.pending&&saved.action.kind!=='retract'&&!saved.text.trim())}>{busy?busyLabels[saved.action.kind]:saved.pending?'重试':submitLabels[saved.action.kind]}</Button></footer></form>;
}
