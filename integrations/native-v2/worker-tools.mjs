import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { workerPanelResult } from './compact-app/worker-result.mjs';

const id = z.uuid(), digest = value => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/), viewer = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const disclosure = { visibility: z.enum(['Private', 'Public']).default('Private'), viewers: z.array(viewer).max(16).default([]) };
export const workerReadSchema = z.strictObject({ action: z.enum(['list', 'get', 'poll', 'reconcile-result', 'reconcile-use']), associationId: id.optional() });
export const workerPrepareSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), workerId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), caseId: id, attemptId: id,
    attemptVersion: z.number().int().positive(), purpose: z.string().trim().min(1).max(500), text: z.string().min(1).max(12000), taskId: id.optional() }),
  z.strictObject({ action: z.literal('cancel'), associationId: id }),
  z.strictObject({ action: z.literal('result'), associationId: id, summary: z.string().min(1).max(1200),
    reportedOutcome: z.enum(['succeeded', 'partial', 'failed', 'inconclusive', 'conflicting']), limitations: z.string().max(600).default(''),
    ...disclosure, expiresAt: z.number().int().positive().optional() }),
  z.strictObject({ action: z.literal('use'), associationId: id, ...disclosure }),
]);
export const workerExecuteSchema = z.strictObject({ handle: id, previewHash: hash });
export const workerAbortSchema = z.strictObject({ handle: id });
const fail = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };

/** No commands, installation, peer discovery or models are owned by this factory.
 * Original WeakMap previews remain in the selected host flow. Only its opaque,
 * process-local handle is accepted from MCP or an Apps callServerTool. */
export function registerNativeWorkerTools(server, { flow, runtime, review, now = () => Date.now(),
  render = workerPanelResult, toolMeta } = {}) {
  fail(flow && typeof review === 'function' && typeof runtime?.receiptStatus?.captureLease === 'function', 'worker_host_dependencies_required');
  const endpoint = runtime.api.endpoint, operations = new Map(), active = new Set();
  let closed = false, closing, preparing = 0;
  const capture = () => {
    fail(!closed, 'worker_host_closed');
    const lease = runtime.receiptStatus.captureLease(), current = runtime.api.snapshot();
    fail(runtime.api.endpoint === endpoint && lease.subjectId && lease.bindingId && current?.subjectId === lease.subjectId && current.bindingId === lease.bindingId
      && runtime.api.endpoint === lease.endpoint && (current.generation ?? null) === lease.generation, 'worker_host_connection_required');
    lease.assertCurrent(); return lease;
  };
  const check = lease => { fail(!closed, 'worker_host_closed'); lease.assertCurrent(); const s = runtime.api.snapshot();
    fail(runtime.api.endpoint === endpoint && runtime.api.endpoint === lease.endpoint && s?.subjectId === lease.subjectId
      && s.bindingId === lease.bindingId && (s.generation ?? null) === lease.generation, 'worker_host_connection_changed'); };
  const current = async (lease, fn) => { check(lease); let value;
    try { value = await fn(); } catch (error) { check(lease); throw error; }
    check(lease); return value;
  };
  const data = (lease, fields) => { check(lease); return { schemaVersion: 1, kind: 'galaxy-worker-panel', viewId: randomUUID(),
    ownerScope: digest(JSON.stringify([lease.subjectId, lease.deviceId ?? null, lease.endpoint, lease.bindingId, lease.generation])),
    checkedAt: new Date(now()).toISOString(), availability: 'ready', workers: flow.workers(), associations: [], ...fields }; };
  const errorResult = (error, lease) => {
    try { if (lease) check(lease); } catch { return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: 'worker_host_connection_changed', originalOperationRetained: true, privateResultWithheld: true }) }] }; }
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.code ?? 'worker_host_action_incomplete',
      reason: error.message, ...(error.associationId ? { associationId: error.associationId } : {}), originalOperationRetained: true }) }] };
  };
  const prune = () => { for (const [handle, op] of operations) if (op.expiresAt <= now() && op.state !== 'running') {
    // Completion/unknown journals belong to the flow, not this expiring local
    // review handle. Never abort them just to reclaim preview capacity.
    if (op.state === 'prepared') { try { flow.abort(op.original); } catch { /* Journal remains independent. */ } }
    operations.delete(handle);
  } };
  const run = fn => {
    // Capture synchronously before any queue, store or user-choice await.
    let lease; try { lease = capture(); } catch (error) { return Promise.resolve(errorResult(error)); }
    const pending = Promise.resolve().then(() => fn(lease)).catch(error => errorResult(error, lease));
    active.add(pending); pending.then(() => active.delete(pending), () => active.delete(pending)); return pending;
  };
  const decorate = result => {
    // Choice's input_required/declined/browser fallback remains the actual SDK
    // protocol result. Only our successful panel data is formatted for Apps.
    if (result?.content?.length === 1 && result.content[0].type === 'text') {
      try { const value = JSON.parse(result.content[0].text);
        if (value.schemaVersion === 1 && value.kind === 'galaxy-worker-panel') return { ...result, ...render(value) };
      } catch { /* Not a panel result. */ }
    }
    return result;
  };
  const register = (name, inputSchema, description, readOnlyHint, handler) => server.registerTool(name, {
    inputSchema, description, annotations: { readOnlyHint }, ...(toolMeta ? { _meta: toolMeta } : {}),
  }, (input, context) => run(lease => handler(inputSchema.parse(input), context, lease)));

  register('galaxy_worker_host_read', workerReadSchema,
    'Read configured user-host Workers and original associations. Explicit poll only queries a known peer Task; Result/use reconciliation only reads original receipts. No work, model or publication starts.', true,
    async (input, _context, lease) => {
      fail(input.action === 'list' || input.associationId, 'worker_association_required');
      if (input.action === 'list') {
        const rows = await current(lease, () => flow.associations());
        const associations = [];
        // Titles are read from the same current owner/source, never inferred
        // from an opaque Case or association ID. The remaining list still
        // carries its exact references for the foreground Agent.
        for (const row of rows.slice(-32).reverse()) {
          let view; try { view = await current(lease, () => flow.read(row.associationId)); } catch { check(lease); }
          associations.push({ ...row, ...(view ? { purpose: view.association.purpose,
            state: view.peer?.peer?.state ?? view.peer?.status } : { sourceUnavailable: true }) });
        }
        return render(data(lease, { associations, earlierAssociationsAvailable: rows.length > 32 }));
      }
      if (input.action.startsWith('reconcile-')) return render(data(lease, { actionResult: { associationId: input.associationId,
        action: input.action, result: await current(lease, () => input.action === 'reconcile-result'
          ? flow.reconcileResult(input.associationId) : flow.reconcileUse(input.associationId)) } }));
      let selected = await current(lease, () => flow.read(input.associationId, { poll: input.action === 'poll' }));
      // Read-only recovery belongs to the backend. It never turns an absent
      // receipt into a resend or restores source permission after withdrawal.
      if (selected.peer?.resultImportV2 && selected.peer.resultImportV2.state !== 'acknowledged') {
        const resultReceipt = await current(lease, () => flow.reconcileResult(input.associationId));
        selected = { ...await current(lease, () => flow.read(input.associationId)), resultReceipt };
      }
      if (selected.association?.packUse) selected = { ...selected,
        packUseReceipt: await current(lease, () => flow.reconcileUse(input.associationId)) };
      return render(data(lease, { selected }));
    });
  register('galaxy_worker_host_prepare', workerPrepareSchema,
    'Prepare one exact selected Worker input/cancel, separate participant-reported Result, or separate PackUse. Complete review is returned to ordinary MCP. Preparing never dispatches work, signs Consent or publishes a fact.', false,
    async (input, _context, lease) => {
      prune(); fail(operations.size + preparing < 128, 'worker_preview_capacity');
      // Reserve synchronously across every prepare/source await. An opaque
      // handle takes over the slot before finally releases its reservation.
      preparing += 1;
      try {
      const { action, associationId, ...selected } = input;
      const original = await current(lease, () => action === 'start' ? flow.prepareStart(selected) : action === 'cancel'
        ? flow.prepareCancel(associationId) : action === 'result' ? flow.prepareResult(associationId, selected) : flow.prepareUse(associationId, selected));
      if (original.state === 'acknowledged') return render(data(lease, { actionResult: { action, associationId, ...structuredClone(original), remoteResent: false } }));
      const inner = original.preview;
      let exact, payloadJson, visibility, recipients, operationId, configuration;
      if (original.kind === 'pack-use-retry') {
        const read = await current(lease, () => flow.read(original.associationId)), op = read.association.packUse;
        fail(op?.operationId === original.operationId && op.payload?.operationId === op.operationId, 'worker_original_use_review_required');
        payloadJson = JSON.stringify(op.payload);
        fail(digest(payloadJson) === op.payloadHash, 'worker_original_use_hash_changed');
        visibility = op.disclosure.visibility; recipients = op.disclosure.viewers; operationId = op.operationId;
        exact = { payloadJson, payload: structuredClone(op.payload), disclosure: structuredClone(op.disclosure), configuration: read.association.configuration };
        configuration = read.association.configuration;
      } else if (original.kind === 'pack-use') {
        payloadJson = inner.payloadJson; visibility = inner.visibility; recipients = inner.viewers; operationId = inner.operationId;
        fail(digest(payloadJson) === inner.payloadHash, 'worker_original_use_hash_changed');
        exact = { payloadJson, payload: structuredClone(inner.payload), disclosure: { visibility, viewers: [...recipients] } };
      } else if (original.kind === 'result') {
        payloadJson = inner.authorization.payloadJson; visibility = inner.authorization.visibility; recipients = inner.authorization.viewers;
        operationId = inner.draft.event.eventId;
        exact = { payloadJson, payload: JSON.parse(payloadJson), authorization: structuredClone(inner.authorization), source: structuredClone(inner.draft.source) };
      } else {
        fail(inner && ['send', 'cancel'].includes(original.kind), 'worker_preview_kind_invalid');
        payloadJson = inner.payloadJson; visibility = 'selected-peer'; recipients = [inner.peerPrincipal]; operationId = inner.operationId;
        exact = { payloadJson, payload: JSON.parse(payloadJson), externalEndpoint: inner.endpoint, peerPrincipal: inner.peerPrincipal };
      }
      if (action === 'start') {
        const view = await current(lease, () => runtime.api.call(`/v2/cases/${original.caseId}/read`, selected.taskId ? { taskId: selected.taskId } : {}));
        configuration = view.attempts?.find(a => a.id === original.attempt.id && a.version === original.attempt.version)?.configurationRef;
      } else if (!configuration) configuration = (await current(lease, () => flow.read(original.associationId))).association.configuration;
      fail(configuration?.id && Number.isSafeInteger(configuration.version) && configuration.version > 0, 'worker_configuration_review_required');
      check(lease);
      const worker = flow.workers().find(w => w.id === original.workerId);
      fail(worker, 'worker_configuration_unavailable');
      const reviewData = { action, associationId: original.associationId, workerId: original.workerId, workerName: worker.name ?? worker.id, pack: structuredClone(original.pack),
        workerVersion: worker.version, sourceHash: worker.sourceHash, configuration: structuredClone(configuration),
        purpose: original.purpose, caseId: original.caseId, attempt: structuredClone(original.attempt), operationId,
        payloadHash: digest(payloadJson), visibility, recipients: [...recipients], exact };
      const handle = randomUUID(), previewHash = digest(JSON.stringify(reviewData)), expiresAt = now() + 300000;
      operations.set(handle, { original, lease, reviewData, previewHash, expiresAt, state: 'prepared' });
      return render(data(lease, { preview: { handle, previewHash, expiresAt: new Date(expiresAt).toISOString(), ...structuredClone(reviewData) } }));
      } finally { preparing -= 1; }
    });
  register('galaxy_worker_host_execute', workerExecuteSchema,
    'Use the native actual user-choice surface for the exact prepared handle/hash. Result and PackUse each require their own confirmation. Repeating a completed/unknown handle never sends again; inspect original receipts.', false,
    async (input, context, lease) => {
      prune(); const op = operations.get(input.handle);
      fail(op && op.previewHash === input.previewHash && op.expiresAt > now(), 'worker_preview_changed_or_expired');
      check(op.lease); check(lease);
      const retained = () => data(lease, { actionResult: { action: op.reviewData.action, associationId: op.reviewData.associationId,
        operationId: op.reviewData.operationId, state: op.state, remoteResent: false,
        ...(op.state === 'completed' ? { result: structuredClone(op.result) } : { originalOperationRetained: true }) } });
      if (op.state !== 'prepared') return render(retained());
      const reviewed = await current(lease, () => review('galaxy_worker_host_execute',
        { handle: input.handle, previewHash: input.previewHash, expiresAt:op.expiresAt, preview: structuredClone(op.reviewData) }, context, async () => {
          check(lease); check(op.lease); fail(op.expiresAt > now(), 'worker_preview_expired');
          if (op.state !== 'prepared') return retained();
          op.state = 'running';
          try { op.result = await current(lease, () => flow.execute(op.original, { confirmed: true })); op.state = 'completed'; }
          catch (error) { op.state = 'original-operation-needs-reconciliation'; throw error; }
          return retained();
        }));
      check(op.lease); return decorate(reviewed);
    });
  register('galaxy_worker_host_abort_local', workerAbortSchema,
    'Abandon this local preview or transport only. It does not assert a peer CancelTask, remove accepted Result/PackUse, or discard original unknown-operation journals.', false,
    async (input, _context, lease) => {
      const op = operations.get(input.handle); fail(op, 'worker_preview_unknown'); check(op.lease);
      // Aborting a completed action cannot relabel its accepted original fact.
      if (op.state === 'completed') return render(data(lease, { actionResult: { state: 'completed', localStopped: false, remoteCanceled: false,
        associationId: op.reviewData.associationId, originalOperationRetained: true } }));
      const result = await current(lease, () => flow.abort(op.original));
      if (op.state === 'prepared') op.state = 'locally-stopped';
      return render(data(lease, { actionResult: { ...result, associationId: op.reviewData.associationId, remoteCanceled: false, originalOperationRetained: true } }));
    });
  return Object.freeze({ close() {
    closing ??= Promise.resolve().then(async () => { closed = true;
      for (const op of operations.values()) if (op.state !== 'completed') { try { flow.abort(op.original); } catch { /* No remote cancellation assertion. */ } }
      await Promise.allSettled(active); operations.clear(); flow.close();
    }); return closing;
  } });
}
