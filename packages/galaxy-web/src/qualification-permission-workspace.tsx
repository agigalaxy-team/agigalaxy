import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { createQualificationPermissionClient } from './qualification-permission-client.mjs';
import { QualificationPermissionOperations } from './qualification-permission-operations';

const states: Record<string, string> = {
  pending: '等待原作者回应',
  declined: '原作者已拒绝',
  cancelled: '申请者已取消',
  expired: '请求已到期',
  'permission-recorded': '已关联原作者许可',
  'source-unavailable': '原材料当前不可用',
  'request-source-unavailable': '请求授权或正文当前不可用',
};
const names: Record<string, string> = {
  request: '请求原作者的限定计算许可',
  decline: '拒绝这项请求',
  cancel: '取消这项请求',
  'source-permission': '授予本人所选材料的限定计算许可',
  compute: '为本任务创建限定计算授权',
  'record-permission': '关联已经授出的本人许可',
  revoke: '撤销这项原许可',
};
const stamp = (s: any) => (s ? new Date(s).toLocaleString() : '未取得');
const refsKey = (refs: any[] = []) =>
  JSON.stringify(
    refs
      .map((r) => `${r.kind}:${r.id}:${r.eventVersion}:${r.payloadHash}`)
      .sort(),
  );
export function matchingSourcePermissions(request: any, grants: any[]) {
  return grants.filter(
    (g) =>
      g.state === 'recorded-current-intent' &&
      g.payload?.kind === 'source-permission' &&
      g.payload.taskId === request.taskId &&
      g.payload.candidateId === request.candidateId &&
      g.payload.recipientId === request.recipientId &&
      Date.parse(g.payload.expiresAt) >= Date.parse(request.expiresAt) &&
      refsKey(g.payload.sourceRefs) === refsKey(request.sourceRefs),
  );
}

function usePermissionSession({ runtime, subjectId, connected }: any) {
  const client = useMemo(
    () =>
      runtime && subjectId && connected
        ? createQualificationPermissionClient({ runtime, subjectId })
        : null,
    [runtime, subjectId, connected],
  );
  const [pending, setPending] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [preview, setPreview] = useState<any>(null);
  const epoch = useRef(0),
    working = useRef(false),
    currentClient = useRef(client);
  currentClient.current = client;
  useEffect(() => {
    const token = ++epoch.current;
    working.current = false;
    setBusy(false);
    setError('');
    setNotice('');
    setPreview(null);
    setPending([]);
    client
      ?.pending()
      .then((p) => {
        if (token === epoch.current) setPending(p);
      })
      .catch((e) => {
        if (token === epoch.current) setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '资格许可操作暂未完成，请稍后重试。');
      });
    return () => {
      epoch.current++;
    };
  }, [client]);
  async function run(fn: () => Promise<any>) {
    if (!client || working.current) return;
    working.current = true;
    const token = epoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e: any) {
      if (token === epoch.current)
        setError((typeof e?.message==='string'&&e.message.trim()?e.message:'资格许可操作暂未完成，请保留原操作并重试。'));
    } finally {
      if (token === epoch.current) {
        try {
          const p = await client.pending();
          if (token === epoch.current) setPending(p);
        } catch {}
        if (token === epoch.current) {
          working.current = false;
          setBusy(false);
        }
      }
    }
  }
  return {
    client,
    pending,
    busy,
    error,
    notice,
    preview,
    setPreview: (v: any) => {
      if (currentClient.current === client) setPreview(v);
    },
    setNotice: (v: string) => {
      if (currentClient.current === client) setNotice(v);
    },
    run,
  };
}
function PermissionPreview({ preview, busy, onConfirm, onCancel }: any) {
  if (!preview) return null;
  const p = preview.payload;
  return (
    <article className="message">
      <h3>确认：{names[p.kind] ?? p.kind}</h3>
      <p>
        仅用于这一个任务的资格条件计算；不会公开旧任务、配置或其他人的原文。请求不等于许可，许可不等于计算成功，计算结果也不替代双方参与确认。
      </p>
      {p.sourceAuthorId && (
        <p>
          接收请求的原作者：<code>{p.sourceAuthorId}</code>
        </p>
      )}
      {p.candidateId && (
        <p>
          使用人：<code>{p.candidateId}</code>；限定结论接收人：
          <code>{p.recipientId}</code>
        </p>
      )}
      {p.expiresAt && <p>本项截止：{stamp(p.expiresAt)}。到期不自动续期。</p>}
      {p.sourceRefs && (
        <p>
          明确选择 {p.sourceRefs.length}{' '}
          个精确事件版本；更正、撤销或删除后重新核对，不静默改用新版本。
        </p>
      )}
      {p.reason && <p>原因：{p.reason}</p>}
      {p.kind === 'cancel' && (
        <p>
          取消请求不会撤销原作者另行签署的许可；原作者可在自己的许可清单中独立撤销。
        </p>
      )}
      <details>
        <summary>精确对象、版本及范围</summary>
        <pre>{JSON.stringify(p, null, 2)}</pre>
      </details>
      <div className="button-row">
        <Button type="button" disabled={busy} onClick={onConfirm}>
          确认这一项
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          返回修改
        </Button>
      </div>
    </article>
  );
}
function MaterialList({ items }: any) {
  return (
    <details>
      <summary>本次选定的材料（{items?.length ?? 0} 项）</summary>
      {items?.map((m: any) => (
        <p key={`${m.kind}:${m.id}`}>
          {m.label} · 精确事件版本 {m.eventVersion ?? 1}
          {m.summary && <span>：{m.summary}</span>}
          <br />
          <small>{m.id}</small>
        </p>
      ))}
    </details>
  );
}

export function QualificationPermissionCollector({
  runtime,
  subjectId,
  connected,
  task,
  selected,
  onCompute,
  navigate,
}: any) {
  const s = usePermissionSession({ runtime, subjectId, connected }),
    [plan, setPlan] = useState<any>(null),
    [expiresAt, setExpiresAt] = useState(''),
    [ready, setReady] = useState(false);
  const queryEpoch = useRef(0),
    key = `qualification-collection:${task.taskId}`,
    ids = (selected ?? [])
      .filter((x: any) => x.kind === 'participation')
      .map((x: any) => x.id)
      .sort(),
    selectionKey = JSON.stringify(ids);
  useEffect(() => {
    let active = true;
    setPlan(null);
    setReady(false);
    runtime?.getLocal(key).then((d: any) => {
      if (active) {
        setExpiresAt(
          d?.expiresAt ?? new Date(Date.now() + 7 * 86400000).toISOString(),
        );
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [runtime, key, subjectId]);
  useEffect(() => {
    queryEpoch.current++;
    setPlan(null);
    s.setPreview(null);
    return () => {
      queryEpoch.current++;
    };
  }, [runtime, subjectId, connected, selectionKey, expiresAt, task.version]);
  async function refresh() {
    if (!s.client) return;
    const token = queryEpoch.current,
      data = { taskId: task.taskId, participationIds: ids, expiresAt };
    await runtime.putLocal(key, { expiresAt });
    const current = await s.client.plan(data);
    if (token === queryEpoch.current) setPlan(current);
  }
  async function receipt(result: any) {
    if (result?.state === 'acknowledged') {
      s.setNotice('原操作已取得精确回执。请刷新清单；资格结论仍须单独核对。');
      await refresh();
    }
  }
  async function confirm() {
    const value = s.preview;
    if (!value || !s.client) return;
    const result = await s.client.execute(value, { confirmed: true });
    s.setPreview(null);
    if (value.payload.kind === 'compute' && result.state === 'acknowledged') {
      const evidence = {
        ...value.payload.evidence,
        calculationGrantId: result.grantId,
      };
      onCompute?.({
        id: result.grantId,
        kind: 'calculation',
        label: '本任务限定计算许可',
        sourceStatus: 'current-check-required',
        evidence,
      });
      s.setNotice(
        '计算授权已记录并加入本次所选材料。点击“核对本人所选材料”取得当前结论；这一步没有提交申请。',
      );
    } else await receipt(result);
  }
  if (!connected || !ready) return null;
  return (
    <section className="task-body" aria-busy={s.busy}>
      <h3>按原作者分别收集计算许可</h3>
      <p>
        选择上方本人实际参与材料后，银河从真实记录辨认原作者和精确版本。每人只收到自己材料的许可请求；不能读目标私有任务的人不会因此获得任务原文。
      </p>
      {s.error && (
        <p className="message error" role="alert">
          {s.error}
        </p>
      )}
      {s.notice && <output className="message">{s.notice}</output>}
      <label>
        这轮请求与计算许可的截止时间
        <input
          type="datetime-local"
          value={
            expiresAt
              ? new Date(
                  Date.parse(expiresAt) -
                    new Date(expiresAt).getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)
              : ''
          }
          onChange={(e) => {
            if (e.target.value) {
              const v = new Date(e.target.value).toISOString();
              setExpiresAt(v);
              runtime.putLocal(key, { expiresAt: v });
            }
          }}
        />
      </label>
      <p className="muted">
        期限固定保存到本机，刷新不会续期。当前请求最长 29
        天，实际能计算的期限还受原材料授权限制。
      </p>
      <div className="button-row">
        <Button
          type="button"
          variant="outline"
          disabled={s.busy || !ids.length}
          onClick={() => s.run(refresh)}
        >
          读取这些参与材料的原作者清单
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => navigate('/app/qualification-permissions')}
        >
          管理我发送／收到的请求和许可
        </Button>
      </div>
      {!ids.length && (
        <p>
          先选择至少一项本人的实际参与记录；外部审核、CI
          证明继续走各自现有材料许可，不能被这个请求替代。
        </p>
      )}
      {plan && (
        <>
          <p>
            本人材料 {plan.ownMaterials.length} 项；另有 {plan.authors.length}{' '}
            位原作者需要分别明确许可。收集齐全仍不保证满足资格。
          </p>
          {plan.authors.map((a: any) => (
            <article className="task-card" key={a.sourceAuthorId}>
              <h4>
                原作者 <code>{a.sourceAuthorId}</code>
              </h4>
              <MaterialList items={a.materials} />
              <p>
                {a.permission
                  ? `已有当前可用的限定许可，截止 ${stamp(a.permission.expiresAt)}`
                  : a.request
                    ? (states[a.request.state] ?? a.request.state)
                    : '尚未发出请求'}
              </p>
              <div className="button-row">
                {!a.permission &&
                  (!a.request ||
                    ['expired', 'declined', 'cancelled'].includes(
                      a.request.state,
                    )) && (
                    <Button
                      type="button"
                      disabled={
                        s.busy ||
                        s.pending.some((p) => p.state !== 'stopped-local')
                      }
                      onClick={() =>
                        s.run(async () =>
                          s.setPreview(await s.client!.prepareRequest(plan, a)),
                        )
                      }
                    >
                      预览对此人的请求
                    </Button>
                  )}
                {a.request && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      navigate(
                        `/app/qualification-permissions/${a.request.requestId}`,
                      )
                    }
                  >
                    查看本人的请求与回应
                  </Button>
                )}
              </div>
            </article>
          ))}
          <Button
            type="button"
            disabled={
              s.busy ||
              !plan.ready ||
              s.pending.some((p) => p.state !== 'stopped-local')
            }
            onClick={() =>
              s.run(async () =>
                s.setPreview(await s.client!.prepareCompute(plan)),
              )
            }
          >
            预览本任务限定计算授权
          </Button>
          {!plan.ready && (
            <p>
              等待缺少许可的原作者回应；也可以减少所选材料、放弃此次申请或选择开放协助。
            </p>
          )}
        </>
      )}
      <PermissionPreview
        preview={s.preview}
        busy={s.busy}
        onCancel={() => s.setPreview(null)}
        onConfirm={() => s.run(confirm)}
      />
      <QualificationPermissionOperations {...s} onComplete={receipt} />
    </section>
  );
}

export function QualificationPermissionWorkspace({
  runtime,
  subjectId,
  connected,
  navigate,
  initialRequestId,
  onNeedIdentity,
}: any) {
  const s = usePermissionSession({ runtime, subjectId, connected }),
    [view, setView] = useState<'received' | 'sent'>('received'),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [request, setRequest] = useState<any>(null),
    [grants, setGrants] = useState<any[]>([]),
    [grantNext, setGrantNext] = useState<string | null>(null),
    [reason, setReason] = useState(''),
    [selectedGrant, setSelectedGrant] = useState('');
  const lease = useRef(0);
  async function load(after?: string) {
    if (!s.client) return;
    const token = lease.current,
      r = await s.client.requests({ view, ...(after ? { after } : {}) });
    if (token === lease.current) {
      setItems((old) => (after ? [...old, ...r.items] : r.items));
      setNext(r.nextAfter);
    }
  }
  async function loadGrants(after?: string) {
    if (!s.client) return;
    const token = lease.current,
      r = await s.client.grants((after ? { after } : {}));
    if (token === lease.current) {
      setGrants((old) => (after ? [...old, ...r.items] : r.items));
      setGrantNext(r.nextAfter);
    }
  }
  async function open(id: string) {
    if (!s.client) return;
    const token = lease.current,
      r = await s.client.request(id);
    if (token === lease.current) {
      setRequest(r);
      setSelectedGrant('');
      setReason('');
      s.setPreview(null);
    }
  }
  useEffect(() => {
    lease.current++;
    setItems([]);
    setRequest(null);
    setGrants([]);
    setNext(null);
    setGrantNext(null);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && s.client && !s.busy) {
        s.run(async () => { await load(); await loadGrants(); });
      }
    };
    const timer = window.setInterval(onVisible, 20000);
    document.addEventListener('visibilitychange', onVisible);
    if (s.client)
      s.run(async () => {
        await load();
        await loadGrants();
        if (initialRequestId) await open(initialRequestId);
      });
    return () => {
      lease.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [s.client, view, initialRequestId]);
  async function refresh(result?: any) {
    await load();
    await loadGrants();
    if (request?.requestId) await open(request.requestId);
    if (result?.state === 'acknowledged')
      s.setNotice('这一项已取得精确回执。请求、来源许可及最终计算仍各自独立。');
  }
  async function confirm() {
    const p = s.preview;
    if (!p || !s.client) return;
    const result = await s.client.execute(p, { confirmed: true });
    s.setPreview(null);
    await refresh(result);
    if (p.payload.kind === 'source-permission')
      s.setNotice(
        '本人限定许可已授出。下方选择这项已授出许可并确认关联请求；即使未关联，许可仍是一份独立授权，可单独撤销。',
      );
  }
  const matches = request ? matchingSourcePermissions(request, grants) : [];
  if (!connected)
    return (
      <section>
        <h1 className="small">资格材料许可</h1>
        <p>连接本人身份，分别处理材料作者的回应和本任务计算授权。</p>
        <Button
          onClick={() =>
            onNeedIdentity
              ? onNeedIdentity()
              : navigate('/app/settings/identity')
          }
        >
          连接身份
        </Button>
      </section>
    );
  return (
    <section aria-busy={s.busy}>
      <h1 className="small">资格材料许可</h1>
      <p className="lead">
        原作者只决定自己的精确材料如何用于一次任务的资格计算；不公开旧项目原文，也不代替参与和交付确认。
      </p>
      {s.error && (
        <p className="message error" role="alert">
          {s.error}
        </p>
      )}
      {s.notice && <output className="message">{s.notice}</output>}
      <div className="button-row">
        <Button
          variant={view === 'received' ? 'default' : 'outline'}
          onClick={() => setView('received')}
        >
          我收到的请求
        </Button>
        <Button
          variant={view === 'sent' ? 'default' : 'outline'}
          onClick={() => setView('sent')}
        >
          我发出的请求
        </Button>
        <Button
          variant="outline"
          disabled={s.busy}
          onClick={() => s.run(() => refresh())}
        >
          刷新当前状态
        </Button>
      </div>
      {!items.length && !s.error && (
        <p className="empty-state">
          当前没有这一类请求。可从任务申请中选择真实参与材料后发起。
        </p>
      )}
      {items.map((i) => (
        <article className="task-card" key={i.requestId}>
          <h2>{i.target?.title ?? '限定计算许可事项'}</h2>
          <p>
            {states[i.state] ?? i.state} · 截止 {stamp(i.expiresAt)}
          </p>
          <Button
            variant="outline"
            disabled={s.busy}
            onClick={() => s.run(() => open(i.requestId))}
          >
            查看材料与回应
          </Button>
        </article>
      ))}
      {next && (
        <Button
          variant="outline"
          disabled={s.busy}
          onClick={() => s.run(() => load(next))}
        >
          继续读取请求
        </Button>
      )}
      {request && (
        <article className="message">
          <h2>{request.target?.title ?? '本次许可请求'}</h2>
          <p>
            {states[request.state] ?? request.state} · 截止{' '}
            {stamp(request.expiresAt)}
          </p>
          {request.sourceRefs && (
            <>
              <p>
                申请者：<code>{request.candidateId}</code>
                ；计算结论只给本任务请求者：<code>{request.recipientId}</code>。
              </p>
              {request.target ? (
                <>
                  <p>
                    目标领域：{request.target.capabilityId}；采用资格规则{' '}
                    {request.target.qualification?.policyId} /{' '}
                    {request.target.qualification?.policyVersion}。
                  </p>
                  <Button
                    variant="ghost"
                    onClick={() => navigate(`/app/tasks/${request.taskId}`)}
                  >
                    查看当前可读任务
                  </Button>
                </>
              ) : (
                <p>
                  目标任务内容当前对你不可读。本请求只提供计算用途、对象编号、受众和本人材料，未扩大阅读权限；可以拒绝或暂不回应。
                </p>
              )}
              <MaterialList items={request.materials} />
              {request.role === 'source-author' &&
                request.state === 'pending' && (
                  <>
                    <Button
                      disabled={s.busy || !request.grant}
                      onClick={() =>
                        s.run(async () =>
                          s.setPreview(
                            await s.client!.preparePermission(request),
                          ),
                        )
                      }
                    >
                      预览授予所选本人材料的许可
                    </Button>
                    {matches.length > 0 && (
                      <div>
                        <label>
                          关联我已经授出的精确许可
                          <select
                            value={selectedGrant}
                            onChange={(e) => setSelectedGrant(e.target.value)}
                          >
                            <option value="">选择当前可用的本人许可</option>
                            {matches.map((g) => (
                              <option value={g.id} key={g.id}>
                                授出于 {stamp(g.createdAt)} · 截止{' '}
                                {stamp(g.payload.expiresAt)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <Button
                          variant="outline"
                          disabled={s.busy || !selectedGrant}
                          onClick={() =>
                            s.run(async () =>
                              s.setPreview(
                                await s.client!.prepareResponse(
                                  request,
                                  'record-permission',
                                  { grantId: selectedGrant },
                                ),
                              ),
                            )
                          }
                        >
                          预览关联所选许可
                        </Button>
                      </div>
                    )}
                  </>
                )}
              {((request.role === 'candidate' &&
                ['pending', 'permission-recorded'].includes(request.state)) ||
                (request.role === 'source-author' &&
                  request.state === 'pending')) && (
                <div>
                  <label>
                    {request.role === 'candidate'
                      ? '取消请求的原因'
                      : '拒绝原因'}
                    <Textarea
                      value={reason}
                      maxLength={500}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <Button
                    variant="outline"
                    disabled={s.busy || !reason.trim()}
                    onClick={() =>
                      s.run(async () =>
                        s.setPreview(
                          await s.client!.prepareResponse(
                            request,
                            request.role === 'candidate' ? 'cancel' : 'decline',
                            { reason: reason.trim() },
                          ),
                        ),
                      )
                    }
                  >
                    {request.role === 'candidate'
                      ? '预览取消请求'
                      : '预览拒绝请求'}
                  </Button>
                </div>
              )}
              {request.role === 'candidate' && request.target && (
                <Button
                  variant="outline"
                  onClick={() => navigate(`/app/tasks/${request.taskId}`)}
                >
                  返回原任务继续选择材料
                </Button>
              )}
              {request.permission && (
                <p>
                  已关联许可当前状态：
                  {request.permission.state === 'current'
                    ? '许可仍可读取；计算时继续核对所有来源'
                    : '许可或其原授权当前不可用'}
                  。
                </p>
              )}
              {request.history?.map((e: any) => (
                <p key={e.eventId}>
                  {names[e.kind] ?? e.kind}
                  {e.reason ? `：${e.reason}` : ''}
                </p>
              ))}
            </>
          )}
        </article>
      )}
      <details className="room-settings">
        <summary>我已授出的许可与计算授权</summary>
        <p>
          这里只列本人签署的意图。当前显示不证明依赖材料仍有效；每次计算会重新核验。撤销不等于删除他方独立材料。
        </p>
        {grants.map((g) => (
          <article className="task-card" key={g.id}>
            <h3>{names[g.kind] ?? '本人许可回执'}</h3>
            <p>
              {g.state} · 截止 {stamp(g.expiresAt)}
            </p>
            {g.payload && (
              <>
                <p>
                  使用人 {g.payload.candidateId}；本任务结论接收人{' '}
                  {g.payload.recipientId}。
                </p>
                <p>已选 {g.payload.sourceRefs?.length ?? 0} 个精确来源版本。</p>
                <Button
                  variant="outline"
                  disabled={s.busy || g.state !== 'recorded-current-intent'}
                  onClick={() =>
                    s.run(async () =>
                      s.setPreview(
                        await s.client!.prepareRevoke(
                          g,
                          '本人停止这项限定计算授权',
                        ),
                      ),
                    )
                  }
                >
                  预览撤销这项本人授权
                </Button>
              </>
            )}
          </article>
        ))}
        {grantNext && (
          <Button
            variant="outline"
            disabled={s.busy}
            onClick={() => s.run(() => loadGrants(grantNext))}
          >
            继续读取本人许可
          </Button>
        )}
      </details>
      <PermissionPreview
        preview={s.preview}
        busy={s.busy}
        onCancel={() => s.setPreview(null)}
        onConfirm={() => s.run(confirm)}
      />
      <QualificationPermissionOperations {...s} onComplete={refresh} />
    </section>
  );
}
