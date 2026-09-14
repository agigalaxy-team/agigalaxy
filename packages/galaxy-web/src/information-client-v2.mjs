import { canonicalInformationCommand as canonicalize } from '../../galaxy-official/src/shared/information-canonical.mjs';
import { informationWatchCommandSchema } from '../../galaxy-official/src/shared/information-v2-schema.mjs';
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
    key = 'information-watch-operations:' + api.endpoint + ':' + subjectId;
  const read = async () =>
    (await runtime.getLocal(key)) ?? { version: 1, operations: [] };
  async function call(path, input, privateRead = false) {
    const initial = api.snapshot()?.subjectId;
    if (privateRead && (!subjectId || initial !== subjectId))
      throw Error('请先连接当前身份。');
    const response = await api.call(path, input, {
      authenticated: !!subjectId && initial === subjectId,
    });
    if (api.snapshot()?.subjectId !== initial)
      throw Error('当前身份已变化，请重新读取。');
    return response;
  }
  async function prepare(command) {
    const value = informationWatchCommandSchema.parse(command),
      requestHash = await hash(value),
      record = { command: value, requestHash, state: 'prepared' };
    const s = await read(),
      old = s.operations.find(
        (o) => (o.command?.operationId ?? o.operationId) === value.operationId,
      );
    if (old?.state === 'stopped-local')
      throw Error('原操作已停止本机重试，请核对回执；新决定使用新操作编号。');
    if (old && old.requestHash !== requestHash)
      throw Error('原操作内容已变化，请使用新的操作。');
    if (!old) {
      s.operations.push(record);
      await runtime.putLocal(key, s);
    }
    return old ?? record;
  }
  async function update(operationId, changes) {
    const s = await read(),
      op = s.operations.find(
        (o) => (o.command?.operationId ?? o.operationId) === operationId,
      );
    if (!op) throw Error('本机没有这份操作。');
    Object.assign(op, changes);
    await runtime.putLocal(key, s);
    return op;
  }
  async function receipt(op) {
    return call(
      '/v2/information/watches/receipt',
      {
        operationId: op.command?.operationId ?? op.operationId,
        requestHash: op.requestHash,
      },
      true,
    );
  }
  async function reconcile(operationId) {
    const s = await read(),
      op = s.operations.find(
        (o) => (o.command?.operationId ?? o.operationId) === operationId,
      );
    if (!op) throw Error('本机没有这份操作。');
    const r = await receipt(op);
    if (r.state === 'acknowledged')
      await update(operationId, { state: 'acknowledged', result: r.result });
    return r;
  }
  async function execute(operationId, { confirmed = false } = {}) {
    if (!confirmed) throw Error('请先确认本次关注范围。');
    const s = await read(),
      op = s.operations.find((o) => o.command?.operationId === operationId);
    if (!op || op.state === 'stopped-local') throw Error('此操作不能重试。');
    const prior = await receipt(op);
    if (prior.state === 'acknowledged') {
      await update(operationId, {
        state: 'acknowledged',
        result: prior.result,
      });
      return prior.result;
    }
    if (prior.state === 'conflict') throw Error('服务端原操作与本机不一致。');
    await update(operationId, { state: 'result-unknown' });
    const result = await call(
      '/v2/information/watches/' +
        (['pause', 'end'].includes(op.command.action) ? 'stop' : 'command'),
      op.command,
      true,
    );
    await update(operationId, { state: 'acknowledged', result });
    return result;
  }
  async function stopLocal(operationId) {
    const r = await reconcile(operationId);
    if (r.state === 'acknowledged') return r;
    const op = await update(operationId, {
      state: 'stopped-local',
      operationId,
      command: null,
    });
    return { state: op.state, serverCancellationConfirmed: false };
  }
  return {
    query: (input) => call('/v2/information/query', input),
    rules: () => call('/v1/honor/rules', {}),
    prepare,
    execute,
    reconcile,
    stopLocal,
    pending: async () =>
      (await read()).operations.filter((o) => o.state !== 'acknowledged'),
    watches: (input) => call('/v2/information/watches/list', input ?? {}, true),
    check: (input) => call('/v2/information/watches/check', input, true),
    events: (watchId) =>
      call('/v2/information/watches/events', { watchId }, true),
    // One host-driven check pass, not a scheduler. The webpage/native host owns
    // actual timing; expiration/pause/revision are checked again by the service.
    async checkDue() {
      const rows = await call(
          '/v2/information/watches/list',
          { limit: 20, activeOnly: true },
          true,
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
              ),
            );
          } catch (error) {
            items.push({
              watchId: w.watchId,
              state: 'check-failed',
              message: error.message ?? 'Check not completed',
            });
          }
        }
      return { items, modelCalls: 0 };
    },
  };
}
