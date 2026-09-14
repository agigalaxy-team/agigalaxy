import { caseEventV2Schema } from '../../galaxy-official/src/shared/cases-schema.mjs';
import { verificationEventSchema } from '../../galaxy-official/src/shared/verification-record-schema.mjs';
import { equalJson } from '../../galaxy-official/src/shared/web-primitives.mjs';

const instances = new WeakMap();
export const exactFactRef = (record) => ({
  id: record.id,
  version: record.version,
});
export function latestFacts(items = []) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
export function getFactClient(runtime, subjectId) {
  let owners = instances.get(runtime);
  if (!owners) {
    owners = new Map();
    instances.set(runtime, owners);
  }
  if (owners.has(subjectId)) return owners.get(subjectId);
  let queue = Promise.resolve();
  const endpoint = runtime.api.endpoint,
    key = (id) => `task-fact-pending:${subjectId}:${id}`;
  const owner = () => {
    if (
      runtime.api.snapshot()?.subjectId !== subjectId ||
      runtime.api.endpoint !== endpoint
    )
      throw new Error('身份或连接已改变，请重新打开工作记录。');
  };
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const get = async (id) => {
    owner();
    const value = await runtime.getLocal(key(id));
    owner();
    return value;
  };
  const put = async (id, value) => {
    owner();
    await runtime.putLocal(key(id), value);
    owner();
  };
  const readCase = async (task) => {
    owner();
    if (!task.caseId) return null;
    const value = await runtime.api.call(`/v2/cases/${task.caseId}/read`, {
      taskId: task.taskId,
    });
    owner();
    return value;
  };
  const readRecord = async (ref) => {
    owner();
    const value = await runtime.api.call('/v2/verification-records/read', ref);
    owner();
    return value;
  };
  async function send(record) {
    try {
      for (const item of record.items)
        if (!item.submission) {
          if (!item.authorization) {
            item.authorization = await runtime.api.prepareAuthorization(
              JSON.stringify(item.payload),
              {
                action: item.action,
                objectId: item.payload.eventId ?? item.payload.operationId,
                visibility: 'Private',
                viewers: record.viewers,
                confirmed: true,
              },
            );
            await put(record.taskId, record);
          }
          const reconcile = item.authorizationAttempted === true;
          item.authorizationAttempted = true;
          await put(record.taskId, record);
          item.submission = await runtime.api.submitAuthorization(
            item.authorization,
            { confirmed: true, reconcile },
          );
          await put(record.taskId, record);
        }
      record.attempts = (record.attempts ?? 0) + 1;
      await put(record.taskId, record);
      owner();
      const body =
        record.kind === 'case-link'
          ? {
              operationId: record.operationId,
              taskId: record.taskId,
              expectedTaskVersion: record.expectedTaskVersion,
              case: record.items[0].submission,
              initialFact: record.items[1].submission,
            }
          : record.items[0].submission;
      const response = await runtime.api.call(record.path, body);
      owner();
      const payload = record.items.at(-1).payload;
      const valid =
        record.kind === 'case-link'
          ? response.caseId === record.caseId &&
            response.taskId === record.taskId &&
            response.initialFact?.id === payload.eventId
          : record.kind === 'verification'
            ? response.id === payload.id &&
              response.operationId === payload.operationId
            : response.caseId === record.caseId &&
              response.eventId === payload.eventId;
      if (!valid) throw new Error('写入回执不匹配，保留原操作待查询。');
      await put(record.taskId, null);
      return response;
    } catch (error) {
      if (
        error.outcome === 'rejected' &&
        error.status >= 400 &&
        error.status < 500 &&
        (record.attempts ?? 0) <= 1
      ) {
        await put(record.taskId, null);
        throw error;
      }
      throw Object.assign(error, {
        resultUnknown: true,
        operationId: record.operationId,
      });
    }
  }
  async function write(task, record, { confirmed = false, viewers = [] } = {}) {
    return serial(async () => {
      if (!confirmed) throw new Error('请确认记录这次实际工作。');
      owner();
      if (await get(task.taskId))
        throw new Error('请先查询这项任务上一次事实操作。');
      Object.assign(record, {
        taskId: task.taskId,
        viewers: [...new Set(viewers.filter((id) => id !== subjectId))],
      });
      await put(task.taskId, record);
      return send(record);
    });
  }
  function submitFact(
    task,
    facts,
    participant,
    fields,
    { confirmed = false, viewers = [], caseSummary, synthetic = false } = {},
  ) {
    if (participant && participant.subjectId !== subjectId)
      throw new Error('不能以他人的参与关系声明工作。');
    const caseId = task.caseId ?? crypto.randomUUID(),
      eventId = crypto.randomUUID();
    const common = {
      caseId,
      eventId,
      actorId: subjectId,
      taskId: task.taskId,
      expectedVersion: facts?.version ?? 1,
      taskScopeVersion: fields.taskScopeVersion ?? facts?.scopeVersion ?? 1,
      ...(participant
        ? {
            participationId: participant.participationId,
            participationScopeVersion: participant.scopeVersion,
          }
        : {}),
    };
    const payload = caseEventV2Schema.parse({ ...fields, ...common });
    if (!task.caseId) {
      if (
        task.requesterId !== subjectId ||
        participant ||
        !['attempt-start', 'intervention'].includes(payload.kind)
      )
        throw new Error(
          '由请求者先保存本人真实尝试或介入，原子建立Case；不代替他人补造记录。',
        );
      const root = caseEventV2Schema.parse({
        kind: 'case-created',
        caseId,
        eventId: caseId,
        expectedVersion: 0,
        actorId: subjectId,
        taskId: task.taskId,
        localRef: task.taskId,
        title: task.request.title,
        summary: caseSummary,
        source: { kind: 'active-task', reference: task.taskId },
        synthetic,
      });
      return write(
        task,
        {
          kind: 'case-link',
          operationId: crypto.randomUUID(),
          caseId,
          expectedTaskVersion: task.version,
          path: `/v2/tasks/${task.taskId}/case`,
          items: [root, payload].map((payload) => ({
            action: 'case.teaser.publish',
            payload,
          })),
        },
        { confirmed, viewers },
      );
    }
    return write(
      task,
      {
        kind: 'fact',
        operationId: eventId,
        caseId,
        path: '/v2/cases/events',
        items: [{ action: 'case.teaser.publish', payload }],
      },
      { confirmed, viewers },
    );
  }
  function submitRecord(task, facts, participant, fields, options = {}) {
    if (!task.caseId)
      throw new Error('先关联实际工作Case，再保存相应证据或检查。');
    if (participant && participant.subjectId !== subjectId)
      throw new Error('不能以他人的参与关系报告。');
    const payload = verificationEventSchema.parse({
      ...fields,
      id: fields.id ?? crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      caseId: task.caseId,
      reportedBy: subjectId,
      taskId: task.taskId,
      ...(participant
        ? {
            participationId: participant.participationId,
            participationScopeVersion: participant.scopeVersion,
          }
        : {}),
      synthetic: facts.synthetic === true || fields.synthetic === true,
    });
    return write(
      task,
      {
        kind: 'verification',
        operationId: payload.operationId,
        caseId: task.caseId,
        path: '/v2/verification-records/submit',
        items: [{ action: 'evidence.submit', payload }],
      },
      options,
    );
  }
  async function reconcile(taskId, { retry = false, confirmed = false } = {}) {
    return serial(async () => {
      const record = await get(taskId);
      if (!record) return { state: 'none' };
      let matched = false,
        current;
      try {
        if (record.kind === 'verification') {
          const payload = record.items[0].payload;
          current = await readRecord({
            type: payload.kind === 'revoke' ? payload.objectType : payload.kind,
            id: payload.id,
            version: payload.expectedVersion + 1,
          });
          matched = equalJson(current.record, payload);
        } else {
          current = await readCase({ taskId, caseId: record.caseId });
          matched = record.items.every((item) =>
            current.events.some((event) => {
              const { caseVersion, ...payload } = event;
              return equalJson(payload, item.payload);
            }),
          );
        }
      } catch (error) {
        if (![403, 404, 409].includes(error.status)) throw error;
      }
      if (matched) {
        await put(taskId, null);
        return { state: 'acknowledged', caseId: record.caseId, current };
      }
      if (!retry)
        return {
          state: 'result-unknown',
          caseId: record.caseId,
          operationId: record.operationId,
        };
      if (!confirmed) throw new Error('请确认重试原有签名载荷。');
      return send(record);
    });
  }
  const client = {
    submitFact,
    submitRecord,
    readCase,
    readRecord,
    reconcile,
    pending: async (taskId) => {
      const r = await get(taskId);
      return r
        ? { kind: r.kind, operationId: r.operationId, caseId: r.caseId }
        : null;
    },
  };
  owners.set(subjectId, client);
  return client;
}
