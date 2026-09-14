import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FactWorkspace } from './fact-workspace';
import { ContextWorkspace } from './context-workspace';
import { TaskContactWorkspace } from './task-contact-workspace';
import { RequesterFeedback } from './requester-feedback';
import {qualificationEvaluationView} from './task-bounty-client.mjs';
import {ApplicationTerms,QualificationSummary} from './task-application';
import {localDateTime,taskWriteError} from './task-bounty-client.mjs';

const roles: Record<string, string> = { diagnosis: '诊断', advice: '建议', context: '补充背景', tool: '引入工具', patch: '补丁', review: '复核', verification: '验证', takeover: '接管', 'main-responsible': '主要负责人' };
const states: Record<string, string> = { 'awaiting-counterparty': '等待参与者确认', active: '正在参与', declined: '已婉拒', withdrawn: '已退出', delivered: '已有交付', accepted: '交付已验收', disputed: '存在争议', closed: '本次参与已结束' };
export function TaskCollaboration({ task, runtime, subjectId, connected, navigate, refresh }: any) {
  const [recipient, setRecipient] = useState(''), [note, setNote] = useState(''), [proposal, setProposal] = useState<any>(null);
  const [action, setAction] = useState<any>(null), [reason, setReason] = useState(''), [scope, setScope] = useState(''), [role, setRole] = useState('advice');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const working = useRef(false);
  const [qualification,setQualification]=useState<any>(null),[extension,setExtension]=useState('');
  const requester = task.requesterId === subjectId;
  const enrollmentOpen=task.enrollmentOpen??(task.state==='open'&&task.request.enrollmentExpiresAt>Date.now()/1000);
  async function run(fn: () => Promise<any>) {
    if (working.current) return;
    working.current=true; setBusy(true); setError(''); setNotice('');
    let committed=false;
    try { await fn(); committed=true; await refresh(); }
    catch (e: any) {
      if (committed) setNotice('这一步已经收到服务回执，但最新任务状态暂时未刷新；请稍后刷新或查询原操作，不要重复提交。');
      else setError(taskWriteError(e));
    } finally { working.current=false; setBusy(false); }
  }
  async function participationEvent(participant: any, event: any) {
    return runtime.participationEvent(task.taskId, participant.participationId, { expectedParticipationVersion: participant.version, ...event },
      { confirmed: true, viewers: [...new Set([participant.subjectId, task.requesterId])] });
  }
  const choose = (kind: string, participant?: any, extra: any = {}) => { setAction({ kind, participant, ...extra }); setReason(''); };
  async function commitAction() {
    const { kind, participant } = action;
    if (participant) {
      const event: any = { kind };
      if (kind === 'confirm') event.scopeVersion = participant.scopeVersion;
      if (['decline', 'withdraw', 'dispute', 'decline-scope'].includes(kind)) event.reason = reason;
      if (['confirm-scope', 'decline-scope'].includes(kind)) event.proposalId = participant.pendingScope.eventId;
      if (kind === 'accept') { event.deliveryId = action.deliveryId; event.summary = reason; }
      if (kind === 'propose-scope') { event.scopeVersion = participant.scopeVersion + 1; event.agreedScope = scope; event.reason = reason; }
      if (kind === 'propose-resolution') { event.summary = reason; event.outcome = action.outcome; }
      if (kind === 'confirm-resolution') event.proposalId = participant.disputeResolution.eventId;
      await participationEvent(participant, event);
    } else {
      const event: any = { kind, expectedTaskVersion: task.version };
      if (kind === 'invitation-reply') { event.invitationId = action.invitationId; event.response = action.response; event.message = reason; }
      else { event.reason = reason; if (action.applicationId) event.applicationId = action.applicationId; if (action.invitationId) event.invitationId = action.invitationId; }
      await runtime.taskEvent(task.taskId, event, { confirmed: true, viewers: [...new Set([task.requesterId, ...(action.recipientId ? [action.recipientId] : [])])] });
    }
    setAction(null); setNotice('已记录这一步。其他参与者、房间成员和整体解决状态不会自动改变。');
  }
  if (task.schemaVersion !== 2 || !connected) return null;
  return <section className="task-collaboration"><h2>协作进程</h2>
    {error && <div className="message error" role="alert">{error}</div>}{notice && <div className="message" role="status">{notice}</div>}
    <TaskContactWorkspace key={`contacts:${task.taskId}:${subjectId}`} task={task} runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} refresh={refresh}/>
    {requester && <>
      <details><summary>按已知银河 ID 单独联系</summary><form className="workspace-form" onSubmit={e => { e.preventDefault(); run(async () => { await runtime.taskEvent(task.taskId, { kind: 'invite', expectedTaskVersion: task.version, recipientId: recipient, note, expiresAt: Math.min(task.request.enrollmentExpiresAt,Math.floor(Date.now() / 1000) + 7 * 86400) }, { confirmed: true, viewers: [...new Set([task.requesterId, recipient])] }); setRecipient(''); setNote(''); setNotice('邀请已发出，对方回应后再确认实际参与范围。'); }); }}>
        <h3>联系合适的参与者</h3><label>银河 ID<Input required pattern="GUID[A-Z0-9]{28}" value={recipient} onChange={e => setRecipient(e.target.value.trim())}/></label><label>你希望获得什么帮助<Textarea required maxLength={1500} value={note} onChange={e => setNote(e.target.value)}/></label>
        <Button type="submit" disabled={busy||!enrollmentOpen}>确认发送邀请</Button><p className="muted">建议清单不等于邀请记录。邀请期限为七天与本任务征集截止中较早者；公开额度与未回应冷却仍适用。</p>
      </form></details>
      <h2>实际申请与回应</h2><p>这里来自真实申请和邀请回应。建议不是已发送邀请，愿意了解也不等于正式承接。</p>
      {task.contacts?.responses.applications.map((application: any) => <article className="task-card" key={application.applicationId}><h3>{application.proposal}</h3><p>{application.scope}</p><code>{application.subjectId}</code><ApplicationTerms application={application} request={task.request}/><div className="button-row"><Button variant="outline" disabled={busy || application.state!=='pending'||!enrollmentOpen} onClick={() => { setProposal(application); setScope(application.scope); }}>拟定此人的参与范围</Button>{task.request.qualification&&<Button variant="outline" disabled={busy} onClick={()=>run(async()=>{const modern=task.request.qualification.profile==='facts-v2';const input=modern?{taskId:task.taskId,subjectId:application.subjectId,evidence:application.qualificationEvidence,includeSimulation:false}:{...task.request.qualification,capabilityId:task.request.capabilityId,subjectId:application.subjectId,evidence:application.qualificationEvidence};if(!modern)delete input.profile;const result=await runtime.api.call(modern?'/v2/qualification/evaluate':'/v1/qualification/evaluate',input,{authenticated:true});setQualification({applicationId:application.applicationId,value:qualificationEvaluationView(result)});})}>核对此人的本任务资格</Button>}</div>{qualification?.applicationId===application.applicationId&&<QualificationSummary value={qualification.value}/>}</article>)}
      {task.contacts?.responses.invitations.filter((invite:any)=>invite.state==='interested').map((invite:any)=><article className="task-card" key={'scope:'+invite.invitationId}><p>{invite.recipientId} 已表示愿意了解；这仍不是正式承接。</p>{task.request.qualification?<p>请对方通过申请选择本任务资格材料与报价，再拟定明确参与范围。</p>:<Button variant="outline" disabled={busy||!enrollmentOpen} onClick={()=>{setProposal({subjectId:invite.recipientId});setScope('');}}>向此人提出明确参与范围</Button>}</article>)}
      {proposal && <form className="workspace-form" onSubmit={e => { e.preventDefault(); run(async () => { await runtime.proposeParticipation(task.taskId, { subjectId: proposal.subjectId, applicationId: proposal.applicationId, expectedTaskVersion: task.version, role, agreedScope: scope }, { confirmed: true }); setProposal(null); }); }}><h3>提出参与安排</h3>{proposal.applicationId&&<ApplicationTerms application={proposal} request={task.request}/>}<p className="muted">{proposal.subjectId}，对方明确确认后才开始。本安排独立于其他人。</p><label>介入职责<select value={role} onChange={e => setRole(e.target.value)}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>明确范围<Textarea required maxLength={1500} value={scope} onChange={e => setScope(e.target.value)}/></label><div className="button-row"><Button type="submit" disabled={busy||!enrollmentOpen}>发送参与提议</Button><Button type="button" variant="ghost" onClick={() => setProposal(null)}>取消编辑</Button></div></form>}
    </>}
    {task.contacts?.responses.invitations.map((invite: any) => <article className="task-card" key={invite.invitationId}><h3>任务邀请</h3><p>{invite.note}</p><p className="muted">接收身份：{invite.recipientId}</p><div className="button-row">{!requester && invite.recipientId === subjectId && !['revoked', 'expired', 'declined'].includes(invite.state) && [['question', '先问清楚'], ['interested', '愿意了解'], ['declined', '婉拒']].map(([response, label]) => <Button variant="outline" key={response} onClick={() => choose('invitation-reply', null, { invitationId: invite.invitationId, response })}>{label}</Button>)}
      {requester && !['revoked', 'expired'].includes(invite.state) && <Button variant="ghost" onClick={() => choose('revoke-invitation', null, { invitationId: invite.invitationId, recipientId: invite.recipientId })}>撤回邀请</Button>}</div></article>)}
    {!requester && task.contacts?.responses.applications.filter((application: any) => application.subjectId === subjectId && application.state==='pending').map((application: any) => <Button key={application.applicationId} variant="ghost" onClick={() => choose('withdraw-application', null, { applicationId: application.applicationId })}>撤回我的申请</Button>)}
    <div className="result-list">{task.participations?.map((participant: any) => <article className="task-card" key={participant.participationId}><span className="tag">{states[participant.state] ?? participant.state}</span><h3>{roles[participant.role] ?? participant.role}</h3><code>{participant.subjectId}</code><p>{participant.agreedScope ?? '此范围资料当前不可读取。'}</p>{participant.applicationId&&task.contacts?.responses.applications.find((a:any)=>a.applicationId===participant.applicationId)&&<ApplicationTerms application={task.contacts.responses.applications.find((a:any)=>a.applicationId===participant.applicationId)} request={task.request}/>}<p className="muted">参与范围版本 {participant.scopeVersion}；不同参与者分别记录贡献与结果。</p>
      <div className="button-row">{participant.subjectId === subjectId && participant.state === 'awaiting-counterparty' && <><Button disabled={busy} onClick={() => choose('confirm', participant)}>确认按此范围参与</Button><Button variant="outline" onClick={() => choose('decline', participant)}>婉拒参与</Button></>}
        {participant.subjectId === subjectId && ['active', 'delivered', 'accepted', 'disputed'].includes(participant.state) && <Button variant="outline" onClick={() => choose('withdraw', participant)}>退出这次参与</Button>}
        {requester && ['active', 'delivered', 'accepted'].includes(participant.state) && !participant.pendingScope && <Button variant="outline" onClick={() => { setScope(participant.agreedScope ?? ''); choose('propose-scope', participant); }}>提议调整范围</Button>}
        {participant.confirmedAt && !['declined', 'awaiting-counterparty', 'disputed'].includes(participant.state) && <Button variant="ghost" onClick={() => choose('dispute', participant)}>提出具体争议</Button>}
      </div>
      {participant.pendingScope && <div className="message"><p>待确认的新范围：{participant.pendingScope.agreedScope}</p><p>{participant.pendingScope.reason}</p>{participant.subjectId === subjectId && <div className="button-row"><Button onClick={() => choose('confirm-scope', participant)}>接受新范围</Button><Button variant="outline" onClick={() => choose('decline-scope', participant)}>维持原范围</Button></div>}</div>}
      {participant.deliveries.map((delivery: any) => <article key={delivery.deliveryId}><h4>交付</h4><p>{delivery.summary ?? '交付来源当前不可读取。'}</p>
        <details><summary>所引实际结果与多方贡献版本</summary><p>结果：{delivery.resultRef ? `${delivery.resultRef.id} / 版本 ${delivery.resultRef.version}` : '当前来源不可读取'}</p>
          <p>介入：{(delivery.interventionRefs ?? []).map((ref: any)=>`${ref.id} / 版本 ${ref.version}`).join('；') || '未选择'}</p>
          <p>证据：{(delivery.evidenceRefs ?? []).map((ref: any)=>typeof ref==='string'?`${ref} / 历史第一版`:`${ref.id} / 版本 ${ref.version}`).join('；') || '未选择'}</p>
          <p className="muted">原作者在下方工作记录中分别显示。任何单份交付都不会获得其他作者的归属。</p></details>
        <p className="muted">{delivery.acceptance ? '发起者已验收此交付；独立验证与整体解决另行记录。' : '尚未验收。'}</p>{delivery.acceptance?.summary && <p>请求者意见：{delivery.acceptance.summary}</p>}
        {requester && !delivery.acceptance && <Button variant="outline" onClick={() => choose('accept', participant, { deliveryId: delivery.deliveryId })}>记录我的验收意见</Button>}</article>)}
      {participant.dispute && <div className="message"><h4>争议</h4><p>{participant.dispute.reason}</p>{participant.state === 'disputed' && <div className="button-row"><Button variant="outline" onClick={() => choose('propose-resolution', participant, { outcome: 'resume-work' })}>提议解决争议后继续</Button><Button variant="outline" onClick={() => choose('propose-resolution', participant, { outcome: 'close' })}>提议结束本次参与</Button></div>}</div>}
      {participant.disputeResolution && <div className="message"><p>{participant.disputeResolution.summary}</p>{participant.state === 'disputed' && participant.disputeResolution.actorId !== subjectId && <Button onClick={() => choose('confirm-resolution', participant)}>确认对方提出的处理办法</Button>}</div>}
      <RequesterFeedback runtime={runtime} task={task} participant={participant} subjectId={subjectId} connected={connected} onChanged={refresh}/>
    </article>)}</div>
    <FactWorkspace key={`facts:${task.taskId}:${subjectId}`} task={task} runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} refresh={refresh}/>
    <ContextWorkspace key={`context:${task.taskId}:${subjectId}`} task={task} runtime={runtime} subjectId={subjectId} connected={connected}/>
    <TaskContactWorkspace key={`task-rooms:${task.taskId}:${subjectId}`} section="rooms" task={task} runtime={runtime} subjectId={subjectId} connected={connected} navigate={navigate} refresh={refresh}/>
    <div className="button-row"><Button variant="outline" disabled={busy} onClick={() => run(async () => { const room = await runtime.chat.create({ title: task.request.title, taskRefs: [task.taskId] }, { confirmed: true }); navigate(`/app/rooms/${room.roomId}`); })}>为此任务建立讨论房间</Button>
      {requester && task.state === 'open' && <><Button variant="ghost" onClick={() => choose('close')}>结束征集</Button><Button variant="ghost" onClick={() => choose('cancel')}>取消任务</Button></>}</div>
    {requester&&task.state==='open'&&<form className="workspace-form" onSubmit={e=>{e.preventDefault();run(async()=>{const deadline=Math.floor(Date.parse(extension)/1000);if(!Number.isSafeInteger(deadline)||deadline<=Math.max(task.request.enrollmentExpiresAt,Date.now()/1000))throw Error('新的征集截止必须晚于当前截止和现在。');await runtime.taskEvent(task.taskId,{kind:'extend-enrollment',expectedTaskVersion:task.version,enrollmentExpiresAt:deadline},{confirmed:true,viewers:[task.requesterId]});setExtension('');setNotice('征集时间已明确延长；原有参与范围与交付时间未自动修改。');});}}><h3>延长征集</h3><p>仅延长新申请与参与安排的征集窗口，不修改已有人的交付约定。</p><label>新的征集截止（本机时区）<Input required type="datetime-local" min={localDateTime(Math.max(task.request.enrollmentExpiresAt,Date.now()/1000)+60)} value={extension} onChange={e=>setExtension(e.target.value)}/></label><Button type="submit" disabled={busy}>确认延长征集</Button></form>}
    {action && <form className="workspace-form message" onSubmit={e => { e.preventDefault(); run(commitAction); }}><h3>确认本次选择</h3><p>{action.kind === 'confirm' ? '接受所列参与职责和范围，成为本次实际参与者。' : action.kind === 'confirm-scope' ? '接受对方提出的新范围，旧范围仍作为历史保留。' : action.kind === 'confirm-resolution' ? '确认对方所述争议处理结果。' : '请填写具体说明，这一步只改变对应邀请、申请或参与。'}</p>
      {action.kind === 'propose-scope' && <label>新的范围<Textarea required maxLength={1500} value={scope} onChange={e => setScope(e.target.value)}/></label>}
      {!['confirm', 'confirm-scope', 'confirm-resolution'].includes(action.kind) && <label>说明<Textarea required maxLength={1500} value={reason} onChange={e => setReason(e.target.value)}/></label>}
      <div className="button-row"><Button type="submit" disabled={busy}>确认提交</Button><Button type="button" variant="outline" onClick={() => setAction(null)}>取消</Button></div></form>}
  </section>;
}
