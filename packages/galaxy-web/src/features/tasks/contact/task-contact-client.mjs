import { createContactDiscovery } from "./discovery.mjs";
import { createContactInvitationBatch } from "./invitation-batch.mjs";
import { createContactRoomBatch } from "./room-batch.mjs";
export { contactSourceRef, contactCandidates } from "./candidates.mjs";

const clone = (value) => structuredClone(value);

export function createTaskContactClient(sourceRuntime, taskId) {
  const connection = () => {
    const value = sourceRuntime.api.snapshot();
    return value && { subjectId: value.subjectId, endpoint: sourceRuntime.api.endpoint ?? value.endpoint,
      bindingId: value.bindingId, generation: value.generation };
  };
  const owner = connection(); let closed = false;
  const check = () => {
    const current = connection();
    if (closed || !owner || !current || Object.keys(owner).some(key => owner[key] !== current[key]))
      throw Error('身份或连接已改变，请重新打开当前任务并核对原批次。');
  };
  const guarded = async action => {
    check(); let result;
    try { result = await action(); } catch (error) { check(); throw error; }
    check(); return result;
  };
  // Bind every local, network and nested operation to this exact reviewed
  // connection. A remounted client may inspect a retained original batch, but
  // an in-flight old client cannot keep sending under a new binding.
  const runtime = {
    api: { snapshot: () => { check(); return sourceRuntime.api.snapshot(); }, call: (...args) => guarded(() => sourceRuntime.api.call(...args)) },
    chat: Object.fromEntries(['create', 'pending', 'propose', 'retry'].map(name => [name, (...args) => guarded(() => sourceRuntime.chat[name](...args))])),
    ...Object.fromEntries(['getLocal', 'putLocal', 'status', 'taskEvent', 'reconcileTaskEvent', 'stoppedTaskOperations', 'queryStoppedTaskOperation']
      .map(name => [name, (...args) => guarded(() => sourceRuntime[name](...args))])),
    updateLocal: (name, updater, subjectId) => guarded(() => {
      if (typeof sourceRuntime.updateLocal !== 'function') throw Error('local_atomic_update_unavailable');
      return sourceRuntime.updateLocal(name, updater, subjectId);
    }),
  };
  const key = `task-contact-batch:${taskId}`,
    roomKey = `task-room-batch:${taskId}`;
  let working = false;
  const call = (path, input) =>
    runtime.api.call(path, input, { authenticated: true });
  const read = () =>
    runtime.api.call(`/v2/tasks/${taskId}`, null, {
      method: 'GET',
      authenticated: true,
    });
  const inviteError = (code, message) => Object.assign(new Error(message), { code });
  const lock = async (operation) => {
    check();
    if (working) throw Error('请等待当前批次操作完成。');
    working = true;
    try {
      return await guarded(operation);
    } finally {
      working = false;
    }
  };
  const context = { runtime, taskId, key, roomKey, owner, check, clone, call, read, inviteError, lock };
  const methods = {
    ...createContactDiscovery(context),
    ...createContactInvitationBatch(context),
    ...createContactRoomBatch(context),
  };
  /** @typedef {{[K in keyof typeof methods]: (...args: Parameters<(typeof methods)[K]>) => Promise<Awaited<ReturnType<(typeof methods)[K]>>>}} GuardedMethods */
  return Object.freeze({ close() { closed = true; }, .../** @type {GuardedMethods} */ (Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, (...args) => guarded(() => fn(...args))]))) });
}
