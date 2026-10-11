import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Laptop, Monitor} from 'lucide-react';
import {Button} from '@/components/ui/button';

type Device = {deviceId:string;keyId:string;epoch:number;scopes:string[];state:string;currentDevice:boolean;canRevoke:boolean};
type Current = {subjectId:string;endpoint:string;deviceId:string;epoch:number;chainHead:string;canManage:boolean;devices:Device[];recoveryConfigured:boolean;recoveryReadiness:string;checkedAt:string};
export type DeviceControlState = Current;
type Operation = {operationId:string;subjectId:string;deviceId:string;initiatorDeviceId:string;state:string;localRetryStopped:boolean;serverCancellationConfirmed:boolean;currentAccessGranted:false;requestHash:string;challengeHash:string|null};
type Preview = {operationId:string;subjectId:string;endpoint:string;requestHash:string;challengeHash:string;expiresAt:number;target:{deviceId:string;keyId:string;scopes:string[];currentDevice:boolean};control:{deviceId:string;signerKeyId:string;epoch:number;chainHead:string}};
type Receipt = Operation & {receipt?:{state:string}|null;acceptedOperationOnly?:boolean;recordedLocalReceipt?:boolean;registered?:boolean;submission?:string};
type Pending = {active:Operation|null;history:Operation[]};
type Management = {current:()=>Promise<Current>;pending:()=>Promise<Pending>;prepareRevoke:(input:{deviceId:string})=>Promise<Preview>;confirm:(preview:Preview,options:{confirmed:true})=>Promise<Receipt>;reconcile:(id:string)=>Promise<Receipt>;stopRetry:(id:string,options:{confirmed:true})=>Promise<Receipt>};
type Props = {runtime:{deviceManagement?:Management}|null;subjectId?:string;deviceId?:string;connected?:boolean;onChange?:()=>void|Promise<void>;onManagementChange?:(canManage:boolean)=>void;onCurrentChange?:(current:Current|null)=>void};
const states:Record<string,string> = {active:'可使用',revoked:'已撤销',preparing:'正在准备',prepared:'等待你确认',submitting:'正在处理','result-unknown':'正在确认结果',requested:'等待你确认',committed:'已撤销',canceled:'已取消',expired:'已到期','stopped-local':'已停止发送'};
const errors:Record<string,string> = {
 device_management_identity_required:'先连接自己的银河身份，再查看设备。',device_management_identity_changed:'身份已变化，请重新打开设备页。',
 device_management_confirmation_required:'这份确认已过期，请重新选择设备。',device_management_pending_exists:'请先完成上次的设备操作。',
 device_management_local_retry_stopped:'这次操作已停止继续发送，系统仍会确认此前的结果。',device_management_control_changed:'设备权限已变化，请根据当前设备状态重新选择。',
 device_management_pending_changed:'上次操作已变化，请重新打开设备页。',device_management_operation_unavailable:'这台设备没有找到上次的操作。',device_management_operation_closed:'这次操作已结束，设备状态会自动更新。',
 device_controller_not_authorized:'本机不能管理设备，请使用其他管理设备或已保存的恢复码。',identity_last_controller:'这是最后一个管理设备，需要先设置恢复码或连接另一台管理设备。',
 identity_device_not_active:'这台设备已被撤销。',device_approval_expired:'此次确认已到期，请重新选择设备。',receipt_status_authority_changed:'身份或连接已变化，请重新打开设备页。',
 device_key_unavailable:'这台设备缺少所需的身份材料，请使用另一台管理设备。',device_control_state_invalid:'暂时无法读取当前设备状态。',identity_control_stale:'设备状态已变化，请根据最新内容继续。',control_epoch_changed:'身份已在其他设备恢复，本机不能继续管理它。',
};
function message(error:unknown){const e=error as {code?:string;message?:string};return errors[e?.code??e?.message??'']??'暂时无法完成，连接恢复后会继续读取结果。';}
function receiptText(value:Receipt){
 if(value.state==='committed')return '这台设备已撤销。';
 if(value.serverCancellationConfirmed)return '这次操作已取消。';
 if(value.state==='expired')return '此次确认已到期，需要时可重新选择设备。';
 if(value.localRetryStopped)return '已停止继续发送，系统仍会确认此前的处理结果。';
 if(value.registered===false)return '上次的操作尚未发送。';
 return '正在确认处理结果。';
}
const deviceName=(device:{deviceId:string;currentDevice?:boolean})=>device.currentDevice?'当前设备':'设备 '+device.deviceId.slice(-6);

export function DeviceManagement(props:Props){return <DeviceManagementSession key={JSON.stringify([props.subjectId,props.deviceId,props.connected])} {...props}/>;}
function DeviceManagementSession({runtime,subjectId,deviceId,connected,onChange,onManagementChange,onCurrentChange}:Props){
 const management=runtime?.deviceManagement;
 const [current,setCurrent]=useState<Current|null>(null),[pending,setPending]=useState<Pending>({active:null,history:[]});
 const [preview,setPreview]=useState<Preview|null>(null),[historyReceipt,setHistoryReceipt]=useState<Receipt|null>(null),[activeReceipt,setActiveReceipt]=useState<Receipt|null>(null);
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[readError,setReadError]=useState(''),[notice,setNotice]=useState('');
 const lifecycle=useRef({epoch:0,sequence:0,active:true}),working=useRef(false),reading=useRef(false),lastApplied=useRef(new Set<string>()),onChanged=useRef(onChange);
 const onManagementChanged=useRef(onManagementChange);
 const onCurrentChanged=useRef(onCurrentChange);
 useLayoutEffect(()=>{onChanged.current=onChange;onManagementChanged.current=onManagementChange;onCurrentChanged.current=onCurrentChange;},[onChange,onManagementChange,onCurrentChange]);
 const reviewElement=useRef<HTMLElement|null>(null);
 useEffect(()=>{if(preview)reviewElement.current?.focus();},[preview]);
 const refresh=useCallback(async(reconcile=true)=>{
  if(!management)return;const session=lifecycle.current,lease=session.epoch,query=++session.sequence,valid=()=>session.active&&lease===session.epoch&&query===session.sequence;
  const publishCurrent=onCurrentChanged.current,publishManagement=onManagementChanged.current;
  let state:Pending|null=null,readProblem='',receipt:Receipt|null=null;
  try{state=await management.pending();
   if(reconcile&&state.active){const r=await management.reconcile(state.active.operationId);if(!valid())return;receipt=r;
    if(r.state==='committed'&&!lastApplied.current.has(r.operationId)){lastApplied.current.add(r.operationId);setNotice(receiptText(r));setPreview(null);await onChanged.current?.();}
    state=await management.pending();
   }
  }catch(e){readProblem=message(e);}
  const results=await Promise.allSettled([management.current(),state?Promise.resolve(state):management.pending()]);if(!valid())return;
  if(results[0].status==='fulfilled'&&results[0].value.subjectId===subjectId&&(!deviceId||results[0].value.deviceId===deviceId)){
   setCurrent(results[0].value);publishCurrent?.(results[0].value);publishManagement?.(results[0].value.canManage);
  }else{setCurrent(null);setPreview(null);publishCurrent?.(null);publishManagement?.(false);readProblem=message(results[0].status==='rejected'?results[0].reason:{code:'device_management_identity_changed'});}
  if(results[1].status==='fulfilled'){setPending(results[1].value);const activeId=results[1].value.active?.operationId;setActiveReceipt(previous=>receipt?.operationId===activeId?receipt:previous?.operationId===activeId?previous:null);}else readProblem=message(results[1].reason);
  setReadError(readProblem);
  setLoading(false);
 },[management,subjectId,deviceId]);
 useEffect(()=>{
  const session=lifecycle.current,lease=++session.epoch;session.active=true;working.current=false;reading.current=false;
  onCurrentChanged.current?.(null);onManagementChanged.current?.(false);
  const read=()=>{if(!subjectId||!management||document.hidden||working.current||reading.current)return;reading.current=true;void refresh().finally(()=>{if(session.active&&lease===session.epoch)reading.current=false;});};
  read();const timer=setInterval(read,20000);document.addEventListener('visibilitychange',read);
  return()=>{session.active=false;session.epoch++;session.sequence++;clearInterval(timer);document.removeEventListener('visibilitychange',read);};
 },[runtime,management,subjectId,deviceId,connected,refresh]);
 async function run(action:(valid:()=>boolean)=>Promise<void>){
  const session=lifecycle.current;if(!session.active||working.current)return;working.current=true;session.sequence++;setBusy(true);setError('');setNotice('');setActiveReceipt(null);const lease=session.epoch,valid=()=>session.active&&lease===session.epoch;
  try{await action(valid);}catch(e){if(valid()){setPreview(null);setError(message(e));}}
  finally{if(valid()){await refresh(false);if(valid()){setBusy(false);working.current=false;}}}
 }
 function prepare(deviceId:string){void run(async valid=>{setPreview(null);const value=await management!.prepareRevoke({deviceId});if(valid())setPreview(value);});}
 if(!subjectId)return null;
 return <details className="room-settings device-management" id="identity-device-management">
  <summary>我的设备</summary>
  <style>{'.device-list{list-style:none;padding:0;margin:18px 0}.device-row{display:flex;gap:14px;align-items:flex-start;padding:18px 0;border-bottom:1px solid var(--border,#e2e8f0)}.device-row>svg{color:#66768d;flex:none;margin-top:3px}.device-row>div{flex:1;min-width:0}.device-row h3{font-size:1rem;margin:0 0 6px}.device-row p{margin:6px 0}.device-management .service-details{font-size:.84rem;margin:12px 0}.device-management code{overflow-wrap:anywhere}.device-confirm{padding:20px;background:var(--muted,#f3f6f9);border-radius:12px;margin:20px 0}.device-confirm h3{margin:0 0 12px}.device-management .device-muted{color:var(--muted-foreground,#64748b);font-size:.88rem}'} </style>
  <h2>管理可以使用这个身份的设备</h2>
  {!management?<p>设备管理暂时不可用，请稍后重新打开。</p>:<>
   {loading&&<output>正在读取设备…</output>}
   {(error||readError)&&<div className="message error" role="alert">{error||readError} <button className="text-link" disabled={busy} onClick={()=>run(async()=>{})}>再试一次</button></div>}
   {notice&&<output className="message">{notice}</output>}
   {current&&<>
    {!current.canManage&&<p className="device-muted">当前设备没有管理权限。</p>}
    <ul className="device-list">{current.devices.map(device=><li className="device-row" key={device.deviceId}>
     {device.currentDevice?<Laptop size={22} aria-hidden="true"/>:<Monitor size={22} aria-hidden="true"/>}<div>
      <h3>{deviceName(device)}</h3><p className="device-muted">{states[device.state]??'状态暂不可用'}{device.currentDevice&&' · 你正在使用'}</p>
      <details className="service-details"><summary>设备详情</summary><dl><dt>设备标识</dt><dd><code>{device.deviceId}</code></dd><dt>公钥标识</dt><dd><code>{device.keyId}</code></dd><dt>已登记权限</dt><dd>{device.scopes.join('、')}</dd><dt>控制版本</dt><dd>{device.epoch}</dd></dl></details>
      {device.canRevoke&&<Button type="button" variant="outline" disabled={busy||!!pending.active} onClick={()=>prepare(device.deviceId)}>撤销此设备</Button>}
      {device.currentDevice&&device.state==='active'&&current.canManage&&!device.canRevoke&&<p className="device-muted">这是最后一个管理设备。先设置恢复码或连接另一台管理设备，再撤销本机。</p>}
     </div>
    </li>)}</ul>{!current.devices.length&&<p>没有可显示的设备。</p>}
    <details className="service-details"><summary>服务与恢复设置</summary><p className="break-all">{current.endpoint}</p><p>{current.recoveryConfigured?'已设置恢复码，请自行妥善保存。':'尚未设置恢复码。'}</p></details>
   </>}
   {preview&&<section className="device-confirm" aria-label="撤销设备" tabIndex={-1} ref={reviewElement}>
    <h3>撤销{deviceName(preview.target)}？</h3>
    <p>撤销后，它将无法继续在当前服务使用这个身份。{preview.target.currentDevice?'当前设备也会断开连接。':''}</p>
    <p className="device-muted">银河身份、历史和资料保留。</p>
    <details className="service-details"><summary>确认的设备与范围</summary><dl><dt>设备</dt><dd><code>{preview.target.deviceId}</code></dd><dt>服务</dt><dd className="break-all">{preview.endpoint}</dd><dt>权限</dt><dd>{preview.target.scopes.join('、')}</dd><dt>确认有效至</dt><dd>{new Date(preview.expiresAt*1000).toLocaleString()}</dd><dt>原操作</dt><dd><code>{preview.operationId}</code></dd></dl></details>
    <div className="button-row"><Button disabled={busy||!current?.canManage} onClick={()=>void run(async valid=>{const exact=preview;setPreview(null);const r=await management.confirm(exact,{confirmed:true});if(valid()){setNotice(receiptText(r));if(r.state==='committed')lastApplied.current.add(r.operationId);await onChanged.current?.();}})}>确认撤销</Button><Button variant="ghost" disabled={busy} onClick={()=>void run(async valid=>{const id=preview.operationId;setPreview(null);await management.stopRetry(id,{confirmed:true});if(valid())setNotice('已停止继续发送。');})}>暂不撤销</Button></div>
   </section>}
   {pending.active&&!preview&&<section className="device-confirm" aria-label="上次的设备操作">
    <p><strong>{activeReceipt?.registered===false?'尚未发送':states[pending.active.state]??'正在确认结果'}</strong></p>
    <p className="device-muted">{pending.active.localRetryStopped?'已停止继续发送，系统仍会确认此前的结果。':activeReceipt?.registered===false||['prepared','requested'].includes(pending.active.state)?'上次选定的设备仍在等待你确认。':'连接恢复后会继续确认处理结果。'}</p>
    {!pending.active.localRetryStopped&&current?.canManage&&(activeReceipt?.registered===false||['prepared','requested','preparing'].includes(pending.active.state))&&<Button disabled={busy} onClick={()=>prepare(pending.active!.deviceId)}>继续上次的选择</Button>}
    {!pending.active.localRetryStopped&&<Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{const r=await management.stopRetry(pending.active!.operationId,{confirmed:true});setNotice(receiptText(r));})}>停止继续发送</Button>}
   </section>}
   {pending.history.length>0&&<details className="service-details"><summary>以前的设备操作</summary><ul className="device-list">{pending.history.map(row=><li key={row.operationId}><p>设备 {row.deviceId.slice(-6)} · {states[row.state]??'结果待确认'}</p><button className="text-link" disabled={busy} onClick={()=>void run(async valid=>{const r=await management.reconcile(row.operationId);if(valid())setHistoryReceipt(r);})}>查看详情</button>{historyReceipt?.operationId===row.operationId&&<p>{receiptText(historyReceipt)}</p>}</li>)}</ul></details>}
  </>}
 </details>;
}
