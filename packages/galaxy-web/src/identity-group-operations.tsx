import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useMemberNames} from './conversation-ui';
import {HistoryFields} from './history-facts';
import {groupRefKey,identityGroupError,IdentityGroupIntent} from './identity-group-presentation';
import {identityGroupSourceSelection} from './identity-group-sources';
import type {IdentityGroup,IdentityGroupClient,IdentityGroupLease,IdentityGroupLocator,IdentityGroupPending,IdentityGroupPreview,IdentityGroupResult,IdentityGroupRuntime,IdentityGroupSourceView} from './identity-group-types';

const explanations:Record<string,string>={'business-declined':'原操作未被接受，系统已停止自动发送。','proposal-expired':'原邀请已经到期，不能继续发送。','binding-changed':'连接已变化，需要查看原内容后继续。','control-changed':'设备控制已变化，需要查看原内容后继续。','explicit-approval-required':'原内容尚未签署，需要你查看后继续。','original-binding-unavailable':'原连接信息不可用，需要查看原内容后继续。','stopped-local':'本机已停止发送。服务已经收到的邀请仍按原状态处理。','read-or-send-unavailable':'正在核对原操作是否收到。原输入和操作编号保留。'};
const reviewReasons=new Set(['binding-changed','control-changed','explicit-approval-required','original-binding-unavailable']);

type OperationsProps={runtime:IdentityGroupRuntime;client:IdentityGroupClient;lease:IdentityGroupLease;subjectId:string;onReceipt:(receipt:IdentityGroupResult)=>Promise<void>;onOpen:(operationId:string)=>void;rebindDraft:(original:IdentityGroupLocator,next:IdentityGroupLocator)=>Promise<void>;refreshKey:number};
export function IdentityGroupOperations({runtime,client,lease,subjectId,onReceipt,onOpen,rebindDraft,refreshKey}:OperationsProps){
 const active=useRef(true),reading=useRef(false),working=useRef(false),epoch=useRef(0),refreshRef=useRef<()=>Promise<void>>(async()=>{});
 const [rows,setRows]=useState<IdentityGroupPending[]>([]),[status,setStatus]=useState<Record<string,IdentityGroupResult>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[review,setReview]=useState<{row:IdentityGroupPending;preview:IdentityGroupPreview}|null>(null),[sources,setSources]=useState<IdentityGroupSourceView[]>([]),[notice,setNotice]=useState('');
 const reviewedPayload=review?.preview.payload,names=useMemberNames(runtime,subjectId,true,reviewedPayload&&reviewedPayload.kind!=='revoke'?[...reviewedPayload.memberIds,...reviewedPayload.viewers]:[]);
 const check=useCallback(()=>{lease.assertCurrent();if(!active.current)throw Error('身份分组页面已关闭。');},[lease]);
 async function refresh(){if(reading.current||working.current)return;reading.current=true;const token=epoch.current;
  try{check();const result=await client.resumePending({explicitRetry:false});check();if(token!==epoch.current)return;const next:Record<string,IdentityGroupResult>={};for(const item of result.items){next[item.locator.proofId]=item;if(item.state==='acknowledged')await onReceipt(item);}const pending=await client.pending();check();if(token!==epoch.current)return;setStatus(next);setRows(pending);setError('');}catch(error){if(active.current&&token===epoch.current)setError(identityGroupError(error));}finally{reading.current=false;}
 }
 useLayoutEffect(()=>{refreshRef.current=refresh;});
 useEffect(()=>{active.current=true;const requests=epoch;void refreshRef.current();const tick=()=>{if(!document.hidden)void refreshRef.current();};const timer=window.setInterval(tick,12000);document.addEventListener('visibilitychange',tick);return()=>{active.current=false;requests.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',tick);};},[lease]);
 useEffect(()=>{void refreshRef.current();},[refreshKey]);
 const readSources=useCallback(async(preview:IdentityGroupPreview)=>{const refs=preview.payload.kind==='revoke'?[]:preview.payload.sourceRefs,values:IdentityGroupSourceView[]=[];let group:IdentityGroup|null=null;if(refs.some(ref=>ref.originalSubjectId!==subjectId))try{group=await client.read(preview.payload.groupId);}catch{check();}
  for(const ref of refs){try{if(ref.originalSubjectId===subjectId){const source=await client.source(identityGroupSourceSelection(ref));values.push(source.ref.sourceHash===ref.sourceHash?source:{ref,record:null});}else values.push(group?.sources.find(item=>groupRefKey(item.ref)===groupRefKey(ref))??{ref,record:null});}catch{check();values.push({ref,record:null});}}check();return values;
 },[client,check,subjectId]);
 async function run(fn:()=>Promise<void>){if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');try{check();await fn();check();}catch(cause){if(active.current)setError(identityGroupError(cause));}finally{working.current=false;if(active.current){setBusy(false);await refreshRef.current();}}}
 async function inspect(row:IdentityGroupPending){const preview=await client.reviewPending(row.proofId);check();const values=await readSources(preview);check();setReview({row,preview});setSources(values);}
 useEffect(()=>{if(!review)return;let running=false,live=true;const token=epoch.current,tick=async()=>{if(document.hidden||running||working.current)return;running=true;try{const values=await readSources(review.preview);if(live&&active.current&&token===epoch.current)setSources(values);}catch{if(live&&active.current&&token===epoch.current)setSources((review.preview.payload.kind==='revoke'?[]:review.preview.payload.sourceRefs).map(ref=>({ref,record:null})));}finally{running=false;}};const timer=window.setInterval(tick,15000);return()=>{live=false;window.clearInterval(timer);};},[review,readSources]);
 if(!rows.length&&!error&&!review&&!notice)return null;
 return <section className="ig-operations" aria-label="继续原身份分组操作"><h3>继续原操作</h3>
  {rows.map(row=>{const result=status[row.proofId],reason=row.state==='stopped-local'?'stopped-local':result?.reason??row.blockedReason??'';return <article key={row.proofId}><p>{explanations[reason]??'正在核对上次操作的结果。'}</p>{reason==='business-declined'&&<p>{identityGroupError({code:row.businessFailure?.code??result?.businessFailure?.code})}</p>}<div className="button-row">
   {reviewReasons.has(reason)&&<Button type="button" disabled={busy} onClick={()=>void run(()=>inspect(row))}>查看原内容并继续</Button>}
   {reason==='business-declined'&&<Button type="button" variant="outline" disabled={busy} onClick={()=>void run(async()=>{const receipt=await client.retry(row.proofId,{explicitRetry:true});check();if(receipt.state==='acknowledged')await onReceipt(receipt);})}>重试原操作</Button>}
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>onOpen(row.operationId)}>查看原邀请</Button>
   <Button type="button" variant="ghost" disabled={busy} onClick={()=>void run(async()=>{const receipt=await client.reconcile(row.proofId);check();if(receipt.state==='acknowledged')await onReceipt(receipt);else setNotice(receipt.operationClosed?'原邀请已经结束；本次发送尚未确认收到，输入仍保留。':'尚未确认收到这次发送，原操作仍保留。');})}>查询处理结果</Button>
   {row.state!=='stopped-local'&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void run(async()=>{const receipt=await client.stopLocalRetry(row.proofId,{confirmed:true});check();if(receipt.ownApprovalAcknowledged)await onReceipt({...receipt,state:'acknowledged'});else setNotice('本机已停止发送。已经收到的邀请仍按原状态处理。');})}>停止本机发送</Button>}
  </div><details className="ig-technical"><summary>原操作详情</summary><HistoryFields value={row.locator}/></details></article>;})}
  {review&&<section className="ig-original-review"><header><h4>继续这份原内容</h4><p>连接或设备控制发生变化。这次会用当前设备处理同一份内容，原操作编号、范围和截止时间保持不变。</p></header><IdentityGroupIntent payload={review.preview.payload} sources={sources} subjectId={subjectId} names={names}/><p>本次选择：{review.preview.decision==='approve'?'同意':review.preview.decision==='decline'?'拒绝':'取消'}。</p><div className="button-row"><Button type="button" disabled={busy} onClick={()=>void run(async()=>{const prior=review;const receipt=await client.execute(prior.preview,{confirmed:true,onJournal:locator=>rebindDraft(prior.row.locator,locator)});check();setReview(null);setSources([]);if(receipt.state==='acknowledged')await onReceipt(receipt);else setNotice('原操作已经结束，本次发送没有确认收到。');})}>以当前设备继续{review.preview.decision==='approve'?'同意':review.preview.decision==='decline'?'拒绝':'取消'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>{setReview(null);setSources([]);}}>暂不继续</Button></div></section>}
  {error&&<p role="alert" className="message error">{error}</p>}{notice&&<output>{notice}</output>}
 </section>;
}
