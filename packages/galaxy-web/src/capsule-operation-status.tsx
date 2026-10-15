import { ReadingDetails, ReadingSummary } from './reading-details';
import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {HistoryFields} from './history-facts';
import {memberName,useMemberNames,readableTime} from './conversation-ui';
import {CapsuleAuthorPreview} from './capsule-author-preview';
import {useChoiceViewLease} from './choice-retained-operations';
import type {CapsuleAuthorClient,CapsuleAuthorLease,CapsuleAuthorRuntime,CapsuleAuthorizationReview,CapsulePending,CapsulePreview,CapsuleReceipt} from './capsule-authoring-types';
const explanation=(reason:string)=>({
 'authorization-expired':'上次授权已到期，核对原内容和本次期限后可以继续。',
 'authorization-deadline-invalid':'原授权期限暂不能使用，核对原内容和本次期限后可以继续。',
 'original-binding-changed':'当前连接已变化，核对原内容后可用当前连接继续。',
 'original-binding-unavailable':'原连接依据暂不能核对，请先查看原内容。',
 'original-authorization-unavailable':'原授权目前不可用，请查看原内容和当前授权范围。',
 'business-rejected':'原提交未被接受。输入仍保留，请核对来源或许可变化后决定是否继续。'
} as Record<string,string>)[reason]??'正在确认上次提交，已保留同一份内容和原操作。';
type OperationProps={runtime:CapsuleAuthorRuntime|null;subjectId?:string;client:CapsuleAuthorClient|null;connected:boolean;scopeKey:string;paused:boolean;onComplete?:(receipt:CapsuleReceipt)=>Promise<unknown>};
type PendingReview={original:CapsulePreview;authorization:Exclude<CapsuleAuthorizationReview,{state:'acknowledged'}>};
export function CapsuleOperationStatus(props:OperationProps){
 const {runtime,subjectId,client,connected,scopeKey}=props,view=useChoiceViewLease(runtime,subjectId);
 if(!runtime||!subjectId||!client||!connected||!view.lease)return null;
 return <CapsuleCurrentOperations key={scopeKey+':'+view.key} {...props} runtime={runtime} subjectId={subjectId} client={client} lease={view.lease}/>;
}
function CapsuleCurrentOperations({runtime,subjectId,client,paused,onComplete,lease}:Omit<OperationProps,'runtime'|'subjectId'|'client'>&{runtime:CapsuleAuthorRuntime;subjectId:string;client:CapsuleAuthorClient;lease:CapsuleAuthorLease}){
 const [pending,setPending]=useState<CapsulePending[]>([]),[review,setReview]=useState<PendingReview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reason,setReason]=useState('');
 const epoch=useRef(0),working=useRef(false),latest=useRef({paused,review}),complete=useRef(onComplete),done=useRef(new Set<string>()),dialog=useRef<HTMLDialogElement>(null);
 useLayoutEffect(()=>{complete.current=onComplete;latest.current={paused,review};},[onComplete,paused,review]);
 const original=review?.original,payload=original?.payload,names=useMemberNames(runtime,subjectId,true,[...(original?.viewers??[]),...(payload&&'contributors' in payload?payload.contributors:[]),...(payload&&'grantees' in payload?payload.grantees:[])]);
 useEffect(()=>{if(review)dialog.current?.showModal();else dialog.current?.close();},[review]);
 const finish=useCallback(async(receipt:CapsuleReceipt,valid:()=>boolean)=>{if(!valid())return;const id=receipt.operationId??receipt.eventId;if(!id||done.current.has(id))return;done.current.add(id);setReview(null);await complete.current?.(receipt);},[]);
 const resume=useCallback(async(valid:()=>boolean)=>{
  const receipt=await client.resumePending();if(!valid())return;setReason(receipt.reason??'');
  if(receipt.state==='acknowledged')await finish(receipt,valid);
  for(const stopped of receipt.stopped??[])if(stopped.state==='acknowledged')await finish(stopped,valid);
  const items=await client.pending();if(valid())setPending(items);
 },[client,finish]);
 const run=useCallback(async(fn:(valid:()=>boolean)=>Promise<void>)=>{
  if(working.current||latest.current.paused)return;
  const token=epoch.current,valid=()=>{if(token!==epoch.current)return false;try{lease.assertCurrent();return true;}catch{return false;}};if(!valid())return;working.current=true;setBusy(true);setError('');
  try{await fn(valid);}catch(error){const message=error instanceof Error?error.message:'';if(valid())setError(/[\u3400-\u9fff]/.test(message)?message:'上次操作的结果暂未核对完成，原输入仍保留。');}
  if(valid()){try{const items=await client.pending();if(valid())setPending(items);}catch{}if(valid()){working.current=false;setBusy(false);}}
 },[client,lease]);
 useEffect(()=>{const requests=epoch;requests.current++;working.current=false;
  const tick=()=>{if(!document.hidden&&!latest.current.review&&!latest.current.paused)void run(resume);},start=window.setTimeout(tick,0),timer=window.setInterval(tick,12000);document.addEventListener('visibilitychange',tick);
  return()=>{requests.current++;window.clearTimeout(start);window.clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
 },[run,resume]);
 async function open(id:string,valid:()=>boolean){
  const original=await client.reviewPending(id);if(!valid())return;
  const receipt=await client.receiptFor(original);if(!valid())return;if(receipt.state==='acknowledged'){await finish(receipt,valid);return;}
  const authorization=await client.reviewAuthorization(id);if(!valid())return;
  if(authorization.state==='acknowledged'){await finish(authorization,valid);return;}
  if(!('payload' in original))throw Error('这份原内容已停止本机发送，只能继续核对原回执。');
  setReview({original,authorization});
 }
 async function confirm(valid:()=>boolean){
  const chosen=review;if(!chosen)return;
  const receipt=chosen.authorization.state==='reauthorization-required'?await client.reauthorize(chosen.original.operationId,chosen.authorization,{confirmed:true}):await client.retry(chosen.original.operationId,{confirmed:true});
  if(!valid())return;if(receipt.state==='acknowledged'){setReason('');await finish(receipt,valid);}else setReason(receipt.reason??'');
 }
 const active=pending.find(item=>item.state!=='stopped-local'),stopped=pending.filter(item=>item.state==='stopped-local');
 if(!active&&!stopped.length&&!review&&!error)return null;
 return <aside className="operation-status" aria-label="上次的方法提交">
  {active&&<><p>{explanation(reason)}</p><div className="button-row"><Button type="button" variant="outline" disabled={busy||paused} onClick={()=>void run(valid=>open(active.operationId,valid))}>查看上次提交</Button><Button type="button" variant="ghost" disabled={busy||paused} onClick={()=>void run(async valid=>{const receipt=await client.stopLocalRetry(active.operationId,{confirmed:true});if(receipt.state==='acknowledged')await finish(receipt,valid);if(valid())setReview(null);})}>停止本机继续发送</Button></div></>}
  {!!stopped.length&&<ReadingDetails className="source-reference-details"><ReadingSummary>已停止发送的原记录</ReadingSummary><p>这里继续查询原操作回执，不会重新发送已移除的内容。</p>{stopped.map(item=><p key={item.operationId}>{item.type==='permission'?'来源许可':item.type==='use'?'方法使用':'方法内容'} <code>{item.operationId}</code></p>)}</ReadingDetails>}
  {error&&<p role="alert">{error}</p>}
  <dialog ref={dialog} className="workspace-dialog method-preview-dialog" onCancel={event=>{event.preventDefault();if(!busy)setReview(null);}}>{review&&original&&<>
   <header className="dialog-heading"><h2>继续上次这份内容</h2><button type="button" className="icon-button" aria-label="关闭原提交" disabled={busy} onClick={()=>setReview(null)}>×</button></header>
   {original.type==='use'?<><p>{original.visibility==='Public'?'公开':original.viewers.length?'本人和 '+original.viewers.map((id:string)=>memberName(id,subjectId,names[id]??undefined)).join('、'):'仅本人'}可读</p><p className="reading-prose">{original.payload.note}</p><ReadingDetails className="source-reference-details"><ReadingSummary>原应用与准确来源</ReadingSummary><HistoryFields value={original.payload}/></ReadingDetails></>:<CapsuleAuthorPreview preview={original} subjectId={subjectId} names={names} display={{}}/>}
   <section className="method-preview-scope"><p>原授权期限：{original.expiresAt?readableTime(original.expiresAt):'未能核对'}</p>{review.authorization.state==='reauthorization-required'&&<p>本次明确授权至：{readableTime(review.authorization.expiresAt)}</p>}<p>继续原来的内容、阅读者和操作编号。</p></section>
   {error&&<p role="alert" className="message error">{error}</p>}
   <div className="button-row"><Button disabled={busy||paused} onClick={()=>void run(confirm)}>{review.authorization.state==='reauthorization-required'?'确认以上范围并继续':'继续同一笔提交'}</Button><Button variant="outline" disabled={busy} onClick={()=>setReview(null)}>暂不继续</Button></div>
  </>}</dialog>
 </aside>;
}
