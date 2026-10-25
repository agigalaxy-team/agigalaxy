import { projectEventV2Schema } from "../../../../../galaxy-official/src/shared/projects-schema-v2.mjs";
import { contactEventV2Schema } from "../../../../../galaxy-official/src/shared/contacts-schema-v2.mjs";
import { recruitmentEventV2Schema } from "../../../../../galaxy-official/src/shared/recruitment-schema-v2.mjs";
import { recruitmentOperationReceiptResultSchema } from "../../../../../galaxy-official/src/shared/recruitment-schema-v2.mjs";
import { sha256Hex } from "../../../../../galaxy-official/src/shared/web-primitives.mjs";
const types = {
  project: { schema: projectEventV2Schema, path: '/v2/projects', field: 'projectId' },
  contact: { schema: contactEventV2Schema, path: '/v2/contacts', field: 'contactId' },
  recruitment: { schema: recruitmentEventV2Schema, path: '/v2/recruitment', field: 'recruitmentId' },
};
const instances = new WeakMap();
// This is the existing local terminal window, shared by all three operation types.
export const acknowledgedOperationLimit = 64;
export function getProjectContactClient(runtime, subjectId) {
  let map = instances.get(runtime);
  if (!map) { map = new Map(); instances.set(runtime, map); }
  if (map.has(subjectId)) return map.get(subjectId);
  const key = `m10-operations:${subjectId}`, endpoint = runtime.api.endpoint;
  let queue = Promise.resolve();
  const owner = () => {
    if (runtime.api.snapshot()?.subjectId !== subjectId || runtime.api.endpoint !== endpoint)
      throw new Error('当前身份或连接已改变，请重新打开操作页面。');
  };
  const connection = () => {
    const state = runtime.api.snapshot();
    return state ? JSON.stringify([state.subjectId, runtime.api.endpoint, state.endpoint,
      state.bindingId, state.generation, state.control?.deviceId, state.control?.keyId, state.control?.epoch]) : null;
  };
  const capture = () => {
    owner();
    const tag = connection(), original = runtime.receiptStatus?.captureLease?.();
    if (original && (original.subjectId !== subjectId || original.endpoint !== endpoint || typeof original.assertCurrent !== 'function'))
      throw new Error('当前身份租约不可用，请重新打开操作页面。');
    const check = () => {
      original?.assertCurrent(); owner();
      if (!tag || connection() !== tag) throw Object.assign(new Error('身份或连接已改变，原操作已保留，请重新核对后继续。'),
        {code:'project_contact_authority_changed'});
    };
    check(); return {check};
  };
  const guarded = async (lease, action) => {
    lease.check(); let value;
    try { value = await action(); } catch (error) { lease.check(); throw error; }
    lease.check(); return value;
  };
  // Capture at enqueue, including confirmations waiting behind another call.
  const serial = fn => {
    const lease = capture(), invoke = () => guarded(lease, () => fn(lease));
    const next = queue.then(invoke, invoke); queue = next.catch(() => {}); return next;
  };
  const records = async lease => {
    const data = await guarded(lease, () => runtime.getLocal(key));
    if (data && !Array.isArray(data)) throw new Error('原操作记录格式不匹配，请保留记录并核对。');
    const list = data ?? [];
    if (list.some(x => x.subjectId && x.subjectId !== subjectId || x.endpoint && x.endpoint !== endpoint))
      throw new Error('原操作不属于当前身份或服务。');
    return list;
  };
  const save = (lease, list) => guarded(lease, () => runtime.putLocal(key, list));
  async function put(lease, record) {
    const list = await records(lease);
    await save(lease, [...list.filter(x => x.operationId !== record.operationId), record]);
  }
  async function remove(lease, id) {
    await save(lease, (await records(lease)).filter(x => x.operationId !== id));
  }
  async function originalRecord(lease, record, {persistHash = true} = {}) {
    const spec = types[record.type];
    if (!spec || typeof record.payloadJson !== 'string') throw new Error('原操作记录不匹配，请保留记录并核对。');
    const payload = spec.schema.parse(JSON.parse(record.payloadJson));
    const hash = await guarded(lease, () => sha256Hex(record.payloadJson));
    if (payload.operationId !== record.operationId || payload[spec.field] !== record.objectId
      || record.payloadHash && record.payloadHash !== hash
      || record.submission && record.submission.payloadJson !== record.payloadJson)
      throw new Error('原操作字节或定位不匹配，请保留记录并核对。');
    // Legacy rows receive only the hash of their exact bytes, never rewritten JSON.
    if (!record.payloadHash) { record.payloadHash = hash; if (persistHash) await put(lease, record); }
    return record;
  }
  async function acknowledge(lease, record, result, receipt = {operationId:record.operationId,objectId:record.objectId,
    revision:result.appliedRevision ?? result.revision,replayed:result.replayed === true}) {
    const terminal = {type:record.type,objectId:record.objectId,operationId:record.operationId,
      payloadHash:record.payloadHash,consentId:record.submission?.consentId,subjectId,endpoint,
      state:'acknowledged',receipt};
    // Save a body-free original locator before returning. A late store completion
    // stays in the owner key resolved at the call, and cannot reach another UI.
    const list = (await records(lease)).filter(x => x.operationId !== record.operationId);
    const acknowledged = [...list.filter(x => x.state === 'acknowledged'), terminal].slice(-acknowledgedOperationLimit);
    await save(lease, [...list.filter(x => x.state !== 'acknowledged'), ...acknowledged]);
    return result;
  }
  const waitingResult = record => ({state:record.state,operationId:record.operationId,objectId:record.objectId,
    reason:record.wait.reason,retryAt:record.wait.retryAt ?? null,rejectionCode:record.wait.code});
  async function waitCondition(lease, record) {
    if (!record.wait) return null;
    if (['community_quota_exceeded','community_restricted'].includes(record.wait.code)) {
      let status;
      try { status = await guarded(lease, () => runtime.api.call('/v2/account/quotas', {})); }
      catch { lease.check(); return {...waitingResult(record),conditionUnavailable:true}; }
      const category = record.wait.category ?? (record.type === 'recruitment' ? 'task' : 'invitation');
      const quota = status?.quotas?.find(item => item.category === category);
      if (status?.accountVerified !== true || !quota || !Number.isSafeInteger(quota.remaining))
        return {...waitingResult(record),conditionUnavailable:true};
      if (status.restriction || quota.remaining === 0) {
        const retryAt = status.restriction?.until ?? quota.resetAt;
        if (typeof retryAt === 'string' && Number.isFinite(Date.parse(retryAt))) {
          record.wait.retryAt = new Date(retryAt).toISOString(); await put(lease, record);
        }
        return waitingResult(record);
      }
      // A current quota read proves that the original rejected condition has
      // changed. Keep the original Consent envelope and operation bytes.
    } else if (!record.wait.retryAt || Date.parse(record.wait.retryAt) > Date.now()) return waitingResult(record);
    delete record.wait; await put(lease, record); return null;
  }
  async function send(lease, record, {originalOnly = false} = {}) {
    lease.check();
    const type = types[record.type];
    try {
      await originalRecord(lease, record);
      if (record.state === 'stopped-local') return {state:'stopped-local',operationId:record.operationId,objectId:record.objectId};
      const waiting = await waitCondition(lease, record); if (waiting) return waiting;
      if (originalOnly && !record.submission)
        return {state:record.state,operationId:record.operationId,objectId:record.objectId,reason:'authorization-review-required'};
      if (!record.submission) {
        record.submission = await guarded(lease, () => runtime.api.authorizePayload(record.payloadJson, {
          action:record.type + '.write', objectId:record.operationId, visibility:record.visibility,
          viewers:record.viewers, confirmed:true,
        }));
        if (record.submission.payloadJson !== record.payloadJson) throw new Error('授权字节与原操作不匹配。');
        await put(lease, record);
      }
      record.attempts = (record.attempts ?? 0) + 1;
      record.state = 'result-unknown'; await put(lease, record);
      const result = await guarded(lease, () => runtime.api.call(type.path, record.submission));
      if (result.operationId !== record.operationId || result[type.field] !== record.objectId)
        throw new Error('操作回执不匹配，需查询原操作。');
      return await acknowledge(lease, record, result);
    } catch (error) {
      // An authority change cannot erase a previous owner locator, even when a
      // business response or its local acknowledgement completed during the await.
      try { lease.check(); } catch (authority) {
        throw Object.assign(authority, {operationId:record.operationId,objectId:record.objectId,resultUnknown:true});
      }
      if (error.outcome === 'rejected' && ['community_quota_exceeded','invitation_cooldown','community_restricted','rate_limited','capacity_limited'].includes(error.code)) {
        record.state = 'rejected-wait';
        record.wait = {code:error.code,reason:error.code === 'invitation_cooldown' ? 'cooldown-wait' : 'quota-wait',
          retryAt:error.retryAt ?? error.quota?.resetAt ?? null,
          category:error.quota?.category ?? (record.type === 'recruitment' ? 'task' : 'invitation')};
        await put(lease, record);
        throw Object.assign(error, {operationId:record.operationId,objectId:record.objectId,resultUnknown:false,
          originalOperationRetained:true,reason:record.wait.reason,retryAt:record.wait.retryAt});
      }
      if (!originalOnly && error.outcome === 'rejected' && error.status >= 400 && error.status < 500
        && (record.attempts ?? 0) <= 1) { await remove(lease, record.operationId); throw error; }
      throw Object.assign(error, {operationId:record.operationId,objectId:record.objectId,resultUnknown:true});
    }
  }
  async function submit(type, input, {visibility='Private',viewers=[],confirmed=false}={}) {
    const selected = structuredClone(input), audience = structuredClone(viewers);
    return serial(async lease => {
      if (!confirmed) throw new Error('请确认这次具体操作。');
      const spec = types[type];
      if (!spec) throw new Error('无效操作类型。');
      const payload = spec.schema.parse({...selected,operationId:selected.operationId ?? crypto.randomUUID()});
      if ((await records(lease)).some(x => x.state !== 'acknowledged' && x.type === type && x.objectId === payload[spec.field]))
        throw new Error('这个对象有结果未知的操作，请先查询或重试原操作。');
      const payloadJson = JSON.stringify(payload), payloadHash = await guarded(lease, () => sha256Hex(payloadJson));
      const record = {type,objectId:payload[spec.field],operationId:payload.operationId,payloadJson,payloadHash,
        visibility,viewers:[...new Set(audience.filter(x => x !== subjectId))],state:'prepared',subjectId,endpoint};
      await put(lease, record); return send(lease, record);
    });
  }
  async function reconcileWithin(lease, operationId, {retry=false,confirmed=false,originalOnly=false}={}) {
      const record = (await records(lease)).find(x => x.operationId === operationId);
      if (!record) return {state:'none'};
      if (record.state === 'acknowledged') return {state:'acknowledged',operationId,objectId:record.objectId,receipt:record.receipt};
      await originalRecord(lease, record);
      if (record.type === 'recruitment') {
        const query={recruitmentId:record.objectId,operationId:record.operationId,payloadHash:record.payloadHash};
        const params=new URLSearchParams({operationId:query.operationId,payloadHash:query.payloadHash});
        const checked=recruitmentOperationReceiptResultSchema.parse(await guarded(lease,()=>runtime.api.call(
          `/v2/recruitment/${query.recruitmentId}/receipt?${params}`,undefined,{method:'GET'})));
        if (Object.keys(query).some(field=>checked.query[field]!==query[field]))
          throw new Error('原招募操作回执不匹配，请保留记录并核对。');
        const result={...checked,operationId,objectId:record.objectId};
        if (checked.state === 'acknowledged') return acknowledge(lease,record,result,checked.receipt);
        if (checked.state === 'conflict' || !retry || record.state === 'stopped-local') return record.wait ? {...result,...waitingResult(record),state:checked.state} : result;
        if (originalOnly && !record.submission) return {...result,reason:'authorization-review-required'};
        if (!confirmed) throw new Error('请确认重试原操作；其对象、签名和操作ID保持一致。');
        return send(lease,record,{originalOnly});
      }
      if (originalOnly) return send(lease, record, {originalOnly:true});
      let current = null;
      try { current = await guarded(lease, () => runtime.api.call(`${types[record.type].path}/${record.objectId}`,
        undefined, {method:'GET'})); } catch (error) { lease.check(); if (error.status !== 404) throw error; }
      if (!retry || record.state === 'stopped-local') return {state:record.state==='stopped-local'?'stopped-local':'exact-receipt-unconfirmed',current,operationId,objectId:record.objectId};
      if (originalOnly && !record.submission)
        return {state:record.state,operationId,objectId:record.objectId,reason:'authorization-review-required'};
      if (!confirmed) throw new Error('请确认重试原操作；其对象、签名和操作ID保持一致。');
      return send(lease, record, {originalOnly});
  }
  function reconcile(operationId, options = {}) {
    return serial(lease => reconcileWithin(lease, operationId, options));
  }
  const client = {
    submit, reconcile,
    resumePending: operationId => serial(async lease => {
      // authorizePayload returns only after an exact active Consent ACK. A
      // durable submission therefore reuses that Consent across connections;
      // it never generates a new signature, period, audience or selection.
      // Project/Contact have no exact GET receipt. Their original envelope POST
      // checks the operation ID/hash/Consent first and is the idempotent receipt.
      const result = await reconcileWithin(lease, operationId, {retry:true,confirmed:true,originalOnly:true});
      const record = (await records(lease)).find(row => row.operationId === operationId);
      return record?.state === 'acknowledged'
        ? {state:'acknowledged',operationId,objectId:record.objectId,receipt:record.receipt,
            ...(result.state === 'acknowledged' ? {} : {result})}
        : result;
    }),
    reviewPending: operationId => serial(async lease => {
      const record = (await records(lease)).find(row => row.operationId === operationId);
      if (!record) return null;
      if (record.state === 'acknowledged') return {state:record.state,operationId,objectId:record.objectId,
        type:record.type,receipt:record.receipt,payload:null};
      await originalRecord(lease, record, {persistHash:false});
      const payload = types[record.type].schema.parse(JSON.parse(record.payloadJson));
      return {state:record.state,operationId,objectId:record.objectId,type:record.type,payload,
        payloadHash:record.payloadHash,visibility:record.visibility,viewers:structuredClone(record.viewers ?? []),
        hasSubmission:!!record.submission,authorization:record.submission?'original-consent':'review-required',
        ...(record.wait ? {reason:record.wait.reason,retryAt:record.wait.retryAt ?? null,rejectionCode:record.wait.code} : {})};
    }),
    pendingContacts: async () => {
      const lease = capture(), list = await records(lease), result = [];
      for (const record of list.filter(x => x.state !== 'acknowledged' && x.type === 'contact')) {
        await originalRecord(lease, record);
        const payload = types.contact.schema.parse(JSON.parse(record.payloadJson));
        if (payload.kind === 'send') result.push({operationId:record.operationId,contactId:record.objectId,
          recipientId:payload.recipientId,opportunityRef:payload.opportunityRef,state:record.state});
      }
      lease.check(); return result;
    },
    /** @returns {Promise<Array<{contactId:string,operationId:string}>>} */
    acknowledgedContacts: async () => {
      const lease = capture(), list = await records(lease), seen = new Set(), result = [];
      // Locators only: current invitations and their readable send sources must
      // still come from Contact GET, including after an owner reconnects.
      for (const record of [...list].reverse()) {
        if (record.state !== 'acknowledged' || record.type !== 'contact' || seen.has(record.objectId)) continue;
        seen.add(record.objectId);
        result.push({contactId:record.objectId,operationId:record.operationId});
      }
      lease.check(); return result;
    },
    pending: async () => {
      const lease = capture();
      return (await records(lease)).filter(x => x.state !== 'acknowledged')
        .map(({payloadJson:_payloadJson,submission:_submission,...meta}) => meta);
    },
  };
  map.set(subjectId, client); return client;
}
