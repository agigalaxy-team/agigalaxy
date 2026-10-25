import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { packUseEventSchema } from '../../../galaxy-official/src/shared/worker-pack-uses-v2-schema.mjs';

const packRef = z.strictObject({ builderId: z.uuid(), manifestId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) });
const workerSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), peerId: z.string().min(1).max(80), pack: packRef,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), version: z.string().min(1).max(80) });
const startSchema = z.strictObject({ workerId: z.string(), caseId: z.uuid(), attemptId: z.uuid(), attemptVersion: z.number().int().positive(),
  purpose: z.string().trim().min(1).max(500), text: z.string().min(1).max(12000), taskId: z.uuid().optional() });
const fail = (ok, message) => { if (!ok) throw new Error(message); };

/** User-host composition. The caller supplies already selected peer/Pack pins
 * and the existing A2A and PackUse clients. No installation, process launch,
 * identity creation, model call or cloud execution is hidden in this flow. */
export function createWorkerPackHostFlowV2({ runtime, a2a, packUses, workers }) {
  workers = structuredClone(z.array(workerSchema).min(1).max(32).parse(workers));
  fail(new Set(workers.map(v => v.id)).size === workers.length, 'Select unique configured Workers.');
  const endpoint = runtime.api.endpoint, previews = new WeakMap();
  let queue = Promise.resolve(), closed = false;
  const capture = () => {
    const s = runtime.api.snapshot(); fail(!closed && s?.subjectId && runtime.api.endpoint === endpoint, 'Current Worker host connection required.');
    return Object.freeze({ subjectId: s.subjectId, endpoint, bindingId: s.bindingId, generation: s.generation ?? null });
  };
  const check = lease => {
    const current = capture(); fail(Object.keys(lease).every(key => current[key] === lease[key]), 'Worker host connection changed; inspect original operation.');
  };
  const awaitCurrent = async (lease, fn) => { check(lease); let result;
    try { result = await fn(); } catch (error) { check(lease); throw error; } check(lease); return result; };
  const run = fn => {
    let lease; try { lease = capture(); } catch (error) { return Promise.reject(error); }
    const next = queue.then(async () => { check(lease); const result = await fn(lease); check(lease); return result; });
    queue = next.then(() => {}, () => {}); return next;
  };
  const key = lease => `worker-pack-host-v2:${lease.endpoint}:${lease.subjectId}`;
  const load = async lease => await awaitCurrent(lease, () => runtime.getLocal(key(lease))) ?? { associations: {} };
  const save = (lease, state) => awaitCurrent(lease, () => runtime.putLocal(key(lease), structuredClone(state)));
  const selected = async (lease, id) => {
    const row = (await load(lease)).associations[id];
    fail(row?.associationId === id && row.owner?.subjectId === lease.subjectId && row.owner.endpoint === lease.endpoint,
      'Original Worker association unavailable for this owner.'); return row;
  };
  const manifest = async (lease, worker) => {
    const pack = await awaitCurrent(lease, () => packUses.manifest(worker.pack));
    fail(pack.builderId === worker.pack.builderId && pack.manifestId === worker.pack.manifestId && pack.manifestHash === worker.pack.manifestHash
      && pack.manifest?.sha256 === worker.sourceHash && pack.manifest.version === worker.version && !pack.delisted && !pack.securityIssue,
    'Selected Worker Pack version or permission changed.'); return pack;
  };
  const facts = (lease, row) => awaitCurrent(lease, () => packUses.caseFacts(row.caseId, row.taskId));
  const prepare = (lease, kind, inner, row, extra = {}) => {
    const preview = Object.freeze({ kind, associationId: row.associationId, workerId: row.workerId, pack: structuredClone(row.pack),
      purpose: row.purpose, caseId: row.caseId, attempt: structuredClone(row.attempt), ...extra, preview: inner });
    previews.set(preview, { kind, inner, row, lease, used: false }); return preview;
  };
  const useReceipt = async (lease, op) => {
    const pending = await awaitCurrent(lease, () => packUses.pending());
    const result = await awaitCurrent(lease, () => pending.some(v => v.operationId === op.operationId)
      ? packUses.reconcile(op.operationId) : runtime.api.call('/v2/builders/pack-uses/receipt',
        { operationId: op.operationId, payloadHash: op.payloadHash }));
    fail(result.operationId === op.operationId && ['absent', 'conflict', 'acknowledged'].includes(result.state)
      && result.currentReadPermissionConfirmed === false, 'Original PackUse receipt mismatch.'); return result;
  };
  return Object.freeze({
    workers: () => workers.map(({ id, peerId, pack, sourceHash, version }) => ({ id, peerId, pack: structuredClone(pack), sourceHash, version })),
    associations: () => run(async lease => Object.values((await load(lease)).associations).map(row => ({
      associationId: row.associationId, workerId: row.workerId, pack: structuredClone(row.pack),
      caseId: row.caseId, attempt: structuredClone(row.attempt), owner: structuredClone(row.owner),
      ...(row.packUse ? { packUse: { operationId: row.packUse.operationId, payloadHash: row.packUse.payloadHash } } : {}) }))),
    prepareStart: input => run(async lease => {
      const request = startSchema.parse(input), worker = workers.find(v => v.id === request.workerId);
      fail(worker, 'Select a configured reference Worker.'); await manifest(lease, worker);
      const view = await facts(lease, request), attempt = view.attempts?.find(v => v.id === request.attemptId && v.version === request.attemptVersion);
      fail(view.caseId === request.caseId && attempt?.actorId === lease.subjectId && attempt.configurationRef,
        'An actual current owned Attempt with an exact Configuration is required.');
      const inner = await awaitCurrent(lease, () => a2a.prepare(worker.peerId, 'send', { caseId: request.caseId,
        attemptId: request.attemptId, attemptVersion: request.attemptVersion, text: request.text, ...(request.taskId ? { taskId: request.taskId } : {}) }));
      const row = { associationId: inner.associationId, workerId: worker.id, peerId: worker.peerId, pack: worker.pack,
        purpose: request.purpose, caseId: request.caseId, attempt: { id: attempt.id, version: attempt.version },
        configuration: structuredClone(attempt.configurationRef), ...(request.taskId ? { taskId: request.taskId } : {}),
        owner: { subjectId: lease.subjectId, endpoint: lease.endpoint }, state: 'prepared' };
      return prepare(lease, 'send', inner, row);
    }),
    execute: (preview, { confirmed = false } = {}) => run(async lease => {
      const pending = previews.get(preview);
      fail(pending && !pending.used && confirmed, 'Review and explicitly confirm this exact Worker action.'); check(pending.lease);
      pending.used = true;
      const row = pending.row;
      if (pending.kind === 'send') {
        await manifest(lease, workers.find(v => v.id === row.workerId));
        const state = await load(lease);
        fail(!state.associations[row.associationId], 'Original Worker association already dispatched.');
        state.associations[row.associationId] = { ...row, state: 'dispatching' }; await save(lease, state);
      }
      // Existing A2A/PackUse journals reserve their exact operation before I/O.
      // A failed or late return never deletes the original host association.
      const result = await awaitCurrent(lease, () => pending.kind === 'pack-use'
        ? packUses.execute(pending.inner, { confirmed: true }) : pending.kind === 'pack-use-retry'
          ? packUses.retry(pending.row.packUse.operationId, { confirmed: true }) : a2a.execute(pending.inner, { confirmed: true }));
      return result;
    }),
    read: (id, { poll = false } = {}) => run(async lease => {
      const row = await selected(lease, id);
      const link = await awaitCurrent(lease, () => a2a.read(row.peerId, poll ? 'poll' : 'get', id));
      return { association: structuredClone(row), peer: link, executionAuthority: 'peer-reported', capabilityVerified: false };
    }),
    prepareCancel: id => run(async lease => {
      const row = await selected(lease, id);
      return prepare(lease, 'cancel', await awaitCurrent(lease, () => a2a.prepare(row.peerId, 'cancel', { associationId: id })), row);
    }),
    prepareResult: (id, input) => run(async lease => {
      const row = await selected(lease, id);
      const inner = await awaitCurrent(lease, () => a2a.prepare(row.peerId, 'result', { ...input, associationId: id }));
      return inner.state === 'acknowledged' ? inner : prepare(lease, 'result', inner, row);
    }),
    reconcileResult: id => run(async lease => {
      const row = await selected(lease, id);
      return awaitCurrent(lease, () => a2a.read(row.peerId, 'reconcile-result', id));
    }),
    prepareUse: (id, disclosure) => run(async lease => {
      const row = await selected(lease, id);
      if (row.packUse) {
        const original = await useReceipt(lease, row.packUse);
        if (original.state === 'acknowledged') return { state: 'acknowledged', originalOperationRetained: true, receipt: original };
        fail(original.state === 'absent', 'The original PackUse is conflicting; keep its locator.');
        const pending = await awaitCurrent(lease, () => packUses.pending());
        const op = pending.find(v => v.operationId === row.packUse.operationId);
        fail(!op || op.state !== 'stopped-local', 'Local retry was stopped; only query the original receipt.');
        if (op) return prepare(lease, 'pack-use-retry', null, row, { operationId: row.packUse.operationId });
      }
      await manifest(lease, workers.find(v => v.id === row.workerId));
      const link = await awaitCurrent(lease, () => a2a.read(row.peerId, 'get', id)), saved = link.resultImportV2;
      fail(saved?.state === 'acknowledged', 'First reconcile the separately accepted original Result.');
      const view = await facts(lease, row), result = view.results?.find(v => v.id === saved.draft.event.eventId && v.version === 1);
      const attempt = view.attempts?.find(v => v.id === row.attempt.id && v.version === row.attempt.version);
      fail(result && attempt && result.origin?.kind === 'attempt' && result.origin.id === row.attempt.id
        && result.origin.version === row.attempt.version && JSON.stringify(attempt.configurationRef) === JSON.stringify(row.configuration),
      'The exact Attempt, Result or Configuration is no longer readable.');
      const payload = row.packUse?.payload ?? packUseEventSchema.parse({ schemaVersion: 2, kind: 'record', operationId: randomUUID(), id: randomUUID(), expectedVersion: 0,
        pack: row.pack, caseId: row.caseId, attempt: row.attempt, configuration: row.configuration,
        result: { id: result.id, version: result.version }, evidenceRefs: [], verificationRefs: [], follows: null });
      const inner = await awaitCurrent(lease, () => packUses.prepare(payload, row.packUse?.disclosure ?? disclosure));
      fail(!row.packUse || inner.payloadHash === row.packUse.payloadHash, 'Original PackUse bytes changed.');
      const state = await load(lease);
      state.associations[id] = { ...row, packUse: { operationId: payload.operationId, payloadHash: inner.payloadHash, id: payload.id,
        payload: structuredClone(payload), disclosure: { visibility: inner.visibility, viewers: inner.viewers } } };
      await save(lease, state); return prepare(lease, 'pack-use', inner, state.associations[id], { operationId: payload.operationId });
    }),
    reconcileUse: id => run(async lease => {
      const row = await selected(lease, id), op = row.packUse;
      fail(op, 'No original PackUse has been prepared.');
      return useReceipt(lease, op);
    }),
    abort: preview => {
      const pending = previews.get(preview); fail(pending, 'Unknown Worker preview.'); check(pending.lease); pending.used = true;
      if (!pending.kind.startsWith('pack-use')) return a2a.abort(pending.inner);
      return { previewDiscarded: true, remoteCanceled: false, originalOperationRetained: true };
    },
    close() { closed = true; },
  });
}
