import * as z from 'zod/v4';
import { createWorkerPackUseClient } from '../../../../galaxy-web/src/worker-pack-use-client.mjs';
import { caseEventV2Schema } from '../../../../galaxy-official/src/shared/cases-schema.mjs';

const resultAuthorization = z.strictObject({
  requestId: z.uuid(), action: z.literal('case.teaser.publish'), objectId: z.uuid(),
  payloadJson: z.string().min(1).max(16000), visibility: z.enum(['Private', 'Public']),
  viewers: z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(16),
  expiresAt: z.number().int().positive().optional(),
});
const fail = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };

/** Trusted host composition only. MCP receives the existing Worker tool schemas,
 * never these methods, a command, a private key, or a model confirmation flag.
 * Consent signing is the canonical BrowserClient protocol behind the native
 * runtime's current-device fence; no connection is implicitly established. */
export function createNativeWorkerPackAdapter({ runtime, subjectId, now }) {
  fail(runtime?.workerAuthorization && runtime?.receiptStatus?.captureLease
    && runtime?.store?.get && runtime?.store?.put, 'worker_native_adapter_dependencies_required');
  const endpoint = runtime.api.endpoint, initial = runtime.receiptStatus.captureLease();
  subjectId ??= initial.subjectId;
  fail(subjectId && subjectId === initial.subjectId && initial.bindingId, 'worker_native_connection_required');
  initial.assertCurrent();
  const prefix = 'native-worker-pack:' + endpoint + ':' + subjectId + ':';
  let closed = false, authorizationQueue = Promise.resolve();
  const capture = () => {
    fail(!closed && runtime.api.endpoint === endpoint, 'worker_native_adapter_closed_or_endpoint_changed');
    const lease = runtime.receiptStatus.captureLease(), current = runtime.api.snapshot();
    fail(lease.subjectId === subjectId && lease.endpoint === endpoint && lease.bindingId
      && current?.subjectId === subjectId && current.bindingId === lease.bindingId
      && current.generation === lease.generation, 'worker_native_connection_required');
    lease.assertCurrent(); return lease;
  };
  const check = lease => { fail(!closed && runtime.api.endpoint === endpoint, 'worker_native_adapter_closed_or_endpoint_changed'); lease.assertCurrent(); };
  const awaitCurrent = async (lease, fn) => {
    check(lease); let value;
    try { value = await fn(); } catch (error) { check(lease); throw error; }
    check(lease); return value;
  };
  const key = name => { fail(typeof name === 'string' && name.length > 0 && name.length <= 1000, 'worker_native_journal_name_invalid'); return prefix + name; };
  const getLocal = async name => {
    const lease = capture(); return awaitCurrent(lease, () => runtime.store.get(key(name)));
  };
  const putLocal = async (name, value) => {
    const lease = capture(), originalKey = key(name); check(lease);
    // A write already in flight remains under the original subject/endpoint.
    // A changed lease withholds its completion; it does not erase the locator
    // or claim that a remote operation was canceled.
    await runtime.store.put(originalKey, value); check(lease);
  };
  const call = async (method, ...args) => {
    const lease = capture(); return awaitCurrent(lease, () => runtime.workerAuthorization[method](...args));
  };
  async function authorizeWithLease(lease, input, confirmed) {
    input = structuredClone(resultAuthorization.parse(input));
    const event = caseEventV2Schema.parse(JSON.parse(input.payloadJson));
    fail(event.kind === 'result-recorded' && event.actorId === subjectId
      && event.eventId === input.objectId, 'worker_native_result_intent_mismatch');
    const name = 'result-authorization:' + input.requestId;
    let saved = await awaitCurrent(lease, () => runtime.store.get(key(name)));
    fail(!saved || saved.owner === subjectId && saved.endpoint === endpoint
      && JSON.stringify(saved.input) === JSON.stringify(input), 'worker_native_authorization_request_changed');
    // Even an existing authorization is consumed only by the independently
    // reviewed Result execute path. Reading an original receipt needs no sign.
    fail(confirmed, 'worker_native_result_review_required');
    const save = async value => {
      check(lease); await runtime.store.put(key(name), value); check(lease);
    };
    if (!saved) {
      const prepared = await awaitCurrent(lease, () => runtime.workerAuthorization.prepareAuthorization(input.payloadJson, {
        action: input.action, objectId: input.objectId, id: input.requestId,
        visibility: input.visibility, viewers: input.viewers,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), confirmed: true,
      }));
      saved = { owner: subjectId, endpoint, input, prepared, state: 'prepared' }; await save(saved);
    }
    saved = { ...saved, state: 'result-unknown' }; await save(saved);
    const result = await awaitCurrent(lease, () => runtime.workerAuthorization.submitAuthorization(saved.prepared, { confirmed: true, reconcile: true }));
    await save({ ...saved, state: 'active', receipt: result });
    return { requestId: input.requestId, ...result, state: 'active' };
  }
  const boundRuntime = Object.freeze({
    receiptStatus: Object.freeze({ captureLease: capture }),
    api: Object.freeze({ endpoint, snapshot: runtime.api.snapshot,
      call: (...args) => call('call', ...args),
      prepareAuthorization: (...args) => call('prepareAuthorization', ...args),
      submitAuthorization: (...args) => call('submitAuthorization', ...args),
      reconcileAuthorization: (...args) => call('reconcileAuthorization', ...args),
    }),
    status: async () => { const lease = capture(); const value = await awaitCurrent(lease, runtime.status); fail(value.identity === subjectId, 'worker_native_owner_changed'); return value; },
    getLocal, putLocal,
    authorize(input, { confirmed = false } = {}) {
      // Capture before queue entry. A delayed old operation cannot acquire a
      // fresh connection merely because it finally reached the queue head.
      const lease = capture();
      const run = authorizationQueue.then(() => authorizeWithLease(lease, input, confirmed));
      authorizationQueue = run.catch(() => {}); return run;
    },
  });
  return Object.freeze({ runtime: boundRuntime,
    packUses: createWorkerPackUseClient({ runtime: boundRuntime, subjectId, ...(now ? { now } : {}) }),
    close() { closed = true; },
  });
}
