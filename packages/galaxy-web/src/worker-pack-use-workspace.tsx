import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  createWorkerPackUseClient,
  preparePackUse,
} from './worker-pack-use-client.mjs';
type Props = {
  runtime: any;
  subjectId?: string;
  connected: boolean;
  navigate?: (path: string) => void;
  onNeedIdentity?: () => void;
  builderId?: string;
  manifestId?: string;
  useId?: string;
};
const same = (a: any, b: any) => a?.id === b?.id && a?.version === b?.version;
const key = (v: any) => v.id + ':' + v.version;
const outcomes: Record<string, string> = {
  succeeded: '报告成功',
  failed: '报告失败',
  partial: '报告部分完成',
  unrecorded: '尚未记录结果',
  running: '进行中',
  stopped: '已停止',
  inconclusive: '结论不足',
};
export function WorkerPackUseWorkspace({
  runtime,
  subjectId,
  connected,
  navigate,
  onNeedIdentity,
  builderId,
  manifestId,
  useId,
}: Props) {
  const client = useMemo(
    () => (runtime ? createWorkerPackUseClient({ runtime, subjectId, now: () => Date.now() }) : null),
    [runtime, subjectId],
  );
  const [packs, setPacks] = useState<any[]>([]),
    [packAfter, setPackAfter] = useState<string | null>(null),
    [query, setQuery] = useState('');
  const [pack, setPack] = useState<any>(null),
    [uses, setUses] = useState<any[]>([]),
    [useAfter, setUseAfter] = useState<string | null>(null),
    [usesMine, setUsesMine] = useState(false),
    [selected, setSelected] = useState<any>(null);
  const [cases, setCases] = useState<any[]>([]),
    [sourceCase, setSourceCase] = useState<any>(null),
    [caseAfter, setCaseAfter] = useState<string | null>(null),
    [caseId, setCaseId] = useState(''),
    [attemptKey, setAttemptKey] = useState(''),
    [resultKey, setResultKey] = useState('');
  const [evidence, setEvidence] = useState<string[]>([]),
    [verifications, setVerifications] = useState<string[]>([]),
    [existing, setExisting] = useState<any>(null),
    [prior, setPrior] = useState<any>(null);
  const [visibility, setVisibility] = useState('Private'),
    [preview, setPreview] = useState<any>(null),
    [pending, setPending] = useState<any[]>([]),
    [authorizationReview, setAuthorizationReview] = useState<any>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reason, setReason] = useState('');
  const epoch = useRef(0),
    running = useRef(false);
  const required = () => {
    if (!client) throw Error('连接配置尚未加载。');
    return client;
  };
  async function run(fn: (valid: () => boolean) => Promise<void>) {
    if (running.current) return;
    const token = epoch.current,
      valid = () => token === epoch.current;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await fn(valid);
    } catch (e: any) {
      if (valid()) setError((typeof e?.message==='string'&&e.message.trim()?e.message:'Worker Pack操作暂未完成，请稍后重试。'));
    } finally {
      running.current = false;
      if (valid()) {
        setBusy(false);
        if (connected)
          try {
            const p = await required().pending();
            if (valid()) setPending(p);
          } catch {}
      }
    }
  }
  useEffect(() => {
    epoch.current++;
    setPack(null);
    setPacks([]);
    setUses([]);
    setSelected(null);
    setSourceCase(null);
    setCases([]);
    setExisting(null);
    setPreview(null);
    setPending([]);
    setAuthorizationReview(null);
    setError('');
    setBusy(false);
    if (!client) return;
    let current = true;
    const load = async () => {
      try {
        if (useId) {
          const value = await client.get({ id: useId });
          if (current) {
            setSelected(value);
            if (value.sources?.pack) setPack(value.sources.pack);
          }
        } else if (builderId) {
          const value = manifestId
            ? await client.manifest({ builderId, manifestId })
            : await client.support(builderId);
          const p = manifestId
            ? value
            : value.pack.record
              ? await client.manifest({
                  builderId,
                  manifestId: value.pack.eventId,
                })
              : null;
          if (current) setPack(p);
        }
        if (connected) {
          const p = await client.pending();
          if (current) setPending(p);
        }
      } catch (e: any) {
        if (current) setError(typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请稍后重试。');
      }
    };
    void load();
    const refresh = () => {
      if (document.visibilityState !== 'visible' || !current || running.current || !connected) return;
      void client.pending().then((p) => { if (current) setPending(p); }).catch(() => {});
    };
    const timer = window.setInterval(refresh, 20000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [client, connected, builderId, manifestId, useId]);
  const chosen = cases.find((v) => v.caseId === caseId),
    attempt = chosen?.attempts.find((v: any) => key(v) === attemptKey),
    results = (chosen?.results ?? []).filter((r: any) =>
      same(r.origin, attempt),
    ),
    result = results.find((r: any) => key(r) === resultKey),
    allowedVerifications = (chosen?.verifications ?? []).filter(
      (v: any) =>
        (v.record?.target.type === 'attempt' &&
          same(v.record.target, attempt)) ||
        (v.record?.target.type === 'result' &&
          result &&
          same(v.record.target, result)),
    );
  const resetFact = () => {
    setAttemptKey('');
    setResultKey('');
    setEvidence([]);
    setVerifications([]);
    setPreview(null);
  };
  async function listPacks(after?: string) {
    await run(async (valid) => {
      const page = await required().builders({
        query,
        ...(after ? { after } : {}),
        limit: 8,
      });
      if (valid()) {
        setPacks((v) => (after ? [...v, ...page.items] : page.items));
        setPackAfter(page.nextAfter);
      }
    });
  }
  async function openPack(id: string, valid: () => boolean) {
    const support = await required().support(id);
    if (!support.pack.record) throw Error('这个登记尚无当前可读Pack清单。');
    const value = await required().manifest({
      builderId: id,
      manifestId: support.pack.eventId,
    });
    if (valid()) {
      setPack(value);
      setExisting(null);
      setPreview(null);
      setNotice('已选择准确清单版本，尚未安装或启动任何工具。');
    }
  }
  async function listUses(mine = false, after?: string) {
    await run(async (valid) => {
      const page = await required().query({
        ...(!mine && pack ? { builderId: pack.builderId } : {}),
        ...(mine ? { subjectId } : {}),
        ...(after ? { after } : {}),
        limit: 10,
      });
      if (valid()) {
        setUses((v) => (after ? [...v, ...page.items] : page.items));
        setUseAfter(page.nextAfter);
        setUsesMine(mine);
        setNotice(
          mine ? '本人使用关联' : '当前可读使用关联；数量不代表能力评分。',
        );
      }
    });
  }
  async function loadCases(after?: string) {
    await run(async (valid) => {
      const page = await required().candidates({
        ...(after ? { after } : {}),
        limit: 5,
      });
      if (valid()) {
        setCases((v) => (after ? [...v, ...page.items] : page.items));
        setCaseAfter(page.nextAfter);
      }
    });
  }
  async function editUse(value: any, valid: () => boolean) {
    const fresh = await required().get({ id: value.id });
    if (!fresh.record || fresh.subjectId !== subjectId)
      throw Error('当前关联不可编辑；可使用撤回入口。');
    const page = await required().candidates({ caseId: fresh.record.caseId });
    if (valid()) {
      setExisting(fresh);
      setPack(fresh.sources.pack);
      setCases(page.items);
      setCaseId(fresh.record.caseId);
      setAttemptKey(key(fresh.record.attempt));
      setResultKey(fresh.record.result ? key(fresh.record.result) : '');
      setEvidence(fresh.record.evidenceRefs.map(key));
      setVerifications(fresh.record.verificationRefs.map(key));
      setVisibility(fresh.disclosure.visibility);
      setPreview(null);
      setPrior(null);
    }
  }
  async function prepare() {
    await run(async (valid) => {
      const event = preparePackUse({
        pack,
        caseView: chosen,
        attempt,
        result: result ?? null,
        evidence: (chosen?.evidence ?? []).filter((v: any) =>
          evidence.includes(key(v)),
        ),
        verifications: allowedVerifications.filter((v: any) =>
          verifications.includes(key(v)),
        ),
        prior,
        existing,
      });
      const disclosure = {
          visibility,
          viewers: visibility==='Public'?[]:existing?.disclosure?.viewers ?? [],
        },
        p = await required().prepare(event, disclosure);
      await required().saveDraft({ event, disclosure });
      if (valid()) setPreview(p);
    });
  }
  const toggle = (
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    id: string,
  ) => setter((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  if (!client)
    return (
      <section className="help-intro">
        <h2>Pack实际使用</h2>
        <p>正在加载连接配置。</p>
      </section>
    );
  return (
    <section className="workspace-section">
      <h1>Pack版本与实际使用</h1>
      <p>
        选择作者的版本清单，再关联自己已经发生的配置、尝试和结果。下载、安装、启动和真实使用分别处理；模型仍在用户自己的环境运行。
      </p>
      <form
        className="workspace-form"
        onSubmit={(e) => {
          e.preventDefault();
          void listPacks();
        }}
      >
        <label>
          Pack名称或适用范围
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={200}
          />
        </label>
        <Button type="submit" disabled={busy}>
          查找Pack
        </Button>
        <Button
          type="button"
          disabled={busy || !connected}
          onClick={() => void listUses(true)}
        >
          我的使用与恢复
        </Button>
      </form>
      {packs.map((p) => (
        <article className="task-card" key={p.builderId}>
          <strong>{p.name}</strong>
          <p>
            {p.scope} · {p.version}
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void run((valid) => openPack(p.builderId, valid))}
          >
            选择并核对版本
          </Button>
        </article>
      ))}
      {packAfter && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void listPacks(packAfter)}
        >
          更多Pack
        </Button>
      )}
      {pack && (
        <article className="task-card">
          <h2>
            {pack.manifest.name} {pack.manifest.version}
          </h2>
          <p>
            作者：{pack.authorId} ·{' '}
            {pack.versionStatus === 'current' ? '当前清单' : '准确历史版本'}
          </p>
          <p>
            许可：{pack.manifest.license}；模型要求：
            {pack.manifest.modelRequirements}
          </p>
          <p>环境：{pack.manifest.environment}</p>
          <p>配置要求：{pack.manifest.configurationRequirements}</p>
          <ul>
            {pack.manifest.dependencies.map((d: any) => (
              <li key={d.kind + d.name + d.version}>
                {d.kind} {d.name} {d.version} · {d.license}
              </li>
            ))}
          </ul>
          <ul>
            {pack.manifest.permissions.map((d: any) => (
              <li key={d.resource}>
                {d.resource}：{d.purpose}（{d.required ? '必要' : '可选'}）
              </li>
            ))}
          </ul>
          <p>安装：{pack.manifest.installation}</p>
          <p>
            升级：{pack.manifest.upgrade}；退出或回退：{pack.manifest.rollback}
          </p>
          <a href={pack.manifest.source} target="_blank" rel="noreferrer">
            查看原发布方来源
          </a>{' '}
          ·{' '}
          <a
            href={pack.manifest.licenseSource}
            target="_blank"
            rel="noreferrer"
          >
            查看原许可
          </a>
          <p>
            页面没有安装Pack、启动Agent或开启持续关注。缺少依赖时可以返回原工作，不产生执行失败记录。
          </p>
          {(pack.delisted || pack.securityIssue) && (
            <p role="alert">
              该登记有下架或安全维护状态。历史事实仍按各自许可可查，不能提交新的使用关联。
            </p>
          )}
          <Button type="button" disabled={busy} onClick={() => void listUses()}>
            查看这个Pack的可读使用事实
          </Button>
        </article>
      )}
      {uses.map((u) => (
        <article className="message" key={u.id}>
          <strong>
            {u.sources?.pack.manifest.name ?? '本人保留的关联回执'}
          </strong>
          <p>
            {u.sources
              ? (outcomes[u.sources.reportedOutcome] ??
                u.sources.reportedOutcome)
              : u.sourceStatus}{' '}
            · 使用者 {u.subjectId}
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async (valid) => {
                const v = await required().get({ id: u.id });
                if (valid()) setSelected(v);
              })
            }
          >
            查看当前来源
          </Button>
          {u.subjectId === subjectId && u.record && (
            <>
              <Button
                type="button"
                disabled={busy}
                onClick={() => void run((valid) => editUse(u, valid))}
              >
                补充结果或核验
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPrior({ id: u.id, kind: 'upgrade' });
                  setExisting(null);
                  setPreview(null);
                  setNotice(
                    '请另选升级后的Pack、配置版本和新的实际尝试。旧版验证不会自动继承。',
                  );
                }}
              >
                关联后续升级
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPrior({ id: u.id, kind: 'retry' });
                  setExisting(null);
                  setPreview(null);
                  setNotice('请选择新发生的实际尝试；旧记录保持原样。');
                }}
              >
                关联另一次尝试
              </Button>
            </>
          )}
        </article>
      ))}
      {useAfter && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void listUses(usesMine, useAfter)}
        >
          更多当前可读关联
        </Button>
      )}
      {selected && (
        <article className="task-card">
          <h2>使用关联的当前事实</h2>
          <p>
            修订 {selected.version} · {selected.sourceStatus} · {selected.state}
          </p>
          {selected.sources && (
            <>
              <p>
                使用者：{selected.sources.roles.runnerId}；Pack作者：
                {selected.sources.roles.packAuthorId}；配置作者：
                {selected.sources.roles.configurationAuthorId ?? '当前未知'}
              </p>
              <p>
                尝试：{selected.sources.attempt.strategy}（第{' '}
                {selected.sources.attempt.version} 版，
                {selected.sources.attemptVersionStatus}）
              </p>
              <p>
                配置：
                {selected.sources.configuration.record?.title ??
                  '当前条件未披露或不可用'}
                ；结果：{selected.sources.result?.summary ?? '未关联结果'}
              </p>
              <p>
                {outcomes[selected.sources.reportedOutcome] ??
                  selected.sources.reportedOutcome}
                。这是实际参与者报告；签名关联不证明Pack独立造成了成功。
              </p>
              {selected.sources.synthetic && (
                <p>这些来源明确标记为合成样本，不作为真实能力经历。</p>
              )}
              {selected.sources.evidence.map((v: any) => (
                <p key={key(v)}>
                  材料 v{v.version}：{v.record?.summary ?? '当前不可用'}；
                  {v.record?.reportedBy ?? ''}
                </p>
              ))}
              {selected.sources.verifications.map((v: any) => (
                <p key={key(v)}>
                  核验 v{v.version}：
                  {v.record
                    ? v.record.observation +
                      ' · ' +
                      v.record.summary +
                      ' · 作者 ' +
                      v.record.reportedBy
                    : '已不可用或版本已变'}
                  。核验范围不扩大到整个Pack。
                </p>
              ))}
              {connected && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async (valid) => {
                      const v = await required().caseFacts(
                        selected.record.caseId,
                        selected.sources.attempt.taskId,
                      );
                      if (valid()) setSourceCase(v);
                    })
                  }
                >
                  查看原工作允许的完整过程
                </Button>
              )}
              {navigate && selected.sources.attempt.taskId && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    navigate('/app/tasks/' + selected.sources.attempt.taskId)
                  }
                >
                  返回原协作任务
                </Button>
              )}
              {sourceCase?.caseId === selected.record.caseId && (
                <section>
                  <h3>原工作当前允许的过程</h3>
                  <p>
                    {sourceCase.scopes.at(-1)?.summary}；可见事件{' '}
                    {sourceCase.coverage.visibleEvents}，
                    {sourceCase.coverage.complete
                      ? '已含当前全部允许事件'
                      : '部分资料未授权或不可用'}
                    。
                  </p>
                  {sourceCase.attempts.map((a: any) => (
                    <p key={key(a)}>
                      尝试 v{a.version}：{a.strategy} · {a.status} · 作者{' '}
                      {a.actorId}
                    </p>
                  ))}
                  {sourceCase.interventions.map((a: any) => (
                    <p key={key(a)}>
                      介入 v{a.version}：{a.description} · 作者 {a.actorId}
                    </p>
                  ))}
                  {sourceCase.results.map((a: any) => (
                    <p key={key(a)}>
                      结果 v{a.version}：{a.summary} · {a.reportedOutcome} ·
                      作者 {a.actorId}
                    </p>
                  ))}
                  <p>当前问题状态：{sourceCase.resolution.status}。</p>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setSourceCase(null)}
                  >
                    收起原工作过程
                  </Button>
                </section>
              )}
            </>
          )}
          {connected &&
            selected.subjectId === subjectId &&
            selected.state === 'active' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async (valid) => {
                    const p = await required().prepare(
                      {
                        schemaVersion: 2,
                        kind: 'revoke',
                        id: selected.id,
                        operationId: crypto.randomUUID(),
                        expectedVersion: selected.currentVersion,
                        reason,
                      },
                      { visibility: 'Private' },
                    );
                    if (valid()) setPreview(p);
                  });
                }}
              >
                <label>
                  撤回此关联的原因
                  <input
                    value={reason}
                    maxLength={1000}
                    onChange={(e) => setReason(e.target.value)}
                    required
                  />
                </label>
                <Button type="submit" disabled={busy}>
                  预览撤回
                </Button>
                <p>撤回此关联不会删除原尝试、结果或其他参与者的核验。</p>
              </form>
            )}
        </article>
      )}
      {!connected ? (
        <Button
          type="button"
          onClick={() => {
            if (onNeedIdentity) onNeedIdentity();
            else navigate?.('/app/identity');
          }}
        >
          连接身份后记录自己的使用
        </Button>
      ) : (
        <article className="task-card">
          <h2>{existing ? '补充同一次实际使用' : '关联已发生的工作'}</h2>
          {prior && (
            <p>
              正在关联{prior.kind === 'upgrade' ? '升级后的使用' : '新的重试'}。
              <button type="button" onClick={() => setPrior(null)}>
                取消前后关联
              </button>
            </p>
          )}
          <p>
            只有已经登记配置版本的本人Attempt在此列出。普通无配置任务仍可正常协作。
          </p>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void loadCases()}
          >
            选择我的实际尝试
          </Button>
          {navigate && (
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate('/app/configurations')}
            >
              管理所选配置条件
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async (valid) => {
                const d = await required().loadDraft();
                if (!d?.event) throw Error('没有未发送的本地草稿。');
                const p = await required().prepare(d.event, d.disclosure);
                if (valid()) setPreview(p);
              })
            }
          >
            恢复本地草稿并预览
          </Button>
          {caseAfter && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void loadCases(caseAfter)}
            >
              更多本人工作
            </Button>
          )}
          <label>
            工作
            <select
              value={caseId}
              disabled={!!existing}
              onChange={(e) => {
                setCaseId(e.target.value);
                resetFact();
              }}
            >
              <option value="">请选择</option>
              {cases.map((v) => (
                <option key={v.caseId} value={v.caseId}>
                  {v.summary ?? '可读工作'} {v.synthetic ? '（合成）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            准确尝试版本
            <select
              value={attemptKey}
              onChange={(e) => {
                setAttemptKey(e.target.value);
                setResultKey('');
                setEvidence([]);
                setVerifications([]);
                setPreview(null);
              }}
            >
              <option value="">请选择</option>
              {(chosen?.attempts ?? [])
                .filter(
                  (a: any) => !existing || a.id === existing.record.attempt.id,
                )
                .map((a: any) => (
                  <option key={key(a)} value={key(a)}>
                    {a.strategy} · v{a.version} · {a.status}
                  </option>
                ))}
            </select>
          </label>
          {attempt && (
            <p>
              实际关联配置：{attempt.configurationCondition?.record?.title} v
              {attempt.configurationRef.version}；
              {attempt.configurationCondition?.record?.conditions?.limitations}
            </p>
          )}
          <label>
            这个尝试的准确结果
            <select
              value={resultKey}
              onChange={(e) => {
                setResultKey(e.target.value);
                setVerifications([]);
                setPreview(null);
              }}
            >
              <option value="">尚未关联结果</option>
              {results.map((r: any) => (
                <option key={key(r)} value={key(r)}>
                  {r.summary} · v{r.version} · {r.reportedOutcome}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>相关材料（选择只建立关联，不宣称独立验证）</legend>
            {(chosen?.evidence ?? []).map((v: any) => (
              <label key={key(v)}>
                <input
                  type="checkbox"
                  checked={evidence.includes(key(v))}
                  onChange={() => {
                    toggle(setEvidence, key(v));
                    setPreview(null);
                  }}
                />
                {v.record.summary} · v{v.version} · {v.record.reportedBy}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>针对所选尝试或结果的核验</legend>
            {allowedVerifications.map((v: any) => (
              <label key={key(v)}>
                <input
                  type="checkbox"
                  checked={verifications.includes(key(v))}
                  onChange={() => {
                    toggle(setVerifications, key(v));
                    setPreview(null);
                  }}
                />
                {v.record.summary} · {v.record.observation} · v{v.version} ·{' '}
                {v.record.reportedBy}
              </label>
            ))}
          </fieldset>
          <label>
            关联可见范围
            <select
              value={visibility}
              onChange={(e) => {
                setVisibility(e.target.value);
                setPreview(null);
              }}
            >
              <option value="Private">私有</option>
              <option value="Public">公开这份使用关联</option>
            </select>
          </label>
          <p>
            公开关联不会公开原Case、配置或他人证据；读者仍须具有各项原权限。执行与所有模型成本仍在用户侧。
          </p>
          <Button
            type="button"
            disabled={
              busy || !pack || !attempt || pack.delisted || pack.securityIssue
            }
            onClick={() => void prepare()}
          >
            预览本人实际使用关联
          </Button>
        </article>
      )}
      {preview && (
        <article className="message">
          <h2>确认选定的关联</h2>
          <p>
            {preview.payload.kind === 'revoke'
              ? '撤回本人关联'
              : '仅记录所选已经发生的来源关系'}{' '}
            · {preview.visibility === 'Public' ? '公开关联' : '私有关联'}
            {preview.visibility!=='Public'&&<>；可读人员：{preview.viewers.join('、')||'仅本人'}</>}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(preview.payload, null, 2)}
          </pre>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async (valid) => {
                const r = await required().execute(preview, {
                  confirmed: true,
                });
                const current = valid()
                  ? await required().get({ id: r.id })
                  : null;
                if (valid()) {
                  setPreview(null);
                  setSelected(current);
                  setNotice(
                    '原操作已取得准确回执。没有启动Worker或自动增加成功次数。',
                  );
                }
              })
            }
          >
            确认并提交
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setPreview(null)}
          >
            暂不提交
          </Button>
        </article>
      )}
      {pending.map((p) => (
        <article className="message" key={p.operationId}>
          <h3>原操作 {p.state}</h3>
          <p>保留原编号和原内容；未知结果先核对，不重新创建使用记录。</p>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async (valid) => {
                const r = await required().reconcile(p.operationId);
                if (valid()) setNotice(r.state);
              })
            }
          >
            查询原回执
          </Button>
          {p.state !== 'stopped-local' && (
            <>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await required().retry(p.operationId, { confirmed: true });
                  })
                }
              >
                重试原操作
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async (valid) => {
                    const r = await required().reviewAuthorization(
                      p.operationId,
                    );
                    if (valid()) {
                      if (r.state === 'reauthorization-required')
                        setAuthorizationReview(r);
                      else setNotice(r.state);
                    }
                  })
                }
              >
                检查重连授权
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(async (valid) => {
                    await required().stopLocalRetry(p.operationId, {
                      confirmed: true,
                    });
                    if (valid())
                      setNotice('已停止本机重试，服务端取消未确认。');
                  })
                }
              >
                停止本机重试
              </Button>
            </>
          )}
        </article>
      ))}
      {authorizationReview && (
        <article className="message">
          <h3>同一业务内容重新授权</h3>
          <p>
            原业务与原授权均未记录，旧授权不适用于当前连接。确认后只更换授权，不改变原业务编号。
          </p>
          <p>
            范围：{authorizationReview.visibility}；受众：
            {authorizationReview.viewers.join('、') || '本人'}；截止：
            {new Date(authorizationReview.expiresAt * 1000).toLocaleString()}
          </p>
          <pre>{JSON.stringify(authorizationReview.payload, null, 2)}</pre>
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async (valid) => {
                await required().reauthorize(
                  authorizationReview.operationId,
                  authorizationReview,
                  { confirmed: true },
                );
                if (valid()) setAuthorizationReview(null);
              })
            }
          >
            确认相同内容并继续
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setAuthorizationReview(null)}
          >
            暂不处理
          </Button>
        </article>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
