import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { exactFactRef, getFactClient, latestFacts } from './fact-client.mjs';
import { ciSourceMetadata } from '../../galaxy-official/src/shared/ci-observation-v2-schema.mjs';
import { githubReference } from '../../galaxy-official/src/shared/github-evidence-schema.mjs';
import { CiWorkspace } from './ci-workspace';
import {ConfigurationPicker} from './configuration-picker';
const refsKey = (x: any) => `${x.id}:${x.version}`;
const split = (s: string) =>
  s
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean);
const names: any = {
  diagnosis: '诊断',
  advice: '建议',
  'context-addition': '补充背景',
  'tool-introduction': '引入工具',
  patch: '补丁',
  review: '复核',
  takeover: '接管',
  verification: '验证',
  'scope-clarification': '范围澄清',
  'multi-node-collaboration': '多节点协作',
};
const outcomes: any = {
  succeeded: '达到所述结果',
  partial: '部分达到',
  failed: '未达到',
  inconclusive: '尚不明确',
  conflicting: '存在冲突',
};
const methods: any = {
  'participant-feedback': '参与者反馈',
  'requester-acceptance': '请求者接受反馈',
  'local-test': '实际本地测试',
  'unit-test': '单元测试',
  'integration-test': '集成测试',
  build: '构建',
  'ci-report': 'CI报告',
  'peer-review': '同行复核',
  'human-review': '人工评审',
  'production-validation': '实际生产验证',
};
const blank = {
  summary: '',
  strategy: '',
  environment: '',
  environmentVersion: '',
  inputScope: '',
  permissionScope: '',
  description: '',
  observedEffect: '',
  failureReason: '',
  limitations: '',
  reason: '',
  status: 'completed',
  outcome: 'inconclusive',
  type: 'diagnosis',
  resultChoice: '',
  sourceChoice: '',
  scope: '',
  conditions: '',
  command: '',
  method: 'participant-feedback',
  observation: 'comment',
  relationship: 'unknown',
  satisfied: '',
  remaining: '',
  resolution: 'unresolved',
  caseSummary: '',
  synthetic: false,
  evidenceType: 'self-assertion',
  originSystem: '',
  externalStableId: '',
  contentVersion: '',
  uri: '',
  issuer: '',
  originalAt: '',
  observedAt: '',
  sourceState: 'unknown',
  ciOwner: '',
  ciRepository: '',
  ciRunId: '',
  ciAttempt: '1',
  ciCommit: '',
};
function localNow() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function iso(s: string) {
  if (!s) throw new Error('请填写实际时间，未知时不要补造。');
  return new Date(s).toISOString();
}
export function FactWorkspace({
  task,
  runtime,
  subjectId,
  connected,
  refresh,
}: any) {
  const generation = useRef(0);
  const client = useMemo(
    () => (runtime && subjectId ? getFactClient(runtime, subjectId) : null),
    [runtime, subjectId],
  );
  const [facts, setFacts] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<any>(null);
  const [action, setAction] = useState<any>(null),
    [form, setForm] = useState<any>(blank),
    [participationId, setParticipationId] = useState(''),
    [viewers, setViewers] = useState<string[]>([]);
  const [records, setRecords] = useState<any[]>([]),
    [recordId, setRecordId] = useState(''),
    [recordType, setRecordType] = useState('evidence'),
    [recordSelected, setRecordSelected] = useState<string[]>([]),
    [related, setRelated] = useState<string[]>([]);
  const [configurationConditions,setConfigurationConditions]=useState<any[]>([]),[configurationSources,setConfigurationSources]=useState<any[]>([]);
  const requester = task.requesterId === subjectId,
    own = (task.participations ?? []).filter(
      (p: any) =>
        p.subjectId === subjectId &&
        ['active', 'delivered', 'accepted', 'disputed'].includes(p.state),
    ),
    participant =
      own.find((p: any) => p.participationId === participationId) ?? null;
  const attempts = latestFacts(facts?.attempts ?? []),
    interventions = latestFacts(facts?.interventions ?? []),
    results = latestFacts(facts?.results ?? []);
  const ownOrigins = [
    ...attempts.map((x: any) => ({ ...x, kind: 'attempt' })),
    ...interventions.map((x: any) => ({ ...x, kind: 'intervention' })),
  ].filter(
    (x: any) =>
      x.actorId === subjectId &&
      x.participationId === (participant?.participationId ?? null),
  );
  const eligibleResults = results.filter(
    (x: any) =>
      x.actorId === subjectId &&
      x.participationId === participant?.participationId &&
      x.participationScopeVersion === participant?.scopeVersion,
  );
  const evidence = records.filter(
      (r) =>
        r.type === 'evidence' && r.referenceStatus === 'current' && r.record,
    ),
    verifications = records.filter(
      (r) =>
        r.type === 'verification' &&
        r.referenceStatus === 'current' &&
        r.record,
    );
  const selectedEvidence = evidence.filter((x) =>
      recordSelected.includes(refsKey(x)),
    ),
    selectedVerifications = verifications.filter((x) =>
      recordSelected.includes(refsKey(x)),
    );
  const catalogKey = `task-record-refs:${task.taskId}`;
  async function remember(view: any) {
    const refs = (await runtime.getLocal(catalogKey)) ?? [];
    const next = [
      ...refs.filter((x: any) => !(x.id === view.id && x.type === view.type)),
      { id: view.id, type: view.type },
    ];
    await runtime.putLocal(catalogKey, next);
    return view;
  }
  async function load() {
    const epoch = generation.current;
    if (!client || !connected) return;
    setFacts(null);
    setRecords([]);
    const f = await client.readCase(task);
    if (epoch !== generation.current) return;
    setFacts(f);
    const waiting = await client.pending(task.taskId);
    if (epoch !== generation.current) return;
    setPending(waiting);
    const saved = (await runtime.getLocal(catalogKey)) ?? [],
      all = [
        ...saved,
        ...(f?.results ?? []).flatMap((r: any) =>
          r.deliverableRefs
            .filter((x: any) => x.kind === 'evidence')
            .map((x: any) => ({ id: x.id, type: 'evidence' })),
        ),
        ...(f?.resolutions ?? []).flatMap((r: any) =>
          r.verificationRefs.map((x: any) => ({
            id: x.id,
            type: 'verification',
          })),
        ),
      ];
    const unique = [
        ...new Map(all.map((x: any) => [x.type + ':' + x.id, x])).values(),
      ].slice(0, 100),
      list = [];
    for (const ref of unique) {
      if (epoch !== generation.current) return;
      try {
        list.push(await client.readRecord(ref));
      } catch (e: any) {
        list.push({
          ...ref,
          record: null,
          referenceStatus: 'unavailable',
          reason: e.message,
        });
      }
    }
    if (epoch === generation.current) setRecords(list);
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setFacts(null);
    setRecords([]);
    setAction(null);
    setError('');
    setNotice('');
    setPending(null);
    setForm(blank);
    setRelated([]);
    setConfigurationConditions([]);setConfigurationSources([]);
    setRecordSelected([]);
    setViewers(requester ? [] : [task.requesterId]);
    setParticipationId(own[0]?.participationId ?? '');
    if (connected)
      load().catch((e: any) => {
        if (epoch === generation.current) setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '事实读取暂未完成，请稍后重试。');
      });
    const reload = () => {
      if (document.visibilityState === 'visible' && connected && !busy) load().catch(() => {});
    };
    const timer = window.setInterval(reload, 20000);
    document.addEventListener('visibilitychange', reload);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', reload);
    };
  }, [task.taskId, task.caseId, runtime, subjectId, connected]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e: any) {
      setError(
        e.resultUnknown ? `${e.message} 原操作结果未知，请先查询。` : e.message,
      );
    } finally {
      try {
        setPending(await client.pending(task.taskId));
      } catch {}
      setBusy(false);
    }
  }
  function choose(kind: string, target?: any) {
    const ci = /^github-actions:([^/]+)\/([^:]+):run:(\d+):attempt:(\d+)$/.exec(
      target?.record?.source?.externalStableId ?? '',
    );
    setAction({ kind, target });
    setConfigurationConditions([]);
    setConfigurationSources([...(target?.sourceRefs??[]),...(target?.deliverableRefs??[])].filter(x=>x.kind==='configuration').map(ref=>({ref,label:'原版本明确配置来源'})));
    setRelated(target?.affectsAttemptIds ?? []);
    setRecordSelected((target?.record?.evidenceRefs ?? []).map(refsKey));
    if (target?.record) setParticipationId(target.record.participationId ?? '');
    setForm({
      ...blank,
      observedAt: localNow(),
      ...(target && !target.record
        ? {
            summary: target.summary ?? '',
            description: target.description ?? '',
            observedEffect: target.observedEffect ?? '',
            limitations: target.limitations ?? '',
            failureReason: target.failureReason ?? '',
            outcome:
              target.reportedOutcome === 'unrecorded'
                ? 'inconclusive'
                : (target.reportedOutcome ?? 'inconclusive'),
            status:
              target.status === 'running'
                ? 'completed'
                : (target.status ?? 'completed'),
            type: target.types?.[0] ?? 'diagnosis',
          }
        : {}),
      ...(kind === 'intervention-response' ? { status: '' } : {}),
      ...(target?.strategy ? { strategy: target.strategy } : {}),
      ...(target?.record
        ? {
            summary: target.record.summary,
            reason: '',
            originSystem: target.record.source?.originSystem ?? '',
            externalStableId: target.record.source?.externalStableId ?? '',
            contentVersion: target.record.source?.contentVersion ?? '',
            issuer: target.record.source?.issuer ?? '',
            uri: target.record.source?.uri ?? '',
            evidenceType: target.record.evidenceType ?? 'self-assertion',
            sourceState: target.record.reportedSourceState ?? 'unknown',
            ...(ci
              ? {
                  ciOwner: ci[1],
                  ciRepository: ci[2],
                  ciRunId: ci[3],
                  ciAttempt: ci[4],
                  ciCommit: target.record.source.contentVersion,
                }
              : {}),
            method: target.record.method ?? 'participant-feedback',
            scope: target.record.scope ?? '',
            conditions: target.record.conditions?.environment ?? '',
            command: target.record.conditions?.commandOrMethod ?? '',
            observation: target.record.observation ?? 'comment',
            relationship: target.record.relationship ?? 'unknown',
            originalAt: target.record.source?.originalAt
              ? new Date(
                  Date.parse(target.record.source.originalAt) -
                    new Date().getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)
              : '',
          }
        : {}),
      ...(kind === 'result-recorded'
        ? {
            sourceChoice: target?.origin
              ? refsKey(target.origin)
              : ownOrigins[0]
                ? refsKey(ownOrigins[0])
                : '',
          }
        : {}),
      ...(kind === 'deliver'
        ? {
            resultChoice: eligibleResults[0] ? refsKey(eligibleResults[0]) : '',
          }
        : {}),
      ...(kind === 'verification'
        ? {
            sourceChoice: target?.record?.target
              ? target.record.target.type + ':' + refsKey(target.record.target)
              : results[0]
                ? 'result:' + refsKey(results[0])
                : '',
          }
        : {}),
    });
  }
  function draft(kind: string) {
    const fields: any = { kind };
    const target = action?.target;
    if (kind === 'attempt-start')
      Object.assign(fields, {
        role: participant?.role ?? 'requester',
        strategy: form.strategy,
        environment: {
          name: form.environment || 'unknown',
          version: form.environmentVersion || 'unknown',
        },
        inputScopeSummary: form.inputScope,
        permissionScope: split(form.permissionScope),
        configurationRef:configurationConditions[0]?exactFactRef(configurationConditions[0].ref):null,
      });
    if (['attempt-end', 'attempt-correct'].includes(kind))
      Object.assign(fields, {
        attemptRef: exactFactRef(target),
        taskScopeVersion: target.scopeVersion,
        status: form.status,
        summary: form.summary,
        reportedOutcome: form.outcome,
        failureReason: form.failureReason,
        ...(kind === 'attempt-correct' ? { reason: form.reason } : {}),
      });
    if (kind === 'intervention')
      Object.assign(fields, {
        types: [form.type],
        affectsAttemptIds: related,
        description: form.description,
        sourceRefs: [...configurationSources.map(x=>x.ref),...selectedEvidence.map((r) => ({
          kind: 'evidence',
          ...exactFactRef(r),
        }))],
        observedEffect: form.observedEffect,
        ...(target ? { supersedes: exactFactRef(target) } : {}),
      });
    if (kind === 'intervention-response')
      Object.assign(fields, {
        interventionRef: exactFactRef(target),
        state: form.status,
        summary: form.summary,
      });
    if (kind === 'result-recorded') {
      const origin = ownOrigins.find(
        (x: any) => refsKey(x) === form.sourceChoice,
      );
      if (!origin) throw new Error('请选择本人真实来源及精确版本。');
      Object.assign(fields, {
        origin: { kind: origin.kind, ...exactFactRef(origin) },
        scopeVersion: origin.scopeVersion,
        deliverableRefs: [...configurationSources.map(x=>x.ref),...selectedEvidence.map((r) => ({
          kind: 'evidence',
          ...exactFactRef(r),
        }))],
        reportedOutcome: form.outcome,
        summary: form.summary,
        limitations: form.limitations,
        supersedes: target ? exactFactRef(target) : null,
      });
    }
    if (kind === 'resolution-recorded')
      Object.assign(fields, {
        status: form.resolution,
        summary: form.summary,
        satisfiedGoals: split(form.satisfied),
        remainingGoals: split(form.remaining),
        resultRefs: results
          .filter((x: any) => related.includes(refsKey(x)))
          .map(exactFactRef),
        verificationRefs: selectedVerifications.map(exactFactRef),
        supersedesResolutionId: facts.resolutions.at(-1)?.id ?? null,
      });
    return fields;
  }
  async function save() {
    const kind = action.kind;
    let receipt;
    if (kind === 'deliver') {
      const result = eligibleResults.find(
        (x: any) => refsKey(x) === form.resultChoice,
      );
      if (!participant || !result)
        throw new Error('请选择当前本人参与约定的真实结果。');
      receipt = await runtime.participationEvent(
        task.taskId,
        participant.participationId,
        {
          kind: 'deliver',
          expectedParticipationVersion: participant.version,
          resultRef: exactFactRef(result),
          interventionRefs: interventions
            .filter((x: any) => related.includes(refsKey(x)))
            .map(exactFactRef),
          evidenceRefs: selectedEvidence.map(exactFactRef),
          summary: form.summary,
        },
        { viewers: [task.requesterId], confirmed: true },
      );
    } else if (['evidence', 'verification', 'revoke'].includes(kind)) {
      let fields: any = {
        kind,
        id: action.target?.id,
        expectedVersion: action.target?.currentVersion ?? 0,
        synthetic: form.synthetic,
        observedAt: iso(form.observedAt),
      };
      if (action.target) fields.reason = form.reason;
      if (kind === 'evidence')
        Object.assign(fields, {
          evidenceType: form.evidenceType,
          source: {
            ...(form.evidenceType === 'ci-result'
              ? ciSourceMetadata(
                  githubReference.parse({
                    provider: 'github-actions',
                    owner: form.ciOwner,
                    repository: form.ciRepository,
                    runId: Number(form.ciRunId),
                    attempt: Number(form.ciAttempt),
                    commit: form.ciCommit,
                  }),
                )
              : {
                  originSystem: form.originSystem,
                  externalStableId: form.externalStableId,
                  contentVersion: form.contentVersion,
                }),
            issuer: form.issuer,
            originalAt: iso(form.originalAt),
            ...(form.uri ? { uri: form.uri } : {}),
          },
          reportedSourceState: form.sourceState,
          summary: form.summary,
        });
      if (kind === 'verification') {
        const [type, id, version] = form.sourceChoice.split(':');
        const target = [...attempts, ...interventions, ...results].find(
          (x: any) => x.id === id && x.version === Number(version),
        );
        if (!target) throw new Error('请选择当前可读的真实检查目标。');
        Object.assign(fields, {
          target: { type, id, version: Number(version) },
          scopeVersion: target.scopeVersion,
          method: form.method,
          scope: form.scope,
          conditions: {
            ...action.target?.record?.conditions,
            environment: form.conditions,
            commandOrMethod: form.command,
          },
          observation: form.observation,
          summary: form.summary,
          evidenceRefs: selectedEvidence.map(exactFactRef),
          relationship: form.relationship,
        });
      }
      if (kind === 'revoke') {
        fields = {
          kind,
          id: action.target.id,
          objectType: action.target.type,
          expectedVersion: action.target.currentVersion,
          synthetic: action.target.synthetic,
          reason: form.reason,
        };
      }
      receipt = await client.submitRecord(task, facts, participant, fields, {
        viewers,
        confirmed: true,
      });
      await remember(
        await client.readRecord({ type: receipt.type, id: receipt.id }),
      );
    } else
      receipt = await client.submitFact(task, facts, participant, draft(kind), {
        viewers,
        confirmed: true,
        caseSummary: form.caseSummary,
        synthetic: form.synthetic,
      });
    setAction(null);
    setNotice('已保存本人的这一项记录。交付接受、验证与整体解决分别表达。');
    await refresh();
    if (task.caseId) await load();
    else if (receipt.caseId) {
      setFacts(await client.readCase({ ...task, caseId: receipt.caseId }));
    }
  }
  const field = (
    title: string,
    key: string,
    required = true,
    maxLength = 1200,
  ) => (
    <label>
      {title}
      <Textarea
        required={required}
        maxLength={maxLength}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );
  const chooseRecords = (
    items: any[],
    selected: string[],
    set: (x: string[]) => void,
    title: string,
  ) => (
    <fieldset>
      <legend>{title}</legend>
      {items.map((item: any) => (
        <label key={refsKey(item)}>
          <input
            type="checkbox"
            checked={selected.includes(refsKey(item))}
            onChange={(e) =>
              set(
                e.target.checked
                  ? [...selected, refsKey(item)]
                  : selected.filter((x) => x !== refsKey(item)),
              )
            }
          />
          {item.summary ?? item.description ?? item.record?.summary ?? item.id}{' '}
          · {item.actorId ?? item.record?.reportedBy} · 版本 {item.version}
        </label>
      ))}
      {!items.length && (
        <p className="muted">
          当前没有可选择记录；可以先保存实际材料，或按已获知的记录ID读取。
        </p>
      )}
    </fieldset>
  );
  if (!connected || task.schemaVersion !== 2) return null;
  return (
    <section className="task-body">
      <h2>实际工作、结果和检查</h2>
      <p>
        每个参与者记录本人实际工作；诊断可以有价值而没有补丁。普通讨论不自动成为工作事实。
      </p>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="message" role="status">
          {notice}
        </div>
      )}
      <div className="button-row">
        <Button disabled={busy} variant="outline" onClick={() => run(load)}>
          刷新当前事实与来源
        </Button>
      </div>
      {pending && (
        <div className="message">
          <p>原操作结果未知：{pending.operationId}</p>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() =>
              run(async () => {
                const r = await client.reconcile(task.taskId);
                setNotice(
                  r.state === 'acknowledged'
                    ? '已从精确原文找到原操作。'
                    : '未取得匹配回执，原操作仍保留。',
                );
                await refresh();
                await load();
              })
            }
          >
            查询原操作
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await client.reconcile(task.taskId, {
                  retry: true,
                  confirmed: true,
                });
                await refresh();
                await load();
                setNotice('原操作已取得回执。');
              })
            }
          >
            重试原载荷
          </Button>
        </div>
      )}
      {!task.caseId && (
        <div className="message">
          此任务尚未建立工作事实 Case，发布本身合法且没有失败记录。
          {requester
            ? '记录本人第一次实际尝试或介入时，会一并建立关联。'
            : '由请求者先保存自己的真实首项工作并关联Case，再继续记录本人已约定的工作。'}
        </div>
      )}
      {facts && !facts.coverage.complete && (
        <p className="message">
          目前只展示获准且来源可用的部分事实；缺少内容不等于没有发生。
        </p>
      )}
      {(requester || !!own.length) && (
        <>
          <label>
            本次以哪项本人职责记录
            <select
              value={participationId}
              onChange={(e) => {
                setParticipationId(e.target.value);
                setAction(null);
              }}
            >
              {requester && <option value="">任务请求者的本人工作</option>}
              {own.map((p: any) => (
                <option key={p.participationId} value={p.participationId}>
                  {p.role}：{p.agreedScope}（约定版本{p.scopeVersion}）
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <Button
              disabled={busy || (!task.caseId && !requester)}
              onClick={() => choose('intervention')}
            >
              记录实际诊断、建议或介入
            </Button>
            <Button
              disabled={busy || (!task.caseId && !requester)}
              variant="outline"
              onClick={() => choose('attempt-start')}
            >
              开始一段实际尝试
            </Button>
            <Button
              disabled={busy || !facts || !ownOrigins.length}
              variant="outline"
              onClick={() => choose('result-recorded')}
            >
              记录这次工作结果
            </Button>
            <Button
              disabled={busy || !facts}
              variant="outline"
              onClick={() => choose('evidence')}
            >
              登记实际证据来源
            </Button>
            <Button
              disabled={busy || !facts}
              variant="outline"
              onClick={() => choose('verification')}
            >
              记录反馈或已完成检查
            </Button>
            {participant && (
              <Button
                disabled={busy || !eligibleResults.length}
                onClick={() => choose('deliver')}
              >
                选择真实结果并交付
              </Button>
            )}
            {requester && (
              <Button
                disabled={busy || !facts}
                variant="outline"
                onClick={() => {
                  setParticipationId('');
                  choose('resolution-recorded');
                }}
              >
                记录整体问题当前状态
              </Button>
            )}
          </div>
        </>
      )}
      {facts && (
        <>
          <h3>尝试与实际介入</h3>
          {attempts.map((item: any) => (
            <article className="task-card" key={refsKey(item)}>
              <h4>{item.strategy}</h4>
              <p>
                {item.actorId} · {item.status} · 版本 {item.version}
              </p>
              <p>{item.summary ?? item.inputScopeSummary}</p>
              {item.configurationCondition&&<p>条件版本：{item.configurationCondition.record?item.configurationCondition.record.title+' v'+item.configurationCondition.version+'（主体报告）':'未记录、未披露或当前不可读；不据此推断工作失败'}</p>}
              {item.actorId === subjectId &&
                item.participationId ===
                  (participant?.participationId ?? null) && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() =>
                      choose(
                        item.status === 'running'
                          ? 'attempt-end'
                          : 'attempt-correct',
                        item,
                      )
                    }
                  >
                    {item.status === 'running'
                      ? '记录这段尝试的终态'
                      : '纠正本段尝试记录'}
                  </Button>
                )}
            </article>
          ))}
          {interventions.map((item: any) => (
            <article className="task-card" key={refsKey(item)}>
              <h4>{item.description}</h4>
              <p>
                {item.actorId} ·{' '}
                {item.types.map((x: string) => names[x] ?? x).join('、')} · 版本{' '}
                {item.version}
              </p>
              <p>观察到的作用：{item.observedEffect}</p>
              <p>相关方意见：{item.confirmation}</p>
              {item.responses.map((r: any) => (
                <p key={r.id}>
                  {r.actorId}：{r.state} — {r.summary}
                </p>
              ))}
              <div className="button-row">
                {(requester || own.length > 0) && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => {
                      choose('intervention-response', item);
                      setForm({ ...blank, status: 'accepted' });
                    }}
                  >
                    记录本人对这项介入的意见
                  </Button>
                )}
                {item.actorId === subjectId &&
                  item.participationId ===
                    (participant?.participationId ?? null) && (
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() => choose('intervention', item)}
                    >
                      追加本人纠正版本
                    </Button>
                  )}
              </div>
            </article>
          ))}
          <h3>真实结果</h3>
          {results.map((item: any) => (
            <article className="task-card" key={refsKey(item)}>
              <h4>{item.summary}</h4>
              <p>
                {item.actorId} · {outcomes[item.reportedOutcome]} · 结果版本{' '}
                {item.version}
              </p>
              <p>
                实际来源：{item.origin.kind} {item.origin.id} /{' '}
                {item.origin.version}
              </p>
              <p>限制：{item.limitations}</p>
              <p>本条结果声明不代替交付验收、独立验证或整体解决。</p>
              {item.actorId === subjectId &&
                item.participationId ===
                  (participant?.participationId ?? null) && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => choose('result-recorded', item)}
                  >
                    追加结果修订
                  </Button>
                )}
            </article>
          ))}
          <h3>请求者记录的整体状态</h3>
          <p>
            {facts.resolution.status}：
            {facts.resolution.summary ?? '尚无明确记录。'}
          </p>
          <p>{facts.resolution.remainingGoals?.join('；')}</p>
        </>
      )}
      {task.caseId && (
        <details className="room-settings">
          <summary>读取获知的证据或检查记录</summary>
          <form
            className="search-row"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const item = await client.readRecord({
                  type: recordType,
                  id: recordId,
                });
                if (item.record?.caseId !== task.caseId)
                  throw new Error('此记录不属于当前Case或源资料不可读取。');
                await remember(item);
                setRecords((old) => [
                  ...old.filter((x) => x.id !== item.id),
                  item,
                ]);
              });
            }}
          >
            <Input
              required
              aria-label="证据或检查记录ID"
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
            />
            <select
              value={recordType}
              aria-label="记录类型"
              onChange={(e) => setRecordType(e.target.value)}
            >
              <option value="evidence">Evidence来源</option>
              <option value="verification">Verification检查</option>
            </select>
            <Button type="submit" disabled={busy}>
              读取当前版本与状态
            </Button>
          </form>
        </details>
      )}
      {records.map((item) => (
        <article className="task-card" key={item.type + item.id}>
          <h4>
            {item.type === 'evidence' ? '证据来源' : '反馈或检查'}：
            {item.record?.summary ?? '原文当前不可读取'}
          </h4>
          <code>{item.id}</code>
          <p>
            版本 {item.version ?? '未知'} · 当前引用状态 {item.referenceStatus}
          </p>
          {item.record && (
            <>
              <p>
                报告人：{item.record.reportedBy} ·{' '}
                {item.record.method ?? item.record.evidenceType}
              </p>
              <p>
                范围：{item.record.scope ?? item.record.source?.originSystem} ·
                观察：
                {item.record.observation ?? item.record.reportedSourceState}
              </p>
              <p className="muted">
                来源与观察按实际报告表达，不自动成为能力认证或整体解决。
              </p>
              {item.record.reportedBy === subjectId &&
                item.currentState === 'active' && (
                  <div className="button-row">
                    {['evidence', 'verification'].includes(item.type) && (
                      <Button
                        disabled={busy}
                        variant="outline"
                        onClick={() => choose(item.type, item)}
                      >
                        纠正本人记录（追加新版本）
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() => choose('revoke', item)}
                    >
                      撤回本人这项记录
                    </Button>
                  </div>
                )}
            </>
          )}
        </article>
      ))}
      {facts && (
        <CiWorkspace
          runtime={runtime}
          connected={connected}
          subjectId={subjectId}
          caseId={task.caseId}
          results={results}
          evidence={records}
        />
      )}
      {action && (
        <form
          className="workspace-form message"
          onSubmit={(e) => {
            e.preventDefault();
            run(save);
          }}
        >
          <h3>记录本人的具体工作</h3>
          {!task.caseId && (
            <>
              {field('关联Case的真实工作背景（不自动公开）', 'caseSummary')}
              <label>
                <input
                  type="checkbox"
                  checked={form.synthetic}
                  onChange={(e) =>
                    setForm({ ...form, synthetic: e.target.checked })
                  }
                />{' '}
                本次是合成或演示案例
              </label>
            </>
          )}
          {action.kind === 'attempt-start' && (
            <>
              {field('本段尝试的策略', 'strategy')}
              {field('实际使用的环境；未知可留空', 'environment', false, 160)}
              {field('环境版本；未知可留空', 'environmentVersion', false, 80)}
              {field('实际使用哪些输入', 'inputScope')}
              {field('本人已获准的操作范围，每行一项', 'permissionScope')}
              <ConfigurationPicker {...{runtime,subjectId,busy,run}} single selected={configurationConditions} onChange={setConfigurationConditions}/>
              <a href="/app/configurations" target="_blank" rel="noopener">在独立页面登记配置版本</a>
            </>
          )}
          {['attempt-end', 'attempt-correct'].includes(action.kind) && (
            <>
              <label>
                尝试状态
                <select
                  required
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  {[
                    ['completed', '本段尝试已结束'],
                    ['abandoned', '已放弃'],
                    ['canceled', '已取消'],
                    ['inconclusive', '无法确定'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('实际结果说明', 'summary')}
              {field('失败/中止原因；没有结论时明确填写未知', 'failureReason')}
            </>
          )}
          {action.kind === 'intervention' && (
            <>
              <label>
                本次介入类型
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {Object.entries(names).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title as string}
                    </option>
                  ))}
                </select>
              </label>
              {field('实际做了什么', 'description')}
              {field('观察到的作用或尚未观察到什么', 'observedEffect')}
              <fieldset>
                <legend>作用于哪些已有尝试（可不选）</legend>
                {attempts.map((x: any) => (
                  <label key={x.id}>
                    <input
                      type="checkbox"
                      checked={related.includes(x.id)}
                      onChange={(e) =>
                        setRelated(
                          e.target.checked
                            ? [...related, x.id]
                            : related.filter((v) => v !== x.id),
                        )
                      }
                    />
                    {x.strategy} · {x.actorId} · 当前版本{x.version}
                  </label>
                ))}
              </fieldset>
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '本次明确引用的已登记证据（可选）',
              )}
            </>
          )}
          {action.kind === 'intervention-response' && (
            <>
              <p>{action.target.description}</p>
              <label>
                本人意见
                <select
                  required
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option value="">选择本人的实际意见</option>
                  <option value="accepted">认可实际作用</option>
                  <option value="partial">部分认可</option>
                  <option value="disputed">有具体异议</option>
                </select>
              </label>
              {field('本人意见说明', 'summary')}
            </>
          )}
          {action.kind === 'result-recorded' && (
            <>
              <label>
                这次结果来自本人的哪项实际工作
                <select
                  required
                  value={form.sourceChoice}
                  onChange={(e) =>
                    setForm({ ...form, sourceChoice: e.target.value })
                  }
                >
                  <option value="">选择实际来源</option>
                  {ownOrigins.map((x: any) => (
                    <option key={refsKey(x)} value={refsKey(x)}>
                      {x.description ?? x.strategy} · {x.kind} / 版本{x.version}
                    </option>
                  ))}
                </select>
              </label>
              {field('取得的具体结果', 'summary')}
              {field('适用限制与尚未做到的事情', 'limitations')}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '这次结果明确引用的证据版本（可选）',
              )}
            </>
          )}
          {['intervention','result-recorded'].includes(action.kind)&&<ConfigurationPicker {...{runtime,subjectId,busy,run}} selected={configurationSources} onChange={setConfigurationSources}/>}
          {['attempt-end', 'attempt-correct', 'result-recorded'].includes(
            action.kind,
          ) && (
            <label>
              报告的结果
              <select
                value={form.outcome}
                onChange={(e) => setForm({ ...form, outcome: e.target.value })}
              >
                {Object.entries(outcomes).map(([id, title]) => (
                  <option key={id} value={id}>
                    {title as string}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action.kind === 'deliver' && (
            <>
              <label>
                提交验收的本人结果
                <select
                  required
                  value={form.resultChoice}
                  onChange={(e) =>
                    setForm({ ...form, resultChoice: e.target.value })
                  }
                >
                  {eligibleResults.map((x: any) => (
                    <option key={refsKey(x)} value={refsKey(x)}>
                      {x.summary} / 版本{x.version}
                    </option>
                  ))}
                </select>
              </label>
              {field('本次交付说明与希望验收的范围', 'summary')}
              {chooseRecords(
                interventions,
                related,
                setRelated,
                '实际相关的多方介入贡献（引用原作者，不转移归属）',
              )}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '已登记证据的精确版本',
              )}
            </>
          )}
          {action.kind === 'evidence' && (
            <>
              <label>
                证据类型
                <select
                  value={form.evidenceType}
                  onChange={(e) =>
                    setForm({ ...form, evidenceType: e.target.value })
                  }
                >
                  {[
                    ['self-assertion', '本人来源声明'],
                    ['test-result', '实际测试结果'],
                    ['git-commit', '代码提交'],
                    ['pull-request', 'Pull Request'],
                    ['ci-result', 'CI结果'],
                    ['build-result', '构建结果'],
                    ['organization-record', '组织记录'],
                    ['external-platform-record', '外部平台记录'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {form.evidenceType === 'ci-result' ? (
                <>
                  <p>
                    记录实际 GitHub Actions
                    来源。这里只保存你的来源声明，后续选择对应结果后可申请观察公开
                    CI；不会把声明直接算成已验证。
                  </p>
                  {field('GitHub 仓库所有者', 'ciOwner', true, 100)}
                  {field('仓库名称', 'ciRepository', true, 100)}
                  {field('实际 Workflow run ID', 'ciRunId', true, 24)}
                  {field('本次 run attempt', 'ciAttempt', true, 10)}
                  {field(
                    '本次实际 40 位小写 Git commit SHA',
                    'ciCommit',
                    true,
                    40,
                  )}
                  {action.target && !form.ciOwner && (
                    <p>
                      旧来源未按此结构登记。不同来源身份需要新建记录，不能用纠正覆盖旧来源。
                    </p>
                  )}
                </>
              ) : (
                <>
                  {field('来源系统名称', 'originSystem', true, 120)}
                  {field(
                    '实际来源的稳定编号（例如提交ID或报告编号）',
                    'externalStableId',
                    true,
                    1000,
                  )}
                  {field('实际内容版本', 'contentVersion', true, 240)}
                </>
              )}
              {field(
                '来源发布者/签发者（按所知如实描述）',
                'issuer',
                true,
                1000,
              )}
              {field(
                '实际来源链接（可选，不由银河自动打开）',
                'uri',
                false,
                2048,
              )}
              <label>
                来源原始发生时间
                <Input
                  type="datetime-local"
                  required
                  value={form.originalAt}
                  onChange={(e) =>
                    setForm({ ...form, originalAt: e.target.value })
                  }
                />
              </label>
              <label>
                本人观察到的来源状态
                <select
                  value={form.sourceState}
                  onChange={(e) =>
                    setForm({ ...form, sourceState: e.target.value })
                  }
                >
                  {[
                    ['unknown', '未知'],
                    ['available', '当时可用'],
                    ['unreachable', '当时不可达'],
                    ['removed', '已移除'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('来源说明与内容范围', 'summary', true, 4000)}
              <p>
                此处登记实际引用信息，不上传原始文件，不填写虚构的摘要哈希。来源声明和独立验证分别成立。
              </p>
            </>
          )}
          {action.kind === 'verification' && (
            <>
              <label>
                实际检查的目标版本
                <select
                  required
                  value={form.sourceChoice}
                  onChange={(e) =>
                    setForm({ ...form, sourceChoice: e.target.value })
                  }
                >
                  <option value="">选择检查目标</option>
                  {[
                    ['attempt', attempts],
                    ['intervention', interventions],
                    ['result', results],
                  ].flatMap(([kind, items]: any) =>
                    (items as any[])
                      .filter(
                        (x) =>
                          !action.target?.record?.target ||
                          (kind === action.target.record.target.type &&
                            x.id === action.target.record.target.id),
                      )
                      .map((x) => (
                        <option
                          key={kind + refsKey(x)}
                          value={kind + ':' + refsKey(x)}
                        >
                          {x.summary ?? x.description ?? x.strategy} · {kind} /{' '}
                          {x.version}
                        </option>
                      )),
                  )}
                </select>
              </label>
              <label>
                实际采用的方法
                <select
                  value={form.method}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      method: e.target.value,
                      observation: [
                        'participant-feedback',
                        'requester-acceptance',
                      ].includes(e.target.value)
                        ? 'comment'
                        : 'inconclusive',
                    })
                  }
                >
                  {Object.entries(methods)
                    .filter(
                      ([id]) => id !== 'requester-acceptance' || requester,
                    )
                    .map(([id, title]) => (
                      <option key={id} value={id}>
                        {title as string}
                      </option>
                    ))}
                </select>
              </label>
              {field('本次检查或反馈仅涵盖什么', 'scope', true, 4000)}
              {field('实际环境、仓库版本及前提条件', 'conditions', true, 2000)}
              {field(
                '实际命令或检查方法；反馈可写未执行测试',
                'command',
                true,
                2000,
              )}
              <label>
                实际观察
                <select
                  value={form.observation}
                  onChange={(e) =>
                    setForm({ ...form, observation: e.target.value })
                  }
                >
                  {(['participant-feedback', 'requester-acceptance'].includes(
                    form.method,
                  )
                    ? [
                        ['comment', '意见'],
                        ['accepted', '接受'],
                        ['partially-accepted', '部分接受'],
                        ['rejected', '不接受'],
                        ['inconclusive', '不明确'],
                      ]
                    : [
                        ['passed', '所列检查通过'],
                        ['failed', '所列检查未通过'],
                        ['inconclusive', '不明确'],
                      ]
                  ).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('检查说明、结果与未覆盖之处', 'summary', true, 4000)}
              <label>
                你与目标作者的关系（本人声明）
                <select
                  value={form.relationship}
                  onChange={(e) =>
                    setForm({ ...form, relationship: e.target.value })
                  }
                >
                  {[
                    ['unknown', '未知/不作独立声明'],
                    ['same-controller', '同一控制方'],
                    ['counterparty', '协作相对方'],
                    ['independent', '本人声明独立'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '实际检查使用的支持证据（测试/评审必须有来源，反馈可无）',
              )}
            </>
          )}
          {['evidence', 'verification'].includes(action.kind) && (
            <label>
              本人实际观察时间
              <Input
                type="datetime-local"
                required
                value={form.observedAt}
                onChange={(e) =>
                  setForm({ ...form, observedAt: e.target.value })
                }
              />
            </label>
          )}
          {action.kind === 'resolution-recorded' && (
            <>
              <label>
                整个问题的当前状态
                <select
                  value={form.resolution}
                  onChange={(e) =>
                    setForm({ ...form, resolution: e.target.value })
                  }
                >
                  {[
                    ['unresolved', '仍未解决'],
                    ['partially-resolved', '部分解决'],
                    ['resolved', '已解决'],
                    ['inconclusive', '暂不明确'],
                    ['regressed', '出现回归'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('请求者的判断及适用范围', 'summary')}
              {field('已满足目标，每行一项', 'satisfied', false)}
              {field('仍未满足目标，每行一项', 'remaining', false)}
              {chooseRecords(
                results,
                related,
                setRelated,
                '本次明确依据的结果版本',
              )}
              {chooseRecords(
                verifications,
                recordSelected,
                setRecordSelected,
                '本次明确依据的检查版本（可以没有）',
              )}
            </>
          )}
          {action.target &&
            ['attempt-correct', 'evidence', 'verification', 'revoke'].includes(
              action.kind,
            ) &&
            field('为何纠正或撤回（保留原时点记录）', 'reason')}
          {action.kind === 'deliver' ? (
            <p className="muted">
              这份交付记录仅交给请求者。所引工作与证据分别沿用各作者原先授权，不扩大其他参与者权限。
            </p>
          ) : (
            <fieldset>
              <legend>本次私有记录明确分享给谁</legend>
              {[
                ...new Set([
                  task.requesterId,
                  ...(task.participations ?? []).map((p: any) => p.subjectId),
                ]),
              ]
                .filter((id) => id !== subjectId)
                .map((id: any) => (
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
                    {id === task.requesterId
                      ? '（请求者；交付验收需能读取来源）'
                      : ''}
                  </label>
                ))}
            </fieldset>
          )}
          <div className="button-row">
            <Button type="submit" disabled={busy || !!pending}>
              确认保存本人的实际记录
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAction(null)}
            >
              取消本次草稿
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
