import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createConfigurationClient } from './configuration-client.mjs';
const blank = {
  title: '',
  summary: '',
  modelName: '',
  modelVersion: '',
  runtimeName: '',
  runtimeVersion: '',
  environmentName: '',
  environmentVersion: '',
  tools: '',
  skills: '',
  mcp: '',
  promptPolicyVersion: '',
  rulesVersion: '',
  operationScope: '',
  inputScopeSummary: '',
  contentFingerprint: '',
  limitations: '',
  synthetic: false,
  selected: false,
  observedAt: '',
};
const parts = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [name, version, reference, ...extra] = x
        .split('|')
        .map((x) => x.trim());
      if (extra.length) throw Error('每行只填名称、版本和可选引用。');
      return {
        name,
        version: version || null,
        ...(reference ? { reference } : {}),
      };
    });
const joined = (v: any[]) =>
  v
    .map((x) => [x.name, x.version ?? '', x.reference ?? ''].join(' | '))
    .join('\n');
const localTime = (v: string) => {
  const d = new Date(v);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
};
export function ConfigurationWorkspace({
  runtime,
  subjectId,
  connected,
  navigate,
}: any) {
  function requiredClient(){if(!client)throw new Error('请先连接当前身份。');return client;}
  const client = useMemo(
    () =>
      runtime
        ? createConfigurationClient({
            api: runtime.api,
            getLocal: runtime.getLocal,
            putLocal: runtime.putLocal,
            subjectId,
          })
        : null,
    [runtime, subjectId],
  );
  const generation = useRef(0),
    [items, setItems] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null),
    [versions, setVersions] = useState<any[]>([]),
    [versionNext, setVersionNext] = useState<number | null>(null);
  const [form, setForm] = useState<any>(blank),
    [mode, setMode] = useState(''),
    [visibility, setVisibility] = useState('Private'),
    [viewers, setViewers] = useState<string[]>([]),
    [contacts, setContacts] = useState<any[]>([]),
    [contactNext, setContactNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [preview, setPreview] = useState<any>(null),
    [pending, setPending] = useState<any[]>([]);
  useEffect(() => {
    generation.current++;
    setItems([]);
    setDetail(null);
    setVersions([]);
    setForm(blank);
    setPreview(null);
    setMode('');
    setPending([]);
    setContacts([]);
    setViewers([]);
    setNext(null);
    const token = generation.current;
    const reloadPending = () => {
      if (document.visibilityState !== 'visible' || busy || !connected || !client) return;
      requiredClient().pending().then((p) => { if (generation.current === token) setPending(p); }).catch(() => {});
    };
    const timer = window.setInterval(reloadPending, 20000);
    document.addEventListener('visibilitychange', reloadPending);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reloadPending);
    };
  }, [runtime, subjectId, connected]);
  async function run(fn: () => Promise<any>) {
    const token = generation.current;
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      if (token !== generation.current) return;
      return r;
    } catch (e: any) {
      if (token === generation.current) setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '配置读取暂未完成，请稍后重试。');
    } finally {
      if (token === generation.current) {
        setBusy(false);
        if (connected && client)
          try {
            setPending(await requiredClient().pending());
          } catch {}
      }
    }
  }
  async function read(path: string, input: any) {
    const token = generation.current,
      r = await runtime.api.call(path, input);
    if (token !== generation.current) throw Error('身份已变化。');
    return r;
  }
  async function load(after?: string) {
    const r = await requiredClient().query({
      subjectId,
      limit: 20,
      ...(after ? { after } : {}),
    });
    setItems((old) => (after ? [...old, ...r.items] : r.items));
    setNext(r.nextAfter);
  }
  async function open(id: string, version?: number) {
    const r = await requiredClient().get({ id, ...(version ? { version } : {}) });
    setDetail(r);
    setPreview(null);
    setMode('');
  }
  async function history(afterVersion = 0) {
    const r = await requiredClient().versions({ id: detail.id, afterVersion, limit: 20 });
    setVersions((old) => (afterVersion ? [...old, ...r.items] : r.items));
    setVersionNext(r.nextAfterVersion);
  }
  function edit(value: any = null) {
    const r = value?.record,
      c = r?.conditions;
    setForm(
      c
        ? {
            ...blank,
            ...r,
            ...Object.fromEntries(
              ['model', 'runtime', 'environment'].flatMap((k) => [
                [k + 'Name', c[k].name ?? ''],
                [k + 'Version', c[k].version ?? ''],
              ]),
            ),
            tools: joined(c.tools),
            skills: joined(c.skills),
            mcp: joined(c.mcp),
            promptPolicyVersion: c.promptPolicyVersion ?? '',
            rulesVersion: c.rulesVersion ?? '',
            operationScope: c.operationScope.join('\n'),
            inputScopeSummary: c.inputScopeSummary ?? '',
            contentFingerprint: c.contentFingerprint ?? '',
            limitations: c.limitations,
            observedAt: localTime(r.observedAt),
            selected: false,
          }
        : { ...blank },
    );
    setMode(value ? 'revision' : 'create');
    setPreview(null);
    setVisibility(value?.disclosure?.visibility ?? 'Private');
    setViewers(value?.disclosure?.viewers ?? []);
  }
  async function contactsPage(after?: string) {
    const r = await read('/v2/contacts/query', {
      direction: 'both',
      limit: 20,
      ...(after ? { after } : {}),
    });
    setContacts((old) => (after ? [...old, ...r.items] : r.items));
    setContactNext(r.nextAfter);
  }
  const people = [
    ...new Set(
      contacts
        .filter((c) => c.state === 'accepted')
        .map((c) =>
          c.initiatorId === subjectId ? c.recipientId : c.initiatorId,
        ),
    ),
  ].filter(Boolean) as string[];
  const field = (label: string, name: string, multi = false) => (
    <label>
      {label}
      {multi ? (
        <Textarea
          value={form[name]}
          maxLength={5000}
          onChange={(e) => setForm({ ...form, [name]: e.target.value })}
        />
      ) : (
        <Input
          value={form[name]}
          maxLength={name === 'contentFingerprint' ? 64 : 160}
          onChange={(e) => setForm({ ...form, [name]: e.target.value })}
        />
      )}
    </label>
  );
  async function prepare() {
    if (!form.selected) throw Error('请确认仅包含你选择披露的条件。');
    const common = {
      schemaVersion: 2,
      id: mode === 'create' ? crypto.randomUUID() : detail.id,
      operationId: crypto.randomUUID(),
      expectedVersion: mode === 'create' ? 0 : detail.management.version,
      actorId: subjectId,
    };
    const conditions = {
      ...Object.fromEntries(
        ['model', 'runtime', 'environment'].map((k) => [
          k,
          {
            name: form[k + 'Name'] || null,
            version: form[k + 'Version'] || null,
          },
        ]),
      ),
      tools: parts(form.tools),
      skills: parts(form.skills),
      mcp: parts(form.mcp),
      promptPolicyVersion: form.promptPolicyVersion || null,
      rulesVersion: form.rulesVersion || null,
      operationScope: form.operationScope
        .split('\n')
        .map((x: string) => x.trim())
        .filter(Boolean),
      inputScopeSummary: form.inputScopeSummary || null,
      limitations: form.limitations,
      ...(form.contentFingerprint
        ? { contentFingerprint: form.contentFingerprint }
        : {}),
    };
    const payload =
      mode === 'revoke'
        ? { ...common, kind: 'revoke', reason: form.summary }
        : {
            ...common,
            kind: 'record',
            title: form.title,
            summary: form.summary,
            conditions,
            observedAt: new Date(form.observedAt).toISOString(),
            synthetic: form.synthetic,
            selectedFieldsOnly: true,
          };
    setPreview(
      await requiredClient().prepare(payload, {
        visibility,
        viewers: visibility === 'Public' ? [] : viewers,
      }),
    );
  }
  return (
    <section className="pane-card">
      <h2>配置与条件版本</h2>
      <p>
        登记实际工作所用的关键条件。提示词全文、凭据和未选择的 Skill
        内容留在本地；没有配置也可以发布任务和协作。
      </p>
      <Button type="button" onClick={() => navigate('/app')}>
        返回银河
      </Button>
      {!connected ? (
        <p>连接身份后管理自己的版本。</p>
      ) : (
        <>
          <div className="button-row">
            <Button disabled={busy} onClick={() => run(() => load())}>
              读取我的配置
            </Button>
            <Button disabled={busy} onClick={() => edit()}>
              登记新配置
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => setPending(await requiredClient().pending()))
              }
            >
              查询本机待确认操作
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const d = await requiredClient().loadDraft();
                  if (d) {
                    setForm(d.form);
                    setMode(d.mode);
                    setDetail(d.detail);
                    setVisibility(d.visibility);
                    setViewers(d.viewers);
                    setNotice('已恢复本地草稿，仍需重新预览。');
                  }
                })
              }
            >
              恢复本地草稿
            </Button>
          </div>
          {next && (
            <Button disabled={busy} onClick={() => run(() => load(next))}>
              更多配置
            </Button>
          )}
          {items.map((item) => (
            <article key={item.id} className="task-card">
              <h3>{item.record?.title ?? '内容不可用的配置'}</h3>
              <p>
                v{item.version} · {item.sourceStatus}
              </p>
              <Button disabled={busy} onClick={() => run(() => open(item.id))}>
                打开与查看版本
              </Button>
            </article>
          ))}
          {detail && (
            <article className="task-card">
              <h3>
                {detail.record?.title ?? '配置元数据不可用'} · v{detail.version}
              </h3>
              <p>
                {detail.record?.summary ?? '当前正文已撤回或没有读取授权。'}
              </p>
              <p>这些是主体报告的条件，不代表银河验证其真实安装。</p>
              {detail.record && (
                <dl>
                  {['model', 'runtime', 'environment'].map((k) => (
                    <React.Fragment key={k}>
                      <dt>{k}</dt>
                      <dd>
                        {detail.record.conditions[k].name ?? '未披露/未知'} ·{' '}
                        {detail.record.conditions[k].version ?? '版本未知'}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
              )}
              <Button disabled={busy} onClick={() => run(() => history())}>
                读取授权版本
              </Button>
              {versions.map((v) => (
                <Button
                  key={v.version}
                  disabled={busy}
                  variant="outline"
                  onClick={() => run(() => open(detail.id, v.version))}
                >
                  v{v.version} · {v.sourceStatus}
                </Button>
              ))}
              {versionNext && (
                <Button
                  disabled={busy}
                  onClick={() => run(() => history(versionNext))}
                >
                  更多版本
                </Button>
              )}
              {detail.management?.state === 'active' && (
                <>
                  <Button
                    disabled={busy || !detail.record}
                    onClick={() => edit(detail)}
                  >
                    以所选版本为基础追加修订
                  </Button>
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => {
                      setMode('revoke');
                      setForm({ ...blank });
                      setPreview(null);
                    }}
                  >
                    撤回此配置对象
                  </Button>
                </>
              )}
            </article>
          )}
          {mode && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(prepare);
              }}
            >
              <h3>
                {mode === 'revoke'
                  ? '撤回配置：历史工作保留，依赖内容停止可读'
                  : mode === 'revision'
                    ? '追加不可变版本'
                    : '登记新配置'}
              </h3>
              {mode !== 'revoke' && (
                <>
                  {field('标题', 'title')}
                  {field('选定内容摘要', 'summary', true)}
                  {['model', 'runtime', 'environment'].map((k) => (
                    <React.Fragment key={k}>
                      {field(k + ' 名称（未知留空）', k + 'Name')}
                      {field(k + ' 版本（未知留空）', k + 'Version')}
                    </React.Fragment>
                  ))}
                  {['tools', 'skills', 'mcp'].map((k) => (
                    <React.Fragment key={k}>
                      {field(k + '；每行 名称 | 版本 | 可选公开引用', k, true)}
                    </React.Fragment>
                  ))}
                  {field('提示词策略版本号（不填正文）', 'promptPolicyVersion')}
                  {field('规则版本号', 'rulesVersion')}
                  {field(
                    '实际可用操作范围，每行一项（报告不代替实际授权）',
                    'operationScope',
                    true,
                  )}
                  {field(
                    '输入材料可用范围摘要（未知留空，不填原文）',
                    'inputScopeSummary',
                    true,
                  )}
                  {field(
                    '可选 SHA-256 指纹（原文件留本地）',
                    'contentFingerprint',
                  )}
                  {field('未披露、未知与适用限制', 'limitations', true)}
                  <label>
                    实际观察时间
                    <Input
                      required
                      type="datetime-local"
                      step="1"
                      value={form.observedAt}
                      onChange={(e) =>
                        setForm({ ...form, observedAt: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.synthetic}
                      onChange={(e) =>
                        setForm({ ...form, synthetic: e.target.checked })
                      }
                    />
                    这是合成演示数据
                  </label>
                </>
              )}
              {mode === 'revoke' && field('撤回说明', 'summary', true)}
              <label>
                披露范围
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                >
                  <option value="Private">本人及明确选择的人</option>
                  <option value="Public">公开所选元数据</option>
                </select>
              </label>
              {visibility === 'Private' && (
                <>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => contactsPage())}
                  >
                    从真实已接受联系选择接收者
                  </Button>
                  {contactNext && (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => contactsPage(contactNext))}
                    >
                      更多联系人
                    </Button>
                  )}
                  {people.map((id) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={viewers.includes(id)}
                        onChange={(e) =>
                          setViewers(
                            e.target.checked
                              ? [...viewers, id]
                              : viewers.filter((v) => v !== id),
                          )
                        }
                      />
                      {id}
                    </label>
                  ))}
                  {viewers
                    .filter((id) => !people.includes(id))
                    .map((id) => (
                      <label key={id}>
                        沿用原明确接收者 {id}
                        <button
                          type="button"
                          onClick={() =>
                            setViewers(viewers.filter((v) => v !== id))
                          }
                        >
                          移除
                        </button>
                      </label>
                    ))}
                </>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={form.selected}
                  onChange={(e) =>
                    setForm({ ...form, selected: e.target.checked })
                  }
                />
                我已选定这些条件和接收范围，未包含密钥、提示词全文或未选择的材料
              </label>
              <Button type="submit" disabled={busy}>
                预览本次内容与授权
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await requiredClient().saveDraft({
                      form,
                      mode,
                      detail,
                      visibility,
                      viewers,
                    });
                    setNotice('草稿保存在本机。');
                  })
                }
              >
                保存本地草稿
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setMode('');
                  setPreview(null);
                }}
              >
                取消此次编辑
              </Button>
            </form>
          )}
          {preview && (
            <article className="task-card">
              <h3>确认这份选定内容</h3>
              <p>
                {preview.visibility === 'Public'
                  ? '公开所选元数据'
                  : '仅本人及 ' + preview.viewers.length + ' 名选定接收者'}
                ；操作 {preview.operationId}
              </p>
              <pre>{JSON.stringify(preview.payload, null, 2)}</pre>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await requiredClient().execute(preview, {
                      confirmed: true,
                    });
                    setPreview(null);
                    setMode('');
                    setNotice(
                      '配置已取得精确写入回执；这不代表真实安装已验证。',
                    );
                    await load();
                    await open(r.id, r.version);
                  })
                }
              >
                确认并提交预览中的版本
              </Button>
              <Button disabled={busy} onClick={() => setPreview(null)}>
                返回修改
              </Button>
            </article>
          )}
          {pending.map((op) => (
            <article key={op.operationId} className="task-card">
              <p>
                原操作 {op.operationId} · {op.state}
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setNotice((await requiredClient().reconcile(op.operationId)).state),
                  )
                }
              >
                核对原回执
              </Button>
              {op.state !== 'stopped-local' && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await requiredClient().retry(op.operationId, { confirmed: true });
                        setNotice('已核对原操作并重试。');
                        await load();
                      })
                    }
                  >
                    确认重试原操作
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await requiredClient().stopLocalRetry(op.operationId, {
                          confirmed: true,
                        });
                        setNotice(
                          '已停止本机重试；服务端取消未确认，仍可核对晚到回执。',
                        );
                      })
                    }
                  >
                    停止本机重试
                  </Button>
                </>
              )}
            </article>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
