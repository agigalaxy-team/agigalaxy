import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { createTaskCommentClient } from './task-comment-client.mjs';

const states: Record<string, string> = {
  visible: '可见',
  'pending-review': '待人工复核',
  rejected: '未获发布通过',
  retracted: '作者已撤回',
  'governance-hidden': '暂时停止展示',
  'comment-expired': '保留期已结束',
  blocked: '已屏蔽',
  'comment-permission-unavailable': '原文授权当前不可用',
  'comment-source-erased': '原文已清理',
  received: '已接收',
  resolved: '已形成处理决定',
  appealed: '申诉处理中',
  withdrawn: '举报者已撤回',
};
const actions: Record<string, string> = {
  create: '发布评论',
  edit: '修改评论',
  correct: '追加更正',
  retract: '撤回评论',
  report: '提交举报',
  supplement: '补充说明',
  appeal: '提出申诉',
  'withdraw-report': '撤回举报',
  pause: '暂时停止展示',
  resolve: '记录处理决定',
  resume: '解除本项临时限制',
};
function Audience({ ids, selected, onChange }: any) {
  return (
    <fieldset>
      <legend>本次内容可见人员</legend>
      {!ids.length ? (
        <p className="muted">仅本人保留；当前没有可选的处理者。</p>
      ) : (
        ids.map((id: string) => (
          <label key={id} className="button-row">
            <input
              type="checkbox"
              checked={selected.includes(id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, id]
                    : selected.filter((x: string) => x !== id),
                )
              }
            />
            <code>{id}</code>
          </label>
        ))
      )}
    </fieldset>
  );
}

// This component also renders for anonymous readers; put it outside the
// authenticated-only collaboration workbench in the Task detail page.
export function TaskCommentsWorkspace(props: any) {
  return <TaskCommentsSession key={`${props.task.taskId}:${props.runtime?.api.endpoint}:${props.subjectId ?? 'anonymous'}:${props.connected}`} {...props}/>;
}
function TaskCommentsSession({
  task,
  runtime,
  subjectId,
  connected,
}: any) {
  const taskId = task.taskId,
    privateTask = task.request?.visibility === 'Private';
  const client = useMemo(
    () =>
      connected
        ? createTaskCommentClient({
            api: runtime.api,
            getLocal: runtime.getLocal,
            putLocal: runtime.putLocal,
            subjectId,
            taskId,
          })
        : null,
    [runtime, subjectId, taskId, connected],
  );
  const [comments, setComments] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<any[]>([]),
    [quota, setQuota] = useState<any>(null),
    [config, setConfig] = useState<any>(null);
  const [editor, setEditor] = useState<any>(null),
    [text, setText] = useState(''),
    [reason, setReason] = useState(''),
    [audience, setAudience] = useState<string[]>([]),
    [preview, setPreview] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]),
    [reportNext, setReportNext] = useState<string | null>(null),
    [reportComment, setReportComment] = useState<string | null>(null);
  const committedRef = useRef(false);
  const [category, setCategory] = useState('advertising'),
    [verdict, setVerdict] = useState('dismissed'),
    [disposition, setDisposition] = useState('unchanged'),
    [rule, setRule] = useState('comment-rules/1'),
    [pauseMinutes, setPauseMinutes] = useState(60);
  const knownPeople = [
    ...new Set([
      task.requesterId,
      ...(task.participations ?? []).map((p: any) => p.subjectId),
      ...(editor?.comment?.authorId ? [editor.comment.authorId] : []),
    ]),
  ].filter((id) => id && id !== subjectId) as string[];
  async function read(after?: string) {
    const value = await runtime.api.call(
      '/v2/comments/query',
      { taskId, query, ...(after ? { after } : {}), limit: 20 },
      { authenticated: !!connected },
    );
    setComments((old) => (after ? [...old, ...value.items] : value.items));
    setNext(value.nextAfter);
  }
  async function local() {
    if (client) setPending(await client.pending());
  }
  async function extras() {
    if (!client) return;
    const results = await Promise.allSettled([
      client.governanceConfig(),
      runtime.api.call('/v2/account/quotas', {}),
      client.pending(),
    ]);
    if (results[0].status === 'fulfilled') setConfig(results[0].value);
    else setConfig({ unavailable: true, message: results[0].reason.message });
    if (results[1].status === 'fulfilled') setQuota(results[1].value);
    else setQuota({ unavailable: true, message: results[1].reason.message });
    if (results[2].status === 'fulfilled') setPending(results[2].value);
  }
  async function run(fn: () => Promise<any>) {
    if (busy) return;
    setBusy(true);
    setError('');
    committedRef.current = false;
    try {
      await fn();
    } catch (e: any) {
      setError(committedRef.current ? '评论或处理记录已收到服务回执，但当前列表暂未刷新；请查询原操作，不要重复提交。' : e.message);
    } finally {
      try {
        await local();
      } catch {}
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    setComments([]);
    setEditor(null);
    setPreview(null);
    setReports([]);
    setPending([]);
    setError('');
    setQuota(null);
    setConfig(null);
    (async () => {
      try {
        const v = await runtime.api.call(
          '/v2/comments/query',
          { taskId, limit: 20 },
          { authenticated: !!connected },
        );
        if (active) {
          setComments(v.items);
          setNext(v.nextAfter);
          if (client) await extras();
        }
      } catch (e: any) {
        if (active) setError(typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请稍后重试。');
      }
    })();
    const reload=()=>{if(!active||document.visibilityState!=='visible'||busy)return;void (async()=>{try{const v=await runtime.api.call('/v2/comments/query',{taskId,limit:20},{authenticated:!!connected});if(active){setComments(v.items);setNext(v.nextAfter);if(client)await extras();}}catch(e:any){if(active)setError(typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请稍后重试。');}})();};
    const timer=window.setInterval(reload,15000);const onVisible=()=>reload();document.addEventListener('visibilitychange',onVisible);
    return () => {
      active = false;window.clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);
    };
  }, [client, taskId, runtime, connected]);
  function begin(kind: string, comment?: any, report?: any) {
    setPreview(null);
    setEditor({ kind, comment, report });
    setText(['edit', 'correct'].includes(kind) ? (comment.body ?? '') : '');
    setReason('');
    setCategory(
      comment?.state === 'pending-review' ? 'review-request' : 'advertising',
    );
    setDisposition('unchanged');
    setVerdict('dismissed');
    setAudience(
      kind === 'retract'
        ? []
        : report
          ? ['pause', 'resume', 'resolve'].includes(kind)
            ? (report.decisionRecipients ?? [])
            : (config?.moderatorIds ?? [])
          : kind === 'report'
            ? (config?.moderatorIds ?? [])
            : privateTask
              ? [task.requesterId].filter((id) => id !== subjectId)
              : [],
    );
  }
  async function loadReports(commentId?: string, after?: string) {
    if (!client) return;
    const v = await client.reports({
      ...(commentId ? { commentId } : {}),
      ...(after ? { after } : {}),
      limit: 10,
    });
    setReports((old) => (after ? [...old, ...v.items] : v.items));
    setReportNext(v.nextAfter);
    setReportComment(commentId ?? null);
    if (v.scanTruncated)
      setNotice(
        '本次处理记录扫描达到上限，请从具体评论打开相关记录以缩小范围。',
      );
  }
  async function prepare() {
    if (!client || !editor) return;
    const { kind, comment, report } = editor;
    let payload: any,
      type = 'comment',
      visibility = privateTask ? 'Private' : 'Public';
    if (['create', 'edit', 'correct', 'retract'].includes(kind)) {
      payload = {
        schemaVersion: 2,
        id: crypto.randomUUID(),
        commentId: kind === 'create' ? crypto.randomUUID() : comment.commentId,
        taskId,
        expectedRevision: kind === 'create' ? 0 : comment.revision,
        kind,
      };
      if (kind !== 'retract') {
        payload.body = text;
        payload.visibility = 'inherit-task';
        if (kind === 'create')
          payload.replyTo = comment
            ? { id: comment.commentId, revision: comment.revision }
            : null;
        if (kind === 'correct') payload.reason = reason;
      } else visibility = 'Private';
    } else if (kind === 'report') {
      type = 'report';
      visibility = 'Private';
      payload = {
        schemaVersion: 2,
        id: crypto.randomUUID(),
        target: {
          type: 'task-comment',
          id: comment.commentId,
          revision: comment.revision,
        },
        category,
        summary: text,
      };
    } else {
      type = 'governance';
      visibility = 'Private';
      payload = {
        schemaVersion: 2,
        id: crypto.randomUUID(),
        reportId: report.reportId,
        expectedVersion: report.version,
        kind,
        summary: text,
      };
      if (kind === 'pause') {
        payload.until = Math.floor(Date.now() / 1000) + pauseMinutes * 60;
        payload.rule = rule;
      }
      if (kind === 'resolve') {
        payload.rule = rule;
        payload.verdict = verdict;
        payload.reviewDisposition = disposition;
      }
    }
    setPreview(
      await client.prepare(type, payload, {
        visibility,
        viewers: visibility === 'Private' ? audience : [],
      }),
    );
  }
  const modAction =
      editor && ['pause', 'resume', 'resolve'].includes(editor.kind),
    governanceAction =
      editor && !['create', 'edit', 'correct', 'retract'].includes(editor.kind);
  const availableAudience = governanceAction
    ? modAction
      ? (editor?.report?.decisionRecipients ?? [])
      : (config?.moderatorIds ?? []).filter((id: string) => id !== subjectId)
    : knownPeople;
  const commentQuota = quota?.quotas?.find(
    (x: any) => x.category === 'comment',
  );
  return (
    <section className="task-comments-workspace">
      <h2>任务评论</h2>
      <p className="muted">
        在这里澄清问题、讨论方案或表达意愿。实际参与和交付验收在协作进程中单独确认。
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
      <form
        className="button-row"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => read());
        }}
      >
        <Input
          aria-label="检索本任务评论"
          placeholder="检索当前可见评论"
          maxLength={120}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={busy}>
          查询
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await read();
              await extras();
            })
          }
        >
          刷新
        </Button>
      </form>
      {!connected ? (
        <p>连接银河并完成账号验证后，可以评论和回复；公开评论仍可浏览。</p>
      ) : (
        <>
          {quota?.unavailable ? (
            <p className="muted">
              账号额度当前不可读取：{quota.message}
              。请在身份设置完成邮箱或第三方账号验证。
            </p>
          ) : (
            commentQuota && (
              <p className="muted">
                今日公开评论 {commentQuota.used}/{commentQuota.limit}
                。同账号的各端共享额度；普通编辑不新增计数。
                {privateTask &&
                  '本任务评论仅向选定人员披露，不占公开评论额度。'}
              </p>
            )
          )}
          <div className="button-row">
            <Button
              type="button"
              disabled={busy}
              onClick={() => begin('create')}
            >
              撰写评论
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => loadReports())}
            >
              我的可见处理记录
            </Button>
          </div>
        </>
      )}
      {!comments.length && <p className="muted">当前查询没有可显示的评论。</p>}
      {comments.map((c) => (
        <article className="task-card" key={c.commentId}>
          <div className="button-row">
            <code>{c.authorId}</code>
            <span className="tag">{states[c.state] ?? c.state}</span>
          </div>
          <p className="muted">
            版本 {c.revision} · {new Date(c.createdAt).toLocaleString()} ·
            保留至 {new Date(c.expiresAt).toLocaleString()}
          </p>
          {c.replyTo && (
            <blockquote>
              {c.replyTo.body ?? '所回复的原文版本当前不可用。'}
            </blockquote>
          )}
          <p style={{ whiteSpace: 'pre-wrap' }}>
            {c.body ?? '此评论原文当前不展示。'}
          </p>
          {c.rule?.reasons?.length > 0 && (
            <p className="muted">
              规则提示：{c.rule.reasons.join('、')}
              。这是复核提示，不是违规或能力结论。
            </p>
          )}
          {connected && (
            <div className="button-row">
              {c.body && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => begin('create', c)}
                >
                  回复此版本
                </Button>
              )}
              {c.canEdit && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => begin('edit', c)}
                >
                  修改
                </Button>
              )}
              {c.canCorrect && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => begin('correct', c)}
                >
                  追加更正
                </Button>
              )}
              {c.canRetract && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => begin('retract', c)}
                >
                  撤回
                </Button>
              )}
              {(c.body || c.authorId === subjectId) && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => begin('report', c)}
                >
                  {c.authorId === subjectId ? '请求复核' : '举报此版本'}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => run(() => loadReports(c.commentId))}
              >
                相关处理记录
              </Button>
            </div>
          )}
        </article>
      ))}
      {next && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => run(() => read(next))}
        >
          继续读取评论
        </Button>
      )}
      {editor && !preview && (
        <form
          className="workspace-form"
          onSubmit={(e) => {
            e.preventDefault();
            run(prepare);
          }}
        >
          <h3>{actions[editor.kind]}</h3>
          {editor.comment && (
            <p className="muted">
              针对评论版本 {editor.comment.revision}，作者{' '}
              {editor.comment.authorId}。
            </p>
          )}
          {editor.report && (
            <p className="muted">
              针对处理记录版本 {editor.report.version}
              ；其他限制和原文许可仍分别生效。
            </p>
          )}
          {editor.kind === 'report' && (
            <label>
              问题类型
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {[
                  ['advertising', '广告或无关推广'],
                  ['harassment', '骚扰'],
                  ['privacy', '隐私'],
                  ['review-request', '请求复核我的内容'],
                  ['other', '其他'],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
          {editor.kind !== 'retract' ? (
            <label>
              {governanceAction ? '本次说明（只填必要情况）' : '评论正文'}
              <Textarea
                required
                maxLength={governanceAction ? 1600 : 6000}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
          ) : (
            <p>
              撤回会停止展示本人评论，其他人的独立回复保留。原文按保留策略处理。
            </p>
          )}
          {editor.kind === 'correct' && (
            <label>
              更正原因
              <Input
                required
                maxLength={600}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          )}
          {editor.kind === 'pause' && (
            <label>
              限制时长（分钟，最多 7 天）
              <Input
                type="number"
                required
                min={1}
                max={10080}
                value={pauseMinutes}
                onChange={(e) => setPauseMinutes(Number(e.target.value))}
              />
            </label>
          )}
          {editor.kind === 'resolve' && (
            <>
              <label>
                本项处理结论
                <select
                  value={verdict}
                  onChange={(e) => setVerdict(e.target.value)}
                >
                  <option value="dismissed">不认定所报问题成立</option>
                  <option value="upheld">认定所报问题成立</option>
                </select>
              </label>
              <label>
                此版本的复核状态
                <select
                  value={disposition}
                  onChange={(e) => setDisposition(e.target.value)}
                >
                  <option value="unchanged">不改变发布复核状态</option>
                  <option
                    value="approve"
                    disabled={!editor.report.canReviewSource}
                  >
                    通过发布复核
                  </option>
                  <option
                    value="reject"
                    disabled={!editor.report.canReviewSource}
                  >
                    不通过发布复核
                  </option>
                </select>
              </label>
            </>
          )}
          {['pause', 'resolve'].includes(editor.kind) && (
            <label>
              采用的规则及版本
              <Input
                required
                maxLength={120}
                value={rule}
                onChange={(e) => setRule(e.target.value)}
              />
            </label>
          )}
          {(privateTask || governanceAction) && editor.kind !== 'retract' && (
            <Audience
              ids={availableAudience}
              selected={audience}
              onChange={setAudience}
            />
          )}
          {governanceAction && !config?.configured && (
            <p className="muted">
              未配置官方处理者时，本次只记录本人请求，不能承诺有人受理或形成裁定。以后如需向新处理者披露，请另行补充确认。
            </p>
          )}
          <div className="button-row">
            <Button type="submit" disabled={busy}>
              预览这次操作
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setEditor(null);
                setText('');
              }}
            >
              取消编辑
            </Button>
          </div>
        </form>
      )}
      {preview && (
        <div className="workspace-form">
          <h3>确认{actions[editor?.kind] ?? '本次记录'}</h3>
          <p>
            {preview.visibility === 'Public'
              ? '任何人可读取这条评论。'
              : '仅本人及以下选定身份可读取本次内容：'}
          </p>
          {preview.viewers.map((id: string) => (
            <p key={id}>
              <code>{id}</code>
            </p>
          ))}
          <p style={{ whiteSpace: 'pre-wrap' }}>
            {preview.payload.body ?? preview.payload.summary ?? '撤回本人评论'}
          </p>
          {preview.payload.reason && <p>原因：{preview.payload.reason}</p>}
          {preview.payload.until && (
            <p>
              限制截止：
              {new Date(preview.payload.until * 1000).toLocaleString()}
            </p>
          )}
          {preview.payload.verdict && (
            <p>
              结论：
              {preview.payload.verdict === 'upheld' ? '问题成立' : '不认定成立'}
              ；发布复核：
              {
                { unchanged: '保持', approve: '通过', reject: '不通过' }[
                  preview.payload.reviewDisposition as string
                ]
              }
              。
            </p>
          )}
          <p className="muted">
            此操作不替任何人确认参与、交付成功或能力资格。取消预览不会发送内容。
          </p>
          <div className="button-row">
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await client!.execute(preview, { confirmed: true });
                  committedRef.current = true;
                  setPreview(null);
                  setEditor(null);
                  setText('');
                  setNotice('服务已确认原操作，下面展示当前有效状态。');
                  await read();
                  await extras();
                  if (reportComment) await loadReports(reportComment);
                })
              }
            >
              确认记录
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              返回修改
            </Button>
          </div>
        </div>
      )}
      {!!pending.length && (
        <div className="workspace-form">
          <h3>待核对操作</h3>
          <p className="muted">
            响应丢失时先查询原操作。停止本机重试不代表服务端取消，稍晚到达的请求仍可能完成。
          </p>
          {pending.map((p) => (
            <article key={p.operationId}>
              <code>{p.operationId}</code>
              <p>
                {p.state === 'stopped-local'
                  ? '本机已停止重试，服务端取消未确认。'
                  : '原操作尚待核对。'}
              </p>
              <div className="button-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await client!.reconcile(p.operationId);
                      setNotice(
                        r.state === 'acknowledged'
                          ? '原操作已确认。'
                          : '当前尚无原操作回执；不是取消证明。',
                      );
                      await read();
                    })
                  }
                >
                  查询原操作
                </Button>
                {p.state !== 'stopped-local' && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await client!.retry(p.operationId, {
                            confirmed: true,
                          });
                          committedRef.current = true;
                          setPreview(null);
                          setEditor(null);
                          await read();
                        })
                      }
                    >
                      确认重试原操作
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await client!.stopLocalRetry(p.operationId, {
                            confirmed: true,
                          });
                          setPreview(null);
                          setEditor(null);
                          setText('');
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
        </div>
      )}
      {!!reports.length && (
        <div>
          <h3>当前有权查看的处理记录</h3>
          {reports.map((g) => (
            <article key={g.reportId} className="task-card">
              <p>
                {states[g.state] ?? g.state} · 版本 {g.version}
              </p>
              <p className="muted">
                针对评论版本 {g.target.revision}。
                {g.pauseUntil &&
                  ` 临时限制截止：${new Date(g.pauseUntil).toLocaleString()}。`}
              </p>
              {g.source?.body && <blockquote>{g.source.body}</blockquote>}
              {!g.events.length && (
                <p className="muted">
                  记录存在，但相关说明当前没有向此身份开放。
                </p>
              )}
              {g.events.map((e: any) => (
                <div key={e.eventId}>
                  <p>
                    {actions[e.kind ?? 'report']} · {e.authorId}
                  </p>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{e.summary}</p>
                </div>
              ))}
              <div className="button-row">
                {g.canSupplement && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const current = await client!.report(g.reportId);
                        begin('supplement', undefined, current);
                      })
                    }
                  >
                    补充说明
                  </Button>
                )}
                {g.canAppeal && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        begin(
                          'appeal',
                          undefined,
                          await client!.report(g.reportId),
                        ),
                      )
                    }
                  >
                    提出申诉
                  </Button>
                )}
                {g.canWithdrawReport && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => begin('withdraw-report', undefined, g)}
                  >
                    撤回举报
                  </Button>
                )}
                {g.canModerate && (
                  <>
                    {g.canReviewSource && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => begin('pause', undefined, g)}
                      >
                        暂时停止展示
                      </Button>
                    )}
                    {!['resolved', 'withdrawn'].includes(g.state) && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => begin('resolve', undefined, g)}
                      >
                        记录处理决定
                      </Button>
                    )}
                    {g.pauseUntil && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => begin('resume', undefined, g)}
                      >
                        解除本项临时限制
                      </Button>
                    )}
                  </>
                )}
              </div>
            </article>
          ))}
          {reportNext && (
            <Button
              type="button"
              disabled={busy}
              variant="outline"
              onClick={() =>
                run(() => loadReports(reportComment ?? undefined, reportNext))
              }
            >
              继续读取处理记录
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
