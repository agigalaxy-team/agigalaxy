import { taskEnvelopeV2Schema } from "../../../../../galaxy-official/src/shared/task-schema-v2.mjs";
import { sha256Hex } from "../../../../../galaxy-official/src/shared/web-primitives.mjs";
const guid = (value) => /^GUID[A-Z0-9]{28}$/.test(value ?? '');

// Retains original event IDs and monotone progress in the shared local batch.
export function createContactInvitationBatch({ runtime, taskId, key, owner, check, clone, call, read, inviteError, lock }) {
  const finishedInvite = item => ['acknowledged', 'stopped-unsent', 'stopped-local'].includes(item.state);
  const sameInvite = (left, right) => left.eventId === right.eventId && left.subjectId === right.subjectId
    && left.note === right.note && left.expiresAt === right.expiresAt;
  // One IDB transaction compares the original batch and merges exact event
  // progress. A late old completion cannot replace another reviewed batch;
  // another tab's ACK cannot be downgraded by our delayed transport failure.
  async function persistInvites(batch) {
    let matched = false;
    const proposed = clone(batch);
    const stored = await runtime.updateLocal(key, current => {
      check();
      if (!current || current.batchId !== proposed.batchId) return current;
      if (current.taskId !== taskId || current.requesterId !== owner.subjectId
        || proposed.requesterId !== current.requesterId || proposed.items.length !== current.items.length
        || proposed.items.some((item, index) => !sameInvite(item, current.items[index])))
        throw inviteError('task_contact_operation_changed', '原批次对象或逐人内容已改变，请核对原操作。');
      matched = true;
      const merged = clone(current);
      merged.confirmed = current.confirmed || proposed.confirmed;
      for (let index = 0; index < merged.items.length; index++) {
        const previous = current.items[index], next = proposed.items[index];
        if (previous.payloadHash && next.payloadHash && previous.payloadHash !== next.payloadHash
          || previous.payloadJson && next.payloadJson && previous.payloadJson !== next.payloadJson)
          throw inviteError('task_contact_operation_changed', '原邀请载荷已固定，不能替换原 ID 或 hash。');
        if (previous.state === 'acknowledged' || finishedInvite(previous) && next.state !== 'acknowledged'
          || next.state === 'queued' && previous.state !== 'queued') continue;
        if (next.state === 'stopped-unsent' && (previous.state !== 'queued' || previous.payloadJson))
          throw inviteError('task_contact_operation_changed', '原邀请已准备发送，不能取消成未发送状态。');
        merged.items[index] = { ...previous, ...next,
          ...(previous.payloadHash ? { payloadHash: previous.payloadHash, payloadJson: previous.payloadJson } : {}) };
      }
      return merged;
    }, owner.subjectId);
    if (matched) {
      batch.confirmed = stored.confirmed;
      for (let index = 0; index < batch.items.length; index++) Object.assign(batch.items[index], stored.items[index]);
    }
    return matched;
  }
  async function prepareInvites(items) {
    check(); items = clone(items);
    if (
      !items.length ||
      items.length > 32 ||
      new Set(items.map((i) => i.subjectId)).size !== items.length
    )
      throw Error('请选择一至三十二个不同的联系对象。');
    const prior = await pendingBatch();
    if (
      prior?.items.some(
        (item) =>
          !['acknowledged', 'stopped-unsent', 'stopped-local'].includes(
            item.state,
          ),
      )
    )
      throw Error('请先处理原联系批次。');
    const current = await read();
    if (current.requesterId !== owner.subjectId)
      throw inviteError('task_contact_requester_required', '仅任务请求者可以准备本次邀请。');
    const itemsWithIds = items.map((item) => {
      if (
        !guid(item.subjectId) ||
        item.subjectId === current.requesterId ||
        !item.note?.trim()
      )
        throw Error('每个对象需要有效身份和本次希望获得的帮助。');
      const invite = current.contacts?.responses.invitations.find(
        (i) => i.recipientId === item.subjectId,
      );
      if (invite && !['revoked', 'expired'].includes(invite.state))
        throw Error(
          '此对象已有本任务邀请或已经婉拒，请处理原记录，不重复追发。',
        );
      return {
        eventId: crypto.randomUUID(),
        subjectId: item.subjectId,
        note: item.note.trim(),
        state: 'queued',
        expiresAt: Math.min(
          current.request.enrollmentExpiresAt,
          Math.floor(Date.now() / 1000) + 7 * 86400,
        ),
      };
    });
    const value = {
      batchId: crypto.randomUUID(),
      taskId,
      requesterId: current.requesterId,
      confirmed: false,
      items: itemsWithIds,
    };
    const stopped = await runtime.stoppedTaskOperations(taskId);
    await runtime.updateLocal(key, current => {
      check();
      if ((current?.batchId ?? null) !== (prior?.batchId ?? null)) throw Error('请先处理原联系批次。');
      if (current && (current.taskId !== taskId || current.requesterId !== owner.subjectId))
        throw inviteError('task_contact_operation_changed', '原批次主体或任务已改变，请核对原操作。');
      if (current?.items.some(item => {
        if (finishedInvite(item)) return false;
        const original = prior.items.find(previous => sameInvite(previous, item) && previous.payloadHash === item.payloadHash);
        // pending() projects explicit local stops from a body-free archive.
        // Release only that exact original event/hash, never another slot or an
        // unknown operation that has not actually been stopped by the user.
        return !original || !item.payloadHash || !stopped.some(record => record.eventId === item.eventId && record.payloadHash === item.payloadHash);
      })) throw Error('请先处理原联系批次。');
      return clone(value);
    }, owner.subjectId);
    return value;
  }
  /** @param {{confirmed?: boolean, batchId?: string}} [options] */
  async function sendInvites({ confirmed = false, batchId } = {}) {
    if (!confirmed) throw Error('请确认所选对象、逐人内容和发送范围。');
    if (typeof batchId !== 'string' || !batchId)
      throw inviteError('task_contact_batch_id_required', '请从实际显示的原批次确认发送，不能猜测当前批次。');
    return lock(async () => {
      const batch = await runtime.getLocal(key);
      if (!batch || batch.batchId !== batchId)
        throw inviteError('task_contact_batch_changed', '当前本机批次已变化，请查看并确认实际名单和逐人内容。');
      batch.confirmed = true;
      if (!await persistInvites(batch))
        throw inviteError('task_contact_batch_changed', '当前本机批次已变化，请查看并确认实际名单和逐人内容。');
      for (const item of batch.items) {
        if (
          ['acknowledged', 'stopped-unsent', 'stopped-local'].includes(
            item.state,
          )
        )
          continue;
        try {
          const stopped = (await runtime.stoppedTaskOperations(taskId)).find(
            (record) =>
              record.eventId === item.eventId &&
              record.payloadHash === item.payloadHash,
          );
          if (stopped) {
            const checked = await runtime.queryStoppedTaskOperation(
              item.eventId,
              { taskId },
            );
            item.state =
              checked.receipt.state === 'acknowledged'
                ? 'acknowledged'
                : 'stopped-local';
            item.receipt = checked.receipt;
            item.error = null;
            if (!await persistInvites(batch)) return batch;
            continue;
          }
          if (item.payloadHash) {
            const receipt = await call('/v2/tasks/receipt', {
              taskId,
              eventId: item.eventId,
              payloadHash: item.payloadHash,
            });
            if (receipt.state === 'conflict')
              throw Error('原操作标识与服务回执冲突；未创建替代邀请。');
            if (receipt.state === 'acknowledged') {
              const pending = await runtime.getLocal(`task-event:${taskId}`);
              if (pending?.eventId === item.eventId)
                await runtime.reconcileTaskEvent(taskId);
              item.state = 'acknowledged';
              item.receipt = receipt;
              item.error = null;
              if (!await persistInvites(batch)) return batch;
              continue;
            }
          }
          const pending = await runtime.getLocal(`task-event:${taskId}`);
          if (pending && pending.eventId !== item.eventId)
            throw Error('本任务另有待确认操作，请先在原操作恢复区处理。');
          if (!item.payloadJson) {
            const current = await read();
            const payload = taskEnvelopeV2Schema.parse({
              taskId,
              event: {
                eventId: item.eventId,
                kind: 'invite',
                expectedTaskVersion: current.version,
                recipientId: item.subjectId,
                note: item.note,
                expiresAt: item.expiresAt,
              },
            });
            item.payloadJson = JSON.stringify(payload);
            item.payloadHash = await sha256Hex(item.payloadJson);
            item.state = 'sending';
            if (!await persistInvites(batch)) return batch;
            if (finishedInvite(item)) continue;
          }
          const receipt = pending
            ? await runtime.reconcileTaskEvent(taskId, { retry: true, explicitRetry: true })
            : await runtime.taskEvent(
                taskId,
                JSON.parse(item.payloadJson).event,
                {
                  confirmed: true,
                  viewers: [batch.requesterId, item.subjectId],
                },
              );
          if (
            receipt.taskId !== taskId ||
            receipt.eventId !== item.eventId ||
            !Number.isSafeInteger(receipt.version)
          )
            throw Error('原操作尚未确认，请先完成原授权的恢复。');
          item.receipt = receipt;
          item.state = 'acknowledged';
          item.error = null;
          if (!await persistInvites(batch)) return batch;
        } catch (error) {
          item.state = 'result-unknown';
          item.error = error.message;
          await persistInvites(batch);
          break;
        }
      }
      return batch;
    });
  }
  async function stopUnsent(eventId) {
    return lock(async () => {
      const batch = await runtime.getLocal(key),
        item = batch?.items.find((i) => i.eventId === eventId);
      if (!item || item.payloadJson || item.state !== 'queued')
        throw Error('仅能取消尚未准备发送的对象。已发送或未知操作需要先对账。');
      item.state = 'stopped-unsent';
      if (!await persistInvites(batch))
        throw inviteError('task_contact_batch_changed', '原取消对象已不在当前批次，请重新核对。');
      return batch;
    });
  }
  async function pendingBatch() {
    const batch = await runtime.getLocal(key);
    if (!batch) return null;
    const stopped = await runtime.stoppedTaskOperations(taskId);
    for (const item of batch.items) {
      const found = stopped.find(
        (record) =>
          record.eventId === item.eventId &&
          record.payloadHash === item.payloadHash,
      );
      if (found) {
        item.state =
          found.receipt.state === 'acknowledged'
            ? 'acknowledged'
            : 'stopped-local';
        item.error = null;
      }
    }
    return batch;
  }
  return { prepareInvites, sendInvites, stopUnsent, pending: pendingBatch };
}
