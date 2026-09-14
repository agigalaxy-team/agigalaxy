import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createContextClientV2 } from '../../galaxy-official/src/context-v2-client.mjs';

const statusNames: Record<string, string> = {
  pending: '等待指定参与者接受',
  accepted: '指定参与者已接受',
  declined: '已婉拒',
  revoked: '授权已撤回',
  expired: '材料已到期',
  'source-erased': '原文已清除',
  'scope-changed': '参与范围已改变，需要重新选择材料',
  'participation-inactive': '本次参与已停止',
  'participation-unavailable': '参与依据当前不可用',
  'source-permission-unavailable': '材料原授权当前不可用',
  'source-deletion-pending': '来源正在申请删除，暂不展示',
  'acceptance-permission-unavailable': '接受记录授权当前不可用',
};
const material = () => ({
  id: crypto.randomUUID(),
  label: '',
  mediaType: 'text/plain',
  content: '',
});
export function ContextWorkspace({ task, runtime, subjectId, connected }: any) {
  const generation = useRef(0);
  const client = useMemo(
    () =>
      connected && runtime && subjectId
        ? createContextClientV2({
            api: runtime.api,
            getLocal: runtime.getLocal,
            putLocal: runtime.putLocal,
          })
        : null,
    [runtime, subjectId, connected],
  );
  const [items, setItems] = useState<any[]>([]),
    [pending, setPending] = useState<any[]>([]),
    [nextAfter, setNextAfter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [materials, setMaterials] = useState<any[]>([]),
    [minutes, setMinutes] = useState('60');
  const [preview, setPreview] = useState<any>(null),
    [opened, setOpened] = useState<any>(null),
    [renewal, setRenewal] = useState<any>(null);
  const owner = task.requesterId === subjectId,
    eligible = (task.participations ?? []).filter(
      (p: any) =>
        p.subjectId !== subjectId &&
        p.scopeAvailable !== false &&
        p.agreedScope &&
        p.scopeEventId &&
        ['active', 'delivered', 'accepted'].includes(p.state),
    );
  async function load(after?: string) {
    if (!client) return;
    const epoch = generation.current,
      previousOpen = opened?.metadata.taskId === task.taskId ? opened : null;
    setOpened(null);
    const page = await client.query({
      taskId: task.taskId,
      ...(after ? { after } : {}),
      limit: 20,
    });
    if (epoch !== generation.current) return;
    setItems((previous) =>
      after
        ? [
            ...previous.filter(
              (x) =>
                !page.items.some(
                  (y: any) => y.metadata.grantId === x.metadata.grantId,
                ),
            ),
            ...page.items,
          ]
        : page.items,
    );
    setNextAfter(page.nextAfter ?? null);
    const waiting = await client.pending();
    if (epoch !== generation.current) return;
    setPending(waiting);
    if (previousOpen) {
      const current = await client.get(previousOpen.metadata.grantId);
      if (epoch === generation.current) setOpened(current);
    }
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setItems([]);
    setPreview(null);
    setCreating(false);
    setOpened(null);
    setRenewal(null);
    setSelected([]);
    setError('');
    setNotice('');
    setNextAfter(null);
    if (client)
      load().catch((e: any) => {
        if (epoch === generation.current) setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '上下文读取暂未完成，请稍后重试。');
      });
    const reload = () => {
      if (document.visibilityState === 'visible' && client && !busy) load().catch((e: any) => {
        if (epoch === generation.current) setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '上下文操作暂未完成，请稍后重试。');
      });
    };
    const timer = window.setInterval(reload, 20000);
    document.addEventListener('visibilitychange', reload);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reload);
    };
  }, [client, task.taskId, task.version]);
  async function run(fn: () => Promise<any>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e: any) {
      setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '上下文操作暂未完成，请稍后重试。');
    } finally {
      if (client)
        try {
          setPending(await client.pending());
        } catch {}
      setBusy(false);
    }
  }
  async function prepare() {
    if (!client) throw new Error('请先连接当前银河身份。');
    const recipients = eligible.filter((p: any) =>
      selected.includes(p.participationId),
    );
    if (!recipients.length)
      throw new Error('请选择至少一项当前已确认的参与约定。');
    const duration = Number(minutes);
    if (!Number.isInteger(duration) || duration < 5 || duration > 43200)
      throw new Error('请选择 5 分钟到 30 天之间的本次有效期。');
    const expiresAt = Math.floor(Date.now() / 1000) + duration * 60;
    const drafts = [];
    for (const p of recipients) {
      const payload = {
        schemaVersion: 2,
        id: crypto.randomUUID(),
        taskId: task.taskId,
        participationId: p.participationId,
        participantId: p.subjectId,
        scopeVersion: p.scopeVersion,
        scopeEventId: p.scopeEventId,
        expiresAt,
        materials: structuredClone(materials),
      };
      drafts.push({
        prepared: await client.prepareGrant(payload),
        payload,
        recipient: p,
      });
    }
    setPreview({ kind: 'grants', drafts });
  }
  async function prepareEvent(item: any, kind: string) {
    if (!client) throw new Error('请先连接当前银河身份。');
    const current = await client.get(item.metadata.grantId, {
      metadataOnly: true,
    });
    if (kind !== 'revoke' && current.state !== 'pending')
      throw new Error('这份材料当前不再等待接受，请刷新查看。');
    setPreview({
      kind,
      drafts: [
        {
          prepared: await client.prepareEvent(kind, current.metadata),
          metadata: current.metadata,
          materials: current.materials,
        },
      ],
    });
  }
  async function commit() {
    if (!client) throw new Error('请先连接当前银河身份。');
    // Each chosen person has an independent exact operation and response. A
    // failed later item never rolls an earlier recipient back or signs for them.
    const remaining = [...preview.drafts],
      failures = [];
    let completed = 0;
    for (const draft of preview.drafts) {
      try {
        await client.execute(draft.prepared, { confirmed: true });
        remaining.splice(remaining.indexOf(draft), 1);
        completed++;
      } catch (e: any) {
        failures.push(e.message);
      }
    }
    // The helper consumes each preview once. Failed submitted operations are
    // continued through their exact persisted IDs, never execute(preview) again.
    setPreview(null);
    if (!remaining.length) {
      setCreating(false);
      setMaterials([]);
      setSelected([]);
    }
    await load();
    setNotice(
      `${completed} 项独立操作已记录。${remaining.length ? '其余项目保留原操作，请查询回执后继续。' : '其他参与者的授权与回应各自独立。'}`,
    );
    if (failures.length) setError([...new Set(failures)].join('；'));
  }
  if (!connected || !client) return null;
  return (
    <section className="workspace-panel" aria-label="逐人上下文材料授权">
      <h3>逐人提供工作材料</h3>
      <p>
        只提交本次明确选定的文字片段。每位参与者先看到材料目录，亲自接受后才能打开正文；接受参与或加入房间均不等于接受材料。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="button-row">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => load())}
        >
          刷新材料状态
        </Button>
        {owner && task.state === 'open' && (
          <Button
            disabled={busy || !eligible.length}
            onClick={() => {
              setCreating(true);
              setMaterials([material()]);
              setPreview(null);
              setSelected([]);
            }}
          >
            选择材料并指定参与者
          </Button>
        )}
      </div>
      {owner && !eligible.length && (
        <p className="muted">
          先等对应参与者确认实际职责和范围，再向其交接材料。任务无需先创建
          Case。
        </p>
      )}
      {pending
        .filter((op: any) => op.taskId === task.taskId)
        .map((op: any) => (
          <article className="message" key={op.operationId}>
            <p>待查询原操作：{op.operationId}</p>
            <div className="button-row">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const receipt = await client.reconcile(op.operationId);
                    setNotice(
                      receipt.state === 'acknowledged'
                        ? '已查到原操作回执。'
                        : '目前没有取得确定结果，原操作仍保留。',
                    );
                    await load();
                  })
                }
              >
                查询原回执
              </Button>
              {op.state !== 'stopped-local' && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await client.retry(op.operationId, { confirmed: true });
                        await load();
                      })
                    }
                  >
                    按原内容重试
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const review = await client.reviewAuthorization(
                          op.operationId,
                        );
                        if (review.state === 'reauthorization-required')
                          setRenewal(review);
                        else {
                          setNotice(
                            review.state === 'acknowledged'
                              ? '已确认原操作已记录。'
                              : '原授权仍可查询或重试，无需另行授权。',
                          );
                          await load();
                        }
                      })
                    }
                  >
                    检查原授权能否继续
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const result = await client.abandon(op.operationId, {
                          confirmed: true,
                        });
                        setNotice(
                          result.state === 'stopped-local'
                            ? '已停止本机重试，服务端取消未确认。保留最小原操作定位以便继续查询。'
                            : '已查到原操作回执；如需撤回已有材料，请对该授权单独撤回。',
                        );
                        await load();
                      })
                    }
                  >
                    停止本机重试
                  </Button>
                </>
              )}
            </div>
            {op.state === 'stopped-local' && (
              <p className="muted">
                本机原文待发副本已清除；服务端取消未确认，只继续查询原操作。
              </p>
            )}
          </article>
        ))}
      {renewal && (
        <section className="message">
          <h4>原操作需要重新授权</h4>
          <p>收件人：{renewal.recipientId}</p>
          <p>
            业务操作与材料版本保持原值。仅在确认旧授权未写入且已失效后，重新签署当前连接的授权。
          </p>
          {(renewal.payload.materials ?? []).map((m: any) => (
            <article key={m.id}>
              <strong>{m.label}</strong>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {m.content}
              </pre>
            </article>
          ))}
          <div className="button-row">
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await client.reauthorize(renewal.operationId, renewal, {
                    confirmed: true,
                  });
                  setRenewal(null);
                  await load();
                })
              }
            >
              确认按原内容重新授权
            </Button>
            <Button variant="outline" onClick={() => setRenewal(null)}>
              取消此次确认
            </Button>
          </div>
        </section>
      )}
      {creating && !preview && (
        <form
          className="workspace-form message"
          onSubmit={(e) => {
            e.preventDefault();
            run(prepare);
          }}
        >
          <h4>本次选定材料</h4>
          <fieldset>
            <legend>分别授权给哪些当前参与约定</legend>
            {eligible.map((p: any) => (
              <label key={p.participationId}>
                <input
                  type="checkbox"
                  checked={selected.includes(p.participationId)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, p.participationId]
                        : selected.filter((id) => id !== p.participationId),
                    )
                  }
                />
                {p.subjectId} · {p.role} · 范围版本 {p.scopeVersion}
                <span className="muted">：{p.agreedScope}</span>
              </label>
            ))}
          </fieldset>
          <p className="muted">
            多选时每个人得到当前预览的同一组材料，但形成独立授权。需要提供不同材料时分别提交。
          </p>
          {materials.map((m, index) => (
            <fieldset key={m.id}>
              <legend>片段 {index + 1}</legend>
              <label>
                材料名称
                <Input
                  required
                  maxLength={160}
                  value={m.label}
                  onChange={(e) =>
                    setMaterials(
                      materials.map((x) =>
                        x.id === m.id ? { ...x, label: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
              <label>
                本次明确选择的文字
                <Textarea
                  required
                  maxLength={4000}
                  value={m.content}
                  onChange={(e) =>
                    setMaterials(
                      materials.map((x) =>
                        x.id === m.id ? { ...x, content: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
              {materials.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setMaterials(materials.filter((x) => x.id !== m.id))
                  }
                >
                  移除此片段
                </Button>
              )}
            </fieldset>
          ))}
          {materials.length < 8 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setMaterials([...materials, material()])}
            >
              添加另一个明确片段
            </Button>
          )}
          <label>
            本次材料有效期（分钟）
            <Input
              type="number"
              required
              min={5}
              max={43200}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <p className="muted">
            材料到期或参与范围改变后停止读取。已经由对方另行保存的外部副本不在此删除范围内。
          </p>
          <div className="button-row">
            <Button type="submit" disabled={busy}>
              预览本次逐人授权
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreating(false);
                setMaterials([]);
              }}
            >
              取消本地草稿
            </Button>
          </div>
        </form>
      )}
      {preview && (
        <section className="message">
          <h4>
            {preview.kind === 'grants'
              ? '确认本次逐人材料授权'
              : preview.kind === 'accept'
                ? '确认接受此精确版本材料'
                : preview.kind === 'decline'
                  ? '确认婉拒此材料'
                  : '确认撤回这份材料授权'}
          </h4>
          {preview.drafts.map((draft: any, index: number) => (
            <article key={index}>
              {draft.payload ? (
                <>
                  <p>指定参与者：{draft.payload.participantId}</p>
                  <p>
                    已确认范围：{draft.recipient.agreedScope} / 版本{' '}
                    {draft.payload.scopeVersion}
                  </p>
                  <p>
                    有效至{' '}
                    {new Date(draft.payload.expiresAt * 1000).toLocaleString()}
                  </p>
                  {draft.payload.materials.map((m: any) => (
                    <div key={m.id}>
                      <strong>{m.label}</strong>
                      <pre
                        style={{
                          whiteSpace: 'pre-wrap',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {m.content}
                      </pre>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <p>
                    材料作者：{draft.metadata.ownerId}；指定参与者：
                    {draft.metadata.participantId}
                  </p>
                  <p>
                    范围版本 {draft.metadata.scopeVersion}；有效至{' '}
                    {new Date(draft.metadata.expiresAt * 1000).toLocaleString()}
                  </p>
                  {(draft.materials ?? []).map((m: any) => (
                    <p key={m.id}>{m.label}</p>
                  ))}
                  <p className="muted">
                    本次确认绑定服务返回的真实材料摘要。
                    {preview.kind === 'accept'
                      ? '仅你接受后才能打开正文。'
                      : '其他人的独立授权保持原状态。'}
                  </p>
                </>
              )}
            </article>
          ))}
          <div className="button-row">
            <Button disabled={busy} onClick={() => run(commit)}>
              确认本次操作
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              返回；不提交新操作
            </Button>
          </div>
        </section>
      )}
      {!items.length && <p>当前没有你可见的材料授权。</p>}
      {items.map((item: any) => {
        const m = item.metadata;
        return (
          <article className="task-card" key={m.grantId}>
            <h4>{statusNames[item.state] ?? '当前不可使用'}</h4>
            <p>
              作者：{m.ownerId} → 指定参与者：{m.participantId}
            </p>
            <p>
              范围版本 {m.scopeVersion}；有效至{' '}
              {new Date(m.expiresAt * 1000).toLocaleString()}
            </p>
            {(item.materials ?? []).map((material: any) => (
              <p key={material.id}>{material.label}</p>
            ))}
            <div className="button-row">
              {m.participantId === subjectId && item.state === 'pending' && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() => run(() => prepareEvent(item, 'accept'))}
                  >
                    查看目录并确认接受
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => run(() => prepareEvent(item, 'decline'))}
                  >
                    婉拒这些材料
                  </Button>
                </>
              )}
              {(m.ownerId === subjectId || item.state === 'accepted') &&
                ['pending', 'accepted'].includes(item.state) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () => setOpened(await client.get(m.grantId)))
                    }
                  >
                    打开当前获准材料
                  </Button>
                )}
              {m.ownerId === subjectId &&
                !['revoked', 'source-erased'].includes(item.state) && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => run(() => prepareEvent(item, 'revoke'))}
                  >
                    撤回这份授权
                  </Button>
                )}
            </div>
          </article>
        );
      })}
      {nextAfter && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => load(nextAfter))}
        >
          继续查看材料授权
        </Button>
      )}
      {opened && (
        <section className="message">
          <h4>当前授权材料</h4>
          <p>{statusNames[opened.state] ?? '当前不可使用'}</p>
          {opened.contextAccessGranted ? (
            (opened.materials ?? []).map((m: any) => (
              <article key={m.id}>
                <strong>{m.label}</strong>
                <pre
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {m.content}
                </pre>
              </article>
            ))
          ) : (
            <p>当前未获得读取正文的授权。</p>
          )}
          <Button variant="outline" onClick={() => setOpened(null)}>
            关闭正文
          </Button>
        </section>
      )}
    </section>
  );
}
