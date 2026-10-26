import React, {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import {useChoiceViewLease,type ChoiceViewLease} from "../../shared/operations/choice-retained-operations";
import {errorField} from "../tasks/operations/task-operation-state";
import {getFactClient} from './client.mjs';
import type {WorkRuntime} from "../tasks/work-task-types";
import type {WorkFactClient,WorkFactPending,WorkFactReceipt} from './contracts';
import {receiptMessages} from './record-labels';

// Original receipt locators belong to the current local identity. They do not
// depend on a readable Task/Case, and they never stand in for a current body.
type RecoveryProps={runtime:WorkRuntime;subjectId?:string;taskId:string;connected:boolean};
export function FactReceiptRecovery(props:RecoveryProps){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return props.connected&&props.subjectId&&view.lease?<ReceiptRecoverySession key={props.taskId+':'+view.key} {...props} subjectId={props.subjectId} lease={view.lease}/>:null;
}
function ReceiptRecoverySession({runtime,subjectId,taskId,lease}:RecoveryProps&{subjectId:string;lease:ChoiceViewLease}){
 const client=useMemo<WorkFactClient>(()=>getFactClient(runtime,subjectId),[runtime,subjectId]),generation=useRef(0),working=useRef(false);
 const [pending,setPending]=useState<WorkFactPending|null>(null),[receipt,setReceipt]=useState<WorkFactReceipt|null>(null),
  [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const capture=useCallback(()=>{const epoch=generation.current;const check=()=>{lease.assertCurrent();if(epoch!==generation.current)throw Error('身份或连接已改变，请重新查询原操作。');};check();return {check,isCurrent:()=>{try{check();return true;}catch{return false;}}};},[lease]);
 const query=useCallback(async()=>{
  if(working.current)return;const original=capture();working.current=true;setBusy(true);setError('');setReceipt(null);
  try{const result=await client.reconcile(taskId);original.check();setReceipt(result);if(result.state==='acknowledged'||result.state==='none')setPending(null);}
  catch(reason){if(original.isCurrent()){setPending(null);const code=errorField(reason,'code');setError(['fact_authority_changed','receipt_status_authority_changed'].includes(code)?'身份或连接已改变，请重新查询原操作。':code==='fact_operation_invalid'?'本机原操作与回执定位不一致，已停止展示；请保留原记录以便核对。':'暂未取得确定的原操作回执，请保留原任务链接并稍后查询。');}}
  finally{if(original.isCurrent()){working.current=false;setBusy(false);}}
 },[client,taskId,capture]);
 useEffect(()=>{
  const viewGeneration=generation;viewGeneration.current++;const original=capture();
  void client.pending(taskId).then(async value=>{original.check();setPending(value);if(value)await query();})
   .catch(()=>{if(original.isCurrent())setError('本机原操作暂未读取，请重新查询；这不表示服务未收到提交。');})
   .finally(()=>{if(original.isCurrent())setLoading(false);});
  const visible=()=>{if(!document.hidden)void query();},timer=window.setInterval(visible,20000);document.addEventListener('visibilitychange',visible);
  return()=>{viewGeneration.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[client,taskId,capture,query]);
 if(!pending&&(!receipt||receipt.state==='none')&&!error)return null;
 const locator=receipt?.operationId?receipt:pending;
 return <section className="message" aria-label="上次提交"><h2>上次提交</h2>
  {loading&&<p><output>正在确认…</output></p>}{error&&<p className="message error" role="alert">{error}</p>}
  {receipt&&<p><output>{receiptMessages[receipt.state??'']??receiptMessages['result-unknown']}</output></p>}
  {locator&&<ReadingDetails><ReadingSummary>查看原操作编号与载荷摘要</ReadingSummary><p>原操作：<code style={{overflowWrap:'anywhere'}}>{locator.operationId}</code></p><p>原载荷摘要：<code style={{overflowWrap:'anywhere'}}>{locator.payloadHash}</code></p></ReadingDetails>}
  {error&&<Button type="button" variant="outline" disabled={loading||busy} onClick={()=>void query()}>再试一次</Button>}
 </section>;
}
