import {
  taskCommentV2Schema,
  commentReportV2Schema,
  commentModerationV2Schema,
} from "../../../../../galaxy-contracts/src/task-comment-v2-schema.mjs";
import { equalJson, sha256Hex } from "../../../../../galaxy-contracts/src/web-primitives.mjs";
import { createCommentEditorDraft } from "./editor-draft.mjs";

const operationQueues = new WeakMap();

// One durable operation journal per subject + endpoint + Task. A missing ACK
// never becomes a fresh publication ID; stopped local retries retain a receipt.
export function createTaskCommentClient({
  api,
  getLocal,
  putLocal,
  updateLocal,
  subjectId,
  taskId,
  receiptStatus,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const endpoint = api.endpoint,
    key = `comment-operations:${endpoint}:${subjectId}:${taskId}`,
    previews = new WeakMap(), authorizationPreviews = new WeakMap();
  if (!operationQueues.has(api)) operationQueues.set(api, new Map());
  const operationQueue = operationQueues.get(api);
  const checkOwner = () => {
    if (api.endpoint !== endpoint || api.snapshot()?.subjectId !== subjectId)
      throw new Error('身份或连接已改变，请重新打开评论区。');
  };
  function captureLease() {
    checkOwner();
    const original = api.snapshot(), runtimeLease = receiptStatus?.captureLease?.();
    if (runtimeLease && (runtimeLease.subjectId !== subjectId || runtimeLease.endpoint !== endpoint
      || typeof runtimeLease.assertCurrent !== 'function')) throw new Error('当前评论身份租约不可用。');
    const check = () => {
      runtimeLease?.assertCurrent(); checkOwner();
      const current = api.snapshot();
      if (['subjectId', 'endpoint', 'bindingId', 'generation'].some(field => original[field] !== current?.[field]))
        throw new Error('身份或连接已改变，原评论操作已保留，请重新核对。');
    };
    check();
    return { subjectId, endpoint, taskId, bindingId: original?.bindingId ?? null,
      generation: original?.generation ?? null, deviceId: runtimeLease?.deviceId ?? null,
      assertCurrent: check, check, async wait(action) {
      check(); let result;
      try { result = await action(); } catch (error) { check(); throw error; }
      check(); return result;
    } };
  }
  /** @template T @param {(lease:any)=>Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    // Capture before enqueue, so a waiting action cannot inherit a later binding.
    const lease = captureLease(), invoke = () => { lease.check(); return fn(lease); };
    const run = (operationQueue.get(key) ?? Promise.resolve()).then(invoke, invoke);
    const tail = run.then(
      () => {},
      () => {},
    );
    operationQueue.set(key, tail);
    void tail.then(() => { if (operationQueue.get(key) === tail) operationQueue.delete(key); });
    return run;
  };
  const readJournal = row => {
    if (row && (row.subjectId && row.subjectId !== subjectId || row.endpoint && row.endpoint !== endpoint
      || row.taskId && row.taskId !== taskId)) throw new Error('本机原评论操作不属于当前身份、站点或任务。');
    return row ?? { active: null, stopped: [] };
  };
  const load = async lease => readJournal(await lease.wait(() => getLocal(key, subjectId)));
  const mutateJournal = async (lease, change) => {
    const update = row => { lease.check(); return { ...change(readJournal(row)), subjectId, endpoint, taskId }; };
    if (typeof updateLocal === 'function') return lease.wait(() => updateLocal(key, update, subjectId));
    const next = update(await load(lease));
    await lease.wait(() => putLocal(key, next, subjectId));
    return next;
  };
  const operationChanged = () => Object.assign(new Error('原评论操作已变化，请重新读取原内容；本次没有替换它。'), {code: 'comment_operation_changed'});
  const sameOperation = (left, right) => left?.operationId === right.operationId && left?.type === right.type
    && left?.payloadHash === right.payloadHash && left?.payloadJson === right.payloadJson
    && (left?.journalRevision ?? null) === (right.journalRevision ?? null);
  async function persist(op, lease) {
    const revision = crypto.randomUUID();
    await mutateJournal(lease, state => {
      if (!sameOperation(state.active, op)) throw operationChanged();
      return {...state, active: {...op, journalRevision: revision}};
    });
    op.journalRevision = revision;
  }
  const deadlineOf = op => op.expiresAt ?? op.prepared?.intent?.expiresAt ?? null;
  const bindingOf = op => op.prepared?.intent?.bindingId ?? op.authorizationBindingId ?? null;
  const draft = createCommentEditorDraft({
    api, endpoint, subjectId, taskId, getLocal, updateLocal, captureLease, load,
    query: (...args) => query(...args),
  });
  const hasGovernanceScope = () => api.snapshot()?.scopes?.some(scope => scope === 'moderation' || scope === '*') === true;
  const requireGovernanceScope = () => {
    if (!hasGovernanceScope()) throw Object.assign(new Error('当前浏览器设备未获准使用评论处理功能；评论阅读和原任务仍可继续。请在已有设备核对需要的权限。'), { code: 'device_scope_required' });
  };
  const query = (lease, path, input, options) => {
    lease.check(); if (path.startsWith('/v2/comment-governance/')) requireGovernanceScope();
    return lease.wait(() => api.call(path, input, options));
  };
  /** @param {string} type @param {any} input @param {{visibility?:string,viewers?:string[],expiresAt?:number}} options */
  async function prepare(
    type,
    input,
    { visibility = 'Private', viewers = [], expiresAt = now() + 2591900 } = {},
  ) {
    const lease = captureLease();
    if (!['comment', 'report', 'governance'].includes(type)) throw new Error('评论操作类型无效。');
    if (type !== 'comment') requireGovernanceScope();
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
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt - now() > 2592000)
      throw new Error('请核对本次披露的有效期限。');
    const payloadJson = JSON.stringify(payload),
      operation = {
        type,
        operationId: payload.id,
        payload,
        payloadJson,
        payloadHash: await lease.wait(() => sha256Hex(payloadJson)),
        visibility,
        viewers: selected,
        expiresAt,
        authorizationBindingId: lease.bindingId,
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
    previews.set(preview, { operation, lease, serialized: JSON.stringify(preview) });
    return preview;
  }
  async function receipt(op, lease) {
    const r = await query(lease, op.receiptPath, {
      operationId: op.operationId,
      payloadHash: op.payloadHash,
    });
    if (!['absent', 'acknowledged', 'conflict'].includes(r.state)
      || r.operationId !== undefined && r.operationId !== op.operationId)
      throw new Error('评论操作回执无效。');
    if (r.state === 'conflict')
      throw new Error('发现同号不同内容，请保留原操作核对。');
    return r;
  }
  async function clear(op, lease) {
    await mutateJournal(lease, state => {
      if (state.active?.operationId === op.operationId && state.active.payloadHash === op.payloadHash) state.active = null;
      // A late ACK retires only its original body; a newer operation survives.
      state.stopped = [...state.stopped.filter(x => x.operationId !== op.operationId), {
        operationId: op.operationId, type: op.type, payloadHash: op.payloadHash,
        receiptPath: op.receiptPath, state: 'acknowledged',
      }];
      return state;
    });
  }
  async function original(op, lease) {
    if (!['comment', 'report', 'governance'].includes(op.type)) throw operationChanged();
    const raw = JSON.parse(op.payloadJson), payload = (op.type === 'comment' ? taskCommentV2Schema
      : op.type === 'report' ? commentReportV2Schema : commentModerationV2Schema).parse(raw);
    const path = op.type === 'comment' ? '/v2/comments' : op.type === 'report' ? '/v2/comment-governance/reports'
      : `/v2/comment-governance/${payload.reportId}/events`;
    if (payload.id !== op.operationId || payload.taskId && payload.taskId !== taskId || !equalJson(raw, payload)
      || !equalJson(payload, op.payload) || await lease.wait(() => sha256Hex(op.payloadJson)) !== op.payloadHash
      || op.path !== path || op.receiptPath !== (op.type === 'comment' ? '/v2/comments/receipt' : '/v2/comment-governance/receipt')
      || !['Public', 'Private'].includes(op.visibility) || !Array.isArray(op.viewers)
      || new Set(op.viewers).size !== op.viewers.length || op.visibility === 'Public' && op.viewers.length
      || op.type !== 'comment' && op.visibility !== 'Private') throw operationChanged();
    if (op.prepared) await checkPrepared(op, op.prepared, lease, deadlineOf(op));
    if (op.submission && (!op.prepared || op.submission.consentId !== op.prepared.intent.id || op.submission.payloadJson !== op.payloadJson))
      throw operationChanged();
    return {payload, deadline: deadlineOf(op)};
  }
  async function checkPrepared(op, prepared, lease, deadline) {
    const intent = prepared?.intent;
    if (!intent || prepared.version !== 1 || prepared.endpoint !== endpoint || prepared.payloadJson !== op.payloadJson
      || intent.subjectId !== subjectId || intent.endpoint !== endpoint || intent.objectId !== op.operationId
      || intent.action !== (op.type === 'comment' ? 'comment.publish' : 'moderation.publish')
      || intent.visibility !== op.visibility || intent.purpose !== (op.visibility === 'Public' ? 'public-profile' : 'operational')
      || intent.recipient !== endpoint || intent.payloadHash !== op.payloadHash || intent.expiresAt !== deadline
      || !equalJson(intent.viewers, op.viewers) || !equalJson(intent.fields, Object.keys(JSON.parse(op.payloadJson)))) throw operationChanged();
    lease.check();
  }
  async function permission(op, lease) {
    // Keep old signed attempts queryable. Receipt acceptance, rather than the
    // current binding, decides whether an already granted original may be used.
    let inactive = null;
    for (const prepared of [op.prepared, ...(op.previousAuthorizations ?? []).slice().reverse()].filter(Boolean)) {
      await checkPrepared(op, prepared, lease, prepared.intent.expiresAt);
      let accepted;
      try { accepted = await lease.wait(() => api.reconcileAuthorization(prepared)); }
      catch (error) {
        if (error.code !== 'consent_receipt_not_active_or_mismatched') throw error;
        const saved = await lease.wait(() => api.call('/v2/consents/receipt', {consentId: prepared.intent.id}));
        if (saved?.state !== 'recorded' || saved.consentId !== prepared.intent.id || !equalJson(saved.intent, prepared.intent)
          || saved.signatureHash !== await lease.wait(() => sha256Hex(prepared.signedIntent)) || !['expired', 'revoked'].includes(saved.status)) throw error;
        inactive ??= saved.status; continue;
      }
      if (accepted.state === 'acknowledged' && accepted.consentId === prepared.intent.id && accepted.payloadJson === op.payloadJson)
        return {state: 'acknowledged', prepared, submission: {consentId: accepted.consentId, payloadJson: op.payloadJson}};
      if (accepted.state !== 'absent' || accepted.consentId !== prepared.intent.id) throw operationChanged();
    }
    return {state: inactive ? 'inactive' : 'absent', status: inactive};
  }
  const waitingView = op => ({state: 'unconfirmed', operationId: op.operationId, type: op.type,
    payloadHash: op.payloadHash, reason: op.rejection.reason, retryAt: op.rejection.retryAt ?? null,
    rejectionCode: op.rejection.code});
  async function waitCondition(op, lease) {
    if (!op.rejection) return null;
    const condition = op.rejection;
    if (['community_quota_exceeded', 'community_restricted'].includes(condition.code)) {
      let status;
      try { status = await lease.wait(() => api.call('/v2/account/quotas', {})); }
      catch { lease.check(); return {...waitingView(op), conditionUnavailable: true}; }
      const quota = status?.quotas?.find(item => item.category === 'comment');
      if (status?.accountVerified !== true || !quota || !Number.isSafeInteger(quota.remaining))
        return {...waitingView(op), conditionUnavailable: true};
      if (status.restriction || quota.remaining === 0) {
        const retryAt = status.restriction?.until ?? quota.resetAt;
        if (typeof retryAt === 'string' && Number.isFinite(Date.parse(retryAt)) && condition.retryAt !== retryAt) {
          condition.retryAt = retryAt; await persist(op, lease);
        }
        return waitingView(op);
      }
    } else if (condition.reason === 'original-rejected' || !condition.retryAt || Date.parse(condition.retryAt) > now() * 1000)
      return waitingView(op);
    delete op.rejection; await persist(op, lease); return null;
  }
  async function send(op, lease) {
    try {
      lease.check(); if (op.type !== 'comment') requireGovernanceScope();
      await original(op, lease);
      if (!op.submission) {
        if (!op.prepared) {
          op.prepared = await lease.wait(() => api.prepareAuthorization(op.payloadJson, {
            action:
              op.type === 'comment' ? 'comment.publish' : 'moderation.publish',
            objectId: op.operationId,
            visibility: op.visibility,
            viewers: op.viewers,
            expiresAt: op.expiresAt,
            confirmed: true,
          }));
          op.expiresAt = op.prepared.intent.expiresAt;
          op.authorizationBindingId = op.prepared.intent.bindingId;
          await persist(op, lease);
        }
        const reconcile = op.authorizationAttempted === true;
        op.authorizationAttempted = true;
        await persist(op, lease);
        op.submission = await lease.wait(() => api.submitAuthorization(op.prepared, {
          confirmed: true,
          reconcile,
        }));
        if (op.submission.consentId !== op.prepared.intent.id || op.submission.payloadJson !== op.payloadJson) throw operationChanged();
        await persist(op, lease);
      }
      op.businessAttempted = true;
      await persist(op, lease);
      await query(lease, op.path, op.submission);
      const recorded = await receipt(op, lease);
      if (recorded.state !== 'acknowledged')
        throw new Error('写入后回执尚未确认，请查询原操作。');
      await clear(op, lease);
      lease.check();
      return recorded;
    } catch (error) {
      // A definite rejection is not an unknown transmission. Preserve the
      // original bytes, and wait for a real quota/reset condition before POST.
      if (error.outcome === 'rejected' && error.status >= 400 && error.status < 500) {
        lease.check();
        const waiting = ['community_quota_exceeded', 'community_restricted', 'rate_limited', 'capacity_limited', 'invitation_cooldown'].includes(error.code);
        op.rejection = {code: error.code, reason: waiting ? error.code === 'invitation_cooldown' ? 'cooldown-wait' : 'quota-wait' : 'original-rejected',
          retryAt: error.retryAt ?? error.quota?.resetAt ?? null};
        await persist(op, lease);
        Object.assign(error, {reason: op.rejection.reason, retryAt: op.rejection.retryAt, originalOperationRetained: true});
      }
      throw Object.assign(error, {
        operationId: op.operationId,
        resultUnknown: error.outcome !== 'rejected',
      });
    }
  }
  const pendingView = op => ({
    operationId: op.operationId, type: op.type, payload: structuredClone(op.payload), payloadJson: op.payloadJson,
    payloadHash: op.payloadHash, visibility: op.visibility, viewers: [...op.viewers], expiresAt: deadlineOf(op),
    originalBindingId: bindingOf(op), blockedReason: op.blockedReason ?? null, state: 'awaiting-receipt',
    ...(op.rejection ? {reason: op.rejection.reason, retryAt: op.rejection.retryAt ?? null, rejectionCode: op.rejection.code} : {}),
  });
  async function reusePermission(op, accepted, lease) {
    if (op.prepared?.intent.id !== accepted.prepared.intent.id) {
      op.previousAuthorizations = [...(op.previousAuthorizations ?? []).filter(item => item.intent.id !== accepted.prepared.intent.id),
        ...(op.prepared ? [op.prepared] : [])];
    }
    op.prepared = accepted.prepared; op.submission = accepted.submission;
    op.expiresAt = accepted.prepared.intent.expiresAt; op.authorizationBindingId = accepted.prepared.intent.bindingId;
    delete op.blockedReason; await persist(op, lease);
  }
  async function resume(operationId, lease) {
    const state = await load(lease), op = operationId == null ? state.active
      : state.active?.operationId === operationId ? state.active : state.stopped.find(item => item.operationId === operationId);
    if (!op) return {state: 'none'};
    const result = await receipt(op, lease);
    if (result.state === 'acknowledged') { await clear(op, lease); return {...result, operationId: op.operationId, exactOperationConfirmed: true}; }
    if (op !== state.active) return {...result, operationId: op.operationId, reason: 'stopped-local'};
    const {deadline} = await original(op, lease), waiting = await waitCondition(op, lease);
    if (waiting) return waiting;
    const accepted = await permission(op, lease);
    if (accepted.state === 'acknowledged') { await reusePermission(op, accepted, lease); return send(op, lease); }
    const blocked = async reason => {
      if (op.blockedReason !== reason) { op.blockedReason = reason; await persist(op, lease); }
      return {state: 'unconfirmed', operationId: op.operationId, type: op.type, payloadHash: op.payloadHash, reason};
    };
    if (!Number.isSafeInteger(deadline)) return blocked('original-deadline-unavailable');
    if (deadline <= now()) return blocked('authorization-expired');
    if (accepted.state === 'inactive') return blocked(accepted.status === 'revoked' ? 'original-authorization-revoked' : 'authorization-expired');
    if (!bindingOf(op) || bindingOf(op) !== lease.bindingId)
      return blocked(bindingOf(op) ? 'original-binding-changed' : 'original-binding-unavailable');
    if (!op.prepared) return blocked('original-authorization-unavailable');
    // The saved choice is still valid on its original binding. Refresh only an
    // aged transport signature, keeping the original business bytes/deadline.
    if (op.prepared.intent.issuedAt < now() - 300) {
      if (!sameOperation((await load(lease)).active, op)) throw operationChanged();
      const replacement = await lease.wait(() => api.prepareAuthorization(op.payloadJson, {
        action: op.type === 'comment' ? 'comment.publish' : 'moderation.publish', objectId: op.operationId,
        visibility: op.visibility, viewers: op.viewers, expiresAt: deadline, confirmed: true,
      }));
      op.previousAuthorizations = [...(op.previousAuthorizations ?? []), op.prepared];
      op.prepared = replacement; op.submission = null; op.authorizationAttempted = false;
    }
    op.expiresAt = deadline; delete op.blockedReason; await persist(op, lease);
    return send(op, lease);
  }
  return {
    captureLease,
    draft,
    prepare,
    execute: (preview, { confirmed = false } = {}) =>
      serial(async (lease) => {
        const saved = previews.get(preview);
        if (!confirmed || !saved || saved.serialized !== JSON.stringify(preview))
          throw new Error('请先预览并确认本次评论或处理记录。');
        saved.lease.check(); const op = saved.operation;
        const state = await load(lease);
        if (state.active) throw new Error('请先处理上一次评论操作的回执。');
        if (state.stopped.some(row => row.operationId === op.operationId
          && ['stopped-local', 'acknowledged'].includes(row.state)))
          throw Object.assign(new Error('原操作已停止本机重试或已收到回执，请查询原操作；不能用同一编号重新发送。'),
            {code: 'comment_operation_terminal', operationId: op.operationId});
        previews.delete(preview);
        op.journalRevision = crypto.randomUUID();
        await mutateJournal(lease, current => {
          if (current.active || current.stopped.some(row => row.operationId === op.operationId)) throw operationChanged();
          return {...current, active: op};
        });
        return send(op, lease);
      }),
    pending: async () => {
      const lease = captureLease(), state = await load(lease);
      return [
        ...(state.active
          ? [
              pendingView(state.active),
            ]
          : []),
        ...state.stopped.filter(x => x.state !== 'acknowledged'),
      ];
    },
    reconcile: (operationId) =>
      serial(async (lease) => {
        const state = await load(lease),
          op =
            state.active?.operationId === operationId
              ? state.active
              : state.stopped.find((x) => x.operationId === operationId);
        if (!op) throw new Error('原操作不存在。');
        const r = await receipt(op, lease);
        if (r.state === 'acknowledged') await clear(op, lease);
        lease.check();
        return r;
      }),
    retry: (operationId, { confirmed = false } = {}) =>
      serial(async (lease) => {
        const op = (await load(lease)).active;
        if (!confirmed || op?.operationId !== operationId)
          throw new Error('请确认重试原操作；已停止的本机操作不能重发。');
        return resume(operationId, lease);
      }),
    /** @param {string|null} operationId */
    resumePending: (operationId = null) => serial(lease => resume(operationId, lease)),
    reviewPending: operationId => serial(async lease => {
      const op = (await load(lease)).active;
      if (op?.operationId !== operationId) throw operationChanged();
      await original(op, lease);
      return pendingView(op);
    }),
    reviewAuthorization: operationId => serial(async lease => {
      const op = (await load(lease)).active;
      if (op?.operationId !== operationId) throw operationChanged();
      const result = await receipt(op, lease);
      if (result.state === 'acknowledged') { await clear(op, lease); return {...result, operationId, exactOperationConfirmed: true}; }
      const {deadline} = await original(op, lease), waiting = await waitCondition(op, lease);
      if (waiting) return waiting;
      const accepted = await permission(op, lease);
      if (accepted.state === 'acknowledged') return {state: 'reuse-original-authorization', operationId};
      const preview = {...pendingView(op), state: 'reauthorization-required', endpoint, subjectId, taskId,
        originalExpiresAt: deadline, expiresAt: deadline > now() ? deadline : now() + 2591900,
        priorConsentId: op.prepared?.intent.id ?? null};
      authorizationPreviews.set(preview, {lease, serialized: JSON.stringify(preview), journalRevision: op.journalRevision ?? null});
      return preview;
    }),
    reauthorize: (preview, {confirmed = false} = {}) => serial(async lease => {
      const saved = authorizationPreviews.get(preview);
      if (!confirmed || !saved || saved.serialized !== JSON.stringify(preview)) throw new Error('请确认展示的原内容、受众与授权期限。');
      saved.lease.check();
      const op = (await load(lease)).active;
      if (op?.operationId !== preview.operationId || (op.journalRevision ?? null) !== saved.journalRevision
        || op.payloadHash !== preview.payloadHash || op.payloadJson !== preview.payloadJson
        || op.visibility !== preview.visibility || !equalJson(op.viewers, preview.viewers) || deadlineOf(op) !== preview.originalExpiresAt
        || (op.prepared?.intent.id ?? null) !== preview.priorConsentId) throw operationChanged();
      const result = await receipt(op, lease);
      if (result.state === 'acknowledged') { await clear(op, lease); return {...result, operationId: op.operationId, exactOperationConfirmed: true}; }
      await original(op, lease); const waiting = await waitCondition(op, lease);
      if (waiting) return waiting;
      const accepted = await permission(op, lease);
      if (accepted.state === 'acknowledged') {
        authorizationPreviews.delete(preview); await reusePermission(op, accepted, lease); return send(op, lease);
      }
      if (preview.expiresAt <= now()) throw Object.assign(new Error('本次展示的期限已到，请重新查看原内容和期限。'), {code: 'consent_reauthorization_required'});
      if (!sameOperation((await load(lease)).active, op)) throw operationChanged();
      const replacement = await lease.wait(() => api.prepareAuthorization(op.payloadJson, {
        action: op.type === 'comment' ? 'comment.publish' : 'moderation.publish', objectId: op.operationId,
        visibility: op.visibility, viewers: op.viewers, expiresAt: preview.expiresAt, confirmed: true,
      }));
      authorizationPreviews.delete(preview);
      op.previousAuthorizations = [...(op.previousAuthorizations ?? []), ...(op.prepared ? [op.prepared] : [])];
      op.prepared = replacement; op.submission = null; op.authorizationAttempted = false;
      op.expiresAt = preview.expiresAt; op.authorizationBindingId = replacement.intent.bindingId;
      delete op.blockedReason; await persist(op, lease); return send(op, lease);
    }),
    stopLocalRetry: (operationId, { confirmed = false } = {}) =>
      serial(async (lease) => {
        const state = await load(lease),
          op = state.active;
        if (!confirmed || op?.operationId !== operationId)
          throw new Error('请确认停止本机重试。');
        const r = await receipt(op, lease);
        if (r.state === 'acknowledged') {
          await clear(op, lease);
          lease.check();
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
        await mutateJournal(lease, current => {
          if (!sameOperation(current.active, op)) throw operationChanged();
          return {...current, active: null, stopped: [...current.stopped.filter(item => item.operationId !== op.operationId), minimal]};
        });
        lease.check();
        return minimal;
      }),
    query: (input) => query(captureLease(), '/v2/comments/query', { ...input, taskId }),
    get: (id) => query(captureLease(), '/v2/comments/' + id, undefined, { method: 'GET' }),
    governanceConfig: () => {
      const lease = captureLease();
      if (!hasGovernanceScope()) return Promise.resolve({ configured: false, unavailable: true, scopeRequired: 'moderation', moderatorIds: [],
        message: '当前浏览器设备未获准使用评论处理功能；评论阅读和原任务仍可继续。需要处理评论时，请在已有设备核对相应权限。' });
      return query(lease, '/v2/comment-governance/config', undefined, { method: 'GET' });
    },
    reports: (input) => query(captureLease(), '/v2/comment-governance/query', structuredClone(input)),
    report: (id) =>
      query(captureLease(), '/v2/comment-governance/' + id, undefined, { method: 'GET' }),
  };
}
