import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  capsuleCaseSources,
  capsuleRefKey,
  currentCapsuleFacts,
} from './capsule-workspace-client.mjs';
import { CapsuleMessagePicker } from './capsule-source-picker';
import {ConfigurationPicker} from './configuration-picker';

const lines = (s: string) =>
    s
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean),
  factKey = (x: any) => `${x.id}:${x.version}`;
const blank = {
  title: '',
  problemPattern: '',
  environmentName: '',
  environmentVersion: '',
  solutionStrategy: '',
  tools: '',
  skills: '',
  mcpRefs: '',
  verificationMethod: '',
  limitations: '',
  capabilityId: '',
  applicableScope: '',
  license: '',
  visibility: 'Private',
  redaction: false,
  caseId: '',
  resultKey: '',
  sourceKeys: [] as string[],
  permissionIds: [] as string[],
  attributionKeys: [] as string[],
  externalReferences: [] as any[],
  extraSources: [] as any[],
};
function initial(detail: any, mode: string) {
  if (mode !== 'revision' || !detail?.version) return { ...blank };
  const v = detail.version;
  return {
    ...blank,
    ...v,
    environmentName: v.environment.name,
    environmentVersion: v.environment.version,
    tools: v.tools.join('\n'),
    skills: v.skills.join('\n'),
    mcpRefs: v.mcpRefs.join('\n'),
    limitations: v.limitations.join('\n'),
    caseId: v.sourceResolution.caseId,
    resultKey: `${v.sourceResolution.resultId}:${v.sourceResolution.resultVersion ?? 1}`,
    sourceKeys: (v.sourceRefs ?? []).map(capsuleRefKey),
    permissionIds: v.permissionRefs ?? [],
    attributionKeys: (v.attributionRefs ?? []).map((a: any) =>
      capsuleRefKey(a.source),
    ),
    extraSources: [],
    externalReferences: v.externalReferences ?? [],
    redaction: false,
  };
}
function WorkPicker({
  history,
  historyLoaded,
  historyNext,
  loadHistory,
  value,
  onChange,
  busy,
  run,
}: any) {
  return (
    <>
      <div className="button-row">
        <Button
          type="button"
          disabled={busy}
          onClick={() => run(() => loadHistory())}
        >
          读取我的真实工作与参与记录
        </Button>
        {historyNext && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => run(() => loadHistory(historyNext))}
          >
            更多工作记录
          </Button>
        )}
      </div>
      <label>
        来源工作
        <select
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">选择已发生的工作</option>
          {history.map((c: any) => (
            <option key={c.caseId} value={c.caseId}>
              {c.title ?? '已授权工作'}
              {c.synthetic ? '（合成演示）' : ''}
            </option>
          ))}
        </select>
      </label>
      {historyLoaded && !history.length && (
        <p>
          当前页没有可见 Case。可继续读取更多记录；也可先在原任务记录实际工作。
        </p>
      )}
    </>
  );
}
export function CapsuleAuthoring({
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
  mode,
  detail,
  management,
  disclosure,
  versionOptions = [],
}: any) {
  const [form, setForm] = useState<any>(() => initial(detail, mode)),
    [viewers, setViewers] = useState<string[]>([]),
    [previewCheck, setPreviewCheck] = useState<any>(null),
    [message, setMessage] = useState(''),
    [maintenance, setMaintenance] = useState(
      detail?.securityIssue
        ? 'resolve-security'
        : detail?.deprecated
          ? 'security-issue'
          : 'deprecate',
    ),
    [summary, setSummary] = useState(''),
    [replacement, setReplacement] = useState('');
  const [external, setExternal] = useState({
    url: '',
    description: '',
    license: '',
  });
  const source = history.find((h: any) => h.caseId === form.caseId),
    caseSources = source ? capsuleCaseSources(source) : [],
    allSources = [...caseSources, ...form.extraSources],
    results = currentCapsuleFacts(source?.results ?? []).filter(
      (r: any) => r.reportedOutcome === 'succeeded',
    ),
    result = results.find((r: any) => factKey(r) === form.resultKey),
    people = [
      ...new Set(
        [
          source?.requesterId,
          ...caseSources.map((s: any) => s.authorId),
          ...(source?.collaborations ?? []).flatMap((t: any) => [
            t.requesterId,
            ...t.participation.map((p: any) => p.subjectId),
          ]),
        ].filter(
          (id) => id && id !== subjectId && /^GUID[0-9A-Z]{28}$/.test(id),
        ),
      ),
    ] as string[];
  function change(key: string, value: any) {
    setForm((old: any) => ({ ...old, [key]: value }));
    setPreviewCheck(null);
    setMessage('');
  }
  async function build() {
    if (!source || !result)
      throw new Error(
        '从当前真实工作中选择已报告达到目标的结果。不会为生成 Capsule 补造成功。',
      );
    if (!form.redaction)
      throw new Error('请逐项核对自己编写的内容和来源范围。');
    if (mode === 'revision' && !management)
      throw new Error('未取得本人版本管理状态，请刷新。');
    const selected = allSources.filter((s: any) =>
        form.sourceKeys.includes(capsuleRefKey(s.ref)),
      ),
      attributed = allSources.filter((s: any) =>
        form.attributionKeys.includes(capsuleRefKey(s.ref)),
      );
    if (
      [...form.sourceKeys, ...form.attributionKeys].some(
        (k: string) => !allSources.some((s: any) => capsuleRefKey(s.ref) === k),
      )
    )
      throw new Error(
        '草稿中部分来源或署名依据尚未重新读取。请重新选择消息或工作，不能悄悄删掉来源。',
      );
    return {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      capsuleId: mode === 'revision' ? detail.capsuleId : crypto.randomUUID(),
      kind: 'version',
      expectedRevision: mode === 'revision' ? management.revision : 0,
      version: mode === 'revision' ? management.publishedVersionCount + 1 : 1,
      title: form.title,
      problemPattern: form.problemPattern,
      environment: {
        name: form.environmentName,
        version: form.environmentVersion,
      },
      solutionStrategy: form.solutionStrategy,
      tools: lines(form.tools),
      skills: lines(form.skills),
      mcpRefs: lines(form.mcpRefs),
      verificationMethod: form.verificationMethod,
      limitations: lines(form.limitations),
      capabilityId: form.capabilityId,
      applicableScope: form.applicableScope,
      license: form.license,
      contributors: [...new Set(attributed.map((s: any) => s.authorId))],
      publicationClass: 'formal-source-success',
      synthetic: source.synthetic === true,
      sourceResolution: {
        caseId: source.caseId,
        resultId: result.id,
        resultVersion: result.version,
        proofIds: [],
        verificationRefs: selected
          .filter((s: any) => s.ref.kind === 'verification')
          .map((s: any) => ({ id: s.ref.id, version: s.ref.version })),
      },
      sourceRefs: selected.map((s: any) => s.ref),
      permissionRefs: form.permissionIds,
      attributionRefs: attributed.map((s: any) => ({
        subjectId: s.authorId,
        source: s.ref,
      })),
      externalReferences: form.externalReferences,
      redactionConfirmed: true,
    };
  }
  async function prepare() {
    const payload = await build();
    await propose('publication', payload, {
      visibility: form.visibility,
      viewers: form.visibility === 'Private' ? viewers : [],
    });
  }
  if (mode === 'maintenance')
    return (
      <section className="task-card">
        <h2>维护选定版本</h2>
        <fieldset disabled={busy}>
          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                if (!disclosure || !management)
                  throw new Error('先读取本人精确版本和原披露范围。');
                await propose(
                  'publication',
                  {
                    schemaVersion: 2,
                    id: crypto.randomUUID(),
                    kind: maintenance,
                    capsuleId: detail.capsuleId,
                    versionId: detail.versionId,
                    expectedRevision: management.revision,
                    summary,
                    ...(maintenance === 'deprecate' && replacement
                      ? { replacementVersionId: replacement }
                      : {}),
                  },
                  disclosure,
                );
              });
            }}
          >
            <label>
              状态
              <select
                value={maintenance}
                onChange={(e) => setMaintenance(e.target.value)}
              >
                <option value="deprecate" disabled={detail.deprecated}>
                  停用这一版本
                </option>
                <option value="security-issue" disabled={detail.securityIssue}>
                  标记具体安全事项
                </option>
                <option
                  value="resolve-security"
                  disabled={!detail.securityIssue}
                >
                  记录安全事项处理
                </option>
              </select>
            </label>
            <label>
              说明
              <Textarea
                required
                maxLength={1600}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
            {maintenance === 'deprecate' && (
              <label>
                替代版本（可选，不自动切换读者选择）
                <select
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                >
                  <option value="">不指定替代版本</option>
                  {versionOptions
                    .filter((v: any) => v.versionId !== detail.versionId)
                    .map((v: any) => (
                      <option key={v.versionId} value={v.versionId}>
                        v{v.version} · {v.title ?? '来源当前不可用'}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <p>
              维护说明沿用本版本原披露范围。停止推荐不抹去历史应用；撤销说明正文也不会偷偷恢复已停用状态。
            </p>
            <Button type="submit">预览维护操作</Button>
          </form>
        </fieldset>
      </section>
    );
  return (
    <section className="task-card">
      <h2>
        {mode === 'revision' ? '整理一个独立新版本' : '从实际工作整理本机草稿'}
      </h2>
      <p>
        先编写真实方法、验证范围和限制。已有许可可以继续使用；不自动发布聊天、不要求同一来源重复签署。
      </p>
      <fieldset disabled={busy}>
        <div className="button-row">
          <Button
            type="button"
            onClick={() =>
              run(async () => {
                await client.saveDraft({
                  kind: 'capsule-authoring-draft',
                  form,
                  mode,
                  capsuleId: mode === 'revision' ? detail.capsuleId : null,
                });
                setMessage('草稿已保存在当前设备，未同步或发布到云端。');
              })
            }
          >
            保存本机草稿
          </Button>
          <Button
            type="button"
            onClick={() =>
              run(async () => {
                const d = await client.loadDraft();
                if (!d || d.kind !== 'capsule-authoring-draft')
                  throw new Error('本机没有 Capsule 草稿。');
                if (
                  d.mode !== mode ||
                  (mode === 'revision' && d.capsuleId !== detail.capsuleId)
                )
                  throw new Error(
                    '草稿属于另一发布操作。请先回到其对应入口，不改变原胶囊。',
                  );
                setForm(d.form);
                setPreviewCheck(null);
                setMessage('已载入本机草稿，请重新读取来源并核对当前版本。');
              })
            }
          >
            恢复本机草稿
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              run(async () => {
                await client.saveDraft(null);
                setMessage('本机保存的草稿已删除，表单仍可继续编辑。');
              })
            }
          >
            删除保存的草稿
          </Button>
        </div>
        {message && <p className="message">{message}</p>}
        <WorkPicker
          {...{ history, historyLoaded, historyNext, loadHistory, busy, run }}
          value={form.caseId}
          onChange={(value: string) => {
            change('caseId', value);
            setForm((old: any) => ({
              ...old,
              caseId: value,
              resultKey: '',
              sourceKeys: [],
              attributionKeys: [],
            }));
          }}
        />
        <form
          className="workspace-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(prepare);
          }}
        >
          <label>
            已经报告达到目标的来源结果
            <select
              required
              value={form.resultKey}
              onChange={(e) => change('resultKey', e.target.value)}
            >
              <option value="">选择当前精确结果版本</option>
              {results.map((r: any) => (
                <option key={factKey(r)} value={factKey(r)}>
                  {r.summary} · v{r.version} · {r.actorId}
                </option>
              ))}
            </select>
          </label>
          {source && (
            <p>
              来源
              {source.synthetic
                ? '是合成演示，将保留演示标识。'
                : '未标记为合成；仍不代表结果已经独立核实。'}{' '}
              结果声明、有限验证和问题解决分别成立。
            </p>
          )}
          <label>
            方法标题
            <Input
              required
              maxLength={160}
              value={form.title}
              onChange={(e) => change('title', e.target.value)}
            />
          </label>
          <label>
            问题模式
            <Textarea
              required
              maxLength={1200}
              value={form.problemPattern}
              onChange={(e) => change('problemPattern', e.target.value)}
            />
          </label>
          <div className="form-pair">
            <label>
              适用环境名称
              <Input
                required
                maxLength={160}
                value={form.environmentName}
                onChange={(e) => change('environmentName', e.target.value)}
              />
            </label>
            <label>
              环境版本
              <Input
                required
                maxLength={80}
                value={form.environmentVersion}
                onChange={(e) => change('environmentVersion', e.target.value)}
              />
            </label>
          </div>
          <label>
            策略与可执行做法
            <Textarea
              required
              maxLength={4000}
              value={form.solutionStrategy}
              onChange={(e) => change('solutionStrategy', e.target.value)}
              placeholder="具体步骤、判断依据和为何这样处理；不要粘贴未获准的聊天、代码或文件"
            />
          </label>
          {(
            [
              ['tools', '工具'],
              ['skills', 'Skill'],
              ['mcpRefs', 'MCP'],
            ] as string[][]
          ).map(([field, label]) => (
            <label key={field}>
              {label}（可选，每行一项）
              <Textarea
                value={form[field]}
                onChange={(e) => change(field, e.target.value)}
              />
            </label>
          ))}
          <label>
            验证方法及已验证范围
            <Textarea
              required
              maxLength={1200}
              value={form.verificationMethod}
              onChange={(e) => change('verificationMethod', e.target.value)}
            />
          </label>
          <label>
            限制和不适用条件（每行一项）
            <Textarea
              required
              value={form.limitations}
              onChange={(e) => change('limitations', e.target.value)}
            />
          </label>
          <label>
            能力领域标识
            <Input
              required
              maxLength={128}
              pattern="[a-zA-Z0-9][a-zA-Z0-9:._/\-]*"
              value={form.capabilityId}
              onChange={(e) => change('capabilityId', e.target.value)}
              placeholder="例如 software-debugging（分类标签，不是资格认证）"
            />
          </label>
          <label>
            具体适用范围
            <Textarea
              required
              maxLength={1200}
              value={form.applicableScope}
              onChange={(e) => change('applicableScope', e.target.value)}
            />
          </label>
          <label>
            采用的内容许可
            <Input
              required
              maxLength={80}
              value={form.license}
              onChange={(e) => change('license', e.target.value)}
              placeholder="与来源许可一致，不由系统代替你授予权利"
            />
          </label>
          <fieldset>
            <legend>附加来源与分项署名（主结果及其上游仍会核对）</legend>
            {allSources.map((s: any) => {
              const k = capsuleRefKey(s.ref);
              return (
                <article className="task-card" key={k}>
                  <p>
                    {s.label} · {s.ref.kind} v{s.ref.version} · {s.authorId}
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.sourceKeys.includes(k)}
                      onChange={(e) =>
                        change(
                          'sourceKeys',
                          e.target.checked
                            ? [...form.sourceKeys, k]
                            : form.sourceKeys.filter((v: string) => v !== k),
                        )
                      }
                    />
                    引用这条精确来源
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.attributionKeys.includes(k)}
                      onChange={(e) =>
                        change(
                          'attributionKeys',
                          e.target.checked
                            ? [...form.attributionKeys, k]
                            : form.attributionKeys.filter(
                                (v: string) => v !== k,
                              ),
                        )
                      }
                    />
                    将来源作者列为此项贡献者（不冒充共同署名同意）
                  </label>
                </article>
              );
            })}
          </fieldset>
          <CapsuleMessagePicker
            {...{ runtime, subjectId, busy, run }}
            selected={form.extraSources}
            onChange={(items: any[]) => {
              const removed = form.extraSources
                .filter(
                  (x: any) =>
                    !items.some(
                      (i) => capsuleRefKey(i.ref) === capsuleRefKey(x.ref),
                    ),
                )
                .map((x: any) => capsuleRefKey(x.ref));
              setForm((old: any) => ({
                ...old,
                extraSources: items,
                sourceKeys: [
                  ...old.sourceKeys.filter((k: string) => !removed.includes(k)),
                  ...items
                    .map((x) => capsuleRefKey(x.ref))
                    .filter((k) => !old.sourceKeys.includes(k)),
                ],
                attributionKeys: old.attributionKeys.filter(
                  (k: string) => !removed.includes(k),
                ),
              }));
              setPreviewCheck(null);
            }}
          />
          <ConfigurationPicker {...{runtime,subjectId,busy,run}} selected={form.extraSources} onChange={(items:any[])=>{
            const removed=form.extraSources.filter((x:any)=>!items.some(i=>capsuleRefKey(i.ref)===capsuleRefKey(x.ref))).map((x:any)=>capsuleRefKey(x.ref));
            setForm((old:any)=>({...old,extraSources:items,sourceKeys:[...new Set([...old.sourceKeys.filter((k:string)=>!removed.includes(k)),...items.map(x=>capsuleRefKey(x.ref))])],attributionKeys:old.attributionKeys.filter((k:string)=>!removed.includes(k))}));setPreviewCheck(null);
          }}/>
          <fieldset>
            <legend>来源许可清单</legend>
            <Button
              type="button"
              onClick={() => run(() => loadPermissions('granted'))}
            >
              读取明确授予我的许可
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => run(() => loadPermissions('owned'))}
            >
              读取我已有的许可
            </Button>
            {[...permissions.granted, ...permissions.owned].map((p: any) => (
              <label className="task-card" key={p.permissionId}>
                <input
                  type="checkbox"
                  checked={form.permissionIds.includes(p.permissionId)}
                  disabled={
                    p.revoked ||
                    p.expired ||
                    p.sourceStatus !== 'current' ||
                    !p.payload.grantees.includes(subjectId)
                  }
                  onChange={(e) =>
                    change(
                      'permissionIds',
                      e.target.checked
                        ? [...form.permissionIds, p.permissionId]
                        : form.permissionIds.filter(
                            (id: string) => id !== p.permissionId,
                          ),
                    )
                  }
                />
                {p.authorId}：{p.payload.scope} · {p.payload.license} ·{' '}
                {p.revoked ? '已撤销' : p.expired ? '已到期' : p.sourceStatus} ·{' '}
                {p.payload.allowPublic ? '可按许可公开' : '不允许公开'}
              </label>
            ))}
            {['owned', 'granted'].map(
              (v) =>
                permissionNext[v] && (
                  <Button
                    type="button"
                    key={v}
                    onClick={() =>
                      run(() => loadPermissions(v, permissionNext[v]))
                    }
                  >
                    更多{v === 'owned' ? '本人' : '授予我的'}许可
                  </Button>
                ),
            )}
            <p>没有覆盖的第三方内容先保留本机，不因勾选检查框而变成可公开。</p>
          </fieldset>
          <details>
            <summary>外部资料仅保留链接（可选）</summary>
            <p>链接不会被服务器导入；不能以此声称拥有外部正文权利。</p>
            {form.externalReferences.map((r: any, i: number) => (
              <p key={i}>
                {r.description} · {r.url}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    change(
                      'externalReferences',
                      form.externalReferences.filter(
                        (_: any, j: number) => j !== i,
                      ),
                    )
                  }
                >
                  移除
                </Button>
              </p>
            ))}
            <label>
              链接
              <Input
                type="url"
                value={external.url}
                onChange={(e) =>
                  setExternal({ ...external, url: e.target.value })
                }
              />
            </label>
            <label>
              说明
              <Input
                value={external.description}
                onChange={(e) =>
                  setExternal({ ...external, description: e.target.value })
                }
              />
            </label>
            <label>
              已知许可（未知留空）
              <Input
                value={external.license}
                onChange={(e) =>
                  setExternal({ ...external, license: e.target.value })
                }
              />
            </label>
            <Button
              type="button"
              onClick={() => {
                change('externalReferences', [
                  ...form.externalReferences,
                  {
                    ...external,
                    license: external.license || null,
                    inclusion: 'reference-only; no-imported-body',
                  },
                ]);
                setExternal({ url: '', description: '', license: '' });
              }}
            >
              加入链接
            </Button>
          </details>
          <label>
            本次版本可见范围
            <select
              value={form.visibility}
              onChange={(e) => change('visibility', e.target.value)}
            >
              <option value="Private">本人和选定协作者</option>
              <option value="Public">面向公众</option>
            </select>
          </label>
          {form.visibility === 'Private' && (
            <fieldset>
              <legend>额外阅读者</legend>
              {people.map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={viewers.includes(id)}
                    onChange={(e) =>
                      setViewers(
                        e.target.checked
                          ? [...viewers, id]
                          : viewers.filter((x) => x !== id),
                      )
                    }
                  />
                  {id}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            <input
              type="checkbox"
              required
              checked={form.redaction}
              onChange={(e) => change('redaction', e.target.checked)}
            />
            我已核对即将发布的原文、选定来源与许可，未把未获准的代码、文件或聊天内容当作本人创作。
          </label>
          <div className="button-row">
            <Button
              type="button"
              onClick={() =>
                run(async () => {
                  const p = await build();
                  setPreviewCheck(await client.preview(p));
                })
              }
            >
              核对公开来源条件（不发布）
            </Button>
            <Button type="submit">预览选定范围的发布</Button>
          </div>
          {previewCheck && (
            <p className="message">
              {previewCheck.readyForPublicPublication
                ? '当前公开来源条件可以满足，仍需确认精确发布内容。'
                : `公开条件尚未满足：${previewCheck.reason}。私有发布仍按本次具体许可重新判断。`}
            </p>
          )}
        </form>
        {(source?.taskIds ?? []).map((id: string) => (
          <Button
            type="button"
            key={id}
            variant="link"
            onClick={() => navigate(`/app/tasks/${id}`)}
          >
            返回来源任务
          </Button>
        ))}
      </fieldset>
    </section>
  );
}

export function CapsulePermissionWorkspace({
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
}: any) {
  const [caseId, setCaseId] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [messages, setMessages] = useState<any[]>([]),
    [grantees, setGrantees] = useState<string[]>([]),
    [extraPerson, setExtraPerson] = useState(''),
    [scope, setScope] = useState(''),
    [license, setLicense] = useState(''),
    [basis, setBasis] = useState('authored-content'),
    [licenseReference, setLicenseReference] = useState(''),
    [attribution, setAttribution] = useState(''),
    [allowPublic, setAllowPublic] = useState(false),
    [expires, setExpires] = useState(''),
    [revoke, setRevoke] = useState<any>(null),
    [reason, setReason] = useState('');
  const source = history.find((h: any) => h.caseId === caseId),
    caseSources = source ? capsuleCaseSources(source) : [],
    sources = [
      ...caseSources.filter((s: any) => s.authorId === subjectId),
      ...messages,
    ],
    people = [
      ...new Set(
        [
          ...grantees,
          ...caseSources.map((s: any) => s.authorId),
          ...(source?.collaborations ?? []).flatMap((t: any) => [
            t.requesterId,
            ...t.participation.map((p: any) => p.subjectId),
          ]),
        ].filter(
          (id) => id && id !== subjectId && /^GUID[0-9A-Z]{28}$/.test(id),
        ),
      ),
    ] as string[];
  return (
    <section className="task-card">
      <h2>选定来源许可</h2>
      <p>
        只处理本人创作的注册来源。已知覆盖许可可以说明文档依据；不代替其他作者作出同意。
      </p>
      <fieldset disabled={busy}>
        <WorkPicker
          {...{ history, historyLoaded, historyNext, loadHistory, busy, run }}
          value={caseId}
          onChange={(id: string) => {
            setCaseId(id);
            setSelected([]);
          }}
        />
        <form
          className="workspace-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const chosen = sources.filter(
                (s: any) =>
                  selected.includes(capsuleRefKey(s.ref)) ||
                  s.ref.kind === 'selected-message',
              );
              await propose(
                'permission',
                {
                  schemaVersion: 2,
                  id: crypto.randomUUID(),
                  kind: 'grant',
                  sources: chosen.map((s: any) => s.ref),
                  grantees,
                  license,
                  scope,
                  basis,
                  ...(basis === 'documented-covering-license'
                    ? { licenseReference }
                    : {}),
                  attribution,
                  allowPublic,
                  ...(expires
                    ? { expiresAt: new Date(expires).toISOString() }
                    : {}),
                },
                { visibility: 'Private', viewers: grantees },
              );
            });
          }}
        >
          <fieldset>
            <legend>我的来源</legend>
            {sources
              .filter((s: any) => s.ref.kind !== 'selected-message')
              .map((s: any) => {
                const k = capsuleRefKey(s.ref);
                return (
                  <label className="task-card" key={k}>
                    <input
                      type="checkbox"
                      checked={selected.includes(k)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, k]
                            : selected.filter((x) => x !== k),
                        )
                      }
                    />
                    {s.label} · {s.ref.kind} v{s.ref.version}
                  </label>
                );
              })}
          </fieldset>
          <CapsuleMessagePicker
            {...{ runtime, subjectId, busy, run }}
            onlyOwn
            selected={messages}
            onChange={setMessages}
          />
          <ConfigurationPicker {...{runtime,subjectId,busy,run}} onlyOwn selected={messages} onChange={setMessages}/>
          <fieldset>
            <legend>明确获许可的人</legend>
            {people.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={grantees.includes(id)}
                  onChange={(e) =>
                    setGrantees(
                      e.target.checked
                        ? [...grantees, id]
                        : grantees.filter((x) => x !== id),
                    )
                  }
                />
                {id}
              </label>
            ))}
            <label>
              补充已有联系人的银河 ID
              <Input
                value={extraPerson}
                onChange={(e) => setExtraPerson(e.target.value)}
                placeholder="仅用于已有联系人，不替代发现或邀请"
              />
            </label>
            <Button
              type="button"
              onClick={() => {
                if (!/^GUID[0-9A-Z]{28}$/.test(extraPerson)) return;
                setGrantees([...new Set([...grantees, extraPerson])]);
                setExtraPerson('');
              }}
            >
              加入已知联系人
            </Button>
          </fieldset>
          <label>
            许可名称
            <Input
              required
              maxLength={80}
              value={license}
              onChange={(e) => setLicense(e.target.value)}
            />
          </label>
          <label>
            允许使用的具体范围
            <Textarea
              required
              maxLength={1600}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </label>
          <label>
            授权依据
            <select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="authored-content">本人创作的选定内容</option>
              <option value="documented-covering-license">
                已有文件明确覆盖的许可
              </option>
            </select>
          </label>
          {basis === 'documented-covering-license' && (
            <label>
              覆盖许可的实际文件或链接
              <Input
                required
                maxLength={1200}
                value={licenseReference}
                onChange={(e) => setLicenseReference(e.target.value)}
              />
            </label>
          )}
          <label>
            署名说明
            <Textarea
              required
              maxLength={1600}
              value={attribution}
              onChange={(e) => setAttribution(e.target.value)}
            />
          </label>
          <label>
            可选截止时间
            <Input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </label>
          <p>即使未指定额外截止时间，仍受真实签名授权有效期限制。</p>
          <label>
            <input
              type="checkbox"
              checked={allowPublic}
              onChange={(e) => setAllowPublic(e.target.checked)}
            />
            允许获许可人按上述范围向公众发布选定内容
          </label>
          <Button type="submit">预览来源许可</Button>
        </form>
        <h3>现有许可与撤销</h3>
        {['owned', 'granted'].map((view) => (
          <section key={view}>
            <h4>{view === 'owned' ? '我授予的' : '明确授予我的'}</h4>
            <Button
              type="button"
              onClick={() => run(() => loadPermissions(view))}
            >
              刷新
            </Button>
            {permissions[view].map((p: any) => (
              <article className="task-card" key={p.permissionId}>
                <p>
                  {p.authorId}：{p.payload.scope} · {p.payload.license}
                </p>
                <p>
                  {p.revoked ? '已撤销' : p.expired ? '已到期' : p.sourceStatus}{' '}
                  · {p.payload.attribution}
                </p>
                {view === 'owned' && !p.revoked && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setRevoke(p);
                      setReason('');
                    }}
                  >
                    撤销此项许可
                  </Button>
                )}
              </article>
            ))}
            {permissionNext[view] && (
              <Button
                type="button"
                onClick={() =>
                  run(() => loadPermissions(view, permissionNext[view]))
                }
              >
                更多许可
              </Button>
            )}
          </section>
        ))}
        {revoke && (
          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(() =>
                propose(
                  'permission',
                  {
                    schemaVersion: 2,
                    id: crypto.randomUUID(),
                    kind: 'revoke',
                    permissionId: revoke.permissionId,
                    reason,
                  },
                  { visibility: 'Private', viewers: revoke.payload.grantees },
                ),
              );
            }}
          >
            <h3>撤销：{revoke.payload.scope}</h3>
            <label>
              原因
              <Textarea
                required
                value={reason}
                maxLength={1600}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <p>
              当前依赖内容会重新判定是否可读；不会宣称所有外部副本都已收回。
            </p>
            <Button type="submit">预览撤销</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRevoke(null)}
            >
              取消
            </Button>
          </form>
        )}
      </fieldset>
    </section>
  );
}
