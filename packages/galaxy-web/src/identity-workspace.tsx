import React, {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';

type Props={runtime:any;subjectId?:string;connected?:boolean;navigate:(path:string)=>void;onChange?:()=>void|Promise<void>};
const readable=(error:any)=>({device_request_invalid:'连接申请不完整，或不属于当前服务。请复制新设备显示的完整申请。',
 device_request_not_owned:'这份批准不属于本浏览器保存的新设备申请。请回到生成申请的浏览器。',
 device_approval_expired:'这次批准已过期。取消本机申请后重新生成，再由旧设备批准。',
 device_approval_control_changed:'身份控制已经变化。请在旧设备重新核对，不能继续使用旧批准。',
 device_identity_switch_required:'本浏览器已有另一个银河身份。此流程不会直接覆盖它。',
 device_controller_not_authorized:'当前设备没有管理身份的权限。请使用已授权的旧设备或恢复码。',
 device_authorization_no_longer_current:'此设备授权已经失效，不能凭历史成功回执重新启用。',
 local_draft_changed:'草稿已经在别处更改。请重新查看两份草稿后选择。'} as Record<string,string>)[error?.code]??error?.message??'未取得操作结果，请保留原申请并查询。';

export function IdentityWorkspace({runtime,subjectId,navigate,onChange}:Props){
 const [existingId,setExistingId]=useState(''),[requestText,setRequestText]=useState(''),[approvalText,setApprovalText]=useState('');
 const [requestPreview,setRequestPreview]=useState<any>(null),[approvalPreview,setApprovalPreview]=useState<any>(null),[signedApproval,setSignedApproval]=useState<any>(null);
 const [selectedScopes,setSelectedScopes]=useState<string[]>([]),[pending,setPending]=useState<any>(null),[draftPreview,setDraftPreview]=useState<any>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const working=useRef(false),generation=useRef(0),handoff=runtime?.deviceHandoff;
 async function refresh(){const lease=generation.current;const [operation,draft]=await Promise.all([handoff?.pending(),runtime?.visitorDrafts?.preview()]);
  const shown=operation?{...operation,fingerprint:(await handoff.previewOffer(operation.offer)).fingerprint}:null;
  if(lease===generation.current){setPending(shown);setDraftPreview(draft??null);}}
 useEffect(()=>{generation.current++;setRequestPreview(null);setApprovalPreview(null);setSignedApproval(null);setDraftPreview(null);setPending(null);setRequestText('');setApprovalText('');
  const token=generation.current;const reload=()=>{if(document.visibilityState!=='visible'||working.current)return;void refresh().catch(reason=>{if(generation.current===token)setError(readable(reason));});};
  void refresh().catch(reason=>setError(readable(reason)));const timer=window.setInterval(reload,15000);const onVisible=()=>reload();document.addEventListener('visibilitychange',onVisible);
  return()=>{generation.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};},[runtime,subjectId]);
 async function run(action:()=>Promise<void>){if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');const lease=generation.current;
  try{await action();if(lease===generation.current){await refresh();await onChange?.();}}
  catch(reason){if(lease===generation.current){setError(readable(reason));await refresh().catch(()=>{});}}
  finally{working.current=false;if(lease===generation.current)setBusy(false);}}
 async function copy(value:any){await navigator.clipboard.writeText(JSON.stringify(value));setNotice('已复制。只粘贴到你自己的另一台设备的对应输入框。');}
 if(!runtime||!handoff)return <section><h2>已有设备确认</h2><p>身份连接工具尚未就绪，请稍后再试。</p></section>;
 return <section className="identity-device-workspace">
  <h2>用已有设备继续同一身份</h2><p>新浏览器保留自己的设备钥，旧设备批准所选权限。此过程不会消耗恢复码，不搬运旧设备的私有文件。</p>
  {error&&<div className="message error" role="alert">{error}</div>}{notice&&<p className="message" role="status">{notice}</p>}
  {!subjectId&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(async()=>{await handoff.createOffer(existingId.trim(),{confirmed:true});setNotice('申请已留在本机。复制到已有设备的“批准自己的新设备”。');});}}>
   <label htmlFor="identity-existing-guid">我已有的银河 ID<Input id="identity-existing-guid" required pattern="GUID[A-Z0-9]{28}" value={existingId} onChange={event=>setExistingId(event.target.value.trim())}/></label>
   <Button type="submit" disabled={busy||!!pending&&pending.state!=='canceled'&&pending.state!=='committed'}>生成本机连接申请</Button>
  </form>}
  {pending&&pending.state!=='canceled'&&<article className="task-card"><h3>本机连接申请</h3><p>身份 <code>{pending.offer.subjectId}</code></p><p>服务 {pending.offer.endpoint}</p><p>设备 <code>{pending.offer.deviceId}</code></p><p>在旧设备核对同一公钥指纹：<code>{pending.fingerprint}</code></p>
   <label htmlFor="identity-public-request">复制给已有设备的公开申请<Textarea id="identity-public-request" readOnly value={JSON.stringify(pending.offer)}/></label>
   <div className="button-row"><Button type="button" variant="outline" onClick={()=>void run(()=>copy(pending.offer))}>复制公开申请</Button>
    {pending.approval&&<Button type="button" disabled={busy} onClick={()=>void run(async()=>{const result=await handoff.reconcile(pending.operationId);setNotice(result.activated?'同一身份的设备授权已确认，请连接服务后继续原目标。':`当前申请状态：${result.receipt.state}`);})}>只查询原申请结果</Button>}
    {pending.approval&&pending.state!=='committed'&&<Button type="button" variant="outline" disabled={busy} onClick={()=>void run(async()=>{await handoff.reconcile(pending.operationId,{retry:true,confirmed:true});setNotice('原申请已处理，请按当前状态继续。');})}>重试同一申请</Button>}
    {pending.state!=='committed'&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>void run(async()=>{const result=await handoff.cancel(pending.operationId,{confirmed:true});setNotice(result.receipt.state==='committed'?'服务已完成设备授权，无法把此次申请显示为已取消。':result.receipt.localOnly?'已停止本机申请；尚未签署新设备提交证明。':'服务已确认取消或到期。');})}>取消这次申请</Button>}
   </div>
   {pending.state!=='committed'&&<form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(async()=>{setApprovalPreview(await handoff.previewApproval(approvalText));});}}>
    <label htmlFor="identity-old-device-approval">粘贴旧设备返回的批准<Textarea id="identity-old-device-approval" required maxLength={24000} value={approvalText} onChange={event=>{setApprovalText(event.target.value);setApprovalPreview(null);}}/></label>
    <Button type="submit" variant="outline" disabled={busy}>核对批准内容</Button>
    {approvalPreview&&<div className="message"><p>将以本机设备加入 {approvalPreview.subjectId}，授权范围：{approvalPreview.scopes.join('、')}。</p><p>本机公钥指纹 <code>{approvalPreview.fingerprint}</code></p><Button type="button" disabled={busy} onClick={()=>void run(async()=>{const result=await handoff.acceptApproval(approvalText,{confirmed:true});setNotice(result.activated?'设备已授权，同一银河身份可以连接使用。':'结果尚待确认，请查询原申请。');setApprovalText('');setApprovalPreview(null);})}>确认用本机钥加入同一身份</Button></div>}
   </form>}
  </article>}
  {subjectId&&<details className="room-settings"><summary>批准自己的新设备</summary><form className="workspace-form" onSubmit={event=>{event.preventDefault();void run(async()=>{const preview=await handoff.previewOffer(requestText);if(preview.subjectId!==subjectId)throw new Error('申请中的银河 ID 与当前身份不同。');setRequestPreview(preview);setSelectedScopes(preview.scopes);setSignedApproval(null);});}}>
   <label htmlFor="identity-new-device-request">新设备的公开连接申请<Textarea id="identity-new-device-request" required maxLength={24000} value={requestText} onChange={event=>{setRequestText(event.target.value);setRequestPreview(null);setSignedApproval(null);}}/></label>
   <Button type="submit" variant="outline" disabled={busy}>查看设备与申请范围</Button>
   {requestPreview&&<div className="message"><p>核对新设备显示的公钥指纹：<code>{requestPreview.fingerprint}</code></p><p>只批准你正在使用的新设备。对方发来的普通登录请求不代表它属于你。</p>
    {requestPreview.scopes.map((scope:string)=><label key={scope}><input type="checkbox" disabled={scope==='binding'||busy||!!signedApproval} checked={selectedScopes.includes(scope)} onChange={event=>setSelectedScopes(event.target.checked?[...selectedScopes,scope]:selectedScopes.filter(item=>item!==scope))}/>{scope==='manage-identity'?'允许管理自己的设备与恢复设置':scope==='binding'?'连接所选银河服务（必需）':scope}</label>)}
    <Button type="button" disabled={busy||!!signedApproval} onClick={()=>void run(async()=>{setSignedApproval(await handoff.approveOffer(requestText,{scopes:selectedScopes,confirmed:true}));setNotice('已签署所选设备与范围。将批准复制回新设备；新设备确认持钥并提交后才会生效。');})}>确认批准所选设备权限</Button>
   </div>}
   {signedApproval&&<div><p>这份批准需要在挑战期限内复制回新设备。超时不会自动授权，请重新开始申请。</p><label htmlFor="identity-return-approval">返回新设备的批准<Textarea id="identity-return-approval" readOnly value={JSON.stringify(signedApproval)}/></label><Button type="button" variant="outline" onClick={()=>void run(()=>copy(signedApproval))}>复制批准</Button></div>}
  </form></details>}
  {draftPreview&&<article className="task-card"><h3>登录前留下的任务草稿</h3><p>采纳后放入当前银河身份的本机草稿，仍需另行确认发布。访客原稿保留。</p>
   <p>访客草稿：<strong>{draftPreview.visitorDraft.title||'尚未填写标题'}</strong></p><p>{draftPreview.visitorDraft.summary||'尚未填写摘要'}</p><p>目标：{draftPreview.visitorDraft.goal||'未填写'}</p><p>当前情况：{draftPreview.visitorDraft.situation||'未填写'}</p><p>发布意向：{draftPreview.visitorDraft.intent} · 计划可见范围：{draftPreview.visitorDraft.visibility}</p>
   {draftPreview.existingDraft&&<details><summary>当前身份已有草稿：{draftPreview.existingDraft.title||'尚未填写标题'}</summary><p>选择采纳会覆盖这份当前草稿，请先保存需要保留的内容。</p><p>{draftPreview.existingDraft.summary}</p><p>目标：{draftPreview.existingDraft.goal}</p><p>当前情况：{draftPreview.existingDraft.situation}</p><p>发布意向：{draftPreview.existingDraft.intent} · 计划可见范围：{draftPreview.existingDraft.visibility}</p></details>}
   <div className="button-row"><Button type="button" disabled={busy} onClick={()=>void run(async()=>{const result=await runtime.visitorDrafts.adopt(draftPreview,{confirmed:true});if(result.currentIdentityChanged)throw new Error('原身份的草稿已采纳，当前身份已改变，请重新查看。');navigate('/app/publish');})}>{draftPreview.existingDraft?'确认用访客草稿替换当前草稿':'采纳并继续编辑'}</Button><Button type="button" variant="ghost" onClick={()=>setDraftPreview(null)}>暂不采纳</Button></div>
  </article>}
 </section>;
}
