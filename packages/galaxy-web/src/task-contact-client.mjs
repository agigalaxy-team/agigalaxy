import {independentTaskLabel} from './task-material-client.mjs';
import { taskEnvelopeV2Schema } from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import { sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';

const guid = (value) => /^GUID[A-Z0-9]{28}$/.test(value ?? '');
const clone = (value) => structuredClone(value);
export const contactSourceRef = (item) =>
  `galaxy:${item.type}:${item.ref.id}@${item.ref.version}`;
// Only explicit authors of currently readable facts, or the author of an
// expressed opportunity, become candidates. Request ownership is not expertise.
export function contactCandidates(pages, self) {
  const candidates = new Map();
  for (const page of pages)
    for (const item of page.items ?? []) {
      const record = item.record,
        authors =
          item.type === 'opportunity'
            ? [
                {
                  id: record.subjectId,
                  role: record.participant?.kind ?? 'unknown',
                },
              ]
            : [
                ...(record.attempts ?? []).map((a) => ({
                  id: a.actorId,
                  role: a.role ?? 'attempt',
                })),
                ...(record.interventions ?? []).map((a) => ({
                  id: a.actorId,
                  role: (a.types ?? []).join('、') || 'intervention',
                })),
                ...(record.verificationRecords ?? []).map((a) => ({
                  id: a.reportedBy,
                  role: 'verification-reporter',
                })),
                ...(record.participation ?? []).map((a) => ({
                  id: a.subjectId,
                  role: a.role,
                })),
              ];
      for (const author of authors) {
        if (!guid(author.id) || author.id === self) continue;
        const entry = candidates.get(author.id) ?? {
          subjectId: author.id,
          sources: [],
          roles: [],
          help: '',
          basis: '',
          conditions: '实际可投入时间、意愿与工作范围需要本人回应确认。',
        };
        if (
          !entry.sources.some(
            (s) => contactSourceRef(s.item) === contactSourceRef(item),
          )
        )
          entry.sources.push({ item, search: page.search });
        if (!entry.roles.includes(author.role)) entry.roles.push(author.role);
        if (item.type === 'opportunity') {
          entry.displayName = record.displayName;
          entry.willingness = '本人声明愿意就所列范围交流，仍需接受本次邀请。';
        }
        candidates.set(author.id, entry);
      }
    }
  return [...candidates.values()];
}

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
  async function search(
    task,
    {
      keyword = '',
      functions = /** @type {string[]} */ ([]),
      after = {},
      only = /** @type {string | null} */ (null),
    } = {},
  ) {
    const requests = [
      {
        type: 'history',
        query: {
          query: keyword,
          context: { taskId },
          ...(task.request.capabilityId
            ? { capabilityId: task.request.capabilityId }
            : {}),
          timeWindow: { kind: 'all-visible' },
          limit: 8,
          after: after.history ?? null,
        },
      },
    ];
    if (functions.length)
      requests.push({
        type: 'opportunity',
        query: {
          context: { kind: 'ephemeral', title: independentTaskLabel(task,'关联任务'), functions },
          purposes: ['conversation', 'collaboration'],
          limit: 8,
          after: after.opportunity ?? null,
        },
      });
    return Promise.all(
      requests
        .filter((query) => !only || query.type === only)
        .map(async (query) => {
          try {
            return {
              ...(await call('/v2/search/query', query)),
              search: query,
              error: null,
            };
          } catch (error) {
            return {
              type: query.type,
              items: [],
              search: query,
              error: error.message,
              nextCursor: null,
            };
          }
        }),
    );
  }
  async function saveSuggestions(items, { confirmed = false } = {}) {
    if (!confirmed) throw Error('请确认本次建议和依据。');
    check(); items = clone(items);
    for (const candidate of items)
      for (const source of candidate.sources ?? []) {
        const view = await call('/v2/search/reference', {
          search: source.search,
          ref: source.item.ref,
        });
        if (view.state !== 'current')
          throw Error('所选来源已经变化或不可读取，请刷新清单后重新选择。');
      }
    const current = await read();
    return runtime.taskEvent(
      taskId,
      {
        kind: 'suggest-contacts',
        expectedTaskVersion: current.version,
        state: items.length ? 'ready' : 'empty',
        items: items.map((item) => ({
          subjectId: item.subjectId,
          help: item.help,
          basis: item.basis,
          conditions: item.conditions,
          sourceRefs:
            item.sources
              ?.map((source) => contactSourceRef(source.item))
              .slice(0, 16) ??
            item.sourceRefs ??
            [],
        })),
      },
      { confirmed: true, viewers: [current.requesterId] },
    );
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
  const sameRoomValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const roomBatchChanged = () => inviteError('task_room_batch_changed', '原房间批次已改变，请重新核对当前显示的计划。');
  function displayedRoomBatch(batch, batchId) {
    if (!batchId) throw inviteError('task_room_batch_id_required', '请传入本次实际显示的房间批次标识。');
    if (!batch || batch.batchId !== batchId) throw roomBatchChanged();
    if (batch.taskId !== taskId || batch.ownerId !== owner.subjectId)
      throw inviteError('task_room_operation_changed', '原房间计划的任务或主体已改变。');
    return batch;
  }
  function checkRoomPlan(current, proposed) {
    displayedRoomBatch(current, proposed.batchId);
    if (proposed.taskId !== current.taskId || proposed.ownerId !== current.ownerId || proposed.mode !== current.mode
      || proposed.rooms.length !== current.rooms.length || proposed.rooms.some((room, index) => {
        const previous = current.rooms[index];
        return !sameRoomValue(room.input, previous.input) || !sameRoomValue(room.reviewedMembers, previous.reviewedMembers)
          || room.invitations.length !== previous.invitations.length || room.invitations.some((item, at) => {
            const prior = previous.invitations[at];
            return item.subjectId !== prior.subjectId || item.decisionId !== prior.decisionId
              || !sameRoomValue(item.history, prior.history)
              || item.input && prior.input && !sameRoomValue(item.input, prior.input);
          });
      })) throw inviteError('task_room_operation_changed', '原房间、收件人或已固定提议载荷已改变，请核对原操作。');
  }
  // Merge only this exact reviewed plan. A different tab's accepted original
  // operation is monotone; delayed completion cannot replace a newer plan.
  async function persistRooms(batch) {
    const proposed = clone(batch); let matched = false;
    const stored = await runtime.updateLocal(roomKey, current => {
      check();
      if (!current || current.batchId !== proposed.batchId) return current;
      checkRoomPlan(current, proposed); matched = true;
      const merged = clone(current);
      for (let index = 0; index < merged.rooms.length; index++) {
        const previous = current.rooms[index], next = proposed.rooms[index];
        const room = { ...previous, ...next, created: previous.created || next.created };
        room.invitations = previous.invitations.map((prior, at) => {
          const item = next.invitations[at];
          if (prior.state === 'acknowledged' || item.state === 'queued' && prior.state !== 'queued') return clone(prior);
          return { ...prior, ...item, ...(prior.input ? { input: prior.input } : {}) };
        });
        if (previous.state === 'acknowledged' || room.created && room.invitations.every(item => item.state === 'acknowledged')) {
          room.state = 'acknowledged'; room.error = null;
        } else if (previous.state === 'waiting-for-members' && next.state === 'creating') {
          room.state = previous.state; room.error = previous.error;
        }
        merged.rooms[index] = room;
      }
      return merged;
    }, owner.subjectId);
    if (matched) for (let index = 0; index < batch.rooms.length; index++) {
      const room = batch.rooms[index], invitations = room.invitations;
      Object.assign(room, stored.rooms[index]); room.invitations = invitations;
      for (let at = 0; at < invitations.length; at++) Object.assign(invitations[at], stored.rooms[index].invitations[at]);
    }
    return matched;
  }
  async function rooms(after = '') {
    await read();
    const page = await call('/v2/chat/rooms/query', { after, limit: 50 });
    return {
      rooms: page.rooms.filter((room) => room.taskRefs.includes(taskId)),
      next: page.next,
      scanned: page.rooms.length,
    };
  }
  async function prepareRooms(mode, recipients) {
    check(); recipients = [...recipients];
    if (
      !['separate', 'together'].includes(mode) ||
      !recipients.length ||
      new Set(recipients).size !== recipients.length
    )
      throw Error('请选择沟通对象及分别或共同沟通。');
    const prior = await runtime.getLocal(roomKey);
    if (prior?.rooms.some((room) => room.state !== 'acknowledged'))
      throw Error('请先处理原房间批次。');
    const task = await read(),
      ownerId = (await runtime.status()).identity?.subjectId;
    const allowed = new Set([
      ...(task.contacts?.responses.applications ?? [])
        .filter((a) => a.state === 'pending')
        .map((a) => a.subjectId),
      ...(task.contacts?.responses.invitations ?? [])
        .filter((i) => i.state === 'interested')
        .map((i) => i.recipientId),
      ...(task.participations ?? [])
        .filter((p) =>
          ['active', 'delivered', 'accepted', 'disputed'].includes(p.state),
        )
        .map((p) => p.subjectId),
    ]);
    if (
      (task.participations ?? []).some(
        (p) =>
          p.subjectId === ownerId &&
          ['active', 'delivered', 'accepted', 'disputed'].includes(p.state),
      )
    )
      allowed.add(task.requesterId);
    if (recipients.some((id) => !allowed.has(id) || id === ownerId))
      throw Error('请刷新后选择已实际回应愿意了解、申请或正在参与的对象。');
    const groups =
      mode === 'together' ? [recipients] : recipients.map((id) => [id]);
    const batch = {
      batchId: crypto.randomUUID(),
      taskId,
      ownerId,
      mode,
      rooms: groups.map((group) => ({
        input: {
          roomId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          title: independentTaskLabel(task,'关联任务'),
          taskRefs: [taskId],
          retentionDays: 90,
        },
        reviewedMembers: [ownerId],
        state: 'queued',
        invitations: group.map((subjectId) => ({
          subjectId,
          decisionId: crypto.randomUUID(),
          state: 'queued',
        })),
      })),
    };
    return runtime.updateLocal(roomKey, current => {
      check();
      if ((current?.batchId ?? null) !== (prior?.batchId ?? null)
        || current?.rooms.some(room => room.state !== 'acknowledged')) throw Error('请先处理原房间批次。');
      if (current) displayedRoomBatch(current, prior.batchId);
      if (ownerId !== owner.subjectId) throw Error('当前身份已变化。');
      return clone(batch);
    }, owner.subjectId);
  }
  /** @param {{confirmed?: boolean, batchId?: string}} [options] */
  async function sendRooms({ confirmed = false, batchId } = {}) {
    if (!confirmed) throw Error('请确认本次沟通方式及逐人邀请。');
    return lock(async () => {
      const batch = displayedRoomBatch(await runtime.getLocal(roomKey), batchId);
      if (!await persistRooms(batch)) throw roomBatchChanged();
      for (const room of batch.rooms) {
        if (room.state === 'acknowledged') continue;
        try {
          if (!room.created) {
            const pending = await runtime.chat.pending(null);
            if (
              pending &&
              (pending.input.operationId !== room.input.operationId ||
                pending.input.roomId !== room.input.roomId)
            )
              throw Error('另有普通房间创建操作待确认，请先恢复它。');
            room.state = 'creating';
            if (!await persistRooms(batch)) return batch;
            const created = pending
              ? await runtime.chat.retry(null, { confirmed: true })
              : await runtime.chat.create(room.input, { confirmed: true });
            if (created.roomId !== room.input.roomId)
              throw Error('房间回执标识不一致。');
            room.created = true;
            if (!await persistRooms(batch)) return batch;
          }
          const path = `/v2/chat/rooms/${room.input.roomId}`;
          for (const invitation of room.invitations) {
            if (invitation.state === 'acknowledged') continue;
            const choices = await call(path + '/decisions', {}),
              prior = choices.decisions.find(
                (d) => d.decisionId === invitation.decisionId,
              );
            if (prior) {
              if (
                !invitation.input ||
                [
                  'decisionId',
                  'expectedRevision',
                  'action',
                  'targetSubjectId',
                ].some(
                  (field) => prior.payload[field] !== invitation.input[field],
                )
              )
                throw Error('房间提议的原标识与载荷不一致。');
              const pending = await runtime.chat.pending(room.input.roomId);
              if (pending?.input.decisionId === invitation.decisionId)
                await runtime.chat.retry(room.input.roomId, {
                  confirmed: true,
                });
              invitation.state = 'acknowledged';
              invitation.receipt = {
                decisionId: prior.decisionId,
                state: prior.state,
              };
              if (!await persistRooms(batch)) return batch;
              continue;
            }
            const pending = await runtime.chat.pending(room.input.roomId);
            if (pending && pending.input.decisionId !== invitation.decisionId)
              throw Error('房间另有待确认操作。请先在房间恢复原操作。');
            if (!invitation.input) {
              const current = await call(path + '/read', {});
              // Existing room governance fixes each decision to its member
              // revision. Do not send parallel stale invitations and then spend
              // another recipient cooldown to replace them after the first join.
              const waiting = room.invitations.some(
                (other) =>
                  other !== invitation &&
                  other.state === 'acknowledged' &&
                  !current.members.some(
                    (member) => member.subjectId === other.subjectId,
                  ) &&
                  choices.decisions.some(
                    (decision) =>
                      decision.decisionId === other.decisionId &&
                      ['pending', 'approved'].includes(decision.state),
                  ),
              );
              if (waiting) {
                room.state = 'waiting-for-members';
                room.error = null;
                if (!await persistRooms(batch)) return batch;
                return batch;
              }
              if (
                current.members
                  .map((m) => m.subjectId)
                  .sort((left,right)=>left<right?-1:left>right?1:0)
                  .join(',') !== [...room.reviewedMembers].sort((left,right)=>left<right?-1:left>right?1:0).join(',')
              )
                throw Error(
                  '房间成员已变化。请先检查当前成员，再为未加入者预览新的共同决定。',
                );
              invitation.input = {
                decisionId: invitation.decisionId,
                expectedRevision: current.revision,
                action: 'invite',
                targetSubjectId: invitation.subjectId,
              };
              invitation.state = 'sending';
              if (!await persistRooms(batch)) return batch;
            }
            invitation.state = 'sending';
            if (!await persistRooms(batch)) return batch;
            const receipt = pending
              ? await runtime.chat.retry(room.input.roomId, { confirmed: true })
              : await runtime.chat.propose(
                  room.input.roomId,
                  invitation.input,
                  { confirmed: true },
                );
            invitation.state = 'acknowledged';
            invitation.receipt = receipt;
            if (!await persistRooms(batch)) return batch;
          }
          room.state = 'acknowledged';
          room.error = null;
          if (!await persistRooms(batch)) return batch;
        } catch (error) {
          room.state = 'result-unknown';
          room.error = error.message;
          if (!await persistRooms(batch)) return batch;
          break;
        }
      }
      return batch;
    });
  }
  /** @param {{batchId?: string}} [options] */
  async function cancelPreparedRooms({ batchId } = {}) {
    return lock(async () => {
      const batch = displayedRoomBatch(await runtime.getLocal(roomKey), batchId);
      if (
        !batch ||
        batch.rooms.some(
          (room) =>
            room.created ||
            room.state !== 'queued' ||
            room.invitations.some(
              (invitation) => invitation.state !== 'queued' || invitation.input,
            ),
        )
      )
        throw Error(
          '只能取消完全未发送的房间预览。已经创建的房间或未知操作需要先在原房间核对。',
        );
      if (runtime.api.snapshot()?.subjectId !== batch.ownerId)
        throw Error('当前身份已变化。');
      await runtime.updateLocal(roomKey, current => {
        check(); displayedRoomBatch(current, batchId);
        if (!sameRoomValue(current, batch)) throw roomBatchChanged();
        return null;
      }, owner.subjectId);
      return null;
    });
  }
  async function roomProgress() {
    const batch = await runtime.getLocal(roomKey);
    if (!batch) return [];
    return Promise.all(
      batch.rooms
        .filter((room) => room.created)
        .map(async (room) => {
          const path = `/v2/chat/rooms/${room.input.roomId}`;
          try {
            const [current, choices] = await Promise.all([
              call(path + '/read', {}),
              call(path + '/decisions', {}),
            ]);
            return {
              roomId: current.roomId,
              current,
              invitations: room.invitations.map((invitation) => {
                const decision = choices.decisions.find(
                  (d) => d.decisionId === invitation.decisionId,
                );
                const joined = current.members.some(
                  (m) => m.subjectId === invitation.subjectId,
                );
                return {
                  subjectId: invitation.subjectId,
                  joined,
                  state: joined
                    ? 'joined'
                    : !decision
                      ? 'not-visible-in-decision-page'
                      : decision.state === 'approved' &&
                          decision.memberRevision !== current.memberRevision
                        ? 'members-changed'
                        : decision.state,
                };
              }),
            };
          } catch {
            return { roomId: room.input.roomId, unavailable: true };
          }
        }),
    );
  }
  async function refreshRoomPlan(roomId) {
    return lock(async () => {
      const batch = await runtime.getLocal(roomKey),
        room = batch?.rooms.find((r) => r.input.roomId === roomId);
      if (!room?.created) throw Error('请先核对这个房间的创建回执。');
      displayedRoomBatch(batch, batch.batchId);
      const original = clone(batch);
      if (batch.rooms.some(item => ['creating', 'result-unknown'].includes(item.state)
        || item.invitations.some(invitation => invitation.state === 'sending')))
        throw Error('房间还有原操作待核对，不能刷新替换未知操作。');
      const pending = await runtime.chat.pending(roomId);
      if (pending)
        throw Error('房间还有原操作待核对，请先在房间恢复，不能替换未知操作。');
      const [current, choices] = await Promise.all([
        call(`/v2/chat/rooms/${roomId}/read`, {}),
        call(`/v2/chat/rooms/${roomId}/decisions`, {}),
      ]);
      let count = 0;
      for (const invitation of room.invitations) {
        const prior = choices.decisions.find(
          (d) => d.decisionId === invitation.decisionId,
        );
        if (
          current.members.some((m) => m.subjectId === invitation.subjectId) ||
          prior?.state === 'rejected'
        )
          continue;
        if (
          prior &&
          ['pending', 'approved'].includes(prior.state) &&
          prior.memberRevision === current.memberRevision
        )
          continue;
        if (invitation.input && !prior)
          throw Error(
            '原提议不在当前决定页，不能由缺失推断不存在。请先恢复原操作。',
          );
        if (prior) {
          invitation.history = [
            ...(invitation.history ?? []),
            {
              decisionId: invitation.decisionId,
              input: invitation.input ?? null,
              receipt: invitation.receipt ?? null,
            },
          ];
          invitation.decisionId = crypto.randomUUID();
        }
        invitation.state = 'queued';
        invitation.receipt = null;
        invitation.input = {
          decisionId: invitation.decisionId,
          expectedRevision: current.revision,
          action: 'invite',
          targetSubjectId: invitation.subjectId,
        };
        count++;
      }
      if (!count)
        throw Error(
          '当前没有需要重新提出的未加入对象；已有有效提议继续等待，婉拒不自动追发。',
        );
      room.reviewedMembers = current.members.map((m) => m.subjectId);
      room.state = 'queued';
      room.error = null;
      batch.batchId = crypto.randomUUID();
      return runtime.updateLocal(roomKey, stored => {
        check(); displayedRoomBatch(stored, original.batchId);
        if (!sameRoomValue(stored, original)) throw roomBatchChanged();
        return clone(batch);
      }, owner.subjectId);
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
  const methods = {
    search,
    saveSuggestions,
    prepareInvites,
    sendInvites,
    stopUnsent,
    rooms,
    prepareRooms,
    sendRooms,
    roomProgress,
    refreshRoomPlan,
    cancelPreparedRooms,
    pending: pendingBatch,
    pendingRooms: () => runtime.getLocal(roomKey),
  };
  /** @typedef {{[K in keyof typeof methods]: (...args: Parameters<(typeof methods)[K]>) => Promise<Awaited<ReturnType<(typeof methods)[K]>>>}} GuardedMethods */
  return Object.freeze({ close() { closed = true; }, .../** @type {GuardedMethods} */ (Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, (...args) => guarded(() => fn(...args))]))) });
}
