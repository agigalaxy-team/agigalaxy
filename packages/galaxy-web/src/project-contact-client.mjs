import { projectEventV2Schema } from '../../galaxy-official/src/shared/projects-schema-v2.mjs';
import { contactEventV2Schema } from '../../galaxy-official/src/shared/contacts-schema-v2.mjs';
import { recruitmentEventV2Schema } from '../../galaxy-official/src/shared/recruitment-schema-v2.mjs';
const types = {
  project: {
    schema: projectEventV2Schema,
    path: '/v2/projects',
    field: 'projectId',
  },
  contact: {
    schema: contactEventV2Schema,
    path: '/v2/contacts',
    field: 'contactId',
  },
  recruitment: {
    schema: recruitmentEventV2Schema,
    path: '/v2/recruitment',
    field: 'recruitmentId',
  },
};
const instances = new WeakMap();
export function getProjectContactClient(runtime, subjectId) {
  let map = instances.get(runtime);
  if (!map) {
    map = new Map();
    instances.set(runtime, map);
  }
  if (map.has(subjectId)) return map.get(subjectId);
  const key = `m10-operations:${subjectId}`,
    endpoint = runtime.api.endpoint;
  let queue = Promise.resolve();
  const owner = () => {
    if (
      runtime.api.snapshot()?.subjectId !== subjectId ||
      runtime.api.endpoint !== endpoint
    )
      throw new Error('当前身份或连接已改变，请重新打开操作页面。');
  };
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const records = async () => {
    owner();
    const data = await runtime.getLocal(key);
    owner();
    return data ?? [];
  };
  const save = async (list) => {
    owner();
    await runtime.putLocal(key, list);
    owner();
  };
  async function put(record) {
    const list = await records();
    await save([
      ...list.filter((x) => x.operationId !== record.operationId),
      record,
    ]);
  }
  async function remove(id) {
    await save((await records()).filter((x) => x.operationId !== id));
  }
  async function send(record) {
    owner();
    const type = types[record.type];
    try {
      if (!record.submission) {
        record.submission = await runtime.api.authorizePayload(
          record.payloadJson,
          {
            action: record.type + '.write',
            objectId: record.operationId,
            visibility: record.visibility,
            viewers: record.viewers,
            confirmed: true,
          },
        );
        await put(record);
      }
      record.attempts = (record.attempts ?? 0) + 1;
      record.state = 'result-unknown';
      await put(record);
      owner();
      const result = await runtime.api.call(type.path, record.submission);
      owner();
      if (
        result.operationId !== record.operationId ||
        result[type.field] !== record.objectId
      )
        throw new Error('操作回执不匹配，需查询原操作。');
      await remove(record.operationId);
      return result;
    } catch (error) {
      if (
        error.outcome === 'rejected' &&
        error.status >= 400 &&
        error.status < 500 &&
        (record.attempts ?? 0) <= 1
      ) {
        await remove(record.operationId);
        throw error;
      }
      // Preserve signed bytes after an unknown response, including a lost successful response.
      throw Object.assign(error, {
        operationId: record.operationId,
        objectId: record.objectId,
        resultUnknown: true,
      });
    }
  }
  async function submit(
    type,
    input,
    { visibility = 'Private', viewers = [], confirmed = false } = {},
  ) {
    return serial(async () => {
      if (!confirmed) throw new Error('请确认这次具体操作。');
      owner();
      const spec = types[type];
      if (!spec) throw new Error('无效操作类型。');
      const payload = spec.schema.parse({
        ...input,
        operationId: input.operationId ?? crypto.randomUUID(),
      });
      if (
        (await records()).some(
          (x) => x.type === type && x.objectId === payload[spec.field],
        )
      )
        throw new Error('这个对象有结果未知的操作，请先查询或重试原操作。');
      const record = {
        type,
        objectId: payload[spec.field],
        operationId: payload.operationId,
        payloadJson: JSON.stringify(payload),
        visibility,
        viewers: [...new Set(viewers.filter((x) => x !== subjectId))],
        state: 'prepared',
      };
      await put(record);
      return send(record);
    });
  }
  async function reconcile(
    operationId,
    { retry = false, confirmed = false } = {},
  ) {
    return serial(async () => {
      const record = (await records()).find(
        (x) => x.operationId === operationId,
      );
      if (!record) return { state: 'none' };
      let current = null;
      try {
        current = await runtime.api.call(
          `${types[record.type].path}/${record.objectId}`,
          undefined,
          { method: 'GET' },
        );
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      owner();
      if (!retry)
        return {
          state: 'exact-receipt-unconfirmed',
          current,
          operationId,
          objectId: record.objectId,
        };
      if (!confirmed)
        throw new Error('请确认重试原操作；其对象、签名和操作ID保持一致。');
      return send(record);
    });
  }
  const client = {
    submit,
    reconcile,
    pendingContacts: async () => (await records()).filter(record=>record.type==='contact').flatMap(record=>{
      const payload=types.contact.schema.parse(JSON.parse(record.payloadJson));
      return payload.kind==='send'?[{operationId:record.operationId,contactId:record.objectId,recipientId:payload.recipientId,opportunityRef:payload.opportunityRef,state:record.state}]:[];
    }),
    pending: async () =>
      (await records()).map(({ payloadJson, submission, ...meta }) => meta),
  };
  map.set(subjectId, client);
  return client;
}
