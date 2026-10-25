import {taskRequestV2Schema,taskEnvelopeV2Schema,participationProposalV2Schema,participationEventV2Schema} from "../../../galaxy-official/src/shared/task-schema-v2.mjs";
import {equalJson,sha256Hex} from "../../../galaxy-official/src/shared/web-primitives.mjs";
import {normalizeForumOrigin} from "../community-forum-origin.mjs";
import {taskLocalDraftView} from "../task-local-draft-client.mjs";
import {createTaskMaterialClient} from "../task-material-client.mjs";
import {taskMaterialBodySchema,taskMaterialSubmissionSchema,hasTaskMaterials} from "../../../galaxy-official/src/shared/task-material-v1-schema.mjs";

// Per-runtime task journals and once-only flows. The identity getters remain live
// across every await; neither a copied identity nor a new authority is created.
export function createWebTaskOperations({api,prefix,store,captureTaskDraftLease,now,taskDraftScope,receiptStatus,localKey,agentContinuity,createTaskDraftClient,config,runtimeState}){
  function taskLease() {
    const connection = api.snapshot();
    if (runtimeState.closed || !connection || !runtimeState.active) throw new Error('请连接当前身份并重新核对本次任务操作。');
    return { owner: runtimeState.active, subjectId: connection.subjectId, endpoint: connection.endpoint, bindingId: connection.bindingId, generation: connection.generation };
  }
  function checkTaskLease(lease) {
    const connection = api.snapshot();
    if (runtimeState.closed || runtimeState.active !== lease.owner || !connection || ['subjectId', 'endpoint', 'bindingId', 'generation'].some(key => connection[key] !== lease[key]))
      throw new Error('身份或连接已改变，原任务操作已保留，请重新核对后继续。');
  }
  const checkOperationLease = lease => typeof lease.assertCurrent === 'function' ? lease.assertCurrent() : checkTaskLease(lease);
  async function taskAwait(lease, action) {
    checkOperationLease(lease); let result;
    try { result = await action(); } catch (error) { checkOperationLease(lease); throw error; }
    checkOperationLease(lease); return result;
  }
  let taskQueueTail = Promise.resolve();
  const taskStopListeners = new Set();
  const onTaskOperationStopped = callback => { taskStopListeners.add(callback); return () => { taskStopListeners.delete(callback); }; };
  const withTaskQueue = fn => { const operation = taskQueueTail.then(fn); taskQueueTail = operation.catch(() => {}); return operation; };
  const sameTaskOperation = (left, right) => left && right && left.payloadHash === right.payloadHash
    && (left.eventId ?? left.payload?.operationId) === (right.eventId ?? right.payload?.operationId);
  const taskQueueName = taskId => taskId ? `task-event:${taskId}` : 'task-publication';
  const stoppedQueueName = taskId => `task-stopped-operations:${taskId ?? 'publication'}`;
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
  function preserveTaskQueue(current,next) {
    if(next===null)return null;
    const value=structuredClone(next),erased=[...new Set([...(current.materialErasedIds??[]),...(value.materialErasedIds??[])])];
    if(erased.length){value.materialErasedIds=erased;value.materialBodies=(value.materialBodies??[]).filter(body=>!erased.includes(body.materialId));}
    if(current.automaticRetryBlock)value.automaticRetryBlock=current.automaticRetryBlock;
    return value;
  }
  async function updateTaskQueue(key, operation, next, lease = null) {
    return withTaskQueue(async () => {
      if(typeof store.update==='function'){
        let matched=false;
        const update=()=>store.update(key,current=>{
          if(lease)checkOperationLease(lease);
          if(!sameTaskOperation(current,operation)){
            if(next===null)return current;
            throw new Error('原操作已停止本机重试或队列已改变；不会重新放回发送队列。');
          }
          matched=true;return preserveTaskQueue(current,next);
        });
        if(lease)await taskAwait(lease,update);else await update();return matched;
      }
      const current = lease ? await taskAwait(lease, () => store.get(key)) : await store.get(key);
      if (!sameTaskOperation(current, operation)) {
        if (next === null) return false;
        throw new Error('原操作已停止本机重试或队列已改变；不会重新放回发送队列。');
      }
      const preserved = preserveTaskQueue(current,next);
      if (lease) await taskAwait(lease, () => store.put(key, preserved)); else await store.put(key, preserved);
      return true;
    });
  }
  function materialClientFor(lease) {
    return createTaskMaterialClient({ api, taskDraftScope, receiptStatus }, { subjectId: lease.subjectId, now });
  }
  async function currentPublicationMaterials(record, lease, { rebuild = false, requireAvailable = false } = {}) {
    if (!record || !hasTaskMaterials(record.payload)) return record;
    checkOperationLease(lease);
    const client = materialClientFor(lease), key = prefix + lease.subjectId + ':task-publication';
    try {
      const result = await taskAwait(lease, () => client.verifySubmission(record.payload, record.materialBodies ?? [], { rebuild }));
      let current = record;
      if (result.changed || result.erased.length) {
        if (typeof store.update !== 'function') throw new Error('local_atomic_update_unavailable');
        current = await taskAwait(lease, () => store.update(key, previous => {
          checkOperationLease(lease);
          if (!sameTaskOperation(previous, record)) throw new Error('原发布队列已变化，请重新核对。');
          const erased = [...new Set([...(previous.materialErasedIds ?? []), ...result.erased])];
          const bodies = (previous.materialBodies ?? []).filter(body => !erased.includes(body.materialId));
          for (const body of result.value.materialBodies) if (!erased.includes(body.materialId) && !bodies.some(item => item.materialId === body.materialId)) bodies.push(body);
          const next = { ...previous, materialBodies: bodies, materialErasedIds: erased };
          if (next.submission?.materialBodies) { next.submission = { ...next.submission }; delete next.submission.materialBodies; }
          return next;
        }));
      }
      if (requireAvailable && (!result.allowed || (current.materialErasedIds ?? []).some(id => record.payload.materials.some(material => material.materialId === id))))
        throw Object.assign(new Error('原发布材料当前不可用或编辑文字已清理。可以继续查询原回执，或明确停止本机重试；不会替换原内容、编号或期限。'), { code: 'task_material_unavailable' });
      return { ...current, materialBodies: result.view.materialBodies.filter(body => !(current.materialErasedIds ?? []).includes(body.materialId)), materialStates: result.states };
    } finally { client.close(); }
  }
  async function readTaskPublication(originalSubjectId) {
    const lease = captureTaskDraftLease(), owner = originalSubjectId ?? lease.subjectId ?? 'visitor';
    if (owner !== (lease.subjectId ?? 'visitor')) throw new Error('本机发布记录不属于当前身份。');
    const record = await taskAwait(lease, () => store.get(prefix + owner + ':task-publication'));
    return currentPublicationMaterials(record, lease);
  }
  function taskBusinessRejected(record) {
    const publication = !!record.payload, block = record.automaticRetryBlock;
    return Object.assign(new Error('服务未接受上次内容，已停止自动发送。原内容仍保留。'), {
      code: publication ? 'publication_business_rejected' : 'task_operation_business_rejected',
      reason: block.code, status: block.status, rejectedAt: block.rejectedAt,
      ...(block.retryAt ? { retryAt: block.retryAt } : {}),
    });
  }
  const isTaskBusinessRejection = error => error?.outcome === 'rejected'
    && Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    && ![401, 408, 429].includes(error.status)
    && !['unauthorized', 'binding_revoked', 'invalid_session', 'session_expired', 'access_denied'].includes(error.code);
  async function changeTaskDispatch(key, record, lease, change) {
    return withTaskQueue(async () => {
      const update = current => {
        checkOperationLease(lease);
        if (!sameTaskOperation(current, record)) throw new Error('原操作已停止本机重试或队列已改变；不会重新放回发送队列。');
        return change(current);
      };
      if (typeof store.update === 'function') return taskAwait(lease, () => store.update(key, update));
      const current = await taskAwait(lease, () => store.get(key)), next = update(current);
      await taskAwait(lease, () => store.put(key, next)); return next;
    });
  }
  async function dispatchTaskBusiness(key, record, lease, path, { explicitRetry = false } = {}) {
    // Check the persisted slot at the send boundary too: another page may have
    // received a definite rejection after this page read the original journal.
    const sending = await changeTaskDispatch(key, record, lease, current => {
      if (current.automaticRetryBlock && (!explicitRetry
        || current.automaticRetryBlock.retryAt && Date.parse(current.automaticRetryBlock.retryAt) > now() * 1000))
        throw taskBusinessRejected(current);
      const next = { ...current, state: 'result-unknown' }; delete next.automaticRetryBlock; return next;
    });
    try {
      const current=sending.payload&&hasTaskMaterials(sending.payload)?await currentPublicationMaterials(sending,lease,{rebuild:true,requireAvailable:true}):sending;
      const submission=current.payload&&hasTaskMaterials(current.payload)?taskMaterialSubmissionSchema.parse({...current.submission,materialBodies:current.materialBodies}):current.submission;
      return await taskAwait(lease, () => api.call(path, submission));
    }
    catch (error) {
      // HTTP 5xx, timeouts and network failures cannot prove non-acceptance.
      // They keep the existing unknown-result automatic continuation.
      if (isTaskBusinessRejection(error)) await changeTaskDispatch(key, sending, lease, current => ({ ...current,
        state: 'business-rejected', automaticRetryBlock: {
          code: error.code, status: error.status, rejectedAt: now(),
          ...(typeof error.retryAt === 'string' && Number.isFinite(Date.parse(error.retryAt)) ? { retryAt: error.retryAt } : {}),
        },
      }));
      throw error;
    }
  }
  const continuedTaskReceipt = (receipt, payloadHash) => ({ ...receipt,
    ...(receipt.state && receipt.state !== 'acknowledged' ? { businessState: receipt.state } : {}),
    ...(payloadHash ? { payloadHash } : {}), state: 'acknowledged' });
  const minimalTaskReceipt = receipt => ({ state: receipt.state, checkedAt: receipt.checkedAt ?? now(),
    ...(Number.isSafeInteger(receipt.version) ? { version: receipt.version } : {}),
    ...(Number.isSafeInteger(receipt.participationVersion) ? { participationVersion: receipt.participationVersion } : {}) });
  /** @param {string|null} taskId */
  async function reviewTaskStop(taskId = null) {
    const publicationLease = taskId === null ? captureTaskDraftLease() : null;
    const eventLease = taskId === null ? null : taskLease();
    const key = localKey(taskQueueName(taskId)), record = await store.get(key);
    publicationLease?.assertCurrent();
    if (eventLease) checkTaskLease(eventLease);
    if (!record) return { state: 'none' };
    const payload = JSON.parse(record.payloadJson), ref = { taskId: taskId ?? payload.taskId,
      eventId: record.eventId ?? payload.operationId, payloadHash: record.payloadHash };
    let receipt;
    try { receipt = await api.call('/v2/tasks/receipt', ref); }
    catch { receipt = { ...ref, state: 'unknown', checkedAt: now() }; }
    publicationLease?.assertCurrent();
    if (eventLease) checkTaskLease(eventLease);
    checkedParticipationReceipt(record, receipt);
    if (receipt.state === 'acknowledged') {
      if (publicationLease) return acknowledgePublication(key, record, receipt, publicationLease);
      return acknowledgeTaskEvent(key, record, receipt, eventLease);
    }
    return { ...ref, state: 'stop-local-preview', kind: payload.event?.kind ?? payload.kind ?? 'publish-task',
      receipt: minimalTaskReceipt(receipt), serverCancellationConfirmed: false };
  }
  /** @param {{taskId:string,eventId:string,payloadHash:string}} preview
   * @param {{taskId?:string|null,confirmed?:boolean}} options */
  async function stopTaskOperation(preview, { taskId = null, confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认仅停止本机重试；这不是服务端取消或撤回。');
    const publicationLease = taskId === null ? captureTaskDraftLease() : null;
    const key = localKey(taskQueueName(taskId)), historyKey = localKey(stoppedQueueName(taskId)), owner = runtimeState.active;
    const current = await reviewTaskStop(taskId);
    publicationLease?.assertCurrent();
    if (current.state === 'none' || current.state === 'acknowledged') return current;
    if (owner !== runtimeState.active || current.eventId !== preview?.eventId || current.payloadHash !== preview?.payloadHash || current.taskId !== preview?.taskId)
      throw new Error('原操作或身份已经变化，请重新核对停止预览。');
    return withTaskQueue(async () => {
      publicationLease?.assertCurrent();
      if (owner !== runtimeState.active) throw new Error('身份已变化，请在原身份停止原操作。');
      const record = await store.get(key);
      publicationLease?.assertCurrent();
      if (!record || (record.eventId ?? record.payload?.operationId) !== current.eventId || record.payloadHash !== current.payloadHash)
        throw new Error('原发送队列已经变化，请重新核对。');
      const prior = await store.get(historyKey) ?? [];
      publicationLease?.assertCurrent();
      const stopped = { taskId: current.taskId, eventId: current.eventId, payloadHash: current.payloadHash,
        kind: current.kind, state: 'stopped-local', stoppedAt: now(), receipt: current.receipt,
        consentId: record.submission?.consentId ?? record.preparedConsent?.intent.id ?? null,
        serverCancellationConfirmed: false,
        ...(record.composeRevision ? { composeRevision: record.composeRevision, participationId: record.participationId } : {}),
        ...(publicationLease && record.draftHead ? { draftHead: structuredClone(record.draftHead) } : {}) };
      // Archive the minimum exact query identity before releasing the queue.
      // This archive has no signed payload and can never drive a retry.
      await store.put(historyKey, [...prior.filter(item => item.eventId !== stopped.eventId), stopped]);
      publicationLease?.assertCurrent();
      await store.put(key, null);
      publicationLease?.assertCurrent();
      for (const callback of taskStopListeners) { try { callback({ ...stopped, scopeTaskId: taskId }); } catch {} }
      return stopped;
    });
  }
  /** @param {string|null} taskId */
  async function stoppedTaskOperations(taskId = null) { return await store.get(localKey(stoppedQueueName(taskId))) ?? []; }
  /** @param {string} eventId @param {{taskId?:string|null}} options */
  async function queryStoppedTaskOperation(eventId, { taskId = null } = {}) {
    const publicationLease = taskId === null ? captureTaskDraftLease() : null;
    const eventLease = taskId === null ? null : taskLease();
    const key = localKey(stoppedQueueName(taskId)), owner = runtimeState.active;
    const record = (await store.get(key) ?? []).find(item => item.eventId === eventId);
    publicationLease?.assertCurrent();
    if (eventLease) checkTaskLease(eventLease);
    if (!record) throw new Error('没有本机保存的这个原操作。');
    let receipt;
    try { receipt = await api.call('/v2/tasks/receipt', { taskId: record.taskId, eventId, payloadHash: record.payloadHash }); }
    catch { receipt = { taskId: record.taskId, eventId, payloadHash: record.payloadHash, state: 'unknown', checkedAt: now() }; }
    publicationLease?.assertCurrent();
    if (eventLease) checkTaskLease(eventLease);
    checkedParticipationReceipt(record, receipt);
    if (owner !== runtimeState.active) throw new Error('身份已变化，请在原身份查询。');
    return withTaskQueue(async () => {
      publicationLease?.assertCurrent();
      if (eventLease) checkTaskLease(eventLease);
      const history = await store.get(key) ?? [], index = history.findIndex(item => item.eventId === eventId);
      publicationLease?.assertCurrent();
      if (index < 0 || history[index].payloadHash !== record.payloadHash) throw new Error('原查询记录已变化。');
      history[index] = { ...history[index], receipt: minimalTaskReceipt(receipt) };
      await store.put(key, history); publicationLease?.assertCurrent();
      if (eventLease) checkTaskLease(eventLease);
      if (eventLease && receipt.state === 'acknowledged') await rememberParticipationAcknowledgement(record, receipt, eventLease);
      const localDraftCleanup = publicationLease && receipt.state === 'acknowledged'
        ? await clearAcknowledgedTaskDraft(record, publicationLease) : eventLease && receipt.state === 'acknowledged'
          ? await settleParticipationCompose(record, eventLease) : null;
      return { ...history[index], ...(localDraftCleanup ? { localDraftCleanup } : {}) };
    });
  }
  /** @param {unknown} draft
   * @param {{confirmed?:boolean,forumOrigin?:{postId:string,versionId:string,returnTo:string}|null,draftHead?:{id:string,revision:number}|null,materialBodies?:{materialId:string,text:string}[],assertCurrent?:(()=>unknown)|null}} [options] */
  async function publishTask(draft, { confirmed = false, forumOrigin = null, draftHead = null, materialBodies = [], assertCurrent = null } = {}) {
    if (!confirmed) throw new Error('请确认发布内容和可见范围。');
    const selectedForumOrigin = forumOrigin === null ? null : normalizeForumOrigin(forumOrigin);
    if (forumOrigin !== null && !selectedForumOrigin) throw new Error('原帖子返回位置不完整，请重新核对。');
    const lease = taskLease(), selectedDraft = structuredClone(draft), selectedBodies = materialBodies.map(body => taskMaterialBodySchema.parse(body)), key = prefix + lease.subjectId + ':task-publication';
    const guard = () => { checkTaskLease(lease); if (assertCurrent) { const result = assertCurrent(); if (result?.then) throw new Error('task_publication_guard_must_be_synchronous'); } };
    const selectedHead = draftHead === null ? null : taskLocalDraftView({ format: 'galaxy-task-local-draft', version: 1,
      head: draftHead, value: {} }).head;
    const operation = await withTaskQueue(async () => {
      if (await taskAwait(lease, () => store.get(key))) throw Object.assign(new Error('请先查询上一次发布的结果。'), { code: 'pending_task_publication' });
      guard(); await taskAwait(lease, () => agentContinuity.requireCurrent()); guard();
      if (hasTaskMaterials(selectedDraft)) {
        const client = materialClientFor(lease);
        try { const checked = await taskAwait(lease, () => client.verifySubmission(selectedDraft, selectedBodies)); guard();
          if (!checked.allowed) throw Object.assign(new Error('选定材料当前不可用，请重新核对原稿后发布。'), { code: 'task_material_unavailable' });
        } finally { client.close(); }
      } else if (selectedBodies.length) throw new Error('未关联的材料不能随任务发布。');
      const payload = taskRequestV2Schema.parse({ ...selectedDraft, taskId: crypto.randomUUID(), operationId: crypto.randomUUID() });
      const payloadJson = JSON.stringify(payload);
      const prepared = { payload, payloadJson, payloadHash: await taskAwait(lease, () => sha256Hex(payloadJson)), state: 'prepared', authorizationExpiresAt: now() + 2591900, authorizationBindingId:lease.bindingId,
        ...(hasTaskMaterials(payload) ? { materialBodies: selectedBodies } : {}),
        ...(selectedForumOrigin ? { forumOrigin: selectedForumOrigin } : {}),
        ...(selectedHead ? { draftHead: { id: selectedHead.id, revision: selectedHead.revision } } : {}) };
      guard();
      if (selectedHead) {
        const current = taskLocalDraftView(await taskAwait(lease, () => store.get(prefix + lease.subjectId + ':task-draft'))); guard();
        if (!current?.head || current.head.id !== selectedHead.id || current.head.revision !== selectedHead.revision)
          throw Object.assign(new Error('发布前原稿已在另一页面改变，请重新预览。'), { code: 'task_draft_conflict' });
      }
      if (typeof store.update === 'function') await taskAwait(lease, () => store.update(key, current => { guard(); if (current) throw Object.assign(new Error('请先查询上一次发布的结果。'), { code: 'pending_task_publication' }); return prepared; }));
      else { guard(); await taskAwait(lease, () => store.put(key, prepared)); }
      return prepared;
    });
    return submitPublication(operation, lease);
  }
  async function clearAcknowledgedTaskDraft(record, lease) {
    if (!record.draftHead) return { state: 'not-recorded' };
    checkOperationLease(lease);
    let client;
    try {
      client = createTaskDraftClient();
      const cleared = await client.clear(record.draftHead);
      checkOperationLease(lease); return { state: cleared ? 'cleared' : 'retained' };
    } catch (error) {
      checkOperationLease(lease);
      return { state: 'failed', message: error.message };
    } finally { client?.close(); }
  }
  async function acknowledgePublication(key, operation, receipt, lease) {
    // Save body-free original query coordinates before releasing the queue. If
    // close/reconnect wins while null is persisted, the next explicit query can
    // still reconcile this exact acceptance without creating a replacement ID.
    const ref = { taskId: operation.payload.taskId, eventId: operation.payload.operationId, payloadHash: operation.payloadHash,
      ...(operation.draftHead ? { draftHead: structuredClone(operation.draftHead) } : {}) };
    await taskAwait(lease, () => store.put(key + '-receipt', ref));
    await updateTaskQueue(key, operation, null, lease);
    const localDraftCleanup = await clearAcknowledgedTaskDraft(operation, lease);
    return { ...receipt, localDraftCleanup };
  }
  async function submitPublication(operation, lease = taskLease(), { explicitRetry = false } = {}) {
    checkTaskLease(lease);
    await taskAwait(lease, () => agentContinuity.requireCurrent());
    const key = prefix + lease.subjectId + ':task-publication';
    const materialBearing=hasTaskMaterials(operation.payload);
    if(materialBearing)operation=await currentPublicationMaterials(operation,lease,{rebuild:true,requireAvailable:true});
    if (operation.forumOrigin) {
      const origin = normalizeForumOrigin(operation.forumOrigin);
      if (!origin || typeof store.update !== 'function') throw new Error('当前本机存储不能安全接续原帖子位置。');
      const record = { version: 1, ownerId: lease.subjectId, endpoint: config.endpoint, taskId: operation.payload.taskId,
        operationId: operation.payload.operationId, payloadHash: operation.payloadHash, origin };
      // This locator belongs to this actual generated Task operation, not to a
      // content hash that another otherwise identical Task could share.
      await taskAwait(lease, () => store.update(prefix + lease.subjectId + ':community-forum-task-origin:' + operation.payload.taskId, previous => {
        checkTaskLease(lease);
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('这份任务的原帖子位置已经变化，请核对原操作。');
        return previous ?? record;
      }));
    }
    if (!operation.submission) {
      const reconcile = !!operation.preparedConsent;
      if (!operation.preparedConsent) {
        operation.preparedConsent = await taskAwait(lease, () => api.prepareAuthorization(operation.payloadJson, { action: 'assistance.publish', objectId: operation.payload.operationId,
          visibility: operation.payload.visibility, ...(operation.authorizationExpiresAt ? {expiresAt:operation.authorizationExpiresAt} : {}), confirmed: true }));
        await updateTaskQueue(key, operation, operation, lease);
      }
      operation.submission = materialBearing ? {signedIntent:operation.preparedConsent.signedIntent,payloadJson:operation.payloadJson}
        : await taskAwait(lease, () => api.submitAuthorization(operation.preparedConsent, { confirmed: true, reconcile }));
      await updateTaskQueue(key, operation, operation, lease);
    }
    if (materialBearing) {
      const intent = operation.preparedConsent?.intent, binding = api.snapshot();
      if (!intent || intent.bindingId !== binding?.bindingId || intent.issuedAt < now() - 300 || intent.expiresAt <= now())
        throw Object.assign(new Error('consent_reauthorization_required'), { code: 'consent_reauthorization_required' });
      if (operation.preparedConsent.payloadJson !== operation.payloadJson || intent.payloadHash !== operation.payloadHash
        || operation.submission.signedIntent !== operation.preparedConsent.signedIntent) throw new Error('原材料操作的授权与内容承诺不一致，请查询原回执。');
      operation = await currentPublicationMaterials(operation, lease, { rebuild: true, requireAvailable: true });
    }
    const result = await dispatchTaskBusiness(key, operation, lease, '/v2/tasks', { explicitRetry });
    if (result.taskId !== operation.payload.taskId || result.eventId !== operation.payload.operationId || result.version !== 1) throw new Error('任务提交结果待查询。');
    return acknowledgePublication(key, operation, result, lease);
  }
  async function reconcilePublication({ retry = false, explicitRetry = false } = {}) {
    const lease = taskLease(), key = prefix + lease.subjectId + ':task-publication';
    const operation = await taskAwait(lease, () => store.get(key));
    const ref = operation ? { taskId: operation.payload.taskId, eventId: operation.payload.operationId, payloadHash: operation.payloadHash }
      : await taskAwait(lease, () => store.get(key + '-receipt'));
    if (!ref) return { state: 'none' };
    const receipt = await taskAwait(lease, () => api.call('/v2/tasks/receipt', { taskId: ref.taskId, eventId: ref.eventId, payloadHash: ref.payloadHash }));
    if (operation && receipt.state === 'acknowledged') return acknowledgePublication(key, operation, receipt, lease);
    if (!operation && receipt.state === 'acknowledged') return { ...receipt, localDraftCleanup: await clearAcknowledgedTaskDraft(ref, lease) };
    else if (operation && receipt.state === 'absent' && retry) return submitPublication(operation, lease, { explicitRetry });
    if(operation&&hasTaskMaterials(operation.payload))await currentPublicationMaterials(operation,lease);
    return receipt;
  }
  let resumingPublication = null;
  async function renewTaskTransportAuthorization(record,key,lease,deadline) {
    const previous=record.preparedConsent,intent=previous.intent;
    const replacement=await taskAwait(lease,()=>api.prepareAuthorization(record.payloadJson,{action:intent.action,objectId:intent.objectId,
      visibility:intent.visibility,viewers:intent.viewers,expiresAt:deadline,confirmed:true}));
    record.authorizationHistory=[...(record.authorizationHistory??[]),{preparedConsent:previous,submission:null,
      reason:'same-binding-signature-renewal',recordedAt:now()}];
    record.preparedConsent=replacement;record.submission=null;record.authorizationBindingId=intent.bindingId;record.authorizationExpiresAt=deadline;
    await updateTaskQueue(key,record,record,lease);
  }
  /** @param {{explicitRetry?:boolean}} options */
  async function resumePublication({ explicitRetry = false } = {}) {
    const lease = taskLease();
    if (resumingPublication) return taskAwait(lease, () => resumingPublication);
    const resuming = (async () => {
      const key = prefix + lease.subjectId + ':task-publication', operation = await taskAwait(lease, () => store.get(key));
      if (!operation) return {state:'none'};
      if (JSON.stringify(operation.payload) !== operation.payloadJson || await taskAwait(lease, () => sha256Hex(operation.payloadJson)) !== operation.payloadHash)
        throw Object.assign(new Error('保存的请求与原发布内容不一致。'), {code:'publication_payload_changed'});
      taskRequestV2Schema.parse(operation.payload);
      const receipt = await taskAwait(lease, () => api.call('/v2/tasks/receipt', {
        taskId:operation.payload.taskId,eventId:operation.payload.operationId,payloadHash:operation.payloadHash}));
      if (receipt.state === 'acknowledged') return acknowledgePublication(key,operation,receipt,lease);
      if (receipt.state !== 'absent') return receipt;
      if (operation.automaticRetryBlock && !explicitRetry) throw taskBusinessRejected(operation);
      await taskAwait(lease, () => agentContinuity.requireCurrent());
      const deadline=operation.authorizationExpiresAt??operation.preparedConsent?.intent?.expiresAt;
      if(!Number.isSafeInteger(deadline)||deadline<=now())throw Object.assign(new Error('原发布许可已到期。内容仍保留，请重新决定是否发布。'),{code:'publication_authorization_expired'});
      const materialBearing=hasTaskMaterials(operation.payload);
      if (operation.preparedConsent) {
        const intent = operation.preparedConsent.intent;
        if (intent.subjectId !== lease.subjectId || intent.endpoint !== config.endpoint || intent.action !== 'assistance.publish'
          || intent.objectId !== operation.payload.operationId || intent.payloadHash !== operation.payloadHash
          || intent.visibility !== operation.payload.visibility || intent.viewers.length !== 0
          || intent.recipient!==config.endpoint || intent.purpose!==(intent.visibility==='Public'?'public-profile':'operational')
          || JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(operation.payload)) || intent.expiresAt!==deadline
          || operation.preparedConsent.payloadJson !== operation.payloadJson || operation.preparedConsent.endpoint !== config.endpoint
          || operation.submission && (operation.submission.payloadJson !== operation.payloadJson || (materialBearing?operation.submission.signedIntent!==operation.preparedConsent.signedIntent:operation.submission.consentId !== intent.id)))
          throw Object.assign(new Error('原请求的发布范围已改变。'), {code:'publication_authorization_changed'});
        if(materialBearing){
          if(intent.bindingId!==lease.bindingId)throw Object.assign(new Error('原材料发布的连接依据已改变，请核对原内容后明确确认。'),{code:'publication_authorization_review_required'});
          if(intent.issuedAt<now()-300)await renewTaskTransportAuthorization(operation,key,lease,deadline);
        }else if (!operation.submission) {
          const authorization = await taskAwait(lease, () => api.reconcileAuthorization(operation.preparedConsent));
          if(authorization.state==='acknowledged'){
            operation.submission={consentId:authorization.consentId,payloadJson:operation.payloadJson};await updateTaskQueue(key,operation,operation,lease);
          }else if(authorization.state!=='absent')throw Object.assign(new Error('原发布授权回执不匹配。'),{code:'publication_authorization_changed'});
          else if(intent.bindingId!==lease.bindingId){
            throw Object.assign(new Error('原发布签名不能继续，内容仍保留，请重新核对并明确确认。'), {
              code:'publication_authorization_review_required',reason:'original-binding-changed'});
          }else if(intent.issuedAt<now()-300)await renewTaskTransportAuthorization(operation,key,lease,deadline);
        }
      }else if(operation.submission)throw Object.assign(new Error('原发布授权记录不匹配。'),{code:'publication_authorization_changed'});
      else if(!operation.authorizationBindingId||operation.authorizationBindingId!==lease.bindingId)throw Object.assign(new Error('原发布的连接依据不能继续，请核对原内容后明确确认。'),{
        code:'publication_authorization_review_required',reason:operation.authorizationBindingId?'original-binding-changed':'original-binding-unavailable'});
      return continuedTaskReceipt(await submitPublication(operation,lease,{explicitRetry}), operation.payloadHash);
    })();
    resumingPublication = resuming;
    try { return await resuming; } finally { if (resumingPublication === resuming) resumingPublication = null; }
  }
  /** @param {string} taskId @param {object} event @param {{viewers?:string[],confirmed?:boolean}} options */
  async function taskEvent(taskId, event, { viewers = [], confirmed = false } = {}) {
    if (!confirmed || !api.snapshot()) throw new Error('请连接当前身份并确认这次操作。');
    if(event.kind==='close'&&event.terminationIntent!=='terminate-task')throw Object.assign(Error('请明确选择结束征集或终止整项求助。'),{code:'task_termination_intent_required'});
    const lease = taskLease(), selectedEvent = structuredClone(event), selectedViewers = [...viewers];
    const key = localKey(`task-event:${taskId}`);
    if (await taskAwait(lease, () => store.get(key))) throw new Error('请先查询这项任务上一次操作的结果。');
    if (selectedEvent.kind === 'apply') await taskAwait(lease, () => agentContinuity.requireCurrent());
    const payload = taskEnvelopeV2Schema.parse({ taskId, event: { ...selectedEvent, eventId: selectedEvent.eventId ?? crypto.randomUUID() } });
    if ((await taskAwait(lease, () => stoppedTaskOperations(taskId))).some(item => item.eventId === payload.event.eventId)) throw new Error('这个原操作已停止本机重试，只能查询；新操作需要独立审阅并使用新编号。');
    const payloadJson = JSON.stringify(payload), record = { taskId, eventId: payload.event.eventId, payloadJson, payloadHash: await taskAwait(lease, () => sha256Hex(payloadJson)), viewers: selectedViewers, state: 'prepared',
      authorizationExpiresAt:Math.min(now()+2591900,payload.event.kind==='invite'?payload.event.expiresAt:Infinity),authorizationBindingId:lease.bindingId };
    await taskAwait(lease, () => store.put(key, record)); return sendTaskEvent(record, lease);
  }
  const taskEventSends=new Map(),resumingTaskEvents=new Map();
  const taskEventLeaseKey=(lease,taskId)=>JSON.stringify([lease.subjectId,lease.bindingId,lease.generation,taskId]);
  async function sendTaskEvent(record,lease=taskLease(),{explicitRetry=false}={}){
    checkTaskLease(lease);const key=taskEventLeaseKey(lease,record.taskId);
    if(taskEventSends.has(key))return taskAwait(lease,()=>taskEventSends.get(key));
    const sending=dispatchTaskEvent(record,lease,{explicitRetry});taskEventSends.set(key,sending);
    try{return await sending;}finally{if(taskEventSends.get(key)===sending)taskEventSends.delete(key);}
  }
  async function dispatchTaskEvent(record, lease, { explicitRetry = false } = {}) {
    checkTaskLease(lease);
    const payload = JSON.parse(record.payloadJson), kind = payload.event?.kind ?? payload.kind;
    if(kind==='close'&&payload.event?.terminationIntent!=='terminate-task')throw Object.assign(Error('旧关闭操作只能核对原回执；请重新明确处理方式。'),{code:'task_termination_intent_required'});
    if (kind === 'apply' || kind === 'confirm') await taskAwait(lease, () => agentContinuity.requireCurrent());
    const key = localKey(`task-event:${record.taskId}`);
    if (!record.submission) {
      const reconcile = !!record.preparedConsent;
      if (!record.preparedConsent) {
        record.preparedConsent = await taskAwait(lease, () => api.prepareAuthorization(record.payloadJson, { action: 'assistance.publish', objectId: record.eventId,
          visibility: 'Private', viewers: record.viewers, confirmed: true,
          ...(record.authorizationExpiresAt?{expiresAt:record.authorizationExpiresAt}:{}) }));
        await updateTaskQueue(key, record, record, lease);
      }
      record.submission = await taskAwait(lease, () => api.submitAuthorization(record.preparedConsent, { confirmed: true, reconcile }));
      await updateTaskQueue(key, record, record, lease);
    }
    const receipt = await dispatchTaskBusiness(key, record, lease, record.path ?? `/v2/tasks/${record.taskId}/events`, { explicitRetry });
    if (receipt.taskId !== record.taskId || receipt.eventId !== record.eventId || !Number.isInteger(receipt.version)) throw new Error('任务操作结果待查询。');
    if (record.composeRevision && receipt.participationId !== record.participationId) participationDraftIssue('participation_receipt_mismatch');
    return acknowledgeTaskEvent(key, record, receipt, lease);
  }
  async function reconcileTaskEvent(taskId, { retry = false, explicitRetry = false } = {}) {
    const lease = taskLease(), key = localKey(`task-event:${taskId}`), record = await taskAwait(lease, () => store.get(key)); if (!record) return { state: 'none' };
    const receipt = await taskAwait(lease, () => api.call('/v2/tasks/receipt', { taskId, eventId: record.eventId, payloadHash: record.payloadHash }));
    checkedParticipationReceipt(record, receipt);
    if (receipt.state === 'acknowledged') return acknowledgeTaskEvent(key, record, receipt, lease);
    else if (receipt.state === 'absent' && retry) return sendTaskEvent(record, lease, { explicitRetry });
    return receipt;
  }
  /** @param {string} taskId @param {{expectedEventId?:string,expectedPayloadHash?:string,explicitRetry?:boolean}} options */
  async function resumeTaskEvent(taskId,{expectedEventId,expectedPayloadHash,explicitRetry=false}={}){
    const lease=taskLease(),coalesce=taskEventLeaseKey(lease,taskId);
    if(expectedEventId!==undefined||expectedPayloadHash!==undefined){
      const original=await taskAwait(lease,()=>store.get(prefix+lease.subjectId+`:task-event:${taskId}`));
      if(!original||expectedEventId!==undefined&&original.eventId!==expectedEventId
        ||expectedPayloadHash!==undefined&&original.payloadHash!==expectedPayloadHash)throw Error('task_original_operation_changed');
    }
    if(taskEventSends.has(coalesce))return continuedTaskReceipt(await taskAwait(lease,()=>taskEventSends.get(coalesce)),expectedPayloadHash);
    if(resumingTaskEvents.has(coalesce))return taskAwait(lease,()=>resumingTaskEvents.get(coalesce));
    const resuming=(async()=>{
      const key=prefix+lease.subjectId+`:task-event:${taskId}`,record=await taskAwait(lease,()=>store.get(key));if(!record)return{state:'none'};
      if(expectedEventId!==undefined&&record.eventId!==expectedEventId||expectedPayloadHash!==undefined&&record.payloadHash!==expectedPayloadHash)throw Error('task_original_operation_changed');
      if(record.taskId!==taskId||await taskAwait(lease,()=>sha256Hex(record.payloadJson))!==record.payloadHash)throw Error('task_original_operation_changed');
      const payload=JSON.parse(record.payloadJson),path=record.path??`/v2/tasks/${taskId}/events`;
      if(path===`/v2/tasks/${taskId}/events`){taskEnvelopeV2Schema.parse(payload);if(payload.taskId!==taskId||payload.event.eventId!==record.eventId)throw Error('task_original_operation_changed');}
      else if(path===`/v2/tasks/${taskId}/participations`){participationProposalV2Schema.parse(payload);if(payload.eventId!==record.eventId)throw Error('task_original_operation_changed');}
      else if(/^\/v2\/participations\/[0-9a-f-]{36}\/events$/i.test(path)){participationEventV2Schema.parse(payload);if(payload.eventId!==record.eventId)throw Error('task_original_operation_changed');}
      else throw Error('task_original_operation_changed');
      const receipt=await taskAwait(lease,()=>api.call('/v2/tasks/receipt',{taskId,eventId:record.eventId,payloadHash:record.payloadHash}));
      checkedParticipationReceipt(record,receipt);
      if(receipt.state==='acknowledged')return acknowledgeTaskEvent(key,record,receipt,lease);
      if(receipt.state!=='absent')return receipt;
      if(payload.event?.kind==='close'&&payload.event.terminationIntent!=='terminate-task')throw Object.assign(Error('旧关闭操作未被接受；请明确选择结束征集或终止整项求助。'),{code:'task_termination_intent_required'});
      if((await taskAwait(lease,()=>stoppedTaskOperations(taskId))).some(item=>item.eventId===record.eventId))return{...receipt,reason:'stopped-local'};
      if(record.automaticRetryBlock&&!explicitRetry)throw taskBusinessRejected(record);
      const deadline=record.authorizationExpiresAt??record.preparedConsent?.intent?.expiresAt;
      if(!Number.isSafeInteger(deadline)||deadline<=now())throw Object.assign(Error('原操作许可已到期。内容仍保留，请重新决定是否继续。'),{code:'task_operation_authorization_expired'});
      if(record.preparedConsent){
        const intent=record.preparedConsent.intent;
        if(intent.subjectId!==lease.subjectId||intent.endpoint!==config.endpoint||intent.action!=='assistance.publish'||intent.objectId!==record.eventId
          ||intent.payloadHash!==record.payloadHash||intent.visibility!=='Private'||JSON.stringify(intent.viewers)!==JSON.stringify(record.viewers)
          ||intent.recipient!==config.endpoint||intent.purpose!=='operational'||JSON.stringify(intent.fields)!==JSON.stringify(Object.keys(payload))
          ||intent.expiresAt!==deadline||record.preparedConsent.endpoint!==config.endpoint||record.preparedConsent.payloadJson!==record.payloadJson
          ||record.submission&&(record.submission.consentId!==intent.id||record.submission.payloadJson!==record.payloadJson))throw Error('task_original_authorization_changed');
        const authorization=await taskAwait(lease,()=>api.reconcileAuthorization(record.preparedConsent));
        if(authorization.state==='acknowledged'){
          record.submission={consentId:authorization.consentId,payloadJson:record.payloadJson};await updateTaskQueue(key,record,record,lease);
        }else if(authorization.state!=='absent')throw Error('task_original_authorization_changed');
        else if(intent.bindingId!==lease.bindingId)
          throw Object.assign(Error('原操作签名不能继续，内容仍保留，请重新核对并明确确认。'),{
            code:'task_operation_authorization_review_required',reason:'original-binding-changed'});
        else if(intent.issuedAt<now()-300)await renewTaskTransportAuthorization(record,key,lease,deadline);
      }else if(record.submission)throw Error('task_original_authorization_changed');
      else if(!record.authorizationBindingId||record.authorizationBindingId!==lease.bindingId)throw Object.assign(Error('原操作的连接依据不能继续，请核对原内容后明确确认。'),{
        code:'task_operation_authorization_review_required',reason:record.authorizationBindingId?'original-binding-changed':'original-binding-unavailable'});
      return continuedTaskReceipt(await sendTaskEvent(record,lease,{explicitRetry}),record.payloadHash);
    })();resumingTaskEvents.set(coalesce,resuming);
    try{return await resuming;}finally{if(resumingTaskEvents.get(coalesce)===resuming)resumingTaskEvents.delete(coalesce);}
  }
  /** @param {string|null} taskId */
  async function reviewTaskAuthorization(taskId = null) {
    const publicationLease = taskId === null ? captureTaskDraftLease() : null;
    const eventLease = taskId === null ? null : taskLease();
    const key = localKey(taskId ? `task-event:${taskId}` : 'task-publication'), record = await store.get(key);
    publicationLease?.assertCurrent();
    if (eventLease) checkTaskLease(eventLease);
    if (!record) return { state: 'none' };
    const resolvedTaskId = taskId ?? record.payload.taskId, eventId = record.eventId ?? record.payload.operationId;
    const receipt = await api.call('/v2/tasks/receipt', { taskId: resolvedTaskId, eventId, payloadHash: record.payloadHash });
    publicationLease?.assertCurrent();
    if (eventLease) checkTaskLease(eventLease);
    checkedParticipationReceipt(record, receipt);
    if (receipt.state === 'acknowledged') {
      if (publicationLease) return acknowledgePublication(key, record, receipt, publicationLease);
      return acknowledgeTaskEvent(key, record, receipt, eventLease);
    }
    if (receipt.state !== 'absent') throw new Error('原操作状态存在冲突，不能另建授权。');
    if(publicationLease&&hasTaskMaterials(record.payload)){
      const materials=await currentPublicationMaterials(record,publicationLease),intent=record.preparedConsent?.intent,current=api.snapshot();
      if(intent&&intent.bindingId===current?.bindingId&&intent.issuedAt>=now()-300&&intent.expiresAt>now())return{state:'retry-original',taskId:resolvedTaskId};
      return{state:'reauthorization-required',taskId:resolvedTaskId,eventId,payloadHash:record.payloadHash,consentId:intent?.id??null,
        payload:JSON.parse(record.payloadJson),visibility:record.payload.visibility,viewers:[],expiresAt:now()+2591900,
        action:'assistance.publish',objectId:eventId,materialBodies:materials.materialBodies,materialStates:materials.materialStates};
    }
    if (!record.preparedConsent) return { state: 'reauthorization-required', taskId: resolvedTaskId, eventId, payloadHash: record.payloadHash, consentId: null,
      payload: JSON.parse(record.payloadJson), visibility: taskId === null ? record.payload.visibility : 'Private', viewers: record.viewers ?? [],
      expiresAt: now() + 2591900, action: 'assistance.publish', objectId: eventId };
    let authorization;
    try{authorization=await api.reconcileAuthorization(record.preparedConsent);}
    catch(error){
      if(error?.code!=='consent_receipt_not_active_or_mismatched')throw error;
      const saved=await api.call('/v2/consents/receipt',{consentId:record.preparedConsent.intent.id});
      publicationLease?.assertCurrent();if(eventLease)checkTaskLease(eventLease);
      if(saved.state!=='recorded'||!['expired','revoked'].includes(saved.status)
        ||saved.consentId!==record.preparedConsent.intent.id||!equalJson(saved.intent,record.preparedConsent.intent)
        ||saved.signatureHash!==await sha256Hex(record.preparedConsent.signedIntent))throw error;
      publicationLease?.assertCurrent();if(eventLease)checkTaskLease(eventLease);
      authorization={state:'inactive',status:saved.status};
    }
    publicationLease?.assertCurrent();
    if (eventLease) checkTaskLease(eventLease);
    if (authorization.state === 'acknowledged') return { state: 'retry-original', taskId: resolvedTaskId };
    if(!['absent','inactive'].includes(authorization.state))throw Error('task_original_authorization_changed');
    const intent = record.preparedConsent.intent, current = api.snapshot();
    if (authorization.state==='absent'&&intent.bindingId === current?.bindingId && intent.issuedAt >= now() - 300 && intent.expiresAt > now())
      return { state: 'retry-original', taskId: resolvedTaskId };
    return { state: 'reauthorization-required', taskId: resolvedTaskId, eventId, payloadHash: record.payloadHash, consentId: intent.id,
      payload: JSON.parse(record.payloadJson), visibility: intent.visibility, viewers: intent.viewers,
      expiresAt: now() + 2591900, action: intent.action, objectId: intent.objectId };
  }
  /** @param {any} preview @param {{taskId?:string|null,confirmed?:boolean}} options */
  async function reauthorizeTaskOperation(preview, { taskId = null, confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认相同操作的内容、可见范围与新授权期限。');
    const lease = taskLease(), publicationLease = taskId === null ? lease : null;
    const current = await reviewTaskAuthorization(taskId);
    checkTaskLease(lease);
    if (current.state === 'acknowledged' || current.state === 'none') return current;
    if (current.state !== 'reauthorization-required' || current.consentId !== preview?.consentId || current.eventId !== preview?.eventId
      || current.payloadHash !== preview?.payloadHash || JSON.stringify(current.payload) !== JSON.stringify(preview?.payload)
      || current.visibility !== preview?.visibility || JSON.stringify(current.viewers) !== JSON.stringify(preview?.viewers)
      || current.action !== preview?.action || current.objectId !== preview?.objectId) throw new Error('原操作或授权状态已改变，请重新查询。');
    const key = localKey(taskId ? `task-event:${taskId}` : 'task-publication'), record = await store.get(key);
    checkTaskLease(lease);
    if ((record?.preparedConsent?.intent.id ?? null) !== current.consentId || record.payloadHash !== current.payloadHash) throw new Error('本机原操作已改变。');
    if(publicationLease&&hasTaskMaterials(record.payload))await currentPublicationMaterials(record,publicationLease,{rebuild:true,requireAvailable:true});
    const previous = record.preparedConsent, intent = previous?.intent ?? current;
    const original = JSON.parse(record.payloadJson), kind = original.event?.kind ?? original.kind;
    if (taskId === null || kind === 'apply' || kind === 'confirm') await agentContinuity.requireCurrent();
    checkTaskLease(lease);
    const replacement = await api.prepareAuthorization(record.payloadJson, { action: intent.action, objectId: intent.objectId,
      visibility: intent.visibility, viewers: intent.viewers, expiresAt: preview.expiresAt, confirmed: true });
    checkTaskLease(lease);
    // Keep both the original business ID and the exact prior authorization.
    // Reconnection never silently signs a replacement or drops unknown state.
    record.authorizationHistory = [...(record.authorizationHistory ?? []), ...(previous ? [{ preparedConsent: previous, submission: record.submission ?? null,
      reason: 'business-and-consent-receipts-absent-user-confirmed', recordedAt: now() }] : [])];
    record.preparedConsent = replacement; record.submission = null; record.state = 'prepared';record.authorizationExpiresAt=preview.expiresAt;record.authorizationBindingId=replacement.intent.bindingId;
    await updateTaskQueue(key, record, record, lease);
    return taskId ? sendTaskEvent(record, lease, { explicitRetry: true }) : submitPublication(record, publicationLease, { explicitRetry: true });
  }
  async function participationWrite(taskId, path, payload, viewers, confirmed, composeRevision = null, onJournal = null) {
    if (!confirmed || !api.snapshot()) throw new Error('请连接当前身份并确认参与范围与此操作。');
    const lease = taskLease();
    const key = localKey(`task-event:${taskId}`);
    if (await taskAwait(lease, () => store.get(key))) throw new Error('请先查询此任务上一次操作。');
    const participationId = /^\/v2\/participations\/([0-9a-f-]{36})\/events$/i.exec(path)?.[1] ?? null;
    if (composeRevision !== null) {
      if (!taskUuid(composeRevision) || !participationId || payload.kind !== 'deliver') participationDraftIssue('participation_compose_revision_mismatch');
      const draft = checkedParticipationCompose(await taskAwait(lease, () => store.get(participationComposeKey(lease, taskId, participationId))), taskId, participationId);
      if (!draft || draft.revision !== composeRevision) participationDraftIssue('participation_compose_revision_mismatch');
      if (typeof store.update !== 'function') participationDraftIssue('local_atomic_update_unavailable');
    }
    if (payload.kind === 'confirm') await taskAwait(lease, () => agentContinuity.requireCurrent());
    if(onJournal!==null&&typeof onJournal!=='function')throw Error('participation_journal_callback_invalid');
    const payloadJson = JSON.stringify(payload), record = { taskId, path, eventId: payload.eventId, payloadJson, payloadHash: await taskAwait(lease, () => sha256Hex(payloadJson)), viewers, state: 'prepared',authorizationExpiresAt:now()+2591900,authorizationBindingId:lease.bindingId,
      ...(participationId ? { participationId } : {}), ...(composeRevision !== null ? { composeRevision } : {}) };
    if (composeRevision !== null || onJournal !== null) {
      if(typeof store.update!=='function')participationDraftIssue('local_atomic_update_unavailable');
      // Claim the original operation before linking local editing. Even a lost
      // ACK or a later revision can only reconcile this generated event ID.
      await taskAwait(lease, () => store.update(key, current => {
        checkTaskLease(lease); if (current) participationDraftIssue('pending_task_operation'); return record;
      }));
      if(composeRevision!==null)await updateParticipationCompose(lease, taskId, participationId, current =>
        current?.revision === composeRevision ? { ...current, eventId: record.eventId } : current);
    } else await taskAwait(lease, () => store.put(key, record));
    if(onJournal!==null)await taskAwait(lease,()=>onJournal(Object.freeze({taskId,participationId,eventId:record.eventId,payloadHash:record.payloadHash,kind:payload.kind})));
    return sendTaskEvent(record, lease);
  }
  function proposeParticipation(taskId, input, { confirmed = false } = {}) {
    const payload = participationProposalV2Schema.parse({ ...input, kind: 'propose', eventId: crypto.randomUUID(), participationId: crypto.randomUUID(), scopeVersion: 1 });
    return participationWrite(taskId, `/v2/tasks/${taskId}/participations`, payload, [payload.subjectId], confirmed);
  }
  /** @param {string} taskId @param {string} participationId @param {object} input @param {{viewers?:string[],confirmed?:boolean,composeRevision?:string,onJournal?:(locator:any)=>any}} options */
  function participationEvent(taskId, participationId, input, { viewers = [], confirmed = false, composeRevision = null, onJournal = null } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(participationId)) throw new Error('无效参与标识。');
    const payload = participationEventV2Schema.parse({ ...input, eventId: crypto.randomUUID() });
    return participationWrite(taskId, `/v2/participations/${participationId}/events`, payload, [...viewers], confirmed, composeRevision, onJournal);
  }
  return Object.freeze({readTaskPublication,publishTask,reconcilePublication,resumePublication,taskEvent,reconcileTaskEvent,resumeTaskEvent,reviewTaskAuthorization,reauthorizeTaskOperation,proposeParticipation,participationEvent,readParticipationComposeDraft,saveParticipationComposeDraft,clearParticipationComposeDraft,reviewTaskStop,stopTaskOperation,stoppedTaskOperations,queryStoppedTaskOperation,onTaskOperationStopped});
}
