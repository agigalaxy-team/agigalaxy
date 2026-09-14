import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { currentCapsuleFacts } from './capsule-workspace-client.mjs';

const ref = (x: any) => ({ id: x.id, version: x.version }),
  key = (x: any) => `${x.id}:${x.version}`;
export function CapsuleApplication({
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
}: any) {
  const [kind, setKind] = useState('reference'),
    [caseId, setCaseId] = useState(''),
    [resultKey, setResultKey] = useState(''),
    [note, setNote] = useState(''),
    [difference, setDifference] = useState(''),
    [parts, setParts] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [priorId, setPriorId] = useState(''),
    [visibility, setVisibility] = useState('Private'),
    [viewers, setViewers] = useState<string[]>([]);
  const source = history.find((c: any) => c.caseId === caseId),
    results = currentCapsuleFacts(source?.results ?? []).filter(
      (r: any) => r.actorId === subjectId && r.origin?.kind === 'attempt',
    ),
    result = results.find((r: any) => key(r) === resultKey),
    attempt = (source?.attempts ?? []).find(
      (a: any) =>
        a.id === result?.origin.id && a.version === result?.origin.version,
    ),
    checks = (source?.verificationRecords ?? []).filter(
      (v: any) =>
        v.type === 'verification' &&
        v.referenceStatus === 'current' &&
        v.record?.target.type === 'result' &&
        v.record.target.id === result?.id &&
        v.record.target.version === result?.version,
    ),
    prior = (uses.items ?? []).filter(
      (u: any) =>
        u.subjectId === subjectId &&
        u.kind === 'apply' &&
        u.record &&
        u.caseId === caseId &&
        u.record.resultRef?.id === result?.id &&
        u.record.attemptRef?.id === attempt?.id,
    ),
    people = [
      ...new Set(
        [
          source?.requesterId,
          ...(source?.collaborations ?? []).flatMap((t: any) => [
            t.requesterId,
            ...t.participation.map((p: any) => p.subjectId),
          ]),
        ].filter((id) => id && id !== subjectId),
      ),
    ] as string[];
  async function prepare() {
    if (!source) throw new Error('请选择本人已有的真实工作记录。');
    const payload: any = {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      kind,
      capsuleId: detail.capsuleId,
      versionId: detail.versionId,
      caseId,
      attribution: detail.authorId,
      note,
    };
    if (kind === 'reference') {
      if (source.taskIds.length === 1) payload.taskId = source.taskIds[0];
    } else {
      if (!result || !attempt || attempt.actorId !== subjectId)
        throw new Error(
          '请选择本人真实尝试对应的精确结果。介入型结果不会冒充尝试。',
        );
      if (!attempt.environment?.name || !attempt.environment?.version)
        throw new Error('该历史尝试没有完整环境，先在原任务补充事实。');
      Object.assign(payload, {
        attemptRef: ref(attempt),
        resultRef: ref(result),
        environment: attempt.environment,
        environmentDifference: difference,
        adoptedParts: parts
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        outcome: result.reportedOutcome,
        ...(result.taskId ? { taskId: result.taskId } : {}),
        ...(result.participationId
          ? { participationId: result.participationId }
          : {}),
      });
      if (kind === 'reverify') {
        if (!prior.some((p: any) => p.eventId === priorId))
          throw new Error(
            '选择这一精确版本此前的实际应用；找不到时先加载更多应用记录。',
          );
        Object.assign(payload, {
          priorUseId: priorId,
          verificationRefs: checks
            .filter((v: any) => selected.includes(key(v)))
            .map(ref),
        });
      }
    }
    await propose('use', payload, {
      visibility,
      viewers: visibility === 'Private' ? viewers : [],
    });
  }
  return (
    <details className="room-settings">
      <summary>把这个版本带回我的实际工作</summary>
      <fieldset disabled={busy}>
        <div className="button-row">
          <Button type="button" onClick={() => run(() => loadHistory())}>
            读取我的工作记录
          </Button>
          {historyNext && (
            <Button
              type="button"
              onClick={() => run(() => loadHistory(historyNext))}
            >
              更多工作记录
            </Button>
          )}
        </div>
        {historyLoaded && !history.length && (
          <p className="empty-state">
            当前可见页没有真实
            Case。你可以继续阅读，或到原任务记录实际工作；不会为了使用 Capsule
            自动制造尝试。
          </p>
        )}
        <form
          className="workspace-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(prepare);
          }}
        >
          <label>
            这次是什么行为
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPriorId('');
                setSelected([]);
              }}
            >
              <option value="reference">只加入参考（未声明执行）</option>
              <option value="apply" disabled={!detail.newApplicationAllowed}>
                记录实际应用
              </option>
              <option value="reverify" disabled={!detail.newApplicationAllowed}>
                记录实际应用后的再验证
              </option>
            </select>
          </label>
          <label>
            已有的目标工作
            <select
              required
              value={caseId}
              onChange={(e) => {
                setCaseId(e.target.value);
                setResultKey('');
                setSelected([]);
                setViewers([]);
                setPriorId('');
              }}
            >
              <option value="">选择真实工作</option>
              {history.map((c: any) => (
                <option
                  key={c.caseId}
                  value={c.caseId}
                  disabled={
                    kind !== 'reference' &&
                    c.caseId === detail.version.sourceResolution.caseId
                  }
                >
                  {c.title ?? '已获准的工作'}
                  {c.synthetic ? '（合成演示）' : ''}
                  {c.caseId === detail.version.sourceResolution.caseId
                    ? '（源工作，不算新应用）'
                    : ''}
                </option>
              ))}
            </select>
          </label>
          {kind !== 'reference' && (
            <>
              <label>
                本人尝试产生的实际结果
                <select
                  required
                  value={resultKey}
                  onChange={(e) => {
                    setResultKey(e.target.value);
                    setSelected([]);
                    setPriorId('');
                  }}
                >
                  <option value="">选择结果和精确版本</option>
                  {results.map((r: any) => (
                    <option key={key(r)} value={key(r)}>
                      {r.summary} · v{r.version} · {r.reportedOutcome}
                    </option>
                  ))}
                </select>
              </label>
              {result && (
                <p className="message">
                  原记录报告：{result.reportedOutcome}；环境：
                  {attempt?.environment?.name ?? '未知'} /{' '}
                  {attempt?.environment?.version ?? '未知'}
                  。本表不修改或替换原结果。
                </p>
              )}
              <label>
                与方法原环境的实际差异
                <Textarea
                  required
                  maxLength={1600}
                  value={difference}
                  onChange={(e) => setDifference(e.target.value)}
                  placeholder="有哪些条件相同、不同或尚不明确？"
                />
              </label>
              <label>
                具体采用了哪些部分（每行一项）
                <Textarea
                  required
                  value={parts}
                  onChange={(e) => setParts(e.target.value)}
                  placeholder="说明实际使用的步骤，而不是只写已经阅读"
                />
              </label>
              {kind === 'reverify' && (
                <>
                  <label>
                    已有的实际应用
                    <select
                      required
                      value={priorId}
                      onChange={(e) => setPriorId(e.target.value)}
                    >
                      <option value="">选择先前应用</option>
                      {prior.map((u: any) => (
                        <option value={u.eventId} key={u.eventId}>
                          {u.record.note} · {u.recordedAt}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend>对所选结果精确版本的当前检查</legend>
                    {checks.map((v: any) => (
                      <label key={key(v)}>
                        <input
                          type="checkbox"
                          checked={selected.includes(key(v))}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, key(v)]
                                : selected.filter((x) => x !== key(v)),
                            )
                          }
                        />
                        {v.record.summary} · {v.record.method} ·{' '}
                        {v.record.observation} · v{v.version}
                      </label>
                    ))}
                    {!checks.length && (
                      <p>
                        没有当前可引用的检查。可以返回原任务记录实际验证，不必安排无关全量复测。
                      </p>
                    )}
                  </fieldset>
                </>
              )}
            </>
          )}
          <label>
            这一次的说明
            <Textarea
              required
              maxLength={1600}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label>
            本条应用记录的可见范围
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value="Private">本人和选定协作者</option>
              <option value="Public">公开这条选定记录</option>
            </select>
          </label>
          {visibility === 'Private' && (
            <fieldset>
              <legend>其他阅读者（原 Case 授权不会因此扩大）</legend>
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
          <p className="muted">
            失败、部分达到和结论冲突都可以记录。再验证表示新增了所选检查，不把检查自动变成独立成功或能力认证。
          </p>
          <Button type="submit">预览这一条记录</Button>
        </form>
        {(source?.taskIds ?? []).map((id: string) => (
          <Button
            type="button"
            variant="link"
            key={id}
            onClick={() => navigate(`/app/tasks/${id}`)}
          >
            返回原任务，继续执行或补充事实
          </Button>
        ))}
      </fieldset>
    </details>
  );
}
