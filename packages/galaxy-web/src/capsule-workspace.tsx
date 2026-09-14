import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createCapsuleWebClient } from './capsule-workspace-client.mjs';
import {
  CapsuleAuthoring,
  CapsulePermissionWorkspace,
} from './capsule-authoring';
import { CapsuleApplication } from './capsule-application';
import { CapsuleConsentControls } from './capsule-consent-controls';

export const capsuleLabel = (s: string) =>
  (
    ({
      current: '来源当前可用',
      'source-unavailable': '来源目前不可用',
      'source-result-superseded': '来源结果已有纠正版本',
      'application-result-superseded': '应用结果已有纠正版本',
      'capsule-source-unavailable': '方法来源不可用',
      'application-source-unavailable': '应用来源不可用',
      'prior-application-unavailable': '先前应用已不可用',
      'legacy-v1-source-policy': '历史版本的作者声明来源规则',
      reference: '加入参考',
      apply: '实际应用',
      reverify: '再次验证',
      succeeded: '报告达到目标',
      partial: '部分达到',
      failed: '未达到',
      inconclusive: '尚无定论',
      conflicting: '结论冲突',
      deprecate: '已停用',
      'security-issue': '安全事项',
      'resolve-security': '安全事项已处理',
    }) as any
  )[s] ?? s;
export const capsuleError = (e: any) =>
  (
    ({
      capsule_source_permission_required:
        '某些实际来源还缺原作者许可。请在许可区取得对应授权，或去掉未获准的选定材料。',
      configuration_content_unavailable:
        '所选配置内容已撤回或目前不可读。可保留草稿，重新核对选定来源与许可。',
      capsule_resolution_required:
        '正式版本需要实际报告达到目标的来源结果。失败或不明确的记录可以继续完善，不能改写成成功。',
      capsule_unavailable:
        '这份版本不存在或当前不可读。旧版不会自动替代未获准的新版。',
      capsule_not_applicable:
        '当前版本已停用、有安全事项或来源结果已变化，不能新增应用。',
      capsule_new_case_required:
        '实际应用应来自另一件真实工作，不把源案例自己算作复用。',
      capsule_use_already_recorded:
        '这一条精确应用或再验证已经记录，请刷新查看。',
      consent_reauthorization_required:
        '原授权已失效。先查询原操作；当前界面保留原记录，不自动换一个授权重复发布。',
    }) as any
  )[e.code ?? e.message] ??
  e.message ??
  '操作未完成。';
export const exactCapsulePath = (id: string, versionId?: string) =>
  `/app/capsules/${id}${versionId ? `/versions/${versionId}` : ''}`;

export function CapsuleWorkspace({
  runtime,
  subjectId,
  connected,
  navigate,
  capsuleId,
  versionId,
}: any) {
  function requiredClient(){if(!client)throw new Error('请先连接当前身份。');return client;}
  const client = useMemo(
    () =>
      runtime
        ? createCapsuleWebClient({
            api: runtime.api,
            getLocal: runtime.getLocal,
            putLocal: runtime.putLocal,
            subjectId,
          })
        : null,
    [runtime, subjectId],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [onlyMine, setOnlyMine] = useState(false);
  const [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false),
    [detail, setDetail] = useState<any>(null),
    [versions, setVersions] = useState<any>({ items: [] });
  const [uses, setUses] = useState<any>({ items: [] }),
    [history, setHistory] = useState<any[]>([]),
    [historyNext, setHistoryNext] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const [permissions, setPermissions] = useState<any>({
      owned: [],
      granted: [],
    }),
    [permissionNext, setPermissionNext] = useState<any>({}),
    [pending, setPending] = useState<any[]>([]),
    [preview, setPreview] = useState<any>(null),
    [mode, setMode] = useState('browse');
  const epoch = useRef(0),
    working = useRef(false),
    writable = !!(client && connected && subjectId);
  useEffect(() => {
    epoch.current++;
    working.current = false;
    setBusy(false);
    setDetail(null);
    setVersions({ items: [] });
    setUses({ items: [] });
    setPreview(null);
    setHistory([]);
    setHistoryLoaded(false);
    setHistoryNext(null);
    setPermissions({ owned: [], granted: [] });
    setPermissionNext({});
    setPending([]);
    setError('');
    setNotice('');
    setLoaded(false);
    setItems([]);
    setNext(null);
    setMode('browse');
    const token = epoch.current;
    if (client) {
      if (capsuleId)
        readDetail(capsuleId, versionId, token).catch((e) => {
          if (token === epoch.current) setError(capsuleError(e));
        });
      else
        find(undefined, token).catch((e) => {
          if (token === epoch.current) setError(capsuleError(e));
        });
    }
    if (writable)
      client
        .pending()
        .then((p: any) => {
          if (token === epoch.current) setPending(p);
        })
        .catch(() => {});
    const reload = () => {
      if (document.visibilityState !== 'visible' || working.current || !client) return;
      if (capsuleId) readDetail(capsuleId, versionId, epoch.current).catch(() => {});
      else find(undefined, epoch.current).catch(() => {});
      if (writable) client.pending().then((p: any) => { if (epoch.current === token) setPending(p); }).catch(() => {});
    };
    const timer = window.setInterval(reload, 20000);
    document.addEventListener('visibilitychange', reload);
    return () => {
      epoch.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reload);
    };
  }, [client, connected, capsuleId, versionId]);
  async function guard(p: Promise<any>) {
    const token = epoch.current,
      r = await p;
    if (token !== epoch.current) throw new Error('页面或身份已改变。');
    return r;
  }
  async function run(fn: () => Promise<any>) {
    if (working.current) return;
    const token = epoch.current;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (token === epoch.current) setError(capsuleError(e));
    } finally {
      if (token === epoch.current) {
        if (writable)
          try {
            setPending(await guard(requiredClient().pending()));
          } catch {}
        working.current = false;
        setBusy(false);
      }
    }
  }
  async function find(after?: string, token = epoch.current) {
    const r = await requiredClient().query({
      query,
      ...(onlyMine && subjectId ? { authorId: subjectId } : {}),
      ...(after ? { after } : {}),
      limit: 12,
    });
    if (token !== epoch.current) return;
    setItems((old) => (after ? [...old, ...r.items] : r.items));
    setNext(r.nextAfter);
    setLoaded(true);
  }
  async function readDetail(
    id = capsuleId,
    version = versionId,
    token = epoch.current,
  ) {
    setDetail(null);
    setUses({ items: [] });
    const [d, v] = await Promise.allSettled([
      requiredClient().get({ capsuleId: id, ...(version ? { versionId: version } : {}) }),
      requiredClient().versions({ capsuleId: id, limit: 50 }),
    ]);
    if (token !== epoch.current) return;
    if (v.status === 'fulfilled') setVersions(v.value);
    else setVersions({ items: [] });
    if (d.status === 'rejected') throw d.reason;
    setDetail(d.value);
    const u = await requiredClient().uses({
      capsuleId: id,
      versionId: d.value.versionId,
      limit: 20,
    });
    if (token === epoch.current) setUses(u);
  }
  async function moreVersions() {
    const r = await guard(
      requiredClient().versions({ capsuleId, after: versions.nextAfter, limit: 50 }),
    );
    setVersions((v: any) => ({ ...r, items: [...v.items, ...r.items] }));
  }
  async function loadHistory(after?: string) {
    const h = await guard(requiredClient().history(after ? { after } : {}));
    setHistory((old) =>
      after
        ? [...old, ...h.items.filter((i: any) => i.kind === 'case-history')]
        : h.items.filter((i: any) => i.kind === 'case-history'),
    );
    setHistoryNext(h.nextCursor);
    setHistoryLoaded(true);
  }
  async function loadPermissions(view: string, after?: string) {
    const p = await guard(
      requiredClient().permissions({ view, limit: 30, ...(after ? { after } : {}) }),
    );
    setPermissions((old: any) => ({
      ...old,
      [view]: after ? [...old[view], ...p.items] : p.items,
    }));
    setPermissionNext((old: any) => ({ ...old, [view]: p.nextAfter }));
  }
  async function propose(type: string, payload: any, disclosure: any) {
    const p = await guard(requiredClient().prepare(type, payload, disclosure));
    setPreview(p);
    setNotice('仅生成本机操作预览，尚未签署或写入。');
  }
  async function execute() {
    if (!preview) return;
    const chosen = preview;
    await guard(requiredClient().execute(chosen, { confirmed: true }));
    setPreview(null);
    setNotice('原操作已取得精确回执。当前正文和来源状态仍以刷新后的结果为准。');
    if (chosen.type === 'publication') {
      navigate(
        exactCapsulePath(
          chosen.payload.capsuleId,
          chosen.payload.kind === 'version'
            ? chosen.payload.id
            : chosen.payload.versionId,
        ),
      );
    } else if (chosen.type === 'permission') {
      await loadPermissions('owned');
      await loadPermissions('granted');
    } else if (capsuleId) await readDetail();
  }
  const owned = detail?.authorId === subjectId,
    selectedVersion = versions.items.find(
      (v: any) => v.versionId === detail?.versionId,
    );
  return (
    <section aria-busy={busy}>
      <div className="eyebrow">把可复用的方法带回自己的工作</div>
      <h1 className="small">Capsule 方法与应用</h1>
      <p className="lead">
        查看问题模式、环境、策略和限制。你的模型解释适用差异，你决定是否采用；银河记录来源和实际工作依据。
      </p>
      <div className="button-row">
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/app/capsules')}
        >
          查找方法
        </Button>
        <Button
          type="button"
          disabled={!writable || busy}
          onClick={() => {
            setMode('author');
            setPreview(null);
          }}
        >
          整理本机草稿
        </Button>
        <Button
          type="button"
          disabled={!writable || busy}
          onClick={() => {
            setMode('permissions');
            setPreview(null);
            run(async () => {
              await loadPermissions('owned');
              await loadPermissions('granted');
            });
          }}
        >
          来源许可
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => navigate('/app/rooms')}
        >
          普通聊天
        </Button>
      </div>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {notice && <output className="message">{notice}</output>}
      {!connected && (
        <p className="message">
          公开版本可以直接阅读。记录应用或整理发布时，请先
          <Button
            type="button"
            variant="link"
            onClick={() => navigate('/app/settings/identity')}
          >
            连接身份
          </Button>
          。
        </p>
      )}
      {!!pending.length && (
        <details open>
          <summary>原操作回执与本机重试</summary>
          {pending.map((op) => (
            <article className="task-card" key={op.operationId}>
              <p>
                {op.type === 'publication'
                  ? '发布或维护'
                  : op.type === 'use'
                    ? '引用或应用'
                    : '来源许可'}{' '}
                ·{' '}
                {op.state === 'stopped-local'
                  ? '已停止本机重试'
                  : '结果等待核对'}
              </p>
              <code>{op.operationId}</code>
              <div className="button-row">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await guard(requiredClient().reconcile(op.operationId));
                      setNotice(
                        r.state === 'acknowledged'
                          ? '原操作曾经写入。请刷新当前内容；回执不等于来源现在仍可用。'
                          : '未查到原操作回执；这不能证明尚在途的请求已取消。',
                      );
                    })
                  }
                >
                  查询原操作
                </Button>
                {op.state !== 'stopped-local' && (
                  <>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await guard(
                            requiredClient().retry(op.operationId, { confirmed: true }),
                          );
                          setNotice('原操作已确认。请刷新当前内容。');
                        })
                      }
                    >
                      确认重试原内容
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await guard(
                            requiredClient().stopLocalRetry(op.operationId, {
                              confirmed: true,
                            }),
                          );
                          setNotice(
                            r.state === 'acknowledged'
                              ? '原操作已经写入。'
                              : '本机正文和签名已移除，不再重试；服务端取消尚未确认。',
                          );
                        })
                      }
                    >
                      停止本机重试
                    </Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </details>
      )}
      {!capsuleId && mode === 'browse' && (
        <>
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => find());
            }}
          >
            <Input
              aria-label="查找 Capsule"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="问题模式或方法标题"
            />
            <Button type="submit" disabled={!client || busy}>
              查找
            </Button>
            <label>
              <input
                type="checkbox"
                checked={onlyMine}
                disabled={!writable || busy}
                onChange={(e) => setOnlyMine(e.target.checked)}
              />
              仅我发布的
            </label>
          </form>
          <div className="result-list">
            {items.map((item) => (
              <article className="task-card" key={item.capsuleId}>
                <h2>{item.title}</h2>
                <p>{item.problemPattern}</p>
                <p>
                  版本 {item.sourceVersion} · {capsuleLabel(item.sourceStatus)}
                  {item.synthetic ? ' · 演示记录' : ''}
                  {item.deprecated ? ' · 已停用' : ''}
                  {item.securityIssue ? ' · 有安全事项' : ''}
                </p>
                <Button
                  type="button"
                  onClick={() =>
                    navigate(exactCapsulePath(item.capsuleId, item.versionId))
                  }
                >
                  阅读这一版本
                </Button>
              </article>
            ))}
          </div>
          {loaded && !items.length && (
            <p className="empty-state">
              当前没有符合条件的可见
              Capsule。可以继续让模型探索、寻找开放协助，或发布任务；没有记录不代表没有人能帮助。
            </p>
          )}
          {next && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => run(() => find(next))}
            >
              更多方法
            </Button>
          )}
        </>
      )}
      {capsuleId && (
        <>
          <div className="button-row">
            <Button
              type="button"
              disabled={busy}
              onClick={() => run(() => readDetail())}
            >
              刷新当前来源与版本
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => navigate(exactCapsulePath(capsuleId))}
            >
              明确查询最新版
            </Button>
          </div>
          {!!versions.items.length && (
            <div className="task-card">
              <h2>可读版本</h2>
              <p>
                选择旧版保持原版本，不自动升级。版本列表仅表示当前权限范围。
              </p>
              <div className="button-row">
                {versions.items.map((v: any) => (
                  <Button
                    type="button"
                    variant={
                      v.versionId === detail?.versionId ? 'default' : 'outline'
                    }
                    key={v.versionId}
                    onClick={() =>
                      navigate(exactCapsulePath(capsuleId, v.versionId))
                    }
                  >
                    v{v.version} · {capsuleLabel(v.sourceStatus)}
                  </Button>
                ))}
              </div>
              {versions.nextAfter && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => run(moreVersions)}
                >
                  更多可读版本
                </Button>
              )}
            </div>
          )}
          {detail && (
            <article className="task-body">
              <span className="tag">{capsuleLabel(detail.sourceStatus)}</span>
              {detail.synthetic && (
                <span className="tag">合成演示，不计真实试点</span>
              )}
              {detail.version ? (
                <>
                  <h2>
                    {detail.version.title} · v{detail.version.version}
                  </h2>
                  <p>{detail.version.problemPattern}</p>
                  <dl>
                    <dt>环境</dt>
                    <dd>
                      {detail.version.environment.name} /{' '}
                      {detail.version.environment.version}
                    </dd>
                    <dt>策略与实际做法</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>
                      {detail.version.solutionStrategy}
                    </dd>
                    <dt>工具 / Skill / MCP</dt>
                    <dd>
                      {[
                        ...detail.version.tools,
                        ...detail.version.skills,
                        ...detail.version.mcpRefs,
                      ].join('、') || '未列出'}
                    </dd>
                    <dt>验证方法</dt>
                    <dd>{detail.version.verificationMethod}</dd>
                    <dt>适用范围</dt>
                    <dd>{detail.version.applicableScope}</dd>
                    <dt>限制与可能失败的条件</dt>
                    <dd>
                      <ul>
                        {detail.version.limitations.map(
                          (x: string, i: number) => (
                            <li key={i}>{x}</li>
                          ),
                        )}
                      </ul>
                    </dd>
                    <dt>许可</dt>
                    <dd>
                      {detail.version.license}；来源许可和共同署名分别成立。
                    </dd>
                  </dl>
                  <details>
                    <summary>精确来源、参与者与外部链接</summary>
                    <p>
                      来源 Case：
                      <code>{detail.version.sourceResolution.caseId}</code>
                      ；结果：
                      <code>{detail.version.sourceResolution.resultId}</code> v
                      {detail.version.sourceResolution.resultVersion ??
                        '历史版未独立记录'}
                    </p>
                    {(detail.attributions ?? []).map((a: any, i: number) => (
                      <p key={i}>
                        {a.subjectId} · {a.source.kind} v{a.source.version}
                        （来源作者归属，不冒充共同署名同意）
                      </p>
                    ))}
                    {(detail.permissions ?? []).map((p: any) => (
                      <p key={p.permissionId}>
                        {p.authorId}：{p.scope}；{p.attribution}
                      </p>
                    ))}
                    {(detail.version.externalReferences ?? []).map((r: any) => (
                      <p key={r.url}>
                        {/^https?:\/\//i.test(r.url) ? (
                          <a href={r.url} target="_blank" rel="noreferrer">
                            {r.description}
                          </a>
                        ) : (
                          r.description
                        )}{' '}
                        · 仅引用链接，未导入原内容；许可：{r.license ?? '未知'}
                      </p>
                    ))}
                  </details>
                  <p className="muted">
                    源结果是参与者报告；不等于问题已解决、独立验证通过或专家认证。单纯阅读不会生成应用。
                  </p>
                </>
              ) : (
                <p className="message">
                  原来源当前不可用，正文已隐藏。历史操作回执不恢复当前阅读权限。
                </p>
              )}
              {(detail.deprecated ||
                detail.securityIssue ||
                !detail.newApplicationAllowed) && (
                <p className="message">
                  此版本目前不能新增实际应用或再验证；历史事实保留原状态。
                </p>
              )}
              {(detail.notices ?? []).map((n: any) => (
                <p key={n.id}>
                  {capsuleLabel(n.kind)}：{n.summary}
                </p>
              ))}
               {owned && (
                 <div className="button-row">
                     <Button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setMode('revision');
                        setPreview(null);
                      }}
                    >
                       {detail.version?'基于此版整理新版本':'用新合法来源整理空白修复版本'}
                     </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setMode('maintenance');
                      setPreview(null);
                    }}
                  >
                    维护这一版本
                  </Button>
                </div>
              )}
            </article>
          )}
          <section>
            <h2>参考、实际应用与再验证</h2>
            <p>
              下列数量仅覆盖当前可见记录。重复查看、同一案例的多条检查不会变成多次成功复用。
            </p>
            {uses.counts && (
              <p>
                参考 {uses.counts.references} · 实际应用{' '}
                {uses.counts.applications} · 再验证{' '}
                {uses.counts.reverifications} · 演示应用{' '}
                {uses.counts.syntheticApplications} · 当前真实目标案例{' '}
                {uses.counts.distinctTargetCases}
              </p>
            )}
            {uses.items.map((u: any) => (
              <article className="task-card" key={u.eventId}>
                <h3>
                  {capsuleLabel(u.kind)} · {capsuleLabel(u.sourceStatus)}
                </h3>
                <p>{u.subjectId}</p>
                {u.record ? (
                  <>
                    <p>{u.record.note}</p>
                    {u.record.environment && (
                      <p>
                        {u.record.environment.name} /{' '}
                        {u.record.environment.version}：
                        {u.record.environmentDifference}
                      </p>
                    )}
                    <p>
                      {u.reportedOutcome
                        ? capsuleLabel(u.reportedOutcome)
                        : '没有声明执行或成功'}
                    </p>
                    {u.record.adoptedParts && (
                      <p>实际采用：{u.record.adoptedParts.join('；')}</p>
                    )}
                    {u.verifications?.map((v: any) => (
                      <p key={`${v.id}:${v.version}`}>
                        检查 v{v.version}：{v.referenceStatus} ·{' '}
                        {v.record?.summary ?? '正文当前不可用'}
                      </p>
                    ))}
                    {u.record.taskId && (
                      <Button
                        type="button"
                        variant="link"
                        onClick={() =>
                          navigate(`/app/tasks/${u.record.taskId}`)
                        }
                      >
                        返回这项真实任务
                      </Button>
                    )}
                  </>
                ) : (
                  <p>原应用或其来源目前不可用，保留最小记录。</p>
                )}
              </article>
            ))}
            {uses.nextAfter && (
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const page = await guard(
                      requiredClient().uses({
                        capsuleId,
                        versionId: detail.versionId,
                        after: uses.nextAfter,
                        limit: 20,
                      }),
                    );
                    setUses((old: any) => ({
                      ...page,
                      items: [...old.items, ...page.items],
                    }));
                  })
                }
              >
                更多应用记录
              </Button>
            )}
            {writable && detail?.version && (
              <fieldset disabled={busy || !!preview}>
                <CapsuleApplication
                  key={detail.versionId}
                  {...{
                    detail,
                    history,
                    historyLoaded,
                    historyNext,
                    loadHistory,
                    uses,
                    subjectId,
                    busy,
                    run,
                    propose,
                    navigate,
                  }}
                />
              </fieldset>
            )}
          </section>
        </>
      )}
      {writable && ['author', 'revision', 'maintenance'].includes(mode) && (
        <fieldset disabled={busy || !!preview}>
          <CapsuleAuthoring
            key={`${mode}:${detail?.versionId ?? 'new'}`}
            {...{
              runtime,
              client,
              subjectId,
              history,
              historyLoaded,
              historyNext,
              loadHistory,
              permissions,
              permissionNext,
              loadPermissions,
              busy,
              run,
              propose,
              navigate,
            }}
            mode={mode}
            detail={detail}
            management={versions.management}
            disclosure={selectedVersion?.disclosure}
            versionOptions={versions.items}
          />
        </fieldset>
      )}
      {writable && mode === 'permissions' && (
        <fieldset disabled={busy || !!preview}>
          <CapsulePermissionWorkspace
            {...{
              runtime,
              subjectId,
              history,
              historyLoaded,
              historyNext,
              loadHistory,
              permissions,
              permissionNext,
              loadPermissions,
              busy,
              run,
              propose,
              navigate,
            }}
          />
        </fieldset>
      )}
      {preview && (
        <section className="task-card">
          <h2>确认这一次操作</h2>
          <p>
            {preview.type === 'publication'
              ? preview.payload.kind === 'version'
                ? `发布 v${preview.payload.version}：${preview.payload.title}`
                : `维护：${capsuleLabel(preview.payload.kind)}`
              : preview.type === 'use'
                ? capsuleLabel(preview.payload.kind)
                : preview.payload.kind === 'grant'
                  ? '授予选定来源许可'
                  : '撤销选定来源许可'}
          </p>
          <p>
            范围：
            {preview.visibility === 'Public'
              ? '面向公众'
              : '仅本人及下列选定人员'}
            ；{preview.viewers.join('、') || '无额外阅读者'}。
          </p>
          <p>
            {preview.payload.note ??
              preview.payload.summary ??
              preview.payload.scope ??
              preview.payload.reason ??
              preview.payload.problemPattern}
          </p>
          {preview.payload.solutionStrategy && (
            <p style={{ whiteSpace: 'pre-wrap' }}>
              即将发布的策略：{preview.payload.solutionStrategy}
            </p>
          )}
          {preview.payload.sources && (
            <p>
              选定来源 {preview.payload.sources.length} 条；获许可人：
              {preview.payload.grantees.join('、')}。
              {preview.payload.allowPublic
                ? '允许按此许可公开选定内容。'
                : '不允许公开。'}
            </p>
          )}
          {preview.payload.kind === 'version' && (
            <dl>
              <dt>问题与范围</dt>
              <dd>
                {preview.payload.problemPattern}；
                {preview.payload.applicableScope}
              </dd>
              <dt>环境</dt>
              <dd>
                {preview.payload.environment.name} /{' '}
                {preview.payload.environment.version}
              </dd>
              <dt>工具、Skill、MCP</dt>
              <dd>
                {[
                  ...preview.payload.tools,
                  ...preview.payload.skills,
                  ...preview.payload.mcpRefs,
                ].join('、') || '无'}
              </dd>
              <dt>验证方法</dt>
              <dd>{preview.payload.verificationMethod}</dd>
              <dt>限制</dt>
              <dd>{preview.payload.limitations.join('；')}</dd>
              <dt>许可与来源</dt>
              <dd>
                {preview.payload.license}；主结果{' '}
                {preview.payload.sourceResolution.resultId} v
                {preview.payload.sourceResolution.resultVersion}；附加来源{' '}
                {preview.payload.sourceRefs.length} 条；许可{' '}
                {preview.payload.permissionRefs.length} 项；
                {preview.payload.synthetic ? '合成演示' : '非演示标记'}
              </dd>
              <dt>贡献署名</dt>
              <dd>
                {preview.payload.contributors.join('、') || '没有新增署名'}
              </dd>
              <dt>外部链接</dt>
              <dd>
                {preview.payload.externalReferences
                  .map((r: any) => `${r.description}: ${r.url}`)
                  .join('；') || '无'}
              </dd>
            </dl>
          )}
          {preview.type === 'use' && (
            <p>
              Capsule精确版本：{preview.payload.versionId}；目标Case：
              {preview.payload.caseId}。
              {preview.payload.resultRef && (
                <>
                  结果 {preview.payload.resultRef.id} v
                  {preview.payload.resultRef.version} ·{' '}
                  {capsuleLabel(preview.payload.outcome)}；环境差异：
                  {preview.payload.environmentDifference}；实际采用：
                  {preview.payload.adoptedParts.join('；')}。
                </>
              )}
              {preview.payload.verificationRefs && (
                <>
                  再验证引用 {preview.payload.verificationRefs.length}{' '}
                  条精确版本检查。
                </>
              )}
            </p>
          )}
          {preview.type === 'permission' &&
            preview.payload.kind === 'grant' && (
              <p>
                许可：{preview.payload.license}；依据：{preview.payload.basis}{' '}
                {preview.payload.licenseReference ?? ''}；署名：
                {preview.payload.attribution}；额外截止：
                {preview.payload.expiresAt ?? '未另指定，仍受签名有效期限制'}。
              </p>
            )}
          <p className="muted">
            本机预览尚未发送。确认后签署这些精确内容；发布不自动证明实际复用、法律权利或共同署名。
          </p>
          <div className="button-row">
            <Button type="button" disabled={busy} onClick={() => run(execute)}>
              确认以上内容并提交
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              取消本次预览
            </Button>
          </div>
        </section>
      )}
      {writable && capsuleId && !detail && versions.management && <section className="task-card"><p>本人管理关系仍有效，但当前版本正文不可读取。可重新选择合法来源整理空白新版本，旧授权和旧正文不会恢复。</p><Button type="button" disabled={busy} onClick={()=>{setDetail({capsuleId,versionId:versionId??null,authorId:subjectId,version:null});setMode('revision');setPreview(null);}}>整理空白修复版本</Button></section>}
      {writable && <CapsuleConsentControls {...{runtime,subjectId,busy,run}} targets={[
        ...versions.items.filter((v:any)=>v.ownerControl).map((v:any)=>({...v.ownerControl,label:`本人发布版本 v${v.version}`})),
        ...uses.items.filter((u:any)=>u.ownerControl).map((u:any)=>({...u.ownerControl,label:`本人${capsuleLabel(u.kind)} · ${u.recordedAt}`})),
      ]} onChanged={async()=>{if(capsuleId)try{await readDetail();}catch(e:any){if(![403,404].includes(e.status))throw e;setDetail(null);setUses({items:[]});setNotice('当前展示已关闭；原事实与授权回执按各自规则保留。');}else await find();}}/>}
      <p className="return-note">
        回到原聊天后，由你的模型结合所选版本继续工作。关闭此页不会新增应用，也不会取消已有任务。
      </p>
    </section>
  );
}
