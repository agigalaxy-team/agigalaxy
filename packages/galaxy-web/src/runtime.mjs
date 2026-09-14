import { createBrowserClient, browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { openDeviceKeyStore } from '../../galaxy-core/src/domain/device-key-store.mjs';
import { createBrowserGenesis } from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import { createIdentityControlClient } from '../../galaxy-core/src/domain/identity-control-client.mjs';
import { createIdentityDeviceHandoff } from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import { createVisitorDraftAdoption } from '../../galaxy-core/src/domain/visitor-draft-adoption.mjs';
import { createDeviceMaterial, identityKeyId, importRecoveryMaterial, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { taskRequestV2Schema, taskEnvelopeV2Schema, participationProposalV2Schema, participationEventV2Schema } from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import { sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';
import { createChatClient } from './chat-client.mjs';
import { createPrivacyClient } from './privacy-client.mjs';
import { createTrustPackageClient } from '../../galaxy-official/src/trust-package-client.mjs';
import { createTrustPackageDeviceAdapter } from '../../galaxy-official/src/trust-package-device-adapter.mjs';
import { createIdentityGroupClientV2 } from '../../galaxy-official/src/identity-group-client-v2.mjs';
import { createIdentityGroupDeviceSignerV2 } from '../../galaxy-official/src/identity-group-device-signer-v2.mjs';

export async function loadWebConfiguration(fetcher = globalThis.fetch) {
  const response = await fetcher('/galaxy-web-config.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('当前网站尚未配置业务服务。');
  const raw = await response.text(); if (raw.length > 16000) throw new Error('网站服务配置无效。');
  const config = JSON.parse(raw);
  if (config.version !== 1 || !Array.isArray(config.signingKeys) || config.signingKeys.length < 1) throw new Error('网站服务配置无效。');
  // No received manifest can silently replace these deployment-selected pins.
  return { endpoint: config.endpoint, trustedKeys: new Map(config.signingKeys.map(pin => [pin.kid, pin])), operator: config.operator ?? '银河技术团队' };
}

export async function createWebRuntime(config, { store: suppliedStore, fetch, now = () => Math.floor(Date.now() / 1000), waitForClock } = {}) {
  const store = suppliedStore ?? await openDeviceKeyStore();
  const prefix = `galaxy-web:${config.endpoint}:`, activeKey = prefix + 'active';
  let active = await store.get(activeKey), closed = false;
  const signDevice = async (payload, type) => {
    if (closed || !active) throw new Error('本机身份不可用。');
    const material = await store.get(`device:${active.subjectId}:${active.deviceId}`);
    if (!material) throw new Error('当前设备缺少身份材料，请用旧设备确认或恢复码恢复。');
    return signIdentityPayload(payload, material.privateKey, { type });
  };
  const api = createBrowserClient({ ...config, sign: signDevice, fetch, now, waitForClock });
  const fetchPublicControl = subjectId => api.call(`/v2/identity/${subjectId}/control`, undefined, { method: 'GET', authenticated: false });
  const trustDevice = createTrustPackageDeviceAdapter({endpoint:config.endpoint,now,getBinding:api.snapshot,
    getMaterial:async()=>{if(closed||!active)throw Object.assign(new Error('trust_identity_required'),{code:'trust_identity_required'});
      const selected=active,material=await device();
      if(active!==selected)throw Object.assign(new Error('trust_identity_changed'),{code:'trust_identity_changed'});
      return{subjectId:selected.subjectId,genesisProof:selected.genesisProof,material,localGenesis:false};},
    readIdentity:subjectId=>store.get(prefix+'trust-identity:'+subjectId),writeIdentity:(subjectId,value)=>store.put(prefix+'trust-identity:'+subjectId,value),
    fetchIdentity:fetchPublicControl});
  const publicControl = async subjectId => {const state=await fetchPublicControl(subjectId);await trustDevice.remember(state);return state;};
  const saveActive = async value => { await store.put(activeKey, value); active = value; };
  const visitorDrafts = createVisitorDraftAdoption({ store, prefix, getActive: async () => active });
  const deviceHandoff = createIdentityDeviceHandoff({ endpoint: config.endpoint, send: api.send, store, getActive: async () => active,
    activate: async value => { api.disconnect(); await saveActive(value); }, allowedScopes: browserScopes, now });
  const identityClient = (material, newDevice = material) => createIdentityControlClient({ endpoint: config.endpoint, send: api.send, store, now,
    signController: challenge => signIdentityPayload(challenge, material.privateKey),
    signNewDevice: challenge => signIdentityPayload(challenge, newDevice.privateKey) });
  async function device() {
    if (!active) throw new Error('先创建或连接已有银河身份。');
    const material = await store.get(`device:${active.subjectId}:${active.deviceId}`);
    if (!material) throw new Error('本机设备身份材料不可用。'); return material;
  }
  async function createIdentity({ confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认创建本机身份并连接所示银河服务。');
    if (active) return status();
    let pending = await store.get(prefix + 'new-identity');
    if (!pending) {
      const material = await createDeviceMaterial(), genesis = await createBrowserGenesis({ publicKeyPem: material.publicKeyPem, originCode: '5' });
      pending = { subjectId: genesis.id, genesisProof: genesis.genesisProof, deviceId: material.deviceId, installationId: crypto.randomUUID(), operationId: crypto.randomUUID() };
      await store.put(`device:${genesis.id}:${material.deviceId}`, material);
      await store.put(prefix + 'new-identity', pending);
    }
    const material = await store.get(`device:${pending.subjectId}:${pending.deviceId}`), client = identityClient(material);
    const savedOperation = await store.get(`identity-operation:${config.endpoint}:${pending.operationId}`);
    let receipt;
    if (savedOperation?.commit) {
      receipt = await client.status(pending.operationId);
      if (receipt.state === 'requested') receipt = await client.retry(pending.operationId, { confirmed: true });
    } else {
      const request = { version: 2, kind: 'bootstrap', operationId: pending.operationId, subjectId: pending.subjectId, expectedEpoch: 0, previousEventHash: null,
        signerKeyId: await identityKeyId(material.publicKeyPem), genesisProof: pending.genesisProof,
        newDevice: { deviceId: pending.deviceId, publicKeyPem: material.publicKeyPem, scopes: ['manage-identity', ...browserScopes] } };
      receipt = await client.confirm(await client.prepare(request), { confirmed: true });
    }
    if (receipt.state !== 'committed') throw new Error('身份操作尚未完成，请查看原操作状态。');
    await saveActive(pending); await store.put(prefix + 'new-identity', null); return status();
  }
  async function connect({ confirmed = false } = {}) {
    if (!active || !confirmed) throw new Error('请确认连接当前身份。');
    const state = await publicControl(active.subjectId), material = await device();
    const current = state.devices.find(row => row.device_id === active.deviceId && row.status === 'active' && row.epoch === state.epoch);
    if (!current) throw new Error('当前设备已失效，请使用旧设备确认或恢复码恢复。');
    return api.connect({ subjectId: active.subjectId, genesisProof: state.genesisProof, installationId: active.installationId,
      scopes: browserScopes.filter(scope => current.scopes.includes(scope) || current.scopes.includes('*')),
      control: { deviceId: active.deviceId, keyId: await identityKeyId(material.publicKeyPem), epoch: state.epoch } }, { confirmed });
  }
  async function prepareRecovery() {
    const material = await device(), state = await publicControl(active.subjectId);
    let pending = await store.get(prefix + 'recovery');
    if (!pending || pending.subjectId !== active.subjectId) {
      const operationId = crypto.randomUUID(), recovery = await store.prepareRecovery(active.subjectId, operationId);
      pending = { subjectId: active.subjectId, operationId, expectedEpoch: state.epoch, previousEventHash: state.chainHead,
        signerKeyId: await identityKeyId(material.publicKeyPem), generation: state.recovery?.generation ?? 0, publicKeyPem: recovery.publicKeyPem };
      await store.put(prefix + 'recovery', pending);
    }
    const recovery = await store.get(`pending-recovery:${active.subjectId}:${pending.operationId}`);
    return { operationId: pending.operationId, code: recovery.code, replaces: pending.generation > 0 };
  }
  async function saveRecovery({ confirmed = false } = {}) {
    if (!confirmed) throw new Error('请在复制或下载后声明已保存。');
    const pending = await store.get(prefix + 'recovery'); if (!pending || pending.subjectId !== active?.subjectId) throw new Error('没有待保存的恢复材料。');
    await store.declareSaved(active.subjectId, pending.operationId);
    const client = identityClient(await device()), request = { version: 2, kind: 'set-recovery', operationId: pending.operationId,
      subjectId: pending.subjectId, expectedEpoch: pending.expectedEpoch, previousEventHash: pending.previousEventHash, signerKeyId: pending.signerKeyId,
      recoveryGeneration: pending.generation, nextRecoveryPublicKey: pending.publicKeyPem, saveDeclaration: true };
    const savedOperation = await store.get(`identity-operation:${config.endpoint}:${pending.operationId}`);
    let receipt = savedOperation?.commit ? await client.status(pending.operationId) : await client.confirm(await client.prepare(request), { confirmed: true });
    if (receipt.state === 'requested') receipt = await client.retry(pending.operationId, { confirmed: true });
    if (receipt.state !== 'committed') throw new Error('恢复材料保存状态待查询。');
    await store.recordReceipt(active.subjectId, pending.operationId, receipt);
    // Once the user has saved it, keep only the local receipt, not a second copy
    // of the recovery secret alongside the device whose loss it should survive.
    await store.put(`pending-recovery:${active.subjectId}:${pending.operationId}`, { operationId: pending.operationId, publicKeyPem: pending.publicKeyPem, receipt, saveDeclared: true, status: 'registered-save-declared' });
    await store.put(prefix + 'recovery', null); return receipt;
  }
  async function recover(code, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认恢复同一身份并撤销旧设备控制。');
    const recovery = await importRecoveryMaterial(code), state = await publicControl(recovery.subjectId);
    let pending = await store.get(prefix + 'recover-operation');
    if (!pending || pending.subjectId !== recovery.subjectId) {
      if (state.recovery?.publicKeyPem !== recovery.publicKeyPem) throw new Error('恢复码已更换、已使用或不属于当前身份。');
      const material = await createDeviceMaterial(), operationId = crypto.randomUUID();
      await store.put(`device:${recovery.subjectId}:${material.deviceId}`, material);
      const next = await store.prepareRecovery(recovery.subjectId, operationId);
      pending = { subjectId: recovery.subjectId, genesisProof: state.genesisProof, deviceId: material.deviceId, installationId: crypto.randomUUID(), operationId,
        request: { version: 2, kind: 'recover', operationId, subjectId: recovery.subjectId, expectedEpoch: state.epoch, previousEventHash: state.chainHead,
          signerKeyId: await identityKeyId(recovery.publicKeyPem), recoveryGeneration: state.recovery.generation, nextRecoveryPublicKey: next.publicKeyPem,
          newDevice: { deviceId: material.deviceId, publicKeyPem: material.publicKeyPem, scopes: ['manage-identity', ...browserScopes] } } };
      await store.put(prefix + 'recover-operation', pending);
    }
    const material = await store.get(`device:${pending.subjectId}:${pending.deviceId}`), client = identityClient(recovery, material);
    const savedOperation = await store.get(`identity-operation:${config.endpoint}:${pending.operationId}`);
    let receipt = savedOperation?.commit ? await client.status(pending.operationId) : await client.confirm(await client.prepare(pending.request), { confirmed: true });
    if (receipt.state === 'requested') receipt = await client.retry(pending.operationId, { confirmed: true });
    if (receipt.state !== 'committed') throw new Error('恢复操作尚未完成，请查询原操作。');
    api.disconnect(); await saveActive(pending); await store.recordReceipt(pending.subjectId, pending.operationId, receipt);
    const next = await store.get(`pending-recovery:${pending.subjectId}:${pending.operationId}`);
    return { ...await status(), replacementCode: next.code, operationId: pending.operationId };
  }
  async function confirmRecoveredCode({ confirmed = false } = {}) {
    if (!confirmed || !active?.request || active.request.kind !== 'recover') throw new Error('没有待确认的恢复后材料。');
    const material = await device(), client = identityClient(material), key = prefix + 'recovery-save-operation';
    let request = await store.get(key);
    if (!request || request.subjectId !== active.subjectId) {
      const state = await publicControl(active.subjectId);
      request = { version: 2, kind: 'declare-recovery-saved', operationId: crypto.randomUUID(), subjectId: active.subjectId, expectedEpoch: state.epoch,
        previousEventHash: state.chainHead, signerKeyId: await identityKeyId(material.publicKeyPem), recoveryGeneration: state.recovery.generation, saveDeclaration: true };
      await store.put(key, request);
    }
    const saved = await store.get(`identity-operation:${config.endpoint}:${request.operationId}`);
    let receipt = saved?.commit ? await client.status(request.operationId) : await client.confirm(await client.prepare(request), { confirmed: true });
    if (receipt.state === 'requested') receipt = await client.retry(request.operationId, { confirmed: true });
    if (receipt.state !== 'committed') throw new Error('恢复材料保存声明尚未确认。');
    await store.put(`pending-recovery:${active.subjectId}:${active.operationId}`, { receipt, status: 'registered-save-declared', saveDeclared: true });
    await store.put(prefix + 'recover-operation', null); await store.put(key, null); return receipt;
  }
  async function pendingRecoveryCode() {
    if (!active) return null;
    const recovered = active.request?.kind === 'recover' && await store.get(`pending-recovery:${active.subjectId}:${active.operationId}`);
    if (recovered?.code) return { code: recovered.code, recovered: true };
    const pending = await store.get(prefix + 'recovery');
    if (!pending || pending.subjectId !== active.subjectId) return null;
    const material = await store.get(`pending-recovery:${active.subjectId}:${pending.operationId}`);
    return material?.code ? { code: material.code, recovered: false } : null;
  }
  async function status() { return { identity: active ? { subjectId: active.subjectId, deviceId: active.deviceId } : null, connection: api.snapshot(), endpoint: config.endpoint }; }
  const localKey = name => prefix + (active?.subjectId ?? 'visitor') + ':' + name;
  let taskQueueTail = Promise.resolve();
  const taskStopListeners = new Set();
  const onTaskOperationStopped = callback => { taskStopListeners.add(callback); return () => { taskStopListeners.delete(callback); }; };
  const withTaskQueue = fn => { const operation = taskQueueTail.then(fn); taskQueueTail = operation.catch(() => {}); return operation; };
  const sameTaskOperation = (left, right) => left && right && left.payloadHash === right.payloadHash
    && (left.eventId ?? left.payload?.operationId) === (right.eventId ?? right.payload?.operationId);
  const taskQueueName = taskId => taskId ? `task-event:${taskId}` : 'task-publication';
  const stoppedQueueName = taskId => `task-stopped-operations:${taskId ?? 'publication'}`;
  async function updateTaskQueue(key, operation, next) {
    return withTaskQueue(async () => {
      const current = await store.get(key);
      if (!sameTaskOperation(current, operation)) {
        if (next === null) return false;
        throw new Error('原操作已停止本机重试或队列已改变；不会重新放回发送队列。');
      }
      await store.put(key, next); return true;
    });
  }
  const minimalTaskReceipt = receipt => ({ state: receipt.state, checkedAt: receipt.checkedAt ?? now(),
    ...(Number.isSafeInteger(receipt.version) ? { version: receipt.version } : {}),
    ...(Number.isSafeInteger(receipt.participationVersion) ? { participationVersion: receipt.participationVersion } : {}) });
  async function reviewTaskStop(taskId = null) {
    const key = localKey(taskQueueName(taskId)), record = await store.get(key);
    if (!record) return { state: 'none' };
    const payload = JSON.parse(record.payloadJson), ref = { taskId: taskId ?? payload.taskId,
      eventId: record.eventId ?? payload.operationId, payloadHash: record.payloadHash };
    let receipt;
    try { receipt = await api.call('/v2/tasks/receipt', ref); }
    catch { receipt = { ...ref, state: 'unknown', checkedAt: now() }; }
    if (receipt.state === 'acknowledged') { await updateTaskQueue(key, record, null); return receipt; }
    return { ...ref, state: 'stop-local-preview', kind: payload.event?.kind ?? payload.kind ?? 'publish-task',
      receipt: minimalTaskReceipt(receipt), serverCancellationConfirmed: false };
  }
  async function stopTaskOperation(preview, { taskId = null, confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认仅停止本机重试；这不是服务端取消或撤回。');
    const key = localKey(taskQueueName(taskId)), historyKey = localKey(stoppedQueueName(taskId)), owner = active;
    const current = await reviewTaskStop(taskId);
    if (current.state === 'none' || current.state === 'acknowledged') return current;
    if (owner !== active || current.eventId !== preview?.eventId || current.payloadHash !== preview?.payloadHash || current.taskId !== preview?.taskId)
      throw new Error('原操作或身份已经变化，请重新核对停止预览。');
    return withTaskQueue(async () => {
      if (owner !== active) throw new Error('身份已变化，请在原身份停止原操作。');
      const record = await store.get(key);
      if (!record || (record.eventId ?? record.payload?.operationId) !== current.eventId || record.payloadHash !== current.payloadHash)
        throw new Error('原发送队列已经变化，请重新核对。');
      const prior = await store.get(historyKey) ?? [];
      const stopped = { taskId: current.taskId, eventId: current.eventId, payloadHash: current.payloadHash,
        kind: current.kind, state: 'stopped-local', stoppedAt: now(), receipt: current.receipt,
        consentId: record.submission?.consentId ?? record.preparedConsent?.intent.id ?? null,
        serverCancellationConfirmed: false };
      // Archive the minimum exact query identity before releasing the queue.
      // This archive has no signed payload and can never drive a retry.
      await store.put(historyKey, [...prior.filter(item => item.eventId !== stopped.eventId), stopped]);
      await store.put(key, null);
      for (const callback of taskStopListeners) { try { callback({ ...stopped, scopeTaskId: taskId }); } catch {} }
      return stopped;
    });
  }
  async function stoppedTaskOperations(taskId = null) { return await store.get(localKey(stoppedQueueName(taskId))) ?? []; }
  async function queryStoppedTaskOperation(eventId, { taskId = null } = {}) {
    const key = localKey(stoppedQueueName(taskId)), owner = active;
    const record = (await store.get(key) ?? []).find(item => item.eventId === eventId);
    if (!record) throw new Error('没有本机保存的这个原操作。');
    let receipt;
    try { receipt = await api.call('/v2/tasks/receipt', { taskId: record.taskId, eventId, payloadHash: record.payloadHash }); }
    catch { receipt = { state: 'unknown', checkedAt: now() }; }
    if (owner !== active) throw new Error('身份已变化，请在原身份查询。');
    return withTaskQueue(async () => {
      const history = await store.get(key) ?? [], index = history.findIndex(item => item.eventId === eventId);
      if (index < 0 || history[index].payloadHash !== record.payloadHash) throw new Error('原查询记录已变化。');
      history[index] = { ...history[index], receipt: minimalTaskReceipt(receipt) };
      await store.put(key, history); return history[index];
    });
  }
  async function publishTask(draft, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认发布内容和可见范围。');
    if (!api.snapshot()) throw new Error('connection_required');
    let operation = await store.get(localKey('task-publication'));
    if (operation) throw Object.assign(new Error('请先查询上一次发布的结果。'), { code: 'pending_task_publication' });
    const payload = taskRequestV2Schema.parse({ ...draft, taskId: crypto.randomUUID(), operationId: crypto.randomUUID() });
    const payloadJson = JSON.stringify(payload);
    operation = { payload, payloadJson, payloadHash: await sha256Hex(payloadJson), state: 'prepared' };
    await store.put(localKey('task-publication'), operation);
    return submitPublication(operation);
  }
  async function submitPublication(operation) {
    const key = localKey('task-publication');
    if (!operation.submission) {
      const reconcile = !!operation.preparedConsent;
      if (!operation.preparedConsent) {
        operation.preparedConsent = await api.prepareAuthorization(operation.payloadJson, { action: 'assistance.publish', objectId: operation.payload.operationId,
          visibility: operation.payload.visibility, confirmed: true });
        await updateTaskQueue(key, operation, operation);
      }
      operation.submission = await api.submitAuthorization(operation.preparedConsent, { confirmed: true, reconcile });
      await updateTaskQueue(key, operation, operation);
    }
    operation.state = 'result-unknown'; await updateTaskQueue(key, operation, operation);
    const result = await api.call('/v2/tasks', operation.submission);
    if (result.taskId !== operation.payload.taskId || result.eventId !== operation.payload.operationId || result.version !== 1) throw new Error('任务提交结果待查询。');
    await updateTaskQueue(key, operation, null); return result;
  }
  async function reconcilePublication({ retry = false } = {}) {
    const key = localKey('task-publication'), operation = await store.get(key); if (!operation) return { state: 'none' };
    const receipt = await api.call('/v2/tasks/receipt', { taskId: operation.payload.taskId, eventId: operation.payload.operationId, payloadHash: operation.payloadHash });
    if (receipt.state === 'acknowledged') await updateTaskQueue(key, operation, null);
    else if (receipt.state === 'absent' && retry) return submitPublication(operation);
    return receipt;
  }
  /** @param {string} taskId @param {object} event @param {{viewers?:string[],confirmed?:boolean}} options */
  async function taskEvent(taskId, event, { viewers = [], confirmed = false } = {}) {
    if (!confirmed || !api.snapshot()) throw new Error('请连接当前身份并确认这次操作。');
    const key = localKey(`task-event:${taskId}`);
    if (await store.get(key)) throw new Error('请先查询这项任务上一次操作的结果。');
    const payload = taskEnvelopeV2Schema.parse({ taskId, event: { ...event, eventId: event.eventId ?? crypto.randomUUID() } });
    if ((await stoppedTaskOperations(taskId)).some(item => item.eventId === payload.event.eventId)) throw new Error('这个原操作已停止本机重试，只能查询；新操作需要独立审阅并使用新编号。');
    const payloadJson = JSON.stringify(payload), record = { taskId, eventId: payload.event.eventId, payloadJson, payloadHash: await sha256Hex(payloadJson), viewers, state: 'prepared' };
    await store.put(key, record); return sendTaskEvent(record);
  }
  async function sendTaskEvent(record) {
    const key = localKey(`task-event:${record.taskId}`);
    if (!record.submission) {
      const reconcile = !!record.preparedConsent;
      if (!record.preparedConsent) {
        record.preparedConsent = await api.prepareAuthorization(record.payloadJson, { action: 'assistance.publish', objectId: record.eventId,
          visibility: 'Private', viewers: record.viewers, confirmed: true });
        await updateTaskQueue(key, record, record);
      }
      record.submission = await api.submitAuthorization(record.preparedConsent, { confirmed: true, reconcile });
      await updateTaskQueue(key, record, record);
    }
    record.state = 'result-unknown'; await updateTaskQueue(key, record, record);
    const receipt = await api.call(record.path ?? `/v2/tasks/${record.taskId}/events`, record.submission);
    if (receipt.taskId !== record.taskId || receipt.eventId !== record.eventId || !Number.isInteger(receipt.version)) throw new Error('任务操作结果待查询。');
    await updateTaskQueue(key, record, null); return receipt;
  }
  async function reconcileTaskEvent(taskId, { retry = false } = {}) {
    const key = localKey(`task-event:${taskId}`), record = await store.get(key); if (!record) return { state: 'none' };
    const receipt = await api.call('/v2/tasks/receipt', { taskId, eventId: record.eventId, payloadHash: record.payloadHash });
    if (receipt.state === 'acknowledged') await updateTaskQueue(key, record, null);
    else if (receipt.state === 'absent' && retry) return sendTaskEvent(record);
    return receipt;
  }
  async function reviewTaskAuthorization(taskId = null) {
    const key = localKey(taskId ? `task-event:${taskId}` : 'task-publication'), record = await store.get(key);
    if (!record) return { state: 'none' };
    const resolvedTaskId = taskId ?? record.payload.taskId, eventId = record.eventId ?? record.payload.operationId;
    const receipt = await api.call('/v2/tasks/receipt', { taskId: resolvedTaskId, eventId, payloadHash: record.payloadHash });
    if (receipt.state === 'acknowledged') { await updateTaskQueue(key, record, null); return receipt; }
    if (receipt.state !== 'absent') throw new Error('原操作状态存在冲突，不能另建授权。');
    if (!record.preparedConsent) return { state: 'retry-original', taskId: resolvedTaskId };
    const authorization = await api.reconcileAuthorization(record.preparedConsent);
    if (authorization.state !== 'absent') return { state: 'retry-original', taskId: resolvedTaskId };
    const intent = record.preparedConsent.intent, current = api.snapshot();
    if (intent.bindingId === current?.bindingId && intent.issuedAt >= now() - 300 && intent.expiresAt > now())
      return { state: 'retry-original', taskId: resolvedTaskId };
    return { state: 'reauthorization-required', taskId: resolvedTaskId, eventId, payloadHash: record.payloadHash, consentId: intent.id,
      payload: JSON.parse(record.payloadJson), visibility: intent.visibility, viewers: intent.viewers,
      expiresAt: now() + 2591900, action: intent.action, objectId: intent.objectId };
  }
  async function reauthorizeTaskOperation(preview, { taskId = null, confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认相同操作的内容、可见范围与新授权期限。');
    const current = await reviewTaskAuthorization(taskId);
    if (current.state === 'acknowledged' || current.state === 'none') return current;
    if (current.state !== 'reauthorization-required' || current.consentId !== preview?.consentId || current.eventId !== preview?.eventId
      || current.payloadHash !== preview?.payloadHash) throw new Error('原操作或授权状态已改变，请重新查询。');
    const key = localKey(taskId ? `task-event:${taskId}` : 'task-publication'), record = await store.get(key);
    if (record?.preparedConsent?.intent.id !== current.consentId || record.payloadHash !== current.payloadHash) throw new Error('本机原操作已改变。');
    const previous = record.preparedConsent, intent = previous.intent;
    const replacement = await api.prepareAuthorization(record.payloadJson, { action: intent.action, objectId: intent.objectId,
      visibility: intent.visibility, viewers: intent.viewers, expiresAt: preview.expiresAt, confirmed: true });
    // Keep both the original business ID and the exact prior authorization.
    // Reconnection never silently signs a replacement or drops unknown state.
    record.authorizationHistory = [...(record.authorizationHistory ?? []), { preparedConsent: previous, submission: record.submission ?? null,
      reason: 'business-and-consent-receipts-absent-user-confirmed', recordedAt: now() }];
    record.preparedConsent = replacement; record.submission = null; record.state = 'prepared';
    await updateTaskQueue(key, record, record);
    return taskId ? sendTaskEvent(record) : submitPublication(record);
  }
  async function participationWrite(taskId, path, payload, viewers, confirmed) {
    if (!confirmed || !api.snapshot()) throw new Error('请连接当前身份并确认参与范围与此操作。');
    const key = localKey(`task-event:${taskId}`);
    if (await store.get(key)) throw new Error('请先查询此任务上一次操作。');
    const payloadJson = JSON.stringify(payload), record = { taskId, path, eventId: payload.eventId, payloadJson, payloadHash: await sha256Hex(payloadJson), viewers, state: 'prepared' };
    await store.put(key, record); return sendTaskEvent(record);
  }
  function proposeParticipation(taskId, input, { confirmed = false } = {}) {
    const payload = participationProposalV2Schema.parse({ ...input, kind: 'propose', eventId: crypto.randomUUID(), participationId: crypto.randomUUID(), scopeVersion: 1 });
    return participationWrite(taskId, `/v2/tasks/${taskId}/participations`, payload, [payload.subjectId], confirmed);
  }
  function participationEvent(taskId, participationId, input, { viewers = [], confirmed = false } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(participationId)) throw new Error('无效参与标识。');
    const payload = participationEventV2Schema.parse({ ...input, eventId: crypto.randomUUID() });
    return participationWrite(taskId, `/v2/participations/${participationId}/events`, payload, viewers, confirmed);
  }
  async function confirmAccountLink(id, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认将已验证的账号关联到当前银河身份。');
    const record = await api.call('/v1/identity/status', { id });
    if (record.state === 'linked') return record;
    if (record.state !== 'awaiting-local-signature' || record.intent?.subjectId !== active?.subjectId || record.intent?.bindingId !== api.snapshot()?.bindingId
      || record.intent?.endpoint !== config.endpoint || JSON.stringify(JSON.parse(record.payloadJson)) !== JSON.stringify(record.intent)) throw new Error('账号登录尚未完成，或关联请求已经失效。');
    const signed = await signDevice(record.payloadJson, 'galaxy-identity-link+jws');
    return api.call('/v1/identity/confirm', { id, signed });
  }
  const chat = createChatClient({ api, getLocal: name => store.get(localKey(name)), putLocal: (name, value) => store.put(localKey(name), value) });
  const privacy = createPrivacyClient({ api, now, getLocal: name => store.get(localKey(name)), putLocal: (name, value) => store.put(localKey(name), value),
    identity: async () => active ? { subjectId: active.subjectId, deviceId: active.deviceId } : null,
    sign: async (payload, type, deviceId) => {
      if (closed || !active || !['galaxy-deletion-intent+jws', 'galaxy-deletion-status+jws'].includes(type)) throw new Error('本机删除证明签名不可用。');
      const material = await store.get(`device:${active.subjectId}:${deviceId}`);
      if (!material) throw new Error('此浏览器没有原申请设备的身份材料；请使用原设备查询删除后回执。');
      return signIdentityPayload(payload, material.privateKey, { type });
    } });
  const trustPackages=Object.freeze({...createTrustPackageClient({api,now,current:trustDevice.current,sign:trustDevice.sign,
    getLocal:name=>store.get(localKey(name)),putLocal:(name,value)=>store.put(localKey(name),value)}),refreshIdentity:trustDevice.refreshIdentity});
  let groupSubject=null,groupClient=null;
  const groupSigner=createIdentityGroupDeviceSignerV2({endpoint:config.endpoint,current:trustDevice.refreshIdentity,getMaterial:async()=>{if(closed)throw new Error('identity_group_identity_changed');return device();}});
  function identityGroups(){const subjectId=active?.subjectId;if(closed||!subjectId)return null;
    if(groupSubject!==subjectId){groupSubject=subjectId;const check=()=>{if(closed||active?.subjectId!==subjectId)throw new Error('identity_group_identity_changed');};
      groupClient=createIdentityGroupClientV2({api,subjectId,now,sign:groupSigner,getLocal:async name=>{check();const v=await store.get(prefix+subjectId+':'+name);check();return v;},putLocal:async(name,value)=>{check();await store.put(prefix+subjectId+':'+name,value);check();}});}
    return groupClient;}
  return Object.freeze({ api, chat, privacy, trustPackages, get identityGroups(){return identityGroups();}, deviceHandoff, visitorDrafts, status, createIdentity, connect, prepareRecovery, saveRecovery, recover, confirmRecoveredCode, pendingRecoveryCode, confirmAccountLink, publicControl, publishTask, reconcilePublication,
    taskEvent, reconcileTaskEvent, reviewTaskAuthorization, reauthorizeTaskOperation, proposeParticipation, participationEvent,
    reviewTaskStop, stopTaskOperation, stoppedTaskOperations, queryStoppedTaskOperation, onTaskOperationStopped,
    getLocal: name => store.get(localKey(name)), putLocal: (name, value) => store.put(localKey(name), value),
    disconnect: () => api.disconnect(), close() { closed = true; api.close(); if (!suppliedStore) store.close(); } });
}
