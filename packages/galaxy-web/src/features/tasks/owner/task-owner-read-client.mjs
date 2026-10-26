import { sha256Hex } from "../../../../../galaxy-official/src/shared/web-primitives.mjs";
import { taskOwnerReadDescriptorV2Schema, taskOwnerReadPreviewV2Schema, taskOwnerReadResultV2Schema } from "../../../../../galaxy-official/src/shared/task-owner-read-v2-schema.mjs";

const projection = 'currently-authorized-authored-events';
const clone = value => structuredClone(value);
const changed = () => new Error('身份或连接已改变。请重新打开原任务，核对本次本人记录范围。');
const invalid = () => new Error('本人记录的授权范围或回执不一致，请重新核对。');
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameOwner = (left, right) => ['endpoint','subjectId','bindingId','deviceId','controlEpoch']
  .every(key => left?.[key] === right?.[key]);
const originalPreview = value => {
  if(!value||typeof value!=='object')throw invalid();
  const {authorizationState:_state,readExpiresAt:_readExpiry,...preview}=clone(value);
  return preview;
};
const readExpiry = preview => Math.min(...preview.events.map(event=>event.readExpiresAt));
const expired = () => Object.assign(new Error('这次本人记录的读取授权已到期，请重新选择当前可读范围。'),
  {code:'task_owner_read_authorization_expired'});
const partial = value => value?.projection === projection && value.completeTaskSnapshot === false
  && value.contextAccessGranted === false && value.referenceAccessGranted === false && value.taskWriteGranted === false;

// A read projection is deliberately kept separate from the ordinary Task
// snapshot and task mutation queues. It never replays old task submissions.
export function createTaskOwnerReadClient(runtime, taskId, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!uuid(taskId)) throw invalid();
  const current = () => {
    const value = runtime.api.snapshot();
    return value && { endpoint: runtime.api.endpoint, subjectId: value.subjectId, bindingId: value.bindingId,
      generation: value.generation, deviceId: value.control?.deviceId, controlEpoch: value.control?.epoch };
  };
  const owner = current(), key = `task-owner-read:${taskId}`;
  let closed = false, working = false;
  const previews = new Map();
  const check = () => {
    if (closed || !owner?.deviceId || !same(owner, current())) throw changed();
  };
  const guard = async operation => {
    check(); let value;
    try { value = await operation(); } catch (error) { check(); throw error; }
    check(); return value;
  };
  const lock = async operation => {
    check(); if (working) throw new Error('请等待这次本人记录核对完成。');
    working = true;
    try { return await guard(operation); } finally { working = false; }
  };
  async function validatePreview(value, {allowExpired=false}={}) {
    if (!taskOwnerReadPreviewV2Schema.safeParse(value).success || !partial(value) || value.taskId !== taskId) throw invalid();
    let descriptor;
    try { descriptor = JSON.parse(value.payloadJson); } catch { throw invalid(); }
    if (!taskOwnerReadDescriptorV2Schema.safeParse(descriptor).success
      || Object.keys(descriptor).sort().join(',') !== 'bindingId,controlEpoch,deviceId,eventRefs,expiresAt,operationId,taskId,taskVersion,version'
      || descriptor.version !== 1 || !uuid(descriptor.operationId) || descriptor.taskId !== taskId
      || descriptor.taskVersion !== value.latestTaskVersion || descriptor.bindingId !== owner.bindingId
      || descriptor.deviceId !== owner.deviceId || descriptor.controlEpoch !== owner.controlEpoch
      || descriptor.expiresAt !== value.expiresAt || !Number.isSafeInteger(descriptor.expiresAt)
      || !Array.isArray(descriptor.eventRefs) || !descriptor.eventRefs.length || descriptor.eventRefs.length !== value.events.length
      || new Set(descriptor.eventRefs.map(item => item.eventId)).size !== descriptor.eventRefs.length) throw invalid();
    for (let index = 0; index < descriptor.eventRefs.length; index++) {
      const ref = descriptor.eventRefs[index], event = value.events[index];
      if (!uuid(ref.eventId) || !Number.isSafeInteger(ref.version) || ref.version < 1 || !/^[a-f0-9]{64}$/.test(ref.payloadHash)
        || ref.eventId !== event.eventId || ref.version !== event.version || ref.payloadHash !== event.payloadHash
        || Object.hasOwn(event, 'payloadJson') || Object.hasOwn(event, 'payload') || Object.hasOwn(event, 'body')) throw invalid();
    }
    if (await guard(() => sha256Hex(value.payloadJson)) !== value.payloadHash) throw invalid();
    if(descriptor.expiresAt>readExpiry(value))throw invalid();
    if(!allowExpired&&descriptor.expiresAt<=now())throw expired();
    return descriptor;
  }
  async function pending() {
    return lock(async () => {
      const saved = await guard(() => runtime.getLocal(key));
      if (!saved || !sameOwner(saved.owner, owner)) return null;
      await validatePreview(saved.preview,{allowExpired:true});
      previews.set(saved.preview.payloadJson, clone(saved.preview));
      return {...clone(saved.preview),authorizationState:saved.preview.expiresAt<=now()?'expired':saved.submission?'authorized':'awaiting-receipt',
        readExpiresAt:readExpiry(saved.preview)};
    });
  }
  async function prepare({ eventIds } = {}) {
    return lock(async () => {
      const operationId = crypto.randomUUID();
      const selected = eventIds === undefined ? undefined : [...eventIds];
      if (selected && (!selected.length || selected.length > 32 || selected.some(id => !uuid(id)) || new Set(selected).size !== selected.length)) throw invalid();
      const value = await guard(() => runtime.api.call(`/v2/tasks/${taskId}/owner-read/prepare`, {
        operationId, ...(selected ? { eventIds: selected } : {}),
      }));
      const descriptor = await validatePreview(value);
      // The service always includes the original request along with any
      // explicitly requested authored events; every returned ref is reviewed.
      if (descriptor.operationId !== operationId || selected && (descriptor.eventRefs.length > selected.length + 1
        || selected.some(id => !descriptor.eventRefs.some(ref => ref.eventId === id)))) throw invalid();
      previews.clear(); previews.set(value.payloadJson, clone(value));
      return clone(value);
    });
  }
  async function read(reviewed, { confirmed = false } = {}) {
    return lock(async () => {
      if (!confirmed) throw new Error('请先查看所列本人记录，再明确授权读取。');
      const preview = originalPreview(reviewed), known = previews.get(preview?.payloadJson);
      if (!known || !same(known, preview)) throw invalid();
      const descriptor = await validatePreview(preview);
      let saved = await guard(() => runtime.getLocal(key));
      if (!saved || !sameOwner(saved.owner, owner) || saved.preview?.payloadJson !== preview.payloadJson) {
        const prepared = await guard(() => runtime.api.prepareAuthorization(preview.payloadJson, {
          action: 'task.owner-read', objectId: descriptor.operationId, visibility: 'Private', viewers: [],
          expiresAt: descriptor.expiresAt, confirmed: true,
        }));
        saved = { version: 1, owner: clone(owner), preview, prepared };
        await guard(() => runtime.putLocal(key, saved));
      }
      const intent = saved.prepared?.intent;
      if (saved.prepared?.payloadJson !== preview.payloadJson || intent?.action !== 'task.owner-read'
        || intent.objectId !== descriptor.operationId || intent.subjectId !== owner.subjectId || intent.bindingId !== owner.bindingId
        || intent.endpoint !== owner.endpoint || intent.recipient !== owner.endpoint || intent.purpose !== 'operational'
        || intent.visibility !== 'Private' || !same(intent.viewers, []) || intent.expiresAt !== descriptor.expiresAt
        || !same(intent.fields, Object.keys(descriptor)) || intent.payloadHash !== preview.payloadHash) throw invalid();
      let submission=saved.submission;
      if(!submission){
        submission = await guard(() => runtime.api.submitAuthorization(saved.prepared, { confirmed: true, reconcile: true }));
        if(submission.payloadJson!==preview.payloadJson||!uuid(submission.consentId)
          ||intent.id&&submission.consentId!==intent.id)throw invalid();
        saved.submission=clone(submission);
        await guard(()=>runtime.putLocal(key,saved));
      }
      if (submission.payloadJson !== preview.payloadJson||!uuid(submission.consentId)
        ||intent.id&&submission.consentId!==intent.id) throw invalid();
      const result = await guard(() => runtime.api.call(`/v2/tasks/${taskId}/owner-read`, submission));
      if (!taskOwnerReadResultV2Schema.safeParse(result).success || !partial(result) || result.taskId !== taskId || result.latestTaskVersion !== descriptor.taskVersion
        || !Array.isArray(result.events) || result.events.length !== descriptor.eventRefs.length) throw invalid();
      for (let index = 0; index < result.events.length; index++) {
        const event = result.events[index], ref = descriptor.eventRefs[index];
        if (event.eventId !== ref.eventId || event.version !== ref.version || event.payloadHash !== ref.payloadHash
          || typeof event.payloadJson !== 'string' || await guard(() => sha256Hex(event.payloadJson)) !== ref.payloadHash) throw invalid();
        try { JSON.parse(event.payloadJson); } catch { throw invalid(); }
      }
      // The original selected descriptor and Consent allow current re-reads.
      // Event bodies never enter local storage or ordinary Task state.
      return {...clone(result),expiresAt:descriptor.expiresAt,readExpiresAt:readExpiry(preview)};
    });
  }
  return Object.freeze({ prepare, pending, read, close() { closed = true; previews.clear(); } });
}
