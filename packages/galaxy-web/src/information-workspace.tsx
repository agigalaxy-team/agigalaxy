import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createInformationClientV2 } from './information-client-v2.mjs';
type Props = {
  runtime: any;
  subjectId?: string;
  connected: boolean;
  navigate: (path: string) => void;
  onNeedIdentity?: () => void;
  watchId?: string;
};
const sourceNames: Record<string, string> = {
  history: '经历与能力事实',
  capsule: 'Capsule 与复用',
  proof: '验证凭据',
  task: '开放任务',
  opportunity: '项目、模块与交流意愿',
  honor: '限定范围的 Honor',
};
const stateNames: Record<string, string> = {
  available: '有当前可见资料',
  'no-visible-data': '当前没有可见资料',
  'temporarily-unavailable': '来源暂不可用',
  active: '已开启',
  paused: '已暂停',
  ended: '已结束',
  expired: '已到期',
};
const time = (v: any) =>
  v
    ? new Date(typeof v === 'number' ? v * 1000 : v).toLocaleString()
    : '尚无记录';
const message = (e: unknown) =>
  e instanceof Error ? e.message : '读取未完成，请重试。';
const ruleKey = (r: any) =>
  (r.id ?? r.ruleId) + '@' + (r.version ?? r.ruleVersion);
function scopeTitle(s: any) {
  return s.source.kind === 'honor'
    ? '限定 Honor：' + s.source.request.ruleId
    : s.source.kind === 'reference'
      ? '指定资料：' + s.source.request.ref.id
      : (sourceNames[s.source.request.type] ?? s.source.request.type);
}
function itemLink(item: any) {
  const type = item.type ?? item.recordKind;
  if (type === 'task') return '/app/tasks/' + item.ref?.id;
  if (type === 'capsule')
    return (
      '/app/capsules/' +
      (item.record?.capsuleId ?? item.record?.id ?? item.ref?.id)
    );
  if (type === 'opportunity') return '/app/match';
  return null;
}
function FactSummary({ item }: { item: any }) {
  const r = item.record ?? {},
    request = r.request ?? {},
    fact = r.record ?? r;
  const fields = [
    ['资料类型', item.recordKind ?? item.type],
    ['当前状态', item.sourceStatus ?? r.state ?? r.status],
    ['适用范围', r.applicableScope ?? r.rule?.scope ?? request.expectedOutcome],
    ['环境', fact.environment ?? fact.conditions?.environment],
    [
      '配置版本',
      fact.configurationRef ? JSON.stringify(fact.configurationRef) : undefined,
    ],
    [
      '结果与局限',
      fact.outcome ?? fact.resolution ?? request.summary ?? item.summary,
    ],
    ['原始发生时间', fact.at ?? fact.createdAt ?? r.createdAt],
    ['验证方式', fact.method ?? fact.verification],
  ].filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  return (
    <>
      <dl>
        {fields.map(([label, value]) => (
          <React.Fragment key={String(label)}>
            <dt>{String(label)}</dt>
            <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
          </React.Fragment>
        ))}
      </dl>
      <details>
        <summary>准确来源、介入记录与适用局限</summary>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            maxHeight: 360,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(
            {
              source: item.source,
              record: item.record,
              supportingItems: item.supportingItems,
              limitations: item.limitations,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </>
  );
}
export function InformationWorkspace({
  runtime,
  subjectId,
  connected,
  navigate,
  onNeedIdentity,
  watchId,
}: Props) {
  const client = useMemo(
    () => (runtime ? createInformationClientV2({ runtime, subjectId }) : null),
    [runtime, subjectId, connected],
  );
  const [purpose, setPurpose] = useState('了解与当前工作有关的可用帮助'),
    [query, setQuery] = useState(''),
    [types, setTypes] = useState(['history', 'capsule', 'task']);
  const [windowKind, setWindowKind] = useState('all-visible'),
    [environment, setEnvironment] = useState(''),
    [functions, setFunctions] = useState(''),
    [technologies, setTechnologies] = useState('');
  const [page, setPage] = useState<any>(null),
    [fresh, setFresh] = useState<any>(null),
    [selected, setSelected] = useState<any[]>([]);
  const [watchPurpose, setWatchPurpose] = useState(''),
    [expires, setExpires] = useState(''),
    [report, setReport] = useState('changes'),
    [reportTime, setReportTime] = useState('09:00');
  const [editing, setEditing] = useState<any>(null);
  const [watches, setWatches] = useState<any[]>([]),
    [watchAfter, setWatchAfter] = useState<string | null>(null),
    [events, setEvents] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [pending, setPending] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]),
    [rule, setRule] = useState(''),
    [honorSubject, setHonorSubject] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [lastHostCheck, setLastHostCheck] = useState<number | null>(null);
  const epoch = useRef(0),
    working = useRef(false);
  const visibleSubjects = useMemo(
    () => [
      ...new Set(
        [
          subjectId,
          ...(page?.items ?? []).flatMap((s: any) =>
            s.items.flatMap((i: any) => [
              i.record?.subjectId,
              i.record?.actorId,
              i.record?.requesterId,
              i.record?.authorId,
              i.record?.ownerId,
            ]),
          ),
        ].filter(
          (s: any) => typeof s === 'string' && /^GUID[0-9A-Z]{28}$/.test(s),
        ),
      ),
    ],
    [page, subjectId],
  );
  async function refresh(valid: () => boolean, after?: string) {
    if (!client || !connected) return;
    const [r, p] = await Promise.all([
      client.watches({ limit: 20, ...(after ? { after } : {}) }),
      client.pending(),
    ]);
    if (valid()) {
      setWatches((old) => (after ? [...old, ...r.items] : r.items));
      setWatchAfter(r.nextAfter);
      setPending(p);
    }
  }
  async function run(fn: (valid: () => boolean) => Promise<void>) {
    if (working.current || !client) return;
    const token = epoch.current,
      valid = () => token === epoch.current;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await fn(valid);
    } catch (e) {
      if (valid()) setError(message(e));
    } finally {
      if (valid()) {
        try {
          const p = await client.pending();
          if (valid()) setPending(p);
        } catch {}
        if (valid()) {
          working.current = false;
          setBusy(false);
        }
      }
    }
  }
  useEffect(() => {
    const token = ++epoch.current,
      valid = () => epoch.current === token;
    working.current = false;
    setBusy(false);
    setPage(null);
    setFresh(null);
    setEvents(null);
    setPreview(null);
    setPending([]);
    setWatches([]);
    setSelected([]);
    setLastHostCheck(null);
    setError('');
    setEditing(null);
    if (client && connected)
      refresh(valid)
        .then(async () => {
          if (watchId) {
            const view = await client.events(watchId);
            if (valid()) setEvents(view);
          }
        })
        .catch((e) => {
          if (valid()) setError(message(e));
        });
    return () => {
      epoch.current++;
    };
  }, [client, watchId, connected]);
  // Existing explicit watch configuration is the authorization to check. This
  // timer lives only in this mounted foreground page; it does no model work.
  useEffect(() => {
    if (!client || !connected) return;
    const token = epoch.current;
    const handle = setInterval(() => {
      if (
        document.visibilityState !== 'visible' ||
        working.current ||
        token !== epoch.current
      )
        return;
      run(async (valid) => {
        const r = await client.checkDue();
        if (valid() && r.items.length) {
          setLastHostCheck(Math.floor(Date.now() / 1000));
          setNotice(r.items.some((i:any)=>i.state==='check-failed')?'部分关注检查未完成，请查看状态后重试；其他范围已分别处理。':'已检查开启的关注范围；无变化时不会调用模型。');
          await refresh(valid);
        }
      });
    }, 60000);
    return () => clearInterval(handle);
  }, [client, connected]);
  function inputSources() {
    return types.map((type: any) => {
      const q: any = { query: query.trim(), limit: 8 };
      if (type === 'history') {
        q.timeWindow = { kind: windowKind };
        if (environment.trim()) q.context = { environment: environment.trim() };
      }
      if (type === 'opportunity') {
        const tags = functions
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
          tech = technologies
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (!tags.length)
          throw Error('发现交流意愿时，请填写至少一项需要的功能。');
        return {
          key: type,
          source: {
            kind: 'search',
            request: {
              type,
              query: {
                context: {
                  kind: 'ephemeral',
                  title: purpose.trim(),
                  functions: tags,
                  technologies: tech,
                },
                purposes: [
                  'conversation',
                  'reuse',
                  'collaboration',
                  'recruitment',
                ],
                limit: 8,
              },
            },
          },
        };
      }
      return {
        key: type,
        source: { kind: 'search', request: { type, query: q } },
      };
    });
  }
  async function search(valid: () => boolean) {
    if (!client) return;
    if (!types.length) throw Error('请至少选择一个资料来源。');
    const result = await client.query({
      purpose: purpose.trim(),
      sources: inputSources(),
    });
    if (valid()) {
      setPage(result);
      setFresh(null);
      setNotice(
        '按各来源当前授权读取。没有历史不表示没有能力；可继续选择其他帮助路径。',
      );
    }
  }
  function selectScope(selection: any) {
    setSelected((old) => {
      const same = old.find(
        (s) => JSON.stringify(s.source) === JSON.stringify(selection.source),
      );
      if (same) return old;
      if (old.length >= 4) {
        setError('每份关注最多选择四个来源，可另建关注。');
        return old;
      }
      return [
        ...old,
        {
          ...selection,
          key: 'source_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20),
        },
      ];
    });
    if (!watchPurpose) setWatchPurpose(purpose);
  }
  async function prepareAction(command: any, valid: () => boolean) {
    if (!client) return;
    const record = await client.prepare(command);
    if (valid()) {
      setPreview(record);
      setPending(await client.pending());
      setNotice('这份预览仅保存在当前浏览器，尚未改变关注状态。');
    }
  }
  async function prepareWatch(valid: () => boolean) {
    if (!connected) {
      onNeedIdentity ? onNeedIdentity() : navigate('/app/settings/identity');
      return;
    }
    const deadline = Math.floor(new Date(expires).getTime() / 1000);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() / 1000)
      throw Error('请选择未来的关注截止时间。');
    const [h, m] = reportTime.split(':').map(Number),
      local = new Date();
    local.setHours(h, m, 0, 0);
    const detail =
      report === 'daily'
        ? {
            mode: 'daily',
            utcMinute: local.getUTCHours() * 60 + local.getUTCMinutes(),
          }
        : { mode: 'changes' };
    await prepareAction(
      {
        operationId: crypto.randomUUID(),
        watchId: editing?.watchId ?? crypto.randomUUID(),
        expectedRevision: editing?.revision ?? 0,
        action: editing ? 'revise' : 'start',
        plan: {
          purpose: watchPurpose.trim(),
          sources: selected,
          expiresAt: deadline,
          report: detail,
        },
      },
      valid,
    );
  }
  const name = (s: string) => stateNames[s] ?? s;
  return (
    <section aria-busy={busy}>
      <div className="eyebrow">按需信息服务</div>
      <h1 className="small">资料查询与变化关注</h1>
      <p className="lead">
        一起查看能力事实、尝试、验证、可复用内容和当前参与条件。银河提供来源与选择依据，由你和自己的
        Agent 判断下一步。
      </p>
      <div className="button-row">
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/app/search')}
        >
          继续当前 AI · 查询帮助
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/app/capsules')}
        >
          Capsule 与历史方案
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/app/publish')}
        >
          开放或赏金协助
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/app/match')}
        >
          发现与匹配
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/app/participate')}
        >
          参与任务
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate('/app/rooms')}
        >
          普通聊天
        </Button>
      </div>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="message">
          {notice}
        </p>
      )}
      {!connected && (
        <p className="message">
          可以先浏览公开资料。保存私有关注前需要连接身份。
          <Button
            type="button"
            onClick={() =>
              onNeedIdentity
                ? onNeedIdentity()
                : navigate('/app/settings/identity')
            }
          >
            连接身份
          </Button>
        </p>
      )}
      <form
        className="workspace-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(search);
        }}
      >
        <fieldset disabled={busy || !client}>
          <legend>这次想了解什么</legend>
          <label>
            用途
            <Input
              required
              maxLength={300}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </label>
          <label>
            关键词（可留空，最多八项）
            <Input
              maxLength={200}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="button-row">
            {Object.entries(sourceNames)
              .filter(([k]) => k !== 'honor')
              .map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={types.includes(key)}
                    onChange={(e) =>
                      setTypes((old) =>
                        e.target.checked
                          ? [...old, key]
                          : old.filter((t) => t !== key),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
          </div>
          {types.includes('history') && (
            <>
              <label>
                经历时间范围
                <select
                  value={windowKind}
                  onChange={(e) => setWindowKind(e.target.value)}
                >
                  <option value="all-visible">全部当前可见记录</option>
                  <option value="90-days">最近 90 天</option>
                  <option value="365-days">最近一年</option>
                </select>
              </label>
              <label>
                适用环境（可选）
                <Input
                  maxLength={160}
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                />
              </label>
            </>
          )}
          {types.includes('opportunity') && (
            <>
              <label>
                需要的功能，逗号分隔
                <Input
                  value={functions}
                  onChange={(e) => setFunctions(e.target.value)}
                />
              </label>
              <label>
                相关技术，逗号分隔
                <Input
                  value={technologies}
                  onChange={(e) => setTechnologies(e.target.value)}
                />
              </label>
              <p>
                临时查询无需先创建项目；交流、复用、协作和招募意愿分别来自当前声明。
              </p>
            </>
          )}
          <Button type="submit">查询所选来源</Button>
        </fieldset>
      </form>
      {page && (
        <div>
          <p className="muted">
            本次观察：{time(page.observedAt)} · 查询方式 {page.method.version} ·
            原记录的发生时间与验证范围保持独立。查询标识{' '}
            {page.queryId.slice(0, 16)}…
          </p>
          {page.items.map((s: any) => (
            <article className="panel" key={s.key}>
              <h2>
                {scopeTitle(s)} · {name(s.state)}
              </h2>
              <p>
                {s.state === 'no-visible-data'
                  ? '可以调整范围、联系愿意参与的人，或发布新的请求。'
                  : s.state === 'temporarily-unavailable'
                    ? '这个来源暂时未完成，其他来源的结果仍可使用。'
                    : '以下是当前有权读取的这一页，不能视为全网排名或全部资料。'}
              </p>
              <p className="muted">
                范围 {s.scope} · 方法 {s.method.id} / {s.method.version} · 本页{' '}
                {s.items.length} 项
              </p>
              <div className="button-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => selectScope({ key: s.key, source: s.source })}
                >
                  选择关注此查询范围
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async (valid) => {
                      if (!client) return;
                      const result = await client.query({
                        purpose: page.purpose,
                        sources: [{ key: s.key, source: s.source }],
                      });
                      if (valid())
                        setPage((old: any) => ({
                          ...old,
                          items: old.items.map((i: any) =>
                            i.key === s.key ? result.items[0] : i,
                          ),
                        }));
                    })
                  }
                >
                  重新读取此来源
                </Button>
              </div>
              {s.items.map((item: any) => (
                <div className="message" key={item.id}>
                  <h3>{item.title ?? item.id}</h3>
                  <FactSummary item={item} />
                  <p className="muted">
                    当前来源版本 {String(item.sourceVersion).slice(0, 16)}… ·{' '}
                    {item.authority ?? '来源自述，按实际证据判断'}
                  </p>
                  {item.matchReasons?.length > 0 && (
                    <p>匹配依据：{item.matchReasons.join('；')}</p>
                  )}
                  <div className="button-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        selectScope({
                          key: s.key,
                          source:
                            s.source.kind === 'honor'
                              ? s.source
                              : {
                                  kind: 'reference',
                                  request: {
                                    search:
                                      s.source.kind === 'reference'
                                        ? s.source.request.search
                                        : s.source.request,
                                    ref: item.ref,
                                  },
                                },
                        })
                      }
                    >
                      只关注这一项资料
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        run(async (valid) => {
                          if (!client) return;
                          const selection =
                            s.source.kind === 'honor'
                              ? s.source
                              : {
                                  kind: 'reference',
                                  request: {
                                    search:
                                      s.source.kind === 'reference'
                                        ? s.source.request.search
                                        : s.source.request,
                                    ref: item.ref,
                                  },
                                };
                          const result = await client.query({
                            purpose: '在选择帮助前核对当前来源',
                            sources: [{ key: 'current', source: selection }],
                          });
                          if (valid()) setFresh(result);
                        })
                      }
                    >
                      核对当前来源
                    </Button>
                    {itemLink(item) && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => navigate(itemLink(item)!)}
                      >
                        进入完整内容
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {s.nextCursor && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async (valid) => {
                      if (!client) return;
                      const source = structuredClone(s.source);
                      if (source.kind === 'honor')
                        source.request.after = s.nextCursor;
                      else source.request.query.after = s.nextCursor;
                      const result = await client.query({
                        purpose: page.purpose,
                        sources: [{ key: s.key, source }],
                      });
                      if (valid())
                        setPage((old: any) => ({
                          ...old,
                          items: old.items.map((item: any) =>
                            item.key === s.key ? result.items[0] : item,
                          ),
                        }));
                    })
                  }
                >
                  读取这一来源下一页
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
      {fresh && (
        <article className="panel">
          <h2>重新核对的资料</h2>
          {fresh.items.map((s: any) => (
            <div key={s.key}>
              <p>
                {name(s.state)} · {time(s.observedAt)}
              </p>
              {s.items.map((i: any) => (
                <div key={i.id}>
                  <h3>{i.title}</h3>
                  <FactSummary item={i} />
                </div>
              ))}
            </div>
          ))}
        </article>
      )}
      <article className="panel">
        <h2>限定范围的 Honor</h2>
        <p>
          查看某个已知参与者的具体规则与证据范围。没有记录、证据不足和能力不足不能互相替代。
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !client}
          onClick={() =>
            run(async (valid) => {
              if (!client) return;
              const r = await client.rules();
              if (valid()) {
                setRules(
                  r.rules.filter((x: any) => x.sourceProfile === 'facts-v2'),
                );
                setNotice('已读取当前规则目录；无可用规则时保留空状态。');
              }
            })
          }
        >
          读取当前规则
        </Button>
        <label>
          参与者
          <select
            value={honorSubject}
            onChange={(e) => setHonorSubject(e.target.value)}
          >
            <option value="">从已见资料或本人中选择</option>
            {visibleSubjects.map((id: any) => (
              <option key={id} value={id}>
                {id === subjectId ? '本人' : id}
              </option>
            ))}
          </select>
        </label>
        <label>
          规则与版本
          <select value={rule} onChange={(e) => setRule(e.target.value)}>
            <option value="">选择当前规则</option>
            {rules.map((r) => (
              <option key={ruleKey(r)} value={ruleKey(r)}>
                {r.name ?? r.title ?? r.id} · {r.version}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          disabled={busy || !honorSubject || !rule}
          onClick={() =>
            run(async (valid) => {
              if (!client) return;
              const r = rules.find((r) => ruleKey(r) === rule),
                result = await client.query({
                  purpose: purpose.trim(),
                  sources: [
                    {
                      key: 'honor',
                      source: {
                        kind: 'honor',
                        request: {
                          subjectId: honorSubject,
                          ruleId: r.id ?? r.ruleId,
                          ruleVersion: r.version ?? r.ruleVersion,
                          limit: 8,
                        },
                      },
                    },
                  ],
                });
              if (valid()) setPage(result);
            })
          }
        >
          查看适用证据
        </Button>
      </article>
      <article className="panel">
        <h2>{editing ? '修订已保存的关注范围' : '明确开启变化关注'}</h2>
        <p>
          只保存所选范围、版本引用和必要变化回执。本页面打开且可见时执行到期检查；关闭页面后不承诺持续观察。每份关注最多四个来源。
        </p>
        {editing && (
          <p>
            正在修改“{editing.plan.purpose}”的版本 {editing.revision}。原状态为{' '}
            {name(editing.state)}；修改范围不会自动恢复暂停的关注。
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              改为另开关注
            </Button>
          </p>
        )}
        {selected.map((s, i) => (
          <div className="button-row" key={s.key}>
            <span>{scopeTitle(s)}</span>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                setSelected((old) => old.filter((_, n) => n !== i))
              }
            >
              移除
            </Button>
          </div>
        ))}
        {!selected.length && <p>先查询资料，再选择整个查询范围或具体一项。</p>}
        <label>
          关注用途
          <Textarea
            maxLength={300}
            value={watchPurpose}
            onChange={(e) => setWatchPurpose(e.target.value)}
          />
        </label>
        <label>
          截止时间
          <Input
            type="datetime-local"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </label>
        <label>
          提醒方式
          <select value={report} onChange={(e) => setReport(e.target.value)}>
            <option value="changes">检查发现变化后提醒</option>
            <option value="daily">明确开启每日变化汇总</option>
          </select>
        </label>
        {report === 'daily' && (
          <>
            <label>
              每日汇总时间（本机时区，保存为固定 UTC 时刻）
              <Input
                type="time"
                value={reportTime}
                onChange={(e) => setReportTime(e.target.value)}
              />
            </label>
            <p>
              只汇总实际检查发现的变化，无变化不发送报告；用户端离线期间不补造观察。
            </p>
          </>
        )}
        <Button
          type="button"
          disabled={busy || !client || !selected.length}
          onClick={() => run(prepareWatch)}
        >
          {editing ? '预览范围修改' : '预览开启范围'}
        </Button>
      </article>
      {preview && (
        <article className="message">
          <h2>确认本次关注操作</h2>
          <p>
            操作：{preview.command.action} · 预期版本{' '}
            {preview.command.expectedRevision}
          </p>
          {preview.command.plan && (
            <>
              <p>
                {preview.command.plan.purpose} · 截止{' '}
                {time(preview.command.plan.expiresAt)}
              </p>
              <ul>
                {preview.command.plan.sources.map((s: any) => (
                  <li key={s.key}>{scopeTitle(s)}</li>
                ))}
              </ul>
              <p>
                {preview.command.plan.report.mode === 'daily'
                  ? '每日固定时刻，仅发送有变化的汇总'
                  : '检查到变化后提醒'}
              </p>
            </>
          )}
          <div className="button-row">
            <Button
              type="button"
              disabled={busy || !connected}
              onClick={() =>
                run(async (valid) => {
                  if (!client) return;
                  const r = await client.execute(preview.command.operationId, {
                    confirmed: true,
                  });
                  if (valid()) {
                    setPreview(null);
                    setNotice(
                      '已保存关注状态：' +
                        name(r.state) +
                        '。尚未证明后台持续运行。',
                    );
                    await refresh(valid);
                  }
                })
              }
            >
              确认这项操作
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              暂不提交
            </Button>
          </div>
        </article>
      )}
      {connected && (
        <article className="panel">
          <h2>我的关注</h2>
          <p>
            此页面最后执行检查：{time(lastHostCheck)}
            。下面的“开启”表示配置仍有效，不能证明宿主正在运行。
          </p>
          <div className="button-row">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => run((valid) => refresh(valid))}
            >
              刷新列表
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async (valid) => {
                  if (!client) return;
                  const r = await client.checkDue();
                  if (valid()) {
                    setLastHostCheck(Math.floor(Date.now() / 1000));
                    setNotice(
                      '检查了 ' +
                        r.items.length +
                        ' 个到期范围，其中 '+r.items.filter((i:any)=>i.state==='check-failed').length+' 项未完成。未完成的范围可继续检查。',
                    );
                    await refresh(valid);
                  }
                })
              }
            >
              检查已开启范围
            </Button>
          </div>
          {!watches.length && (
            <p>没有已保存的关注。查询本身不会自动开启关注。</p>
          )}
          {watches.map((row) => (
            <div className="message" key={row.watchId}>
              <h3>
                {row.plan.purpose} · {name(row.state)}
              </h3>
              <p>
                截止 {time(row.plan.expiresAt)} · 最后检查{' '}
                {time(row.lastCheckedAt)} · 下次最早检查 {time(row.nextCheckAt)}
              </p>
              <ul>
                {row.sourceCoverage.map((s: any) => (
                  <li key={s.key}>
                    {s.key}：{name(s.state)}，
                    {s.complete
                      ? '本轮所选范围已读完'
                      : '覆盖尚未完成，不据此推断删除'}
                  </li>
                ))}
              </ul>
              <div className="button-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async (valid) => {
                      if (!client) return;
                      const r = await client.events(row.watchId);
                      if (valid()) setEvents(r);
                    })
                  }
                >
                  变化与当前资料
                </Button>
                {['active', 'paused'].includes(row.state) && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run((valid) =>
                        prepareAction(
                          {
                            operationId: crypto.randomUUID(),
                            watchId: row.watchId,
                            expectedRevision: row.revision,
                            action: row.state === 'active' ? 'pause' : 'resume',
                          },
                          valid,
                        ),
                      )
                    }
                  >
                    {row.state === 'active' ? '暂停' : '预览恢复'}
                  </Button>
                )}
                {row.state !== 'ended' && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run((valid) =>
                        prepareAction(
                          {
                            operationId: crypto.randomUUID(),
                            watchId: row.watchId,
                            expectedRevision: row.revision,
                            action: 'end',
                          },
                          valid,
                        ),
                      )
                    }
                  >
                    结束关注
                  </Button>
                )}
                {row.state !== 'ended' && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(row);
                      setSelected(row.plan.sources);
                      setWatchPurpose(row.plan.purpose);
                      setReport(row.plan.report.mode);
                      const d = new Date(row.plan.expiresAt * 1000);
                      setExpires(
                        new Date(d.getTime() - d.getTimezoneOffset() * 60000)
                          .toISOString()
                          .slice(0, 16),
                      );
                      if (row.plan.report.mode === 'daily') {
                        const t = new Date();
                        t.setUTCHours(
                          Math.floor(row.plan.report.utcMinute / 60),
                          row.plan.report.utcMinute % 60,
                          0,
                          0,
                        );
                        setReportTime(
                          String(t.getHours()).padStart(2, '0') +
                            ':' +
                            String(t.getMinutes()).padStart(2, '0'),
                        );
                      }
                      setNotice(
                        '已载入当前范围，可在上方修改后预览确认。原关注状态尚未改变。',
                      );
                    }}
                  >
                    修改范围或期限
                  </Button>
                )}
              </div>
            </div>
          ))}
          {watchAfter && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => run((valid) => refresh(valid, watchAfter))}
            >
              下一页关注
            </Button>
          )}
        </article>
      )}
      {events && (
        <article className="panel">
          <h2>{events.watch.plan.purpose} · 变化回执</h2>
          {!events.events.length && (
            <p>没有已到提醒时间的变化。首次读取的已有资料不会被当作新变化。</p>
          )}
          {events.events.map((e: any) => (
            <p key={e.id}>
              {time(e.at)} ·{' '}
              {e.changes
                .map((c: any) =>
                  c.kind === 'current-source-recheck-required'
                    ? '需按当前权限重新核对来源'
                    : c.kind === 'no-longer-in-current-scope'
                      ? '不再出现在当前所选范围（不等于已删除）'
                      : '来源或可见版本有变化',
                )
                .join('；')}
            </p>
          ))}
          {events.current.items.map((s: any) => (
            <div key={s.key}>
              <h3>
                {scopeTitle(s)} · {name(s.state)}
              </h3>
              {s.items.map((i: any) => (
                <div className="message" key={i.id}>
                  <h4>{i.title}</h4>
                  <FactSummary item={i} />
                  {itemLink(i) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => navigate(itemLink(i)!)}
                    >
                      进入完整内容
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </article>
      )}
      {pending.length > 0 && (
        <article className="panel">
          <h2>本机尚未确认的操作</h2>
          <p>
            重试使用原编号与原范围。“停止本机重试”不能保证先前在途请求已被服务端取消；已开启的关注请另行结束。
          </p>
          {pending.map((p) => {
            const id = p.command?.operationId ?? p.operationId;
            return (
              <div className="message" key={id}>
                <p>
                  {p.command?.action ?? '已停止本机重试'} · {p.state} · {id}
                </p>
                <div className="button-row">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !connected}
                    onClick={() =>
                      run(async (valid) => {
                        if (!client) return;
                        const r = await client.reconcile(id);
                        if (valid()) {
                          setNotice(
                            r.state === 'acknowledged'
                              ? '已确认原操作'
                              : '尚未取得服务端接受回执',
                          );
                          await refresh(valid);
                        }
                      })
                    }
                  >
                    核对原操作
                  </Button>
                  {p.command && (
                    <>
                      <Button
                        type="button"
                        disabled={busy || !connected}
                        onClick={() => setPreview(p)}
                      >
                        查看原范围并重试
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy || !connected}
                        onClick={() =>
                          run(async (valid) => {
                            if (!client) return;
                            await client.stopLocal(id);
                            if (valid()) {
                              setPreview(null);
                              await refresh(valid);
                            }
                          })
                        }
                      >
                        停止本机重试
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </article>
      )}
    </section>
  );
}
