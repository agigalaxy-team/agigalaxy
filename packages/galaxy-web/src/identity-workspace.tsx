import { ReadingDetails, ReadingSummary } from './reading-details';
import {literalTaskText} from './task-material-client.mjs';
import React,{useCallback,useEffect,useEffectEvent,useLayoutEffect,useRef,useState} from 'react';
import {Copy,Link2,Monitor,ShieldCheck} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {DeviceManagement} from './device-management';
import type {DeviceControlState} from './device-management';
import {identityTransferLink,readIdentityTransfer} from './identity-transfer.mjs';
import {identityPermissionGroups as scopeGroups,identityPermissionLabel as scopeLabel} from './identity-permission-labels.mjs';
import './identity-device.css';
import './settings-visual.css';
import {initialDeviceInput as initial,savedDeviceInput,approvalDeadline} from './identity-workspace-types';
import type {DeviceRuntime,DeviceInput,DeviceOffer,OfferPreview,ApprovalPreview,DevicePending,DeviceResult,DeviceReceipt,VisitorDraftPreview,PublicApproval,DeviceSelectionPreview} from './identity-workspace-types';

type Props={showControls?:boolean;controlsOpen?:boolean;runtime:DeviceRuntime|null;subjectId?:string;deviceId?:string;connected?:boolean;navigate:(path:string)=>void;onChange?:()=>void|Promise<void>;onConnected?:()=>void|Promise<void>;onManagementChange?:(canManage:boolean)=>void;onDeviceStateChange?:(current:DeviceControlState|null)=>void};
const readable=(error:unknown)=>{const reason=error&&typeof error==='object'?error as Record<string,unknown>:{};return ({
 device_transfer_invalid:'这不是完整的银河设备连接信息，请重新复制。',
 device_request_invalid:'连接申请不完整，或不属于当前服务。',
 device_request_not_owned:'这份批准属于另一台设备，请回到发起申请的浏览器。',
 device_approval_expired:'这份批准已经到期，请停止原申请后重新连接。',
 device_approval_control_changed:'身份的设备权限已经变化，请由已有设备重新确认。',
 device_identity_switch_required:'当前浏览器已选择一个身份与设备，请回到原申请设备或使用另一浏览器。',
 device_controller_not_authorized:'当前设备不能批准新设备，请使用管理设备或恢复码。',
 device_authorization_no_longer_current:'这台设备的授权已经失效，不能凭旧记录重新启用。',
 device_handoff_owner_changed:'当前身份已经变化，原设备申请仍保留。',
 device_handoff_not_completed:'这次原连接尚未完成，不能凭本机旧记录接回。',
 device_local_selection_changed:'当前设备或原批准已改变，请重新查看这次连接后继续。',
 local_atomic_update_unavailable:'本机存储暂不能安全切换设备，原身份和申请仍保留。',
 device_key_unavailable:'此浏览器缺少原设备材料，请使用已有管理设备或恢复码接续。',
 local_draft_changed:'另一处已修改草稿，请重新查看两份内容后选择。'
} as Record<string,string>)[typeof reason.code==='string'?reason.code:'']??(typeof reason.message==='string'&&/[\u3400-\u9fff]/.test(reason.message)?reason.message:'暂时无法继续，原申请仍保留。');};
const stateNames:Record<string,string>={offered:'等待已有设备批准','awaiting-result':'正在连接这台设备',committed:'原设备接入已完成',canceled:'已停止这次连接',expired:'这次连接已到期'};
const fingerprint=(value:string)=>value.match(/.{1,8}/g)?.join(' ')??value;
function TransferDetails({offer,code}:{offer:DeviceOffer;code?:string}){const packet=Object.fromEntries(Object.entries(offer).filter(([key])=>key!=='fingerprint'));return <ReadingDetails className="device-transfer-details"><ReadingSummary>身份与设备详情</ReadingSummary><dl><dt>银河身份</dt><dd>{offer.subjectId}</dd><dt>设备</dt><dd>{offer.deviceId}</dd><dt>服务</dt><dd>{offer.endpoint}</dd></dl>{code&&<><p>设备核对码</p><code className="device-fingerprint">{fingerprint(code)}</code></>}<ReadingDetails><ReadingSummary>公开连接信息</ReadingSummary><pre>{JSON.stringify(packet,null,2)}</pre></ReadingDetails></ReadingDetails>;}

export function IdentityWorkspace(props:Props){return props.runtime?<IdentityDeviceSession key={JSON.stringify([props.runtime.api.endpoint,props.subjectId,props.deviceId])} {...props} runtime={props.runtime}/>:null;}
function IdentityDeviceSession({runtime,subjectId,deviceId,connected,navigate,onChange,onConnected,onManagementChange,onDeviceStateChange,showControls=true,controlsOpen=false}:Props&{runtime:DeviceRuntime}){
 const handoff=runtime?.deviceHandoff,storageKey='galaxy:device-connect:'+JSON.stringify([runtime?.api.endpoint,subjectId??'visitor']);
 const [input,setInput]=useState<DeviceInput>(()=>{try{return savedDeviceInput(JSON.parse(sessionStorage.getItem(storageKey)??'null'))??initial;}catch{return initial;}});
 const inputRef=useRef(input);
 const [openView,setOpenView]=useState({requested:controlsOpen,open:controlsOpen});
 if(openView.requested!==controlsOpen)setOpenView({requested:controlsOpen,open:controlsOpen||openView.open});
 const open=openView.open;
 const setOpen=useCallback((value:boolean)=>setOpenView({requested:controlsOpen,open:value}),[controlsOpen]);
 const [requestRead,setRequestRead]=useState<{source:string;value:OfferPreview|null;error:string}|null>(null),[approvalRead,setApprovalRead]=useState<{source:string;value:ApprovalPreview|null;error:string}|null>(null);
 const requestPreview=requestRead?.source===input.request?requestRead.value:null,requestError=requestRead?.source===input.request?requestRead.error:'';
 const approvalPreview=approvalRead?.source===input.approval?approvalRead.value:null,approvalError=approvalRead?.source===input.approval?approvalRead.error:'';
 const [pending,setPending]=useState<DevicePending|null>(null),[draftPreview,setDraftPreview]=useState<VisitorDraftPreview|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [localSelection,setLocalSelection]=useState<DeviceSelectionPreview|null>(null);
 const [error,setError]=useState(''),[readError,setReadError]=useState(''),[notice,setNotice]=useState('');
 const [manualLink,setManualLink]=useState('');
 const [approvalStatus,setApprovalStatus]=useState<{original:PublicApproval;receipt:DeviceReceipt|null;error:string}|null>(null);
 const approvalState=approvalStatus?.original===input.approved?approvalStatus?.receipt:null,approvalReadError=approvalStatus?.original===input.approved?approvalStatus?.error:'';
 const [clock,setClock]=useState(()=>Date.now()/1000);
 const [deviceState,setDeviceState]=useState<DeviceControlState|null>(null);
 const lifecycle=useRef({epoch:0,read:0,active:true}),working=useRef(false),reading=useRef(false),dismissedDraft=useRef(''),attempted=useRef(new Set<string>());
 const callbacks=useRef({onChange,onConnected});useLayoutEffect(()=>{callbacks.current={onChange,onConnected};},[onChange,onConnected]);
 const change=useCallback((patch:Partial<DeviceInput>)=>{const value={...inputRef.current,...patch};inputRef.current=value;setInput(value);setError('');setNotice('');
  if('approval' in patch||'request' in patch||'approved' in patch)setManualLink('');
  if('request' in patch)setRequestRead(null);if('approval' in patch)setApprovalRead(null);if('approved' in patch){setApprovalStatus(null);setClock(Date.now()/1000);}
  try{const text=JSON.stringify(value);if(!/PRIVATE KEY|galaxy-recovery-v1:/.test(text))sessionStorage.setItem(storageKey,text);}catch{}
 },[storageKey]);
  async function copyTransfer(value:unknown){try{const link=identityTransferLink(location.origin,value);setManualLink(link);await navigator.clipboard.writeText(link);setNotice('链接已复制，请在自己的另一台设备打开或粘贴。');}catch{setError('复制未完成，请使用“手动复制链接”，把链接带到自己的另一台设备。');}}
 function draftKey(value:VisitorDraftPreview|null){return JSON.stringify([value?.visitorDraft,value?.existingDraft]);}
 async function finishConnection(result:DeviceResult,valid:()=>boolean){
  if((!result?.activated&&!result?.alreadyActivated)||!valid())return;
  const selected=await runtime.status();if(!valid())return;
  if(selected.identity?.subjectId!==result.identity?.subjectId||selected.identity?.deviceId!==result.identity?.deviceId)throw Object.assign(new Error('device_handoff_owner_changed'),{code:'device_handoff_owner_changed'});
  try{await runtime.connect({confirmed:true});}catch(reason){
   // Activation has already selected the exact original local device. Keep
   // that visible if the separate service connection is temporarily failing.
   if(valid())await callbacks.current.onChange?.();throw reason;
  }
  if(!valid())return;
  change({approval:'',request:'',approved:null,scopes:[]});setApprovalRead(null);
  const complete=callbacks.current;if(complete.onConnected)await complete.onConnected();else await complete.onChange?.();
 }
 async function refresh(resume=false){
  const session=lifecycle.current;if(!handoff||!session.active||reading.current)return;const token=session.epoch,ticket=++session.read,valid=()=>session.active&&token===session.epoch&&ticket===session.read;reading.current=true;
  try{
   let operation:DevicePending|null=await handoff.pending();if(!valid())return;
   if(resume&&operation?.approval&&!['committed','canceled','expired'].includes(operation.state)){
    const result=handoff.resumePending?await handoff.resumePending(operation.operationId):await handoff.reconcile(operation.operationId);
    if(!valid())return;
    if(result.activated&&!attempted.current.has(operation.operationId)){attempted.current.add(operation.operationId);await finishConnection(result,valid);if(!valid())return;}
    const current:DevicePending|null=await handoff.pending();if(!valid())return;
    operation=current?{...current,needsReview:result.needsReview||result.receipt?.registered===false,needsLocalDeviceSelection:result.needsLocalDeviceSelection,receipt:result.receipt??null}:null;
   }
   const shown=operation?{...operation,fingerprint:(await handoff.previewOffer(operation.offer)).fingerprint}:null;
   const selection=operation?.needsLocalDeviceSelection?await handoff.previewLocalDeviceSelection(operation.operationId):null;if(!valid())return;
   const draft:VisitorDraftPreview|null=await runtime.visitorDrafts.preview();if(!valid())return;
   setPending(shown);setLocalSelection(selection);setDraftPreview(draft?.visitorDraft&&draftKey(draft)!==dismissedDraft.current?draft:null);setReadError('');setLoading(false);
  }catch(reason){if(valid()){setLocalSelection(null);setReadError(readable(reason));setLoading(false);}}
  finally{if(valid())reading.current=false;}
 }
 const resumeConnection=useEffectEvent(()=>refresh(true));
 useEffect(()=>{
  const session=lifecycle.current;session.epoch++;session.read++;session.active=true;working.current=false;reading.current=false;
  const read=()=>{if(!document.hidden&&!working.current)void resumeConnection();};
  read();const timer=setInterval(read,15000);document.addEventListener('visibilitychange',read);
  return()=>{session.active=false;session.epoch++;session.read++;clearInterval(timer);document.removeEventListener('visibilitychange',read);};
 },[runtime,subjectId,deviceId]);
 useEffect(()=>{if(!input.approved)return;const timer=setInterval(()=>setClock(Date.now()/1000),1000);return()=>clearInterval(timer);},[input.approved]);
 useEffect(()=>{
  if(!handoff)return;
  const receive=()=>{if(!new URLSearchParams(location.hash.slice(1)).has('device'))return;
   try{const packet=readIdentityTransfer(location.href);setOpen(true);
    if(packet.kind==='identity')change({identity:packet.subjectId,tab:'invite'});
    else if(packet.kind==='request')change({request:JSON.stringify(packet.value),scopes:[],approved:null,tab:'approve'});
    else change({approval:JSON.stringify(packet.value)});
    history.replaceState(history.state,'',location.pathname+location.search);dispatchEvent(new Event('galaxy:route-view-changed'));
   }catch(reason){setOpen(true);setError(readable(reason));}
  };
  receive();addEventListener('hashchange',receive);addEventListener('popstate',receive);return()=>{removeEventListener('hashchange',receive);removeEventListener('popstate',receive);};
 },[handoff,change,setOpen]);
 useEffect(()=>{
  if(!handoff||!subjectId||!input.request.trim())return;let active=true;const source=input.request;
  void (async()=>{const packet=readIdentityTransfer(source);if(packet.kind!=='request')throw Error('请粘贴新设备的连接申请。');
   const value:OfferPreview=await handoff.previewOffer(packet.value);if(value.subjectId!==subjectId)throw Error('这份申请对应另一个银河身份，请在该身份的已有设备中打开。');
   if(!active||inputRef.current.request!==source)return;setRequestRead({source,value,error:''});
   if(!inputRef.current.scopes.length)change({scopes:value.scopes});
  })().catch(reason=>{if(active)setRequestRead({source,value:null,error:readable(reason)});});return()=>{active=false;};
 },[handoff,subjectId,input.request,change]);
 useEffect(()=>{
  if(!handoff||!input.approval.trim())return;let active=true;const source=input.approval;
  void (async()=>{const packet=readIdentityTransfer(source);if(packet.kind!=='approval')throw Error('请粘贴已有设备返回的批准。');
   const value=await handoff.previewApproval(packet.value);if(active)setApprovalRead({source,value:{...value,packet:packet.value},error:''});
  })().catch(reason=>{if(active)setApprovalRead({source,value:null,error:readable(reason)});});return()=>{active=false;};
 },[handoff,input.approval]);
 useEffect(()=>{
  if(!handoff?.readApprovalStatus||!input.approved||!subjectId)return;
  let active=true,readingApproval=false;const original=input.approved;
  const read=async()=>{if(!active||readingApproval||document.hidden)return;readingApproval=true;
   try{const result=await handoff.readApprovalStatus(original);if(active){const receipt:DeviceReceipt=result.receipt??result;setApprovalStatus({original,receipt,error:''});setClock(Date.now()/1000);if(['committed','expired','canceled'].includes(receipt.state))setManualLink(current=>current===identityTransferLink(location.origin,original)?'':current);}}
   catch(reason){if(active)setApprovalStatus({original,receipt:null,error:readable(reason)});}
   finally{readingApproval=false;}
  };
  void read();const timer=setInterval(read,15000);document.addEventListener('visibilitychange',read);
  return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',read);};
 },[handoff,input.approved,subjectId]);
 async function run(action:(valid:()=>boolean)=>Promise<void>){
  const session=lifecycle.current;if(!session.active||working.current)return;const token=session.epoch,valid=()=>session.active&&token===session.epoch;working.current=true;session.read++;reading.current=false;setBusy(true);setError('');setNotice('');
  try{await action(valid);if(valid())await refresh();}
  catch(reason){if(valid()){setError(readable(reason));await refresh();}}
  finally{if(valid()){working.current=false;setBusy(false);}}
 }
 let enteredIdentity:{kind:'identity';subjectId:string}|null=null;try{if(input.identity.trim()){const value=readIdentityTransfer(input.identity);if(value.kind==='identity')enteredIdentity=value;}}catch{}
 const approvedDeadline=approvalDeadline(input.approved);
 const approvalCompleted=approvalState?.state==='committed',approvalClosed=['expired','canceled'].includes(approvalState?.state??'');
 const canCopyApproval=!approvalCompleted&&!approvalClosed&&approvedDeadline>clock;
 const approvalWaiting=!approvalState&&approvedDeadline<=clock;
 const activePending=pending&&!['committed','canceled','expired'].includes(pending.state);
 const currentControl=deviceState?.subjectId===subjectId&&deviceState?.deviceId===deviceId&&deviceState?.endpoint===runtime?.api.endpoint?deviceState:null;
 const currentDevice=currentControl?.devices.find(device=>device.currentDevice&&device.deviceId===deviceId);
 const currentActive=currentDevice?.state==='active'&&currentDevice.epoch===currentControl?.epoch;
 const canConnectCurrent=currentActive&&currentDevice.scopes.some(scope=>scope==='binding'||scope==='*');
 const canApprove=!!currentControl?.canManage&&currentActive;
 const tab=input.tab==='approve'&&canApprove?'approve':'invite';
 const originalIsCurrent=pending?.offer.subjectId===subjectId&&pending?.offer.deviceId===deviceId;
 const approveDisabled=busy||!canApprove||!requestPreview||!!input.approved;
 const pendingContent=pending&&<article className="device-transfer-step"><h3>{pending.needsLocalDeviceSelection?'新设备已获准，选择后继续':pending.needsReview?'连接尚待你确认':stateNames[pending.state]??'正在确认上次的连接'}</h3>
  {pending.state==='offered'&&<><p>把申请链接交给自己的已有设备，在那里核对并批准。</p><Button disabled={busy} onClick={()=>copyTransfer(pending.offer)}><Copy size={16}/>复制申请链接</Button></>}
  {pending.state==='awaiting-result'&&!pending.needsReview&&!pending.needsLocalDeviceSelection&&<p>连接恢复后，会继续处理这次原申请。</p>}
  {localSelection?.operationId===pending.operationId&&<><p>这次连接已由自己的管理设备批准。继续后，本浏览器改用获准的新设备；银河身份、原设备记录与草稿保留。</p>
   <ul className="device-permission-summary">{scopeGroups.map(group=>{const values=group.items.filter(([key])=>localSelection.scopes.includes(key));return values.length?<li key={group.title}>{values.map(([,name])=>name).join('、')}</li>:null;})}</ul>
   <Button disabled={busy||loading} onClick={()=>void run(async valid=>{const result=await handoff.selectLocalDevice(localSelection,{confirmed:true});await finishConnection(result,valid);})}>使用这个设备继续</Button>
  </>}
  {pending.needsReview&&!!pending.approval&&<Button disabled={busy} onClick={()=>change({approval:JSON.stringify(pending.approval)})}>继续这次连接</Button>}
  {pending.state==='committed'&&<>
   <p>{!subjectId?'原申请已完成。接回前会核对这台设备当前仍可使用原身份。':!originalIsCurrent?'这是此前设备接入的记录，当前身份与设备不会因此切换。':currentControl&&!canConnectCurrent?'原申请已完成，但当前设备已无法继续原连接。请使用其他管理设备或恢复码接续。':connected?'这是本机此前接入身份的记录。当前设备状态见“我的设备”。':'这是本机此前接入身份的记录。需要连接时，使用上方当前身份的连接入口。'}</p>
   <p>其他设备上的私有文件仍在原处。</p>
   {!subjectId&&<Button disabled={busy||loading} onClick={()=>void run(async valid=>{const result=await handoff.resumeLocalIdentity(pending.operationId,{confirmed:true});await finishConnection(result,valid);})}>接回这台设备</Button>}
  </>}
  {['canceled','expired'].includes(pending.state)&&<p>需要时可以重新开始连接。</p>}
  <TransferDetails offer={pending.offer} code={pending.fingerprint}/>
  {activePending&&<Button variant="ghost" disabled={busy} onClick={()=>void run(async valid=>{const result=await handoff.cancel(pending.operationId,{confirmed:true});if(valid())setNotice(result.receipt.state==='committed'?'设备已获准连接，不能把已完成的授权显示为取消。':'已停止这次连接。');})}>停止这次连接</Button>}
 </article>;
 if(!runtime||!handoff)return null;
 return <section className="identity-device-workspace">
  <DeviceManagement runtime={runtime} subjectId={subjectId} deviceId={deviceId} connected={connected} onChange={onChange} onManagementChange={onManagementChange} onCurrentChange={value=>{setDeviceState(value);onDeviceStateChange?.(value);}}/>
  <section id="existing-device" className="device-connect-entry" hidden={!showControls&&!open}>
   <header><div><h2>{subjectId?'在其他设备继续':'接回已有身份'}</h2><p>{subjectId?'新设备先提出申请，由你的管理设备批准。':'使用已有设备的连接链接，原身份和工作继续保留。'}</p></div>{subjectId&&!open&&!activePending&&!localSelection?<div className="button-row"><Button onClick={()=>{setOpen(true);void copyTransfer({kind:'identity',subjectId});}}><Link2 size={16}/>复制连接链接</Button><Button variant="outline" onClick={()=>setOpen(true)}>处理连接申请</Button></div>:!open&&!activePending&&!localSelection&&<Button onClick={()=>setOpen(true)}><Monitor size={16}/>连接已有设备</Button>}</header>
   {(open||activePending||localSelection)&&<div className="device-connect-panel">
    <h2>{subjectId?'连接自己的新设备':'接回你已有的银河身份'}</h2>
    {subjectId?<nav className="device-connect-tabs" aria-label="连接设备"><button aria-current={tab==='invite'?'page':undefined} onClick={()=>change({tab:'invite'})}>给新设备连接链接</button>{canApprove&&<button aria-current={tab==='approve'?'page':undefined} onClick={()=>change({tab:'approve'})}>批准新设备</button>}</nav>:<p>在已有设备的身份设置中复制连接链接，带到这里继续。</p>}
    {(error||readError)&&<p className="message error" role="alert">{error||readError}</p>}{notice&&<output className="message">{notice}</output>}
    {manualLink&&<ReadingDetails mode="inline" className="device-transfer-details"><ReadingSummary>手动复制链接</ReadingSummary><Textarea aria-label="公开设备连接链接" readOnly value={manualLink} onFocus={event=>event.target.select()}/></ReadingDetails>}
    {loading&&<output>正在读取上次的连接…</output>}
    {subjectId&&tab==='invite'&&<div className="device-transfer-step"><h3>在新设备打开连接链接</h3><p>{canApprove?'新设备会生成自己的申请，再由你在这台设备批准。':currentControl?'新设备会生成自己的申请，请用有管理权限的设备批准，或使用恢复码接续。':'正在读取本机设备权限。连接申请可由已有管理设备批准。'}</p>{!canApprove&&input.request&&<p>原连接申请保留在此浏览器，当前设备获准管理后可以继续处理。</p>}<Button onClick={()=>copyTransfer({kind:'identity',subjectId})}><Link2 size={16}/>复制连接链接</Button></div>}
    {!subjectId&&!activePending&&<form className="device-transfer-form" onSubmit={event=>{event.preventDefault();if(!enteredIdentity)return;void run(async valid=>{await handoff.createOffer(enteredIdentity.subjectId,{confirmed:true});if(valid())setNotice('申请已准备好，交给已有设备批准。');});}}>
     <label htmlFor="device-identity-input">连接链接或已有银河 ID<Input id="device-identity-input" value={input.identity} onChange={event=>change({identity:event.target.value})} placeholder="粘贴已有设备的连接链接" maxLength={48000}/></label>
     <Button type="submit" disabled={busy||loading||!enteredIdentity}><Monitor size={16}/>为这台设备建立连接申请</Button>
    </form>}
    {pendingContent&&(pending.state==='committed'&&subjectId&&!pending.needsLocalDeviceSelection?<ReadingDetails className="device-transfer-details"><ReadingSummary>以前的设备接入</ReadingSummary>{pendingContent}</ReadingDetails>:pendingContent)}
    {!subjectId&&pending&&activePending&&<div className="device-transfer-form">
     {!approvalPreview?<label htmlFor="device-approval-input">已有设备返回的批准<Textarea id="device-approval-input" value={input.approval} maxLength={48000} onChange={event=>change({approval:event.target.value})} placeholder="粘贴批准链接，内容会自动读取"/></label>:<section className="device-transfer-step"><h3>已有设备已批准这台设备</h3><p>接入后可使用：</p><ul className="device-permission-summary">{scopeGroups.map(group=>{const values=group.items.filter(([key])=>approvalPreview.scopes.includes(key));return values.length?<li key={group.title}>{values.map(([,name])=>name).join('、')}</li>:null;})}</ul><p>批准有效至 {new Date(approvalPreview.expiresAt*1000).toLocaleTimeString('zh-CN')}。</p><div className="button-row"><Button disabled={busy} onClick={()=>void run(async valid=>{const result=await handoff.acceptApproval(approvalPreview.packet,{confirmed:true});await finishConnection(result,valid);if(valid()&&!result.activated)setNotice('正在确认这次连接的结果。');})}><ShieldCheck size={16}/>连接这台设备</Button><Button variant="ghost" disabled={busy} onClick={()=>change({approval:''})}>更换批准链接</Button></div></section>}
     {approvalError&&<output className="message error">{approvalError}</output>}
    </div>}
    {subjectId&&canApprove&&tab==='approve'&&<div className="device-transfer-form">
     {!requestPreview?<label htmlFor="device-request-input">新设备发来的申请<Textarea id="device-request-input" value={input.request} maxLength={48000} onChange={event=>change({request:event.target.value,scopes:[],approved:null})} placeholder="粘贴申请链接，内容会自动读取"/></label>:<section className="device-transfer-step"><h3>批准自己的新设备</h3><p>请和新设备对照这串设备核对码：</p><code className="device-fingerprint">{fingerprint(requestPreview.fingerprint)}</code>
      <ul className="device-permission-summary">{scopeGroups.map(group=>{const values=group.items.filter(([key])=>input.scopes.includes(key));return values.length?<li key={group.title}>{values.map(([,name])=>name).join('、')}</li>:null;})}</ul>
      <ReadingDetails mode="inline" className="device-transfer-details"><ReadingSummary>调整这台设备的权限</ReadingSummary><div className="device-permission-groups">{scopeGroups.map(group=>{const values=group.items.filter(([key])=>requestPreview.scopes.includes(key));return values.length?<fieldset key={group.title}><legend>{group.title}</legend>{values.map(([key,title])=><label key={key}><input type="checkbox" disabled={key==='binding'||busy||!!input.approved} checked={input.scopes.includes(key)} onChange={event=>change({scopes:event.target.checked?[...input.scopes,key]:input.scopes.filter((item:string)=>item!==key)})}/>{title}</label>)}</fieldset>:null;})}</div>{requestPreview.scopes.filter((key:string)=>!scopeGroups.some(group=>group.items.some(item=>item[0]===key))).map((key:string)=><p key={key}>{scopeLabel(key)}</p>)}</ReadingDetails>
      <TransferDetails offer={requestPreview}/>
      {!input.approved&&<div className="button-row"><Button disabled={approveDisabled} onClick={()=>void run(async valid=>{const packet=readIdentityTransfer(input.request);if(packet.kind!=='request')throw Error('请重新读取申请。');const approved=await handoff.approveOffer(packet.value,{scopes:input.scopes,confirmed:true});if(valid())change({approved});})}>批准这台设备</Button><Button variant="ghost" disabled={busy} onClick={()=>change({request:'',scopes:[],approved:null})}>更换申请</Button></div>}
     </section>}
     {requestError&&<output className="message error">{requestError}</output>}
     {input.approved&&<div className="device-transfer-step"><h3>{approvalCompleted?'这次连接已完成':approvalWaiting?'正在确认这次连接':approvalState?.state==='canceled'?'这次申请已取消':canCopyApproval?'把批准带回新设备':'这份批准已到期'}</h3><p>{approvalCompleted?'新设备已完成这次连接，当前使用状态可以在“我的设备”中查看。':approvalWaiting?'正在读取这份原申请的处理结果。':canCopyApproval?'新设备打开或粘贴这份链接，确认后即可连接。':'需要时在新设备重新发起申请。'}</p>{approvalReadError&&<output>{approvalReadError}</output>}{canCopyApproval&&<Button disabled={busy} onClick={()=>copyTransfer(input.approved)}><Copy size={16}/>复制批准链接</Button>}<Button variant="ghost" disabled={busy} onClick={()=>change({request:'',scopes:[],approved:null})}>处理另一份申请</Button></div>}
    </div>}
   </div>}
  </section>
  {draftPreview&&<section className="device-draft-choice"><h3>继续登录前写的求助</h3>{draftPreview.existingDraft?<><p>这个身份也有一份草稿，请选择接下来编辑的内容。</p><div className="device-draft-comparison">{[{value:draftPreview.visitorDraft,label:'登录前的草稿'},{value:draftPreview.existingDraft,label:'当前身份的草稿'}].map(({value,label})=><div key={label}><h4>{label}</h4><strong>{literalTaskText(value?.title)||'尚未填写标题'}</strong><p>{literalTaskText(value?.goal)||literalTaskText(value?.summary)||literalTaskText(value?.situation)||'还没有填写独立说明'}</p></div>)}</div></>:<><strong>{literalTaskText(draftPreview.visitorDraft?.title)||'尚未填写标题'}</strong><p>{literalTaskText(draftPreview.visitorDraft?.goal)||literalTaskText(draftPreview.visitorDraft?.summary)||'可以继续补充独立说明，来源材料回原稿核对。'}</p></>}
   <div className="button-row"><Button disabled={busy} onClick={()=>void run(async()=>{const result=await runtime.visitorDrafts.adopt(draftPreview,{confirmed:true});if(result.currentIdentityChanged)throw Error('草稿已放入原身份，当前身份已变化，请重新查看。');navigate('/app/publish');})}>{draftPreview.existingDraft?'用登录前的草稿继续':'继续编辑'}</Button><Button variant="ghost" onClick={()=>{dismissedDraft.current=draftKey(draftPreview);setDraftPreview(null);if(draftPreview.existingDraft)navigate('/app/publish');}}>{draftPreview.existingDraft?'继续当前身份的草稿':'稍后处理'}</Button></div>{draftPreview.existingDraft&&<p className="device-muted">采用登录前的草稿会替换当前身份的这份草稿；登录前的原稿保留。</p>}
  </section>}
 </section>;
}
