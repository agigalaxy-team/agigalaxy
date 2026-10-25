import * as z from 'zod/v4';
import { createNativeWorkerPackAdapter } from './worker-pack.mjs';
import { createConfiguredNativeA2a, nativeA2aSchema } from './a2a.mjs';
import { createWorkerPackHostFlowV2 } from '../../../../galaxy-a2a/src/worker-pack-flow-v2.mjs';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const nativeWorkerPacksSchema = z.strictObject({ workers: z.array(z.strictObject({
  id: identifier, peerId: identifier,
  pack: z.strictObject({ builderId: z.uuid(), manifestId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), version: z.string().min(1).max(80),
})).min(1).max(32) }).refine(value => new Set(value.workers.map(worker => worker.id)).size === value.workers.length,
  'Unique Worker IDs required');

/** Trusted configuration only. Discovery creates no identity, connection, child
 * process or model. The first explicit connected call binds local journals to
 * that owner; selected Pack and A2A pins are checked again by their existing flows. */
export function createConfiguredNativeWorkerHost({ runtime, directory, configuration, a2aConfiguration,
  environment = process.env, post }) {
  const workers = structuredClone(nativeWorkerPacksSchema.parse(configuration).workers);
  const peers = nativeA2aSchema.parse(a2aConfiguration);
  if (workers.some(worker => !peers.peers.some(peer => peer.id === worker.peerId)))
    throw new Error('worker_configured_peer_required');
  const endpoint = runtime.api.endpoint, owners = new Map();
  let closed = false;
  function flow() {
    const lease = runtime.receiptStatus.captureLease(), current = runtime.api.snapshot();
    if (closed || runtime.api.endpoint !== endpoint || !lease.subjectId || !lease.bindingId
      || lease.endpoint !== endpoint || current?.subjectId !== lease.subjectId || current.bindingId !== lease.bindingId
      || current.generation !== lease.generation) throw new Error('worker_native_connection_required');
    lease.assertCurrent();
    if (!owners.has(lease.subjectId)) {
      const adapter = createNativeWorkerPackAdapter({ runtime, subjectId: lease.subjectId, now: runtime.now });
      const a2a = createConfiguredNativeA2a({ runtime: adapter.runtime, directory, configuration: peers, environment, post });
      owners.set(lease.subjectId, { adapter, flow: createWorkerPackHostFlowV2({ runtime: adapter.runtime,
        a2a, packUses: adapter.packUses, workers }) });
    }
    return owners.get(lease.subjectId).flow;
  }
  const methods = ['associations', 'prepareStart', 'execute', 'read', 'prepareCancel', 'prepareResult',
    'reconcileResult', 'prepareUse', 'reconcileUse', 'abort'];
  return Object.freeze({
    ...Object.fromEntries(methods.map(name => [name, (...args) => flow()[name](...args)])),
    workers: () => structuredClone(workers),
    close() { closed = true; for (const owner of owners.values()) { owner.flow.close(); owner.adapter.close(); } owners.clear(); },
  });
}
