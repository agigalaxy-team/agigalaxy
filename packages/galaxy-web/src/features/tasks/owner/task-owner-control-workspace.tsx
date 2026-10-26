import {ReadingDetails,ReadingSummary} from "../../../shared/reading/reading-details";
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { createTaskOwnerControlClient } from './task-owner-control-client.mjs';
import type {createWebRuntime} from "../../../runtime.mjs";
import {useGovernanceDraft} from "../../governance/governance-presentation";
import './task-owner-reading.css';

type Kind = 'cancel' | 'close' | 'stop-enrollment';
type Locator = { taskId: string; operationId: string; eventId: string; payloadHash: string; kind: Kind;
  expectedTaskVersion: number; state: string; receiptState?: string; version?: number };
type Preview = Locator & { payloadJson: string; expiresAt: number; authorization: { recipient: string;
  bindingId: string; deviceId: string; controlEpoch: number }; source: { eventId: string; version: number; expiresAt: number } };
type Pending = Locator & { preview: Preview };
type Legacy = { taskId: string; eventId: string; operationId: string; payloadHash: string; kind: string;
  state: string; source: 'legacy-task-event' | 'legacy-task-stopped' };
type Directory = { pending: Pending | null; stopped: Locator[]; receipts: Locator[]; legacy: Legacy[] };
type Outcome = { state: string; version?: number; eventId?: string; localRetryStopped?: boolean };
type LegacyStop = Outcome & { taskId?: string; payloadHash?: string; kind?: string; receipt?: Outcome };
type Status = { businessWritesAccepted?: boolean; phase?: string };
type Runtime = Pick<Awaited<ReturnType<typeof createWebRuntime>>, 'api' | 'getLocal' | 'updateLocal' | 'receiptStatus' | 'reviewTaskStop' | 'stopTaskOperation'>;
type Client = { pending(): Promise<Directory>; prepare(input: { kind: Kind; reason: string }): Promise<Preview | Outcome>;
  confirm(preview: Preview, options: { confirmed: boolean }): Promise<Outcome>;
  reconcile(input: { operationId: string }): Promise<Outcome>;
  stopRetry(input: { taskId: string; operationId: string; payloadHash: string }, options: { confirmed: boolean }): Promise<Outcome>;
  close(): void };
const empty: Directory = { pending: null, stopped: [], receipts: [], legacy: [] };
const names = { cancel: '取消请求', close: '终止整项请求', 'stop-enrollment': '结束征集' };
const states: Record<string, string> = { prepared: '已准备，尚未确认提交', unknown: '结果未知', absent: '本次核对未找到原操作',
  conflict: '原操作存在冲突', acknowledged: '原操作已被服务接受', 'stopped-local': '已停止本机重试' };
const messages: Record<string, string> = {
  task_owner_control_connection_changed: '身份或连接已经变化，请在当前设备重新核对原操作。',
  task_owner_control_pending: '还有原操作需要核对。请先查询原回执，再决定如何继续。',
  task_owner_control_legacy_pending: '旧入口还有原操作需要核对。不会绕过未知结果另建授权；如需另起操作，请先明确停止旧入口的本机重试，再核对原回执。',
  task_owner_control_legacy_preview_changed: '当前范围不能保持旧入口原操作的准确内容或版本。原操作未替换；请先明确停止旧入口的本机重试并核对回执，再审阅新操作。',
  task_owner_control_record_invalid: '原操作或授权范围不一致，已停止提交。请保留原任务地址和操作记录。',
  task_owner_control_preview_changed: '原任务版本或操作内容已经变化，未替换原操作。请先核对原回执。',
  task_owner_control_source_unavailable: '原请求的授权或保留条件已不再满足，不能据此执行新操作。',
  task_owner_read_source_unavailable: '原请求的授权或保留条件已不再满足，不能据此执行新操作。',
  task_transition_denied: '原请求已不能执行这项变更。请核对原操作回执；这不代表问题已解决。',
  task_version_conflict: '任务版本已经变化，原操作未自动替换。请先核对原回执。',
  not_found: '当前身份没有这项原请求的可用控制范围。',
  owner_control_readonly: '服务当前未明确允许业务写入。可以核对原回执，暂不能确认取消或结束征集。',
};
const stamp = (value: number) => new Date(value * 1000).toLocaleString();
function errorText(error: unknown) {
  const value = error as { code?: string; message?: string };
  return messages[value.code ?? value.message ?? ''] ?? value.message ?? '未取得可确认的结果，请保留原操作并核对回执。';
}

export function TaskOwnerControlWorkspace({ runtime, taskId, connected }: { runtime: Runtime; taskId: string; connected: boolean }) {
  const snapshot = runtime.api.snapshot();
  const key = JSON.stringify([runtime.api.endpoint, snapshot?.subjectId, snapshot?.bindingId, snapshot?.generation,
    snapshot?.control?.deviceId, snapshot?.control?.epoch, connected, taskId]);
  if (!connected || !snapshot?.control?.deviceId) return null;
  return <OwnerControl key={key} runtime={runtime} taskId={taskId}/>;
}

function OwnerControl({ runtime, taskId }: { runtime: Runtime; taskId: string }) {
  const client = useRef<Client | null>(null), live = useRef(0), working = useRef(false);
  const [directory, setDirectory] = useState<Directory>(empty), [preview, setPreview] = useState<Preview | null>(null);
  const subjectId=runtime.api.snapshot()?.subjectId;
  const draft=useGovernanceDraft<{kind:Kind;reason:string},{operationId:string;payloadHash:string;taskId:string;kind:Kind}>(runtime,subjectId,true,'owner-control-input:v1:'+taskId,{kind:'stop-enrollment',reason:''}),kind=draft.value.kind as Kind,reason=draft.value.reason as string;
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(true), [status, setStatus] = useState<Status | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null), [stopping, setStopping] = useState<Locator | null>(null);
  const [legacyStop, setLegacyStop] = useState<LegacyStop | null>(null);
  useEffect(() => {
    const lease = ++live.current;
    let current: Client | null = null;
    void Promise.resolve().then(async () => {
      if (live.current !== lease) return;
      current = createTaskOwnerControlClient(runtime, taskId); client.current = current;
      const [value, availability] = await Promise.allSettled([current!.pending(), runtime.api.call('/v1/service-status', undefined, { method: 'GET', authenticated: false })]);
      if (live.current !== lease) return;
      if (value.status === 'fulfilled') setDirectory(value.value); else setMessage(errorText(value.reason));
      if (availability.status === 'fulfilled') setStatus(availability.value); else setMessage(errorText(availability.reason));
    }).catch(error => { if (live.current === lease) setMessage(errorText(error)); })
      .finally(() => { if (live.current === lease) setBusy(false); });
    return () => { live.current = lease + 1; current?.close(); if (client.current === current) client.current = null; };
  }, [runtime, taskId]);
  async function run(action: (current: Client, valid: () => boolean) => Promise<void>) {
    const current = client.current;
    if (!current || working.current) return;
    const lease = live.current, valid = () => live.current === lease;
    working.current = true; setBusy(true); setMessage('');
    try { await action(current, valid); }
    catch (error) { if (valid()) { setPreview(null); setMessage(errorText(error)); } }
    finally {
      try { const value = await current.pending(); if (valid()) setDirectory(value); }
      catch (error) { if (valid()) setMessage(errorText(error)); }
      working.current = false; if (valid()) setBusy(false);
    }
  }
  async function requireWritable(valid: () => boolean) {
    const value = await runtime.api.call('/v1/service-status', undefined, { method: 'GET', authenticated: false });
    if (!valid()) throw new Error('task_owner_control_connection_changed');
    setStatus(value);
    if (value.businessWritesAccepted !== true) throw new Error('owner_control_readonly');
  }
  const pending = directory.pending;
  const writable = status?.businessWritesAccepted === true;
  const prepare = (selected: Kind, explanation: string) => run(async (current, valid) => {
    setPreview(null); setOutcome(null); setStopping(null); setLegacyStop(null); await requireWritable(valid);
    const value = await current.prepare({ kind: selected, reason: explanation });
    if (valid()) { if ('payloadJson' in value) setPreview(value); else setOutcome(value); }
  });
  const reconcile = (operationId: string) => run(async (current, valid) => {
    setPreview(null); setStopping(null); setLegacyStop(null);
    const stopped = directory.stopped.some(item => item.operationId === operationId)
      || directory.legacy.some(item => item.operationId === operationId && item.source === 'legacy-task-stopped');
    const value = await current.reconcile({ operationId }); if (valid()) setOutcome({ ...value, localRetryStopped: stopped });
  });
  const submit=()=>run(async(current,valid)=>{
    const saved=await draft.snapshot();if(!valid())return;const selected=saved.value.kind as Kind,explanation=saved.value.reason.trim()||(selected==='stop-enrollment'?'结束这次请求的征集。':'取消这次请求。');
    setPreview(null);setOutcome(null);setStopping(null);setLegacyStop(null);await requireWritable(valid);
    const prepared=await current.prepare({kind:selected,reason:explanation});if(!valid())return;
    if(!('payloadJson' in prepared)){setOutcome(prepared);return;}
    await draft.attach({operationId:prepared.operationId,payloadHash:prepared.payloadHash,taskId,kind:selected},saved.revision);if(!valid())return;
    await requireWritable(valid);const result=await current.confirm(prepared,{confirmed:true});if(!valid())return;setOutcome(result);
    if(['acknowledged','canceled','closed','enrollment-stopped'].includes(result.state))await draft.settle(async locator=>{const receipt=await current.reconcile({operationId:locator.operationId});return{state:['acknowledged','canceled','closed','enrollment-stopped'].includes(receipt.state)?'acknowledged':receipt.state};});
  });
  return <section className="task-owner-control task-card" aria-busy={busy}>
    <h3>处理原请求</h3>
    <p className="record-meta">选择是否继续征集帮助。已有的参与、交付和其他工作记录会保留。</p>
    {message && <p className="message error" role="alert">{message}</p>}
    {!writable && <div className="message"><p>尚未确认服务允许业务写入。原回执仍可单独核对。</p>
      <Button variant="outline" disabled={busy} onClick={() => run(async (_current, valid) => { await requireWritable(valid); })}>重新核对服务状态</Button>
    </div>}
    {outcome && <div className="message" aria-label="原操作核对结果">
      <h3>{outcome.state === 'canceled' ? '已取消这项请求' : outcome.state === 'enrollment-stopped' ? '已结束征集' : outcome.state === 'closed' ? '已终止整项请求' : states[outcome.state] ?? '本次没有待核对操作'}</h3>
      {['acknowledged', 'canceled', 'closed', 'enrollment-stopped'].includes(outcome.state)
        ? <p>已有工作记录继续保留。需要继续查看时，可使用上方的本人记录。</p>
        : <p>{outcome.state === 'absent' ? (outcome.localRetryStopped ? '这次查询没有找到已停止的原操作。该定位只能用于查询，不会重新签署或发送；另起操作需要独立审阅。' : '这次查询没有找到原操作，未重新签署或发送。若继续，需要重新核对同一操作的当前范围。') : outcome.state === 'conflict' ? '原操作存在冲突，不能自动换一个标识重试。请保留原记录。' : outcome.state === 'none' ? '本次没有找到对应的本机待处理操作。不能据此推断服务端状态。' : '本机不再重试这项操作，服务是否接受过它仍以原回执为准。'}</p>}
    </div>}
    {directory.legacy.map(item => <div className="message" key={`${item.source}:${item.operationId}`} aria-label="旧入口保留的原操作">
      <h3>旧入口的原操作：{names[item.kind as Kind] ?? '任务协作记录'}</h3>
      <p>本机保存的状态：{states[item.state] ?? '待核对'}。最近结果以上方明确查询的回执为准。这里只列出定位，不恢复旧正文，也不会自动发送。</p>
      <ReadingDetails><ReadingSummary>查看旧操作定位</ReadingSummary><p style={{ overflowWrap: 'anywhere' }}>操作：{item.eventId}<br/>内容摘要：{item.payloadHash}</p></ReadingDetails>
      <div className="button-row"><Button variant="outline" disabled={busy} onClick={() => reconcile(item.operationId)}>只核对旧入口原回执</Button>
        {item.source === 'legacy-task-event' && <Button variant="ghost" disabled={busy} onClick={() => run(async (_current, valid) => {
          setPreview(null); setStopping(null); setLegacyStop(null);
          const value = await runtime.reviewTaskStop(taskId);
          if (!valid()) return;
          if (value.state === 'stop-local-preview') {
            if (value.taskId !== item.taskId || value.eventId !== item.eventId || value.payloadHash !== item.payloadHash)
              throw new Error('原操作已经变化，请重新核对目录。');
            setLegacyStop(value);
          } else setOutcome(value);
        })}>核对并停止旧入口本机重试…</Button>}
      </div>
    </div>)}
    {legacyStop && <div className="message" aria-label="旧入口停止本机重试确认">
      <p>原回执：{states[legacyStop.receipt?.state ?? 'unknown'] ?? '结果未知'}。确认后只移除旧入口本机待发送内容，并保留原操作定位；不会撤销服务端事实，也不表示请求已被取消。</p>
      <div className="button-row"><Button variant="outline" disabled={busy} onClick={() => run(async (_current, valid) => {
        const { taskId: originalTaskId, eventId, payloadHash } = legacyStop;
        if (!originalTaskId || !eventId || !payloadHash) throw new Error('原操作已经变化，请重新核对目录。');
        const value = await runtime.stopTaskOperation({ taskId: originalTaskId, eventId, payloadHash }, { taskId, confirmed: true });
        if (valid()) { setLegacyStop(null); setOutcome(value); }
      })}>确认只停止旧入口本机重试</Button><Button variant="ghost" disabled={busy} onClick={() => setLegacyStop(null)}>保留旧入口原操作</Button></div>
    </div>}
    {pending && !preview && <div className="message" aria-label="本机保留的原请求操作">
      <h3>待核对：{names[pending.kind]}</h3><p>{states[pending.state] ?? '原操作待核对'}。不会在进入页面时自动提交。</p>
      <ReadingDetails><ReadingSummary>原操作定位</ReadingSummary><p style={{ overflowWrap: 'anywhere' }}>操作：{pending.operationId}<br/>内容摘要：{pending.payloadHash}<br/>所依据的任务版本：{pending.expectedTaskVersion}</p></ReadingDetails>
      <div className="button-row">
        <Button variant="outline" disabled={busy} onClick={() => reconcile(pending.operationId)}>只核对原操作回执</Button>
        {['prepared', 'absent'].includes(pending.state) && <Button variant="outline" disabled={busy || !writable} onClick={() => {
          const event = JSON.parse(pending.preview.payloadJson).event;
          void prepare(pending.kind, event.reason);
        }}>重新核对这项原操作</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => { setPreview(null); setStopping(pending); }}>停止本机重试…</Button>
      </div>
    </div>}
    {stopping && <div className="message" aria-label="停止本机重试确认">
      <p>只移除本机用于继续发送的内容，并保留原操作定位。不会向服务撤销已经接受的操作，也不代表服务已取消请求。</p>
      <div className="button-row"><Button variant="outline" disabled={busy} onClick={() => run(async (current, valid) => {
        const value = await current.stopRetry({ taskId, operationId: stopping.operationId, payloadHash: stopping.payloadHash }, { confirmed: true });
        if (valid()) { setStopping(null); setOutcome(value); }
      })}>确认只停止本机重试</Button><Button variant="ghost" disabled={busy} onClick={() => setStopping(null)}>保留原操作</Button></div>
    </div>}
    {!pending&&!preview&&directory.receipts.length===0&&<form className="owner-request-action" onSubmit={event=>{event.preventDefault();void submit();}}>
      <fieldset disabled={busy||!writable||!draft.ready}><legend>现在怎样处理</legend><label className="owner-control-choice" aria-label="结束征集"><input type="radio" name={'owner-action-'+taskId} checked={kind==='stop-enrollment'} onChange={()=>draft.change({kind:'stop-enrollment'})}/><span><strong>结束征集</strong><small>停止新参与，已经建立的合作可继续交付与验收。</small></span></label><label className="owner-control-choice" aria-label="取消请求"><input type="radio" name={'owner-action-'+taskId} checked={kind==='cancel'} onChange={()=>draft.change({kind:'cancel'})}/><span><strong>取消请求</strong><small>不再按这项请求继续；已经发生的记录继续保留。</small></span></label><label className="owner-control-choice" aria-label="终止整项请求"><input type="radio" name={'owner-action-'+taskId} checked={kind==='close'} onChange={()=>draft.change({kind:'close'})}/><span><strong>终止整项请求</strong><small>停止整项工作，已有参与也不能继续交付或验收。</small></span></label></fieldset>
      <label htmlFor={'owner-reason-'+taskId}>补充说明（可选）</label><Textarea id={'owner-reason-'+taskId} value={reason} maxLength={1500} disabled={busy||!writable||!draft.ready} onChange={event=>draft.change({reason:event.target.value})}/>
      <p className="record-meta">这项操作不会标记问题已解决，也不会自动验收或结算。</p>
      {draft.status&&!['草稿已保存在本机。','已恢复本机草稿。','正在保存…'].includes(draft.status)&&<p className="message error" role="alert">{draft.status}</p>}
      <div className="button-row"><Button type="submit" disabled={busy||!writable||!draft.ready}>{busy?'正在处理…':names[kind]}</Button></div>
    </form>}
    {preview && <div className="message" aria-label="原请求处理确认范围">
      <h3>继续原来的{names[preview.kind]}</h3>
      <p>{JSON.parse(preview.payloadJson).event.reason}</p>
      <p>依据原任务版本 {preview.expectedTaskVersion}，有效至 {stamp(preview.expiresAt)}。本次单独授权提交该操作，私有范围，不增加其他查看者。</p>
      <p>既有历史保留；资料权限不变；不授予完整任务访问；不执行结算。</p>
      <ReadingDetails><ReadingSummary>查看准确操作和授权范围</ReadingSummary>
        <p style={{ overflowWrap: 'anywhere' }}>任务：{taskId}<br/>操作：{preview.operationId}<br/>内容摘要：{preview.payloadHash}<br/>接收服务：{preview.authorization.recipient}<br/>来源记录：{preview.source.eventId}，版本 {preview.source.version}</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.payloadJson}</pre>
      </ReadingDetails>
      <div className="button-row"><Button disabled={busy || !writable} onClick={() => run(async (current, valid) => {
        const reviewed = preview; setPreview(null); await requireWritable(valid);
        const value = await current.confirm(reviewed, { confirmed: true }); if (valid()) setOutcome(value);
      })}>确认{names[preview.kind]}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setPreview(null); setMessage('本次没有确认提交。已准备的原操作仍保留在本机，可核对回执或停止本机重试。'); }}>暂不提交</Button></div>
    </div>}
    {directory.stopped.map(item => <div className="message" key={item.operationId} aria-label="已停止的原操作">
      <p>{names[item.kind]} · 已停止本机重试 · {states[item.receiptState ?? 'unknown'] ?? '结果未知'}。保留历史定位，不会重新发送。</p>
      <Button variant="outline" disabled={busy} onClick={() => reconcile(item.operationId)}>核对这项已停止操作的原回执</Button>
    </div>)}
    {directory.receipts.length > 0 && <ReadingDetails><ReadingSummary>查看已确认的操作记录（{directory.receipts.length}）</ReadingSummary>
      {directory.receipts.map(item => <p key={item.operationId} style={{ overflowWrap: 'anywhere' }}>{names[item.kind]} · 记录版本 {item.version} · {item.operationId}。仅说明该原操作已被接受。</p>)}
    </ReadingDetails>}
  </section>;
}
