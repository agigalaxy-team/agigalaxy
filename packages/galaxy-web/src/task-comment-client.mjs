import {
  taskCommentV2Schema,
  commentReportV2Schema,
  commentModerationV2Schema,
} from '../../galaxy-official/src/shared/task-comment-v2-schema.mjs';
import { sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';

// One durable operation journal per subject + endpoint + Task. A missing ACK
// never becomes a fresh publication ID; stopped local retries retain a receipt.
export function createTaskCommentClient({
  api,
  getLocal,
  putLocal,
  subjectId,
  taskId,
}) {
  const endpoint = api.endpoint,
    key = `comment-operations:${endpoint}:${subjectId}:${taskId}`,
    previews = new WeakMap();
  let queue = Promise.resolve();
  const check = () => {
    if (api.endpoint !== endpoint || api.snapshot()?.subjectId !== subjectId)
      throw new Error('身份或连接已改变，请重新打开评论区。');
  };
  /** @template T @param {()=>Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  const load = async () => {
    check();
    const row = await getLocal(key);
    check();
    return row ?? { active: null, stopped: [] };
  };
  const save = async (row) => {
    check();
    await putLocal(key, row);
    check();
  };
  const query = (path, input, options) => api.call(path, input, options);
  /** @param {string} type @param {any} input @param {{visibility?:string,viewers?:string[]}} options */
  async function prepare(
    type,
    input,
    { visibility = 'Private', viewers = [] } = {},
  ) {
    check();
    const payload = (
      type === 'comment'
        ? taskCommentV2Schema
        : type === 'report'
          ? commentReportV2Schema
          : commentModerationV2Schema
    ).parse(input);
    if (payload.taskId && payload.taskId !== taskId)
      throw new Error('评论目标任务不匹配。');
    const selected = [...new Set(viewers.filter((id) => id !== subjectId))];
    if (
      !['Public', 'Private'].includes(visibility) ||
      (type !== 'comment' && visibility !== 'Private')
    )
      throw new Error('处理记录仅向选定人员披露。');
    if (visibility === 'Public' && selected.length)
      throw new Error('公开评论不能伪装为选定人员可见。');
    const payloadJson = JSON.stringify(payload),
      operation = {
        type,
        operationId: payload.id,
        payload,
        payloadJson,
        payloadHash: await sha256Hex(payloadJson),
        visibility,
        viewers: selected,
        path:
          type === 'comment'
            ? '/v2/comments'
            : type === 'report'
              ? '/v2/comment-governance/reports'
              : `/v2/comment-governance/${payload.reportId}/events`,
        receiptPath:
          type === 'comment'
            ? '/v2/comments/receipt'
            : '/v2/comment-governance/receipt',
      };
    const preview = structuredClone({ ...operation, taskId, subjectId });
    previews.set(preview, operation);
    return preview;
  }
  async function receipt(op) {
    check();
    const r = await query(op.receiptPath, {
      operationId: op.operationId,
      payloadHash: op.payloadHash,
    });
    check();
    if (!['absent', 'acknowledged', 'conflict'].includes(r.state))
      throw new Error('评论操作回执无效。');
    if (r.state === 'conflict')
      throw new Error('发现同号不同内容，请保留原操作核对。');
    return r;
  }
  async function clear(op) {
    const state = await load();
    if (state.active?.operationId === op.operationId) state.active = null;
    state.stopped = state.stopped.filter(
      (x) => x.operationId !== op.operationId,
    );
    await save(state);
  }
  async function send(op) {
    try {
      if (!op.submission) {
        if (!op.prepared) {
          op.prepared = await api.prepareAuthorization(op.payloadJson, {
            action:
              op.type === 'comment' ? 'comment.publish' : 'moderation.publish',
            objectId: op.operationId,
            visibility: op.visibility,
            viewers: op.viewers,
            confirmed: true,
          });
          await save({ ...(await load()), active: op });
        }
        const reconcile = op.authorizationAttempted === true;
        op.authorizationAttempted = true;
        await save({ ...(await load()), active: op });
        op.submission = await api.submitAuthorization(op.prepared, {
          confirmed: true,
          reconcile,
        });
        await save({ ...(await load()), active: op });
      }
      op.businessAttempted = true;
      await save({ ...(await load()), active: op });
      await query(op.path, op.submission);
      check();
      const recorded = await receipt(op);
      if (recorded.state !== 'acknowledged')
        throw new Error('写入后回执尚未确认，请查询原操作。');
      await clear(op);
      return recorded;
    } catch (error) {
      throw Object.assign(error, {
        operationId: op.operationId,
        resultUnknown: error.outcome !== 'rejected',
      });
    }
  }
  return {
    prepare,
    execute: (preview, { confirmed = false } = {}) =>
      serial(async () => {
        check();
        const op = previews.get(preview);
        if (!confirmed || !op)
          throw new Error('请先预览并确认本次评论或处理记录。');
        const state = await load();
        if (state.active) throw new Error('请先处理上一次评论操作的回执。');
        previews.delete(preview);
        await save({ ...state, active: op });
        return send(op);
      }),
    pending: async () => {
      const state = await load();
      return [
        ...(state.active
          ? [
              {
                operationId: state.active.operationId,
                type: state.active.type,
                payload: state.active.payload,
                state: 'awaiting-receipt',
              },
            ]
          : []),
        ...state.stopped,
      ];
    },
    reconcile: (operationId) =>
      serial(async () => {
        const state = await load(),
          op =
            state.active?.operationId === operationId
              ? state.active
              : state.stopped.find((x) => x.operationId === operationId);
        if (!op) throw new Error('原操作不存在。');
        const r = await receipt(op);
        if (r.state === 'acknowledged') await clear(op);
        return r;
      }),
    retry: (operationId, { confirmed = false } = {}) =>
      serial(async () => {
        const op = (await load()).active;
        if (!confirmed || op?.operationId !== operationId)
          throw new Error('请确认重试原操作；已停止的本机操作不能重发。');
        const r = await receipt(op);
        if (r.state === 'acknowledged') {
          await clear(op);
          return r;
        }
        return send(op);
      }),
    stopLocalRetry: (operationId, { confirmed = false } = {}) =>
      serial(async () => {
        const state = await load(),
          op = state.active;
        if (!confirmed || op?.operationId !== operationId)
          throw new Error('请确认停止本机重试。');
        const r = await receipt(op);
        if (r.state === 'acknowledged') {
          await clear(op);
          return r;
        }
        const minimal = {
          operationId: op.operationId,
          type: op.type,
          payloadHash: op.payloadHash,
          receiptPath: op.receiptPath,
          state: 'stopped-local',
          serverCancellationConfirmed: false,
        };
        await save({ active: null, stopped: [...state.stopped, minimal] });
        return minimal;
      }),
    query: (input) => query('/v2/comments/query', { ...input, taskId }),
    get: (id) => query('/v2/comments/' + id, undefined, { method: 'GET' }),
    governanceConfig: () =>
      query('/v2/comment-governance/config', undefined, { method: 'GET' }),
    reports: (input) => query('/v2/comment-governance/query', input),
    report: (id) =>
      query('/v2/comment-governance/' + id, undefined, { method: 'GET' }),
  };
}
