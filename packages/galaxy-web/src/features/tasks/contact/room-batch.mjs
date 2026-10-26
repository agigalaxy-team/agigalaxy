import { independentTaskLabel } from "../materials/task-material-client.mjs";

// Room governance continues through the existing chat operations and client lock.
export function createContactRoomBatch({ runtime, taskId, roomKey, owner, check, clone, call, read, inviteError, lock }) {
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
  return { rooms, prepareRooms, sendRooms, roomProgress, refreshRoomPlan, cancelPreparedRooms, pendingRooms: () => runtime.getLocal(roomKey) };
}
