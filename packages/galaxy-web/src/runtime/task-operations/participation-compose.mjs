import { equalJson } from '../../../../galaxy-official/src/shared/web-primitives.mjs';

// Editing revisions and acceptance coordinates share the caller's original lease.
export function createParticipationCompose({ prefix, store, captureTaskDraftLease, taskAwait, checkOperationLease, stoppedQueueName, now, updateTaskQueue }) {
  const taskUuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value ?? '');
  const participationDraftIssue = code => { throw Object.assign(new Error(code), { code }); };
  function participationComposeKey(lease, taskId, participationId) {
    if (!lease.subjectId || !taskUuid(taskId) || !taskUuid(participationId)) participationDraftIssue('participation_compose_scope_required');
    return prefix + lease.subjectId + `:participation-compose:${taskId}:${participationId}`;
  }
  function checkedParticipationCompose(value, taskId, participationId) {
    if (value == null) return null;
    if (value.version !== 1 || value.taskId !== taskId || value.participationId !== participationId
      || !taskUuid(value.revision) || value.eventId != null && !taskUuid(value.eventId)
      || !value.value || typeof value.value !== 'object' || Array.isArray(value.value) || value.value.kind !== 'deliver')
      participationDraftIssue('participation_compose_invalid');
    return value;
  }
  function updateParticipationCompose(lease, taskId, participationId, change) {
    const key = participationComposeKey(lease, taskId, participationId);
    if (typeof store.update !== 'function') participationDraftIssue('local_atomic_update_unavailable');
    return taskAwait(lease, () => store.update(key, current => {
      checkOperationLease(lease); return change(checkedParticipationCompose(current, taskId, participationId));
    }));
  }
  /** @param {string} taskId @param {string} participationId @param {any} input @param {{expectedRevision?:string|null}} options */
  function saveParticipationComposeDraft(taskId, participationId, input, { expectedRevision } = {}) {
    const lease = captureTaskDraftLease(), value = structuredClone(input);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'deliver'
      || ['prepared','submission','authorization','payloadJson','signedIntent','proofJson','signature','confirmed'].some(key => Object.hasOwn(value, key)))
      participationDraftIssue('participation_compose_invalid');
    return updateParticipationCompose(lease, taskId, participationId, current => {
      if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision && !(current && equalJson(current.value, value)))
        participationDraftIssue('participation_compose_changed');
      return current && equalJson(current.value, value) ? current : {
        version: 1, taskId, participationId, revision: crypto.randomUUID(), value, eventId: null,
      };
    });
  }
  /** @param {string} taskId @param {string} participationId @param {{revision?:string}} options */
  function clearParticipationComposeDraft(taskId, participationId, { revision } = {}) {
    const lease = captureTaskDraftLease();
    return updateParticipationCompose(lease, taskId, participationId, current => revision && current?.revision !== revision ? current : null);
  }
  async function readParticipationComposeDraft(taskId, participationId) {
    const lease = captureTaskDraftLease(), key = participationComposeKey(lease, taskId, participationId);
    const draft = checkedParticipationCompose(await taskAwait(lease, () => store.get(key)), taskId, participationId);
    if (!draft) return null;
    const original = await taskAwait(lease, () => store.get(prefix + lease.subjectId + `:task-event:${taskId}`));
    const eventId = draft.eventId ?? (original?.composeRevision === draft.revision && original.participationId === participationId ? original.eventId : null);
    const accepted = eventId ? await taskAwait(lease, () => store.get(prefix + lease.subjectId + `:task-event-receipt:${eventId}`)) : null;
    if (accepted?.state === 'acknowledged' && accepted.taskId === taskId && accepted.participationId === participationId
      && accepted.composeRevision === draft.revision && accepted.eventId === eventId && /^[a-f0-9]{64}$/.test(accepted.payloadHash)) {
      const kept = await updateParticipationCompose(lease, taskId, participationId, current =>
        current?.revision === draft.revision && (current.eventId === eventId || current.eventId === null) ? null : current);
      return kept ? { ...kept, submission: kept.eventId ? 'result-unknown' : 'draft' } : null;
    }
    const history = eventId ? await taskAwait(lease, () => store.get(prefix + lease.subjectId + ':' + stoppedQueueName(taskId))) ?? [] : [];
    return { ...draft, eventId, submission: eventId ? history.some(row => row.eventId === eventId) ? 'stopped-local' : 'result-unknown' : 'draft' };
  }
  async function rememberParticipationAcknowledgement(record, receipt, lease) {
    if (!record.composeRevision) return;
    checkOperationLease(lease);
    // Only query coordinates are retained. This cannot resend a delivery or
    // grant access to the result, evidence or original work.
    await taskAwait(lease, () => store.put(prefix + lease.subjectId + `:task-event-receipt:${record.eventId}`, {
      taskId: record.taskId, participationId: record.participationId, eventId: record.eventId, payloadHash: record.payloadHash,
      composeRevision: record.composeRevision, state: 'acknowledged', checkedAt: receipt.checkedAt ?? now(), currentAccessGranted: false,
    }));
  }
  async function settleParticipationCompose(record, lease) {
    if (!record.composeRevision) return { state: 'not-recorded' };
    const kept = await updateParticipationCompose(lease, record.taskId, record.participationId, current =>
      current?.revision === record.composeRevision && (current.eventId === record.eventId || current.eventId === null) ? null : current);
    return { state: kept ? 'retained' : 'cleared' };
  }
  async function acknowledgeTaskEvent(key, record, receipt, lease) {
    await rememberParticipationAcknowledgement(record, receipt, lease);
    await updateTaskQueue(key, record, null, lease);
    const localDraftCleanup = await settleParticipationCompose(record, lease);
    return { ...receipt, ...(record.composeRevision ? { localDraftCleanup } : {}) };
  }
  function checkedParticipationReceipt(record, receipt) {
    if (record.composeRevision && (receipt.taskId !== record.taskId || receipt.eventId !== record.eventId
      || receipt.payloadHash !== record.payloadHash || !['absent','acknowledged','conflict','unknown'].includes(receipt.state)))
      participationDraftIssue('participation_receipt_mismatch');
    return receipt;
  }
  return { taskUuid,participationDraftIssue,participationComposeKey,checkedParticipationCompose,updateParticipationCompose,saveParticipationComposeDraft,clearParticipationComposeDraft,readParticipationComposeDraft,rememberParticipationAcknowledgement,settleParticipationCompose,acknowledgeTaskEvent,checkedParticipationReceipt };
}
