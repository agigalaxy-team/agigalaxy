import { canonicalInformationCommand as canonicalize } from '../../../../galaxy-official/src/shared/information-canonical.mjs';
import { informationWatchCommandSchema, informationSelectionSchema } from '../../../../galaxy-official/src/shared/information-v2-schema.mjs';
import * as z from 'zod/v4';
const inputText = z.string().max(16000);
const composerSchemas = {
  query: z.strictObject({
    query: inputText.optional(), types: z.array(z.string().max(80)).max(20).optional(),
    windowKind: z.string().max(80).optional(), environment: inputText.optional(),
    functions: inputText.optional(), technologies: inputText.optional(),
  }),
  watch: z.strictObject({
    selected: z.array(informationSelectionSchema).max(4).optional(),
    selectionLabels: z.record(z.string().max(80), z.string().max(1000)).optional(),
    watchPurpose: inputText.optional(), expires: z.string().max(100).optional(),
    report: z.enum(['changes', 'daily']).optional(), reportTime: z.string().max(20).optional(),
    editing: z.strictObject({watchId: z.uuid(), revision: z.number().int().positive()}).nullable().optional(),
  }),
};
function composerSchema(kind) {
  if (kind !== 'query' && kind !== 'watch') throw Error('invalid_information_composer_kind');
  return composerSchemas[kind];
}
async function hash(value) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalize(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export function createInformationClientV2({ runtime, subjectId }) {
  const api = runtime.api,
    key = 'information-watch-operations:' + api.endpoint + ':' + subjectId,
    reviews = new Map();
  const endpoint = api.endpoint, ownerKey = subjectId ?? 'visitor';
  let tail = Promise.resolve();
  const snapshot = () => {
    const s = api.snapshot() ?? {};
    return {
      subjectId: s.subjectId ?? null,
      bindingId: s.bindingId ?? null,
      generation: s.generation ?? null,
      endpoint: s.endpoint ?? api.endpoint,
    };
  };
  const changed = (lease) => {
    const current = snapshot();
    return Object.keys(lease).some((k) => current[k] !== lease[k]);
  };
  function guard(lease, privateRead = true) {
    if (
      changed(lease) ||
      (privateRead && (!subjectId || lease.subjectId !== subjectId))
    )
      throw Error('当前身份或连接已变化，请重新审阅或核对原操作回执。');
  }
  function serial(fn) {
    const lease = snapshot(),
      work = tail.then(() => {
        guard(lease);
        return fn(lease);
      });
    tail = work.catch(() => {});
    return work;
  }
  async function read(lease) {
    guard(lease);
    const state = (await runtime.getLocal(key, ownerKey)) ?? {
      version: 1,
      operations: [],
    };
    guard(lease);
    return checkedState(state);
  }
  function checkedState(state) {
    if (state?.version !== 1 || !Array.isArray(state.operations))
      throw Error('原关注操作记录格式不匹配，请保留并核对。');
    return state;
  }
  async function mutate(lease, change) {
    guard(lease);
    if (typeof runtime.updateLocal !== 'function') throw Error('local_atomic_update_unavailable');
    const state = await runtime.updateLocal(key, current => {
      guard(lease);
      const next = checkedState(current ?? {version: 1, operations: []});
      change(next);
      return next;
    }, ownerKey);
    guard(lease);
    return checkedState(state);
  }
  async function call(path, input, privateRead = false, lease = snapshot()) {
    guard(lease, privateRead);
    const response = await api.call(path, input, {
      authenticated: !!subjectId && lease.subjectId === subjectId,
    });
    guard(lease, privateRead);
    return response;
  }
  const find = (s, id) =>
    s.operations.find((o) => (o.command?.operationId ?? o.operationId) === id);
  async function update(id, changes, lease, {requireActive = false} = {}) {
    const state = await mutate(lease, next => {
      const op = find(next, id);
      if (!op) throw Error('本机没有这份操作。');
      if (requireActive && op.state === 'acknowledged') return;
      if (requireActive && (!op.command || op.state === 'stopped-local')) throw Error('此操作不能重试。');
      if (op.state === 'acknowledged' && changes.state !== 'acknowledged') return;
      Object.assign(op, changes);
    });
    return find(state, id);
  }
  function draftLease() {
    const lease = snapshot(), scope = runtime.taskDraftScope?.(), scopeKey = scope?.key;
    if (api.endpoint !== endpoint || scope?.closed || scope && (scope.subjectId ?? null) !== (subjectId ?? null))
      throw Error('当前本机身份已变化，请重新读取输入。');
    const check = () => {
      const current = runtime.taskDraftScope?.();
      guard(lease, false);
      if (api.endpoint !== endpoint || scope && (current?.closed || current?.key !== scopeKey))
        throw Error('当前本机身份或连接已变化，请重新读取输入。');
    };
    check(); return {check};
  }
  const draftKey = kind => {composerSchema(kind); return 'information-composer:' + endpoint + ':' + ownerKey + ':' + kind;};
  function checkedDraft(kind, value) {
    if (value === null || value === undefined) return null;
    if (value.version !== 1 || value.kind !== kind || !z.uuid().safeParse(value.revision).success)
      throw Error('本机输入草稿格式不匹配，请保留原稿。');
    return {version: 1, kind, revision: value.revision, value: composerSchema(kind).parse(value.value)};
  }
  const draftConflict = current => Object.assign(new Error('另一页面已保存不同的输入，请先读取或保留本页输入。'),
    {code: 'information_composer_changed', current: structuredClone(current)});
  async function receipt(op, lease) {
    return call(
      '/v2/information/watches/receipt',
      {
        operationId: op.command?.operationId ?? op.operationId,
        requestHash: op.requestHash,
      },
      true,
      lease,
    );
  }
  async function reconcileWithin(id, lease) {
    const state = await read(lease),
      op = find(state, id);
    if (!op) throw Error('本机没有这份操作。');
    const result = await receipt(op, lease);
    if (result.state === 'acknowledged')
      await update(id, { state: 'acknowledged', result: result.result }, lease);
    guard(lease);
    return result;
  }
  return {
    async readComposerDraft(kind) {
      const lease = draftLease(), name = draftKey(kind);
      const saved = await runtime.getLocal(name, ownerKey);
      lease.check(); return checkedDraft(kind, saved);
    },
    /** @param {string} kind @param {any} input @param {{expectedRevision?: string|null}} options */
    async saveComposerDraft(kind, input, options = {}) {
      const lease = draftLease(), name = draftKey(kind), value = composerSchema(kind).parse(structuredClone(input));
      if (typeof runtime.updateLocal !== 'function') throw Error('local_atomic_update_unavailable');
      const hasExpected = Object.hasOwn(options, 'expectedRevision');
      if (hasExpected && options.expectedRevision !== null) z.uuid().parse(options.expectedRevision);
      const saved = await runtime.updateLocal(name, existing => {
        lease.check(); const current = checkedDraft(kind, existing);
        if (current && canonicalize(current.value) === canonicalize(value)) return current;
        if (hasExpected && (current?.revision ?? null) !== options.expectedRevision) throw draftConflict(current);
        return {version: 1, kind, revision: crypto.randomUUID(), value};
      }, ownerKey);
      lease.check(); return checkedDraft(kind, saved);
    },
    /** @param {string} kind @param {{revision?: string|null}} options */
    async clearComposerDraft(kind, {revision} = {}) {
      const lease = draftLease(), name = draftKey(kind);
      if (revision !== undefined && revision !== null) z.uuid().parse(revision);
      if (typeof runtime.updateLocal !== 'function') throw Error('local_atomic_update_unavailable');
      const result = await runtime.updateLocal(name, existing => {
        lease.check(); const current = checkedDraft(kind, existing);
        return revision !== undefined && (current?.revision ?? null) !== revision ? current : null;
      }, ownerKey);
      lease.check(); return checkedDraft(kind, result);
    },
    query: (input) => call('/v2/information/query', input),
    rules: () => call('/v1/honor/rules', {}),
    prepare: (command) =>
      serial(async (lease) => {
        const value = informationWatchCommandSchema.parse(command),
          requestHash = await hash(value);
        guard(lease);
        const state = await mutate(lease, next => {
          const old = find(next, value.operationId);
          if (old?.state === 'stopped-local')
            throw Error('原操作已停止本机重试，请核对回执；新决定使用新操作编号。');
          if (old && old.requestHash !== requestHash)
            throw Error('原操作内容已变化，请使用新的操作。');
          if (!old) next.operations.push({command: value, requestHash, state: 'prepared'});
        }), record = find(state, value.operationId);
        guard(lease);
        reviews.set(value.operationId, lease);
        return record;
      }),
    execute: (id, { confirmed = false } = {}) =>
      serial(async (lease) => {
        if (!confirmed) throw Error('请先确认本次关注范围。');
        const state = await read(lease),
          op = find(state, id);
        if (!op?.command || op.state === 'stopped-local')
          throw Error('此操作不能重试。');
        // A new connection may read the original exact receipt. An absent operation
        // still requires a fresh review under that same connection.
        const prior = await receipt(op, lease);
        if (prior.state === 'acknowledged') {
          await update(
            id,
            { state: 'acknowledged', result: prior.result },
            lease,
          );
          guard(lease);
          return prior.result;
        }
        if (prior.state === 'conflict')
          throw Error('服务端原操作与本机不一致。');
        if (prior.state !== 'absent')
          throw Error('原操作回执尚未确定，请稍后只读核对；不会自动再次提交。');
        const reviewed = reviews.get(id);
        if (!reviewed || changed(reviewed))
          throw Error('连接或预览已变化，请重新审阅原操作。');
        guard(lease);
        const reserved = await update(id, { state: 'result-unknown' }, lease, {requireActive: true});
        if (reserved.state === 'acknowledged') return reserved.result;
        const result = await call(
          '/v2/information/watches/' +
            (['pause', 'end'].includes(op.command.action) ? 'stop' : 'command'),
          op.command,
          true,
          lease,
        );
        await update(id, { state: 'acknowledged', result }, lease);
        guard(lease);
        return result;
      }),
    reconcile: (id) => serial((lease) => reconcileWithin(id, lease)),
    /** @param {string} id @param {{onlyPrepared?: boolean}} options */
    stopLocal: (id, {onlyPrepared = false} = {}) =>
      serial(async (lease) => {
        const result = await reconcileWithin(id, lease);
        if (result.state === 'acknowledged') return result;
        const state = await mutate(lease, next => {
          const original = find(next, id);
          if (!original) throw Error('本机没有这份操作。');
          if (original.state === 'acknowledged' || onlyPrepared && original.state !== 'prepared') return;
          Object.assign(original, {state: 'stopped-local', operationId: id, command: null});
        }), op = find(state, id);
        if (op.state === 'stopped-local') reviews.delete(id);
        guard(lease);
        return {state: op.state, operationId: id, result: op.state === 'acknowledged' ? op.result : undefined,
          serverCancellationConfirmed: false};
      }),
    pending: () =>
      serial(async (lease) => {
        const state = await read(lease);
        guard(lease);
        return state.operations.filter((o) => o.state !== 'acknowledged');
      }),
    watches: (input) => call('/v2/information/watches/list', input ?? {}, true),
    check: (input) => call('/v2/information/watches/check', input, true),
    events: (watchId) =>
      call('/v2/information/watches/events', { watchId }, true),
    // The host owns timing; this pass never creates a scheduler or model loop.
    async checkDue() {
      const lease = snapshot(),
        rows = await call(
          '/v2/information/watches/list',
          { limit: 20, activeOnly: true },
          true,
          lease,
        ),
        now = Math.floor(Date.now() / 1000),
        items = [];
      for (const w of rows.items)
        if (w.state === 'active' && (!w.nextCheckAt || w.nextCheckAt <= now)) {
          try {
            items.push(
              await call(
                '/v2/information/watches/check',
                { watchId: w.watchId, expectedRevision: w.revision },
                true,
                lease,
              ),
            );
          } catch (error) {
            guard(lease);
            items.push({
              watchId: w.watchId,
              state: 'check-failed',
              message: error.message ?? 'Check not completed',
            });
          }
        }
      guard(lease);
      return { items, modelCalls: 0 };
    },
  };
}
