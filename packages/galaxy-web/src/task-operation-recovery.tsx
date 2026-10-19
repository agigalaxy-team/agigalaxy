import {ReadingDetails,ReadingSummary} from './reading-details';
import React,{useCallback,useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {X} from 'lucide-react';
import {memberName,readableTime} from './conversation-ui';
import {errorField,operationSessionKey,readAuthorizationPreview,readOperationReceipt,readPendingOperation,readStoppedOperations,readStopPreview,submittedContent,publicationMaterialIds,readPublicationMaterial} from './task-operation-state';
import type {PublicationMaterialRead,OperationAuthorizationPreview,OperationReceipt,OperationRuntime,StoppedOperation,StopPreview} from './task-operation-state';

const actions:Record<string,string>={'requester-feedback':'合作反馈','publish-task':'发布求助',apply:'申请帮助',invite:'发送邀请','invitation-reply':'回应邀请','propose-participation':'提出参与安排',confirm:'开始参与',decline:'婉拒参与',withdraw:'退出参与',accept:'记录交付反馈',deliver:'提交交付','propose-scope':'更新参与内容','confirm-scope':'接受新的参与内容','decline-scope':'保持原参与内容',dispute:'记录问题','propose-resolution':'回应问题','confirm-resolution':'确认处理结果',close:'结束征集',cancel:'取消求助','extend-enrollment':'延长征集','withdraw-application':'撤回申请','revoke-invitation':'撤回邀请'};
const recoveryError=(reason:unknown)=>errorField(reason,'code')==='task_material_unavailable'?'原发布材料当前不可用。独立说明和原回执查询仍保留。':['task_operation_business_rejected','publication_business_rejected'].includes(errorField(reason,'code'))?'服务未接受上次内容，已停止自动发送。原内容仍保留。':['task_operation_authorization_review_required','publication_authorization_review_required'].includes(errorField(reason,'code'))?'上次提交需要重新确认。请核对保留的内容与可见范围，再继续。':['task_operation_authorization_expired','publication_authorization_expired'].includes(errorField(reason,'code'))?'上次提交的许可已到期。内容仍保留，可以重新确认后继续。':'上次提交暂未完成，原内容已保留。';
type Props={runtime:OperationRuntime;connected:boolean;taskId?:string|null;managedFeedback?:boolean;onComplete?:(receipt:OperationReceipt)=>void|Promise<void>;onStopped?:(receipt:OperationReceipt)=>void|Promise<void>};

function SubmittedContent({value,material,clock}:{value:OperationAuthorizationPreview;material:PublicationMaterialRead|null;clock:number}){
 const body=submittedContent(value.payload,material?.materialBodies,material?.materialStates,clock);
 return <div className="submitted-content"><h3>{actions[body.kind]??'继续上次提交'}</h3>{body.texts.map((text,index)=><p className="reading-prose" key={index}>{text}</p>)}<dl><dt>可见范围</dt><dd>{value.visibility==='Public'?'公开':value.viewers.length?value.viewers.map(id=>memberName(id)).join('、'):'仅自己'}</dd><dt>本次授权至</dt><dd>{readableTime(value.expiresAt)}</dd>{body.enrollmentExpiresAt!==null&&<><dt>征集截止</dt><dd>{readableTime(body.enrollmentExpiresAt)}</dd></>}{body.expiresAt!==null&&<><dt>原内容有效至</dt><dd>{readableTime(body.expiresAt)}</dd></>}</dl><ReadingDetails className="technical-details"><ReadingSummary>原提交的准确内容与引用</ReadingSummary><pre className="code-block">{JSON.stringify(value.payload,null,2)}</pre></ReadingDetails></div>;
}
export function TaskOperationRecovery(props:Props){
 const {runtime,connected,taskId=null,managedFeedback=false}=props;
 const sessionKey=useCallback(()=>operationSessionKey(runtime,undefined,connected,taskId,managedFeedback?'managed-feedback':'all-operations'),[runtime,connected,taskId,managedFeedback]);
 const [,setObserved]=useState(sessionKey);
 useEffect(()=>{const read=()=>setObserved(sessionKey()),timer=window.setInterval(read,1000);document.addEventListener('visibilitychange',read);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[sessionKey]);
 return <RecoverySession key={sessionKey()} {...props} taskId={taskId}/>;
}
function RecoverySession({runtime,connected,taskId=null,onComplete,onStopped,managedFeedback=false}:Props){
 const [pending,setPending]=useState<ReturnType<typeof readPendingOperation>>(null),[preview,setPreview]=useState<OperationAuthorizationPreview|null>(null),[stopPreview,setStopPreview]=useState<StopPreview|null>(null),[stopped,setStopped]=useState<StoppedOperation[]>([]),[archiveOpen,setArchiveOpen]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const session=useRef({active:false,generation:0,working:false,notified:new Set<string>()}),dialog=useRef<HTMLDialogElement>(null);
 const [readMaterial,setReadMaterial]=useState<PublicationMaterialRead|null>(null),[materialClock,setMaterialClock]=useState(()=>Math.floor(Date.now()/1000));
 const materialIds=useMemo(()=>publicationMaterialIds(preview?.payload),[preview?.payload]);
 const material=readMaterial&&preview&&readMaterial.payloadHash===preview.payloadHash&&readMaterial.payload.operationId===preview.eventId?readMaterial:null;
 const materialUnavailable=materialIds.some(id=>material?.materialStates[id]?.status!=='available'||(material.materialStates[id].availableUntil??0)<=materialClock||!material.materialBodies.some(body=>body.materialId===id));
 const callbacks=useRef({onComplete,onStopped});
 useEffect(()=>{callbacks.current={onComplete,onStopped};},[onComplete,onStopped]);
 const lease=useMemo(()=>connected?runtime.receiptStatus.captureLease():null,[runtime,connected]);
 const current=()=>{if(!session.current.active||!lease)return false;try{lease.assertCurrent();return true;}catch{return false;}};
 async function complete(receipt:OperationReceipt){
  if(!current())return;const key=receipt.eventId??receipt.taskId;if(key&&session.current.notified.has(key))return;if(key)session.current.notified.add(key);
  setPending(null);setPreview(null);await callbacks.current.onComplete?.(receipt);
 }
 async function read(resume=true){
  const token=session.current.generation;if(!current()||session.current.working||document.hidden)return;session.current.working=true;
  try{
   const record=readPendingOperation(await runtime.getLocal(taskId?`task-event:${taskId}`:'task-publication'));if(!current()||token!==session.current.generation)return;
   const handledFeedback=managedFeedback&&record!==null&&submittedContent(JSON.parse(record.payloadJson)).kind==='requester-feedback';
   setPending(handledFeedback?null:record);if(handledFeedback)setError('');
   if(record&&resume&&!handledFeedback){
    try{const receipt=readOperationReceipt(taskId?await runtime.resumeTaskEvent(taskId):await runtime.resumePublication());if(!current()||token!==session.current.generation)return;
     if(receipt.state==='acknowledged'||!receipt.state&&receipt.taskId){await complete(receipt);if(current())setError('');}
    }catch(reason){if(current()&&token===session.current.generation)setError(recoveryError(reason));}
   }
   const records=readStoppedOperations(await runtime.stoppedTaskOperations(taskId));if(current()&&token===session.current.generation)setStopped(records);
  }catch{if(current()&&token===session.current.generation)setError('暂时无法读取上次提交的状态。');}
  finally{if(token===session.current.generation)session.current.working=false;}
 }
 const materialReadEpoch=useRef(0);
 const readMaterials=useEffectEvent(async()=>{
  const selected=preview,token=++materialReadEpoch.current;
  if(!selected||taskId!==null||!materialIds.length||document.hidden||!current())return;
  try{const value=await runtime.getLocal('task-publication');if(current()&&token===materialReadEpoch.current)setReadMaterial(readPublicationMaterial(value,selected));}catch{/* Uncertain source state leaves controlled text hidden. */}
 });
 useEffect(()=>{
  if(!materialIds.length)return;
  const reads=materialReadEpoch;const hide=()=>{reads.current++;setReadMaterial(null);},visible=()=>{hide();if(!document.hidden)void readMaterials();};
  const timer=setInterval(()=>{hide();void readMaterials();},15000),tick=setInterval(()=>setMaterialClock(Math.floor(Date.now()/1000)),1000);
  document.addEventListener('visibilitychange',visible);window.addEventListener('online',visible);window.addEventListener('offline',hide);
  return()=>{reads.current++;clearInterval(timer);clearInterval(tick);document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',visible);window.removeEventListener('offline',hide);};
 },[materialIds,preview?.eventId,preview?.payloadHash]);
 const readCurrent=useEffectEvent(()=>read());
 useEffect(()=>{
  session.current.active=true;session.current.generation++;const visible=()=>{if(!document.hidden)void readCurrent();};visible();
  const timer=window.setInterval(visible,8000);document.addEventListener('visibilitychange',visible);
  const state=session.current;return()=>{state.active=false;state.generation++;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[session,runtime,connected,taskId,managedFeedback]);
 useEffect(()=>{if(preview||stopPreview||archiveOpen)dialog.current?.showModal();else dialog.current?.close();},[preview,stopPreview,archiveOpen]);
 async function run(action:(valid:()=>boolean)=>Promise<void>){
  if(session.current.working||!current())return;session.current.working=true;setBusy(true);setError('');const token=session.current.generation,valid=()=>current()&&token===session.current.generation;
  try{await action(valid);}catch(reason){if(valid())setError(errorField(reason,'message')||'暂时无法完成，请重试。');}
  finally{if(valid()){session.current.working=false;setBusy(false);await read(false);}}
 }
 async function continueOriginal(valid:()=>boolean){
  const value:unknown=await runtime.reviewTaskAuthorization(taskId);if(!valid())return;const result=readOperationReceipt(value);
  if(result.state==='reauthorization-required'){const next=readAuthorizationPreview(value);setReadMaterial(null);setPreview(next);if(next&&taskId===null&&publicationMaterialIds(next.payload).length){const saved=await runtime.getLocal('task-publication');if(valid())setReadMaterial(readPublicationMaterial(saved,next));}}
  else if(result.state==='acknowledged')await complete(result);
  else{const receipt=readOperationReceipt(taskId?await runtime.resumeTaskEvent(taskId,{explicitRetry:true}):await runtime.resumePublication({explicitRetry:true}));if(valid()&&receipt.state==='acknowledged')await complete(receipt);}
 }
 async function reviewStop(valid:()=>boolean){
  const value:unknown=await runtime.reviewTaskStop(taskId);if(!valid())return;const result=readOperationReceipt(value);
  if(result.state==='acknowledged')await complete(result);else if(result.state==='stop-local-preview')setStopPreview(readStopPreview(value));
 }
 async function reauthorize(valid:()=>boolean){
  if(!preview)return;const receipt=readOperationReceipt(await runtime.reauthorizeTaskOperation(preview,{taskId,confirmed:true}));
  if(valid()){setPreview(null);if(receipt.state!=='none')await complete(receipt);}
 }
 async function stop(valid:()=>boolean){
  if(!stopPreview)return;const receipt=readOperationReceipt(await runtime.stopTaskOperation(stopPreview,{taskId,confirmed:true}));if(!valid())return;setStopPreview(null);
  if(receipt.state==='acknowledged')await complete(receipt);else if(receipt.state==='stopped-local'){setPending(null);setMessage('已停止本机重试。');await callbacks.current.onStopped?.(receipt);}
 }
 async function query(record:StoppedOperation,valid:()=>boolean){
  const value:unknown=await runtime.queryStoppedTaskOperation(record.eventId,{taskId});if(!valid())return;
  const results=readStoppedOperations([value]),result=results[0];
  if(result.receipt.state==='acknowledged')await complete({...result,...result.receipt});else setMessage('已更新这次提交的状态。');
 }
 if(!pending&&!stopped.length&&!message&&!error)return null;
 return <section className="task-pending-status" aria-label="上次提交状态">
  {pending&&<div><p><output>{error||'正在继续上次提交，内容已保留。'}</output></p><div className="button-row">{error&&<Button variant="ghost" disabled={busy||!connected} onClick={()=>void run(continueOriginal)}>继续上次内容</Button>}<Button variant="ghost" disabled={busy||!connected} onClick={()=>void run(reviewStop)}>停止重试</Button></div></div>}
  {!pending&&error&&<p role="alert">{error}</p>}{message&&<p><output>{message}</output></p>}{!pending&&stopped.length>0&&<button className="text-action" onClick={()=>setArchiveOpen(true)}>查看已停止的提交</button>}
  <dialog ref={dialog} className="conversation-panel task-recovery-dialog" aria-label="处理上次提交" onClose={()=>{setPreview(null);setStopPreview(null);setArchiveOpen(false);}}><header><h2>{preview?'继续这次提交':stopPreview?'停止重试？':'已停止的提交'}</h2><button className="icon-button" aria-label="关闭提交状态" onClick={()=>{setPreview(null);setStopPreview(null);setArchiveOpen(false);}}><X size={20}/></button></header><div className="task-recovery-body">
   {preview&&<><SubmittedContent value={preview} material={material} clock={materialClock}/>{materialUnavailable&&<output>部分来源材料正在核对或当前不可用，相关文字已隐藏。可以关闭后查询原回执。</output>}<div className="button-row"><Button variant="ghost" onClick={()=>setPreview(null)}>暂不继续</Button><Button disabled={busy||!connected||materialUnavailable} onClick={()=>void run(reauthorize)}>确认内容并继续</Button></div></>}
   {stopPreview&&<><p>停止本机继续发送。服务已经收到的内容仍可能完成。</p><div className="button-row"><Button variant="ghost" onClick={()=>setStopPreview(null)}>继续保留</Button><Button disabled={busy||!connected} onClick={()=>void run(stop)}>停止重试</Button></div></>}
   {archiveOpen&&stopped.map(record=><article key={record.eventId}><h3>{actions[record.kind]??'上次提交'}</h3><p>{record.receipt.state==='acknowledged'?'服务已收到这次提交。':record.receipt.state==='absent'?'上次查询尚未收到。':'结果暂未确认。'}</p><Button variant="outline" disabled={busy||!connected} onClick={()=>void run(valid=>query(record,valid))}>更新状态</Button></article>)}
  </div></dialog>
 </section>;
}
