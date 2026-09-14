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
          conditions: '当前时间、意愿和报价需要本人回应确认。',
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

export function createTaskContactClient(runtime, taskId) {
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
  const save = (k, value) => {
    if (
      runtime.api.snapshot()?.subjectId !== (value.ownerId ?? value.requesterId)
    )
      throw Error('当前身份已变化，原批次保留在原身份本机空间。');
    return runtime.putLocal(k, clone(value));
  };
  const lock = async (operation) => {
    if (working) throw Error('请等待当前批次操作完成。');
    working = true;
    try {
      return await operation();
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
          context: { kind: 'ephemeral', title: task.request.title, functions },
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
    await save(key, value);
    return value;
  }
  async function sendInvites({ confirmed = false } = {}) {
    if (!confirmed) throw Error('请确认所选对象、逐人内容和发送范围。');
    return lock(async () => {
      const batch = await runtime.getLocal(key);
      if (!batch) throw Error('没有待发送批次。');
      batch.confirmed = true;
      await save(key, batch);
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
            await save(key, batch);
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
              await save(key, batch);
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
            await save(key, batch);
          }
          const receipt = pending
            ? await runtime.reconcileTaskEvent(taskId, { retry: true })
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
          await save(key, batch);
        } catch (error) {
          item.state = 'result-unknown';
          item.error = error.message;
          await save(key, batch);
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
      await save(key, batch);
      return batch;
    });
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
          title: task.request.title,
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
    await save(roomKey, batch);
    return batch;
  }
  async function sendRooms({ confirmed = false } = {}) {
    if (!confirmed) throw Error('请确认本次沟通方式及逐人邀请。');
    return lock(async () => {
      const batch = await runtime.getLocal(roomKey);
      if (!batch) throw Error('没有房间批次。');
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
            await save(roomKey, batch);
            const created = pending
              ? await runtime.chat.retry(null, { confirmed: true })
              : await runtime.chat.create(room.input, { confirmed: true });
            if (created.roomId !== room.input.roomId)
              throw Error('房间回执标识不一致。');
            room.created = true;
            await save(roomKey, batch);
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
              await save(roomKey, batch);
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
                await save(roomKey, batch);
                return batch;
              }
              if (
                current.members
                  .map((m) => m.subjectId)
                  .sort()
                  .join(',') !== [...room.reviewedMembers].sort().join(',')
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
              await save(roomKey, batch);
            }
            invitation.state = 'sending';
            await save(roomKey, batch);
            const receipt = pending
              ? await runtime.chat.retry(room.input.roomId, { confirmed: true })
              : await runtime.chat.propose(
                  room.input.roomId,
                  invitation.input,
                  { confirmed: true },
                );
            invitation.state = 'acknowledged';
            invitation.receipt = receipt;
            await save(roomKey, batch);
          }
          room.state = 'acknowledged';
          room.error = null;
          await save(roomKey, batch);
        } catch (error) {
          room.state = 'result-unknown';
          room.error = error.message;
          await save(roomKey, batch);
          break;
        }
      }
      return batch;
    });
  }
  async function cancelPreparedRooms() {
    return lock(async () => {
      const batch = await runtime.getLocal(roomKey);
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
      await runtime.putLocal(roomKey, null);
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
      await save(roomKey, batch);
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
  return {
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
}
