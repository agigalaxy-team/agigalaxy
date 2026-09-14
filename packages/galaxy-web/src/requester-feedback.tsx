import React,{useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {requesterFeedbackAvailable,requesterFeedbackPreview,submitRequesterFeedback} from './requester-feedback-client.mjs';

const clarity:Record<string,string>={clear:'清楚','partly-clear':'部分清楚',unclear:'不清楚'};
export function RequesterFeedback({runtime,task,participant,subjectId,connected,onChanged}:any){
 const previous=participant.feedback;
 const initial=()=>({descriptionClarity:previous?.descriptionClarity??'',scopeMatched:previous?previous.scopeMatched?'yes':'no':'',note:previous?.note??'',reason:''});
 const [editing,setEditing]=useState(false),[draft,setDraft]=useState(initial),[preview,setPreview]=useState<any>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const available=connected&&requesterFeedbackAvailable(task,participant,subjectId);
 useEffect(()=>{setEditing(false);setPreview(null);setDraft(initial());},[task.taskId,participant.participationId,subjectId,previous?.eventId]);
 async function submit(){if(busy||!preview)return;setBusy(true);setMessage('');
  try{await submitRequesterFeedback(runtime,preview);setPreview(null);setEditing(false);setMessage('合作反馈已记录；履历按当前允许的来源展示。');try{await onChanged?.();}catch{setMessage('反馈已收到服务回执，但最新任务状态暂未刷新；请稍后刷新或查询原操作，不要重复提交。');}}
  catch(e:any){setMessage(e?.issues?'请补齐反馈与修订原因。':e?.message??'结果未确认，请在任务的恢复入口核对原操作。');}
  finally{setBusy(false);}}
 if(!previous&&!available)return null;
 return <section className="message"><h4>对请求者的合作反馈</h4><p className="muted">由实际参与者陈述本次合作，不是独立质量认证、恶意行为判定或能力分。</p>
  {previous&&<div><p>描述清晰度：{clarity[previous.descriptionClarity]??'当前不可读'}；实际工作与范围：{previous.scopeMatched?'相符':'有差异'}。</p><p>{previous.note}</p><details><summary>反馈来源</summary><p>作者：{participant.subjectId}；本次参与：{participant.participationId}；反馈事件：{previous.eventId}。</p><p>修订追加新事件并引用原事件，历史来源保留。</p></details></div>}
  {message&&<p role="status">{message}</p>}
  {available&&!editing&&<Button variant="outline" onClick={()=>{setDraft(initial());setMessage('');setEditing(true);}}>{previous?'修订我的合作反馈':'记录这次合作反馈'}</Button>}
  {editing&&!preview&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();try{setPreview(requesterFeedbackPreview(task,participant,subjectId,draft));setMessage('');}catch(e:any){setMessage(e?.issues?'请填写全部反馈字段，修订须说明原因。':e.message);}}}>
   <label>任务描述是否清楚<select required value={draft.descriptionClarity} onChange={e=>setDraft({...draft,descriptionClarity:e.target.value})}><option value="">请选择</option>{Object.entries(clarity).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
   <label>实际工作是否符合约定范围<select required value={draft.scopeMatched} onChange={e=>setDraft({...draft,scopeMatched:e.target.value})}><option value="">请选择</option><option value="yes">相符</option><option value="no">存在差异</option></select></label>
   <label>具体合作情况<Textarea required maxLength={1500} value={draft.note} onChange={e=>setDraft({...draft,note:e.target.value})}/></label>
   {previous&&<label>本次修订原因<Textarea required maxLength={1500} value={draft.reason} onChange={e=>setDraft({...draft,reason:e.target.value})}/></label>}
   <div className="button-row"><Button type="submit">预览反馈与可见范围</Button><Button type="button" variant="ghost" onClick={()=>{setEditing(false);setPreview(null);}}>取消编辑</Button></div>
  </form>}
  {preview&&<div><h4>本次{preview.event.supersedes?'修订':'提交'}</h4><p>{clarity[preview.event.descriptionClarity]}；实际工作{preview.event.scopeMatched?'符合范围':'存在范围差异'}。</p><p>{preview.event.note}</p>{preview.event.reason&&<p>修订原因：{preview.event.reason}</p>}<p>仅本人及本任务请求者 {preview.requesterId} 获准查看本次私有反馈；公开任务不会自动公开评价。</p>
   <div className="button-row"><Button disabled={busy||!connected} onClick={submit}>确认提交这份反馈</Button><Button variant="ghost" disabled={busy} onClick={()=>setPreview(null)}>返回修改</Button><Button variant="ghost" disabled={busy} onClick={()=>{setPreview(null);setEditing(false);}}>取消</Button></div><p className="muted">若提交后断线，请使用任务页的原操作恢复入口核对回执；重试保留原内容与事件编号。</p></div>}
 </section>;
}
