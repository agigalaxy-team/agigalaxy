import React,{useEffect,useMemo,useSyncExternalStore} from 'react';
import {Button} from '@/components/ui/button';
import {agentIdentityErrorCode,createAgentIdentityView} from './agent-identity-view';
import type {AgentIdentityEntry,AgentIdentityRuntime} from './agent-identity-view';
import {AgentConnectionSummary,AgentDraftSummary} from './agent-identity-presentation';

const messages:Record<string,string>={
 agent_handoff_entry_invalid:'这份接续入口不完整。请回到本机 Agent 的审阅页重新打开官网。',
 agent_handoff_opener_lost:'与本机审阅页的窗口连接已断开。原申请仍保存在这台设备，请先核对原结果。',
 agent_handoff_expired:'这次接续入口已到期。原申请和本机身份材料仍保留，请回到本机审阅页重新核对。',
 agent_handoff_native_stopped:'本机审阅页已停止本次传递。已提交的设备授权需要按原申请查询。',
 agent_handoff_native_error:'本机审阅页未能继续这次接续。请回到该页面查看当前状态。',
 agent_handoff_existing_device_mismatch:'本浏览器保存的身份或设备与本次接续不一致，或已不在当前授权中。原身份材料仍保留，请回到本机审阅页核对两边的身份与设备。',
 agent_handoff_stopped:'已停止本页自动接续。此操作不会撤销已经提交的设备授权。',
 agent_handoff_original_result_pending:'本浏览器保存了尚待核对的原申请。请先查询该申请，避免另开一次授权。',
 device_identity_switch_required:'本浏览器已保存另一个银河身份。本次接续不会覆盖它，请使用未保存其他身份的浏览器窗口。',
 agent_handoff_browser_identity_changed:'本浏览器当前身份已经改变，原接续已停止。请重新核对当前身份与原申请。',
 agent_handoff_control_changed:'原身份的当前控制已变化。请回到本机 Agent 重新核对后打开官网。',
 agent_handoff_device_not_current:'相应设备已不在当前有效授权中。请在已有设备核对当前控制。',
 agent_handoff_scopes_changed:'当前设备权限未覆盖本次接续范围。请回到本机 Agent 核对需要的权限。',
 agent_handoff_proof_invalid:'无法验证本机 Agent 对这次接续的签名。没有继续加入设备。',
 agent_handoff_proof_changed:'本机接续说明与签名不一致。没有继续加入设备。',
 agent_handoff_context_invalid:'本机接续说明与当前官网、服务或原目标不一致。没有继续加入设备。',
 device_approval_expired:'这次设备批准已到期。请核对原申请后再由已有设备批准。',
 device_approval_control_changed:'设备批准所依据的身份控制已变化。请在已有设备重新核对。',
 receipt_status_authority_changed:'当前身份或连接已经改变，本次接续已停止。请核对原申请。',
 device_handoff_owner_changed:'当前浏览器已选择其他设备。原申请仍保留，请重新查看当前设备后继续。',
 device_local_selection_changed:'本机设备或原批准已改变。原申请仍保留，请重新查看后继续。',
 device_authorization_no_longer_current:'这台设备的授权已失效。请回到自己的管理设备核对后继续。',
 local_atomic_update_unavailable:'本机存储暂不能安全切换设备。原身份和申请仍保留，请稍后重试。',
};
const phaseText:Record<string,string>={waiting:'正在等待本机 AI 的连接说明…','verifying-native':'正在核对本机 AI 的身份与当前设备权限…',preparing:'正在准备这台浏览器的连接申请…','awaiting-approval':'请在本机 AI 的连接页面，核对这台浏览器的设备核对码与使用范围后批准。',accepting:'正在确认已有设备的批准，并连接这台浏览器…',connecting:'正在连接原银河身份…',connected:'已连接原银河身份。'};
const readable=(reason:unknown)=>messages[agentIdentityErrorCode(reason)]??'此次接续未完成。原申请和本机身份材料仍保留，请先查询原结果。';
type Props={
 runtime:AgentIdentityRuntime|null;entry:AgentIdentityEntry;
 identity?:{subjectId:string;deviceId:string}|null;
 connection?:{bindingId?:string;generation?:number}|null;
 navigate:(path:string)=>void;onChange:()=>void|Promise<void>;onManual:()=>void;
};

export function AgentIdentityWorkspace({runtime,entry,identity,connection,navigate,onChange,onManual}:Props){
 const view=useMemo(()=>createAgentIdentityView(runtime,entry,readable),[runtime,entry]);
 const {handoff:state,draft,error,busy}=useSyncExternalStore(view.subscribe,view.snapshot,view.snapshot);
 useEffect(()=>{view.setCallbacks({navigate,onChange,onManual});},[view,navigate,onChange,onManual]);
 useEffect(()=>{view.start();return view.close;},[view]);
 useEffect(()=>{view.verifyCurrent();},[view,identity?.subjectId,identity?.deviceId,connection?.bindingId,connection?.generation]);
 const stopped=['stopped','expired'].includes(state.phase),context=state.context,selection=state.localDeviceSelection;
 const draftVisible=draft&&(identity===undefined||identity?.subjectId===draft.subjectId&&identity?.deviceId===draft.deviceId);
 return <section className="identity-device-workspace agent-identity-workspace" aria-labelledby="agent-identity-heading">
  <h2 id="agent-identity-heading">在浏览器继续使用原身份</h2>
  <p>把本机 AI 使用的银河身份接到当前浏览器。需要批准时，请在本机 AI 的连接页面完成；连接后会回到刚才的页面。</p>
  {!runtime&&<output className="message">正在准备当前官网的连接工具…</output>}
  {phaseText[state.phase]&&<output className="message">{phaseText[state.phase]}</output>}
  {state.additionalDeviceApproval&&state.phase==='awaiting-approval'&&<p className="browse-note">当前浏览器设备缺少本次所需的权限。请在本机 AI 的连接页面批准新设备；原身份与草稿会保留。</p>}
  {context&&<AgentConnectionSummary context={selection?{...context,scopes:selection.scopes}:context} deviceFingerprint={state.fingerprint} approved={!!selection}/>}
  {selection&&!stopped&&<section className="agent-device-selection" aria-labelledby="agent-device-selection-heading"><h3 id="agent-device-selection-heading">使用已获准的设备继续</h3>
   <p>本机 AI 已批准这次连接。继续后，这个浏览器会改用获准的新设备，接着打开刚才的页面；银河身份、原设备记录和已有草稿保留。</p>
   <details className="agent-exact-connection"><summary>查看本次设备变化</summary><dl><dt>原浏览器设备</dt><dd><code>{selection.previousDeviceId}</code></dd><dt>获准的新设备</dt><dd><code>{selection.deviceId}</code></dd></dl></details>
   <Button disabled={busy||state.phase!=='choose-device'} onClick={()=>void view.selectLocalDevice()}>{state.phase==='selecting-device'?'正在接续…':'使用这个设备继续'}</Button>
  </section>}
  {stopped&&<p className="message error" role="alert">{messages[state.code??'']??readable({code:state.code})}</p>}
  {error&&<p className="message error" role="alert">{error}</p>}
  {draftVisible&&<article className="agent-draft-choice"><h3>继续连接前的求助草稿</h3><p>原稿继续留在本浏览器。继续这份草稿会把它保存到当前身份下，下一页仍可编辑，不会立即发布。</p>
   <AgentDraftSummary value={draft.preview.visitorDraft??{}} title="连接前填写的草稿"/>
   {draft.preview.existingDraft&&<details className="agent-existing-draft" open><summary>当前身份还留有另一份草稿</summary><AgentDraftSummary value={draft.preview.existingDraft} title="当前身份的草稿"/><p>改用连接前的草稿会替换上面这份当前身份草稿，请选择需要继续的内容。</p></details>}
   <div className="button-row"><Button disabled={busy} onClick={()=>void view.adopt()}>{draft.preview.existingDraft?'改用连接前的草稿':'继续这份草稿'}</Button><Button variant="outline" disabled={busy} onClick={view.keep}>{draft.preview.existingDraft?'继续当前身份的草稿':'先回原页面'}</Button></div>
  </article>}
  {!stopped&&state.phase!=='connected'&&<Button variant="outline" onClick={view.cancel}>停止本次自动接续</Button>}
  {stopped&&<div className="button-row"><Button variant="outline" onClick={view.manual}>查看本浏览器保存的原申请</Button><Button variant="ghost" onClick={view.returnToOrigin}>保留申请，回到原目标</Button></div>}
 </section>;
}
