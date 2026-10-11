import { createBrowserClient, browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { openDeviceKeyStore } from '../../galaxy-core/src/domain/device-key-store.mjs';
import { createBrowserGenesis } from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';
import { createIdentityControlClient } from '../../galaxy-core/src/domain/identity-control-client.mjs';
import { createIdentityDeviceHandoff } from '../../galaxy-core/src/domain/identity-device-handoff.mjs';
import { createIdentityDeviceManagement } from '../../galaxy-core/src/domain/identity-device-management.mjs';
import { createVisitorDraftAdoption } from '../../galaxy-core/src/domain/visitor-draft-adoption.mjs';
import { createDeviceMaterial, identityKeyId, importRecoveryMaterial, parseRecoveryCode, signIdentityPayload } from '../../galaxy-core/src/domain/identity-material.mjs';
import { taskRequestV2Schema, taskEnvelopeV2Schema, participationProposalV2Schema, participationEventV2Schema } from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import { equalJson, sha256Hex } from '../../galaxy-official/src/shared/web-primitives.mjs';
import { createChatClient } from './chat-client.mjs';
import { createPrivacyClient } from './privacy-client.mjs';
import { createTrustPackageClient } from '../../galaxy-official/src/trust-package-client.mjs';
import { createTrustPackageDeviceAdapter } from '../../galaxy-official/src/trust-package-device-adapter.mjs';
import { createReceiptStatusClient, createReceiptStatusDeviceSigner } from '../../galaxy-official/src/receipt-status-client.mjs';
import { createIdentityGroupClientV2 } from '../../galaxy-official/src/identity-group-client-v2.mjs';
import { createIdentityGroupDeviceSignerV2 } from '../../galaxy-official/src/identity-group-device-signer-v2.mjs';
import { createAgentIdentityEvidence } from './agent-identity-evidence.mjs';
import { createNotificationInboxClient } from '../../galaxy-official/src/personal-summary-client.mjs';
import { createAccountVerificationClient } from './account-verification-client.mjs';
import { normalizeForumOrigin } from './community-forum-origin.mjs';
import { createTaskLocalDraftClient, taskLocalDraftView } from './task-local-draft-client.mjs';
import { createTaskMaterialClient } from './task-material-client.mjs';
import { taskMaterialBodySchema, taskMaterialSubmissionSchema, hasTaskMaterials } from '../../galaxy-official/src/shared/task-material-v1-schema.mjs';

export async function loadWebConfiguration(fetcher = globalThis.fetch) {
  const response = await fetcher('/galaxy-web-config.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('当前网站尚未配置业务服务。');
  const raw = await response.text(); if (raw.length > 16000) throw new Error('网站服务配置无效。');
  const config = JSON.parse(raw);
  if (config.version !== 1 || !Array.isArray(config.signingKeys) || config.signingKeys.length < 1) throw new Error('网站服务配置无效。');
  // No received manifest can silently replace these deployment-selected pins.
  return { endpoint: config.endpoint, trustedKeys: new Map(config.signingKeys.map(pin => [pin.kid, pin])), operator: config.operator ?? '银河技术团队' };
}

export async function createWebRuntime(config, { store: suppliedStore, fetch, now = () => Math.floor(Date.now() / 1000), waitForClock, website = globalThis.location?.origin } = {}) {
  const store = suppliedStore ?? await openDeviceKeyStore();
  const prefix = `galaxy-web:${config.endpoint}:`, activeKey = prefix + 'active';
  let active = await store.get(activeKey), closed = false;
  let connectionIntent = 0, connectionPreferenceTail = Promise.resolve(), resumingConnection = null;
  const connectionPreferenceKey = owner => prefix + 'connection:' + owner.subjectId + ':' + owner.deviceId;
  const saveConnectionPreference = (owner, value, intent) => {
    const saving = connectionPreferenceTail.then(async () => {
      if (closed || active !== owner || connectionIntent !== intent) return;
      await store.put(connectionPreferenceKey(owner), value);
    });
    connectionPreferenceTail = saving.catch(() => {}); return saving;
  };
  const signDevice = async (payload, type) => {
    if (closed || !active) throw new Error('本机身份不可用。');
    const material = await store.get(`device:${active.subjectId}:${active.deviceId}`);
    if (!material) throw new Error('当前设备缺少身份材料，请用旧设备确认或恢复码恢复。');
    return signIdentityPayload(payload, material.privateKey, { type });
  };
  // snapshot() deliberately hides expired sessions. A reference invalidation
  // also fences connect/disconnect/close ABA while both snapshots are null;
  // the ordinary API remains the only owner of its numeric generation.
  let receiptLifecycle = {}, localDraftGeneration = 0;
  const invalidateReceiptLifecycle = () => { receiptLifecycle = {}; localDraftGeneration++; };
  const browserApi = createBrowserClient({ ...config, sign: signDevice, fetch, now, waitForClock });
  function markTaskRead(value, scope, seen = new WeakSet(), inheritedTaskId = null, projectionRead = null, purpose = null) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value); let found = false;
    const taskId=value.taskId??value.record?.taskId??(value.object?.type==='task'?value.object.id:value.type==='task'||value.recordKind==='task'?value.ref?.id??value.id:inheritedTaskId);
    const source=value.source??value.ref;
    if(purpose&&source){
      if(source.kind&&source.id&&source.payloadHash)projectionRead={source:{kind:source.kind,id:source.id,eventVersion:source.eventVersion,payloadHash:source.payloadHash},purpose};
      else if(source.publicationId&&source.sourceKey)projectionRead={publicationId:source.publicationId,sourceKey:source.sourceKey,purpose};
    }
    if (value.taskId && value.request || value.textView) {
      Object.defineProperty(value, '_webTaskScope', { value: scope, enumerable: false, configurable: true });
      if(taskId)Object.defineProperty(value,'_webTaskId',{value:taskId,enumerable:false,configurable:true}); found = true;
      if(projectionRead)Object.defineProperty(value,'_webTaskRead',{value:projectionRead,enumerable:false,configurable:true});
    }
    for (const nested of Object.values(value)) if (markTaskRead(nested, scope, seen, taskId, projectionRead, purpose)) found = true;
    return found;
  }
  const api = Object.freeze({ ...browserApi,
    async call(...args) { const scope = taskDraftScope().key, result = await browserApi.call(...args);
      const purpose=args[0].startsWith('/v2/requester-history/')?'requester-history':args[0].startsWith('/v2/contributions/')?args[1]?.purpose??'honor':null;
      if (markTaskRead(result, scope, new WeakSet(), null, null, purpose) && scope !== taskDraftScope().key) throw Object.assign(new Error('任务读取期间身份或连接已改变。'), { code: 'task_material_scope_changed' });
      return result; },
    async connect(...args) { const result = await browserApi.connect(...args); invalidateReceiptLifecycle(); return result; },
    disconnect() { invalidateReceiptLifecycle(); return browserApi.disconnect(); },
    close() { invalidateReceiptLifecycle(); return browserApi.close(); },
  });
  const fetchPublicControl = subjectId => api.call(`/v2/identity/${subjectId}/control`, undefined, { method: 'GET', authenticated: false });
  const trustDevice = createTrustPackageDeviceAdapter({endpoint:config.endpoint,now,getBinding:api.snapshot,
    getMaterial:async()=>{if(closed||!active)throw Object.assign(new Error('trust_identity_required'),{code:'trust_identity_required'});
      const selected=active,material=await device();
      if(active!==selected)throw Object.assign(new Error('trust_identity_changed'),{code:'trust_identity_changed'});
      return{subjectId:selected.subjectId,genesisProof:selected.genesisProof,material,localGenesis:false};},
    readIdentity:subjectId=>store.get(prefix+'trust-identity:'+subjectId),writeIdentity:(subjectId,value)=>store.put(prefix+'trust-identity:'+subjectId,value),
    fetchIdentity:fetchPublicControl});
  const publicControl = async subjectId => {const state=await fetchPublicControl(subjectId);await trustDevice.remember(state);return state;};
  function captureReceiptLease() {
    const owner = active, lifecycle = receiptLifecycle, binding = api.snapshot();
    const changed = () => { throw Object.assign(new Error('receipt_status_authority_changed'), { code: 'receipt_status_authority_changed' }); };
    const check = () => { const current = api.snapshot();
      if (closed || !owner || active !== owner || receiptLifecycle !== lifecycle
        || (binding === null) !== (current === null)
        || binding && ['subjectId', 'endpoint', 'bindingId', 'generation'].some(key => binding[key] !== current?.[key])) changed();
    };
    check(); return Object.freeze({subjectId:owner.subjectId,deviceId:owner.deviceId,endpoint:config.endpoint,
      bindingId:binding?.bindingId??null,generation:binding?.generation??null,assertCurrent:check});
  }
  function captureTaskDraftLease() {
    const owner = active, lifecycle = receiptLifecycle, binding = api.snapshot();
    const subjectId = owner?.subjectId ?? null, deviceId = owner?.deviceId ?? null;
    const check = () => {
      const current = api.snapshot();
      if (closed || active !== owner || (active?.subjectId ?? null) !== subjectId || (active?.deviceId ?? null) !== deviceId
        || receiptLifecycle !== lifecycle || (binding === null) !== (current === null)
        || binding && ['subjectId', 'endpoint', 'bindingId', 'generation'].some(key => binding[key] !== current?.[key]))
        throw Object.assign(new Error('当前本机身份或连接已改变，请重新读取原任务稿。'), { code: 'task_draft_scope_changed' });
    };
    check(); return Object.freeze({ subjectId, deviceId, endpoint: config.endpoint,
      bindingId: binding?.bindingId ?? null, generation: binding?.generation ?? null, assertCurrent: check });
  }
  function taskDraftScope() {
    const binding = api.snapshot(), subjectId = active?.subjectId ?? null, deviceId = active?.deviceId ?? null;
    return { subjectId, deviceId, closed, key: JSON.stringify([config.endpoint, subjectId, deviceId,
      binding?.bindingId ?? null, binding?.generation ?? null, localDraftGeneration, closed]) };
  }
  function createTaskDraftClient() {
    const lease = captureTaskDraftLease();
    const client = createTaskLocalDraftClient({ captureLease: () => lease,
      getLocal: (name, ownerKey) => store.get(prefix + ownerKey + ':' + name),
      updateLocal: (name, updater, ownerKey) => {
        if (typeof store.update !== 'function') throw new Error('local_atomic_update_unavailable');
        return store.update(prefix + ownerKey + ':' + name, updater);
      } });
    return Object.freeze({ ...client, ownerKey: lease.subjectId ?? 'visitor', check: lease.assertCurrent });
  }
  const receiptStatus = Object.freeze({ captureLease:captureReceiptLease, async query(input, options = {}) {
    const owner=active,lease=captureReceiptLease(),check=lease.assertCurrent;
    const getContext = async () => { check(); const current = await trustDevice.current(); check();
      if (current.identity.subjectId !== owner.subjectId) throw new Error('receipt_status_authority_changed');
      return { subjectId: owner.subjectId, endpoint: config.endpoint,
        control: { deviceId: current.epoch === 0 ? null : owner.deviceId, keyId: current.keyId, epoch: current.epoch },
        bindingId: lease.bindingId, generation: lease.generation };
    };
    const signReceiptStatus = createReceiptStatusDeviceSigner({ ...config, now, getContext,
      getPrivateKey: async () => { check(); const material = await store.get(`device:${owner.subjectId}:${owner.deviceId}`); check();
        if (!material?.privateKey) throw new Error('receipt_status_device_key_unavailable'); return material.privateKey;
      } });
    check(); const result = await createReceiptStatusClient({ ...config, now, fetch, getContext, signReceiptStatus }).query(input, options);
    check(); return result;
  } });
  let identityActivationTail = Promise.resolve();
  const saveActive = (value, options = {}) => {
    const operation = identityActivationTail.then(async () => {
      if (closed || (Object.hasOwn(options, 'expectedOwner') && options.expectedOwner !== active)) throw new Error('当前身份或页面已改变，请重新核对原身份操作。');
      await store.put(activeKey, value);
      if (closed) throw new Error('当前页面已关闭，请重新读取本机身份。');
      if (options.disconnect) api.disconnect();
      active = value; localDraftGeneration++;
    });
    identityActivationTail = operation.catch(() => {}); return operation;
  };
  const visitorDraftAdoption = createVisitorDraftAdoption({ store, prefix, getActive: async () => active });
  const visitorDraftPreviews = new WeakMap();
  const visitorDrafts = Object.freeze({
    async preview() {
      const original = await visitorDraftAdoption.preview(); if (!original) return null;
      const view = { ...original, visitorDraft: taskLocalDraftView(original.visitorDraft)?.value ?? null,
        existingDraft: taskLocalDraftView(original.existingDraft)?.value ?? null };
      visitorDraftPreviews.set(view, original); return view;
    },
    adopt(view, options) { return visitorDraftAdoption.adopt(visitorDraftPreviews.get(view), options); },
  });
  const deviceHandoff = createIdentityDeviceHandoff({ endpoint: config.endpoint, send: api.send, store, getActive: async () => active,
    activate: (value, options) => saveActive(value, {expectedOwner: options.expectedOwner, disconnect: true}),
    captureLease: () => { const lease = captureTaskDraftLease(); return { assertCurrent() {
      try { lease.assertCurrent(); } catch { throw Object.assign(new Error('device_handoff_owner_changed'), {code:'device_handoff_owner_changed'}); }
    } }; }, captureApprovalLease: captureReceiptLease, allowedScopes: browserScopes, now });
  const agentContinuity = createAgentIdentityEvidence({ endpoint: config.endpoint, website, store, getActive: () => active,
    getPendingHandoff: deviceHandoff.pending, publicControl, captureIdentityLease: identityLease, now });
  const deviceManagement = createIdentityDeviceManagement({ endpoint: config.endpoint, send: api.send, store,
    getActive: () => active, captureLease: captureReceiptLease, now });
  const identityClient = (material, newDevice = material, lease = identityLease()) => createIdentityControlClient({ endpoint: config.endpoint, now,
    send: (...args) => lease.wait(() => api.send(...args)),
    store: { get: key => lease.wait(() => store.get(key)), put: (key, value) => lease.wait(() => store.put(key, value)) },
    signController: challenge => lease.wait(() => signIdentityPayload(challenge, material.privateKey)),
    signNewDevice: challenge => lease.wait(() => signIdentityPayload(challenge, newDevice.privateKey)) });
  const ownerKey = value => value ? `${value.subjectId}:${value.deviceId}` : null;
  function identityLease() {
    const owner = active;
    const check = () => { if (closed || active !== owner) throw new Error('当前身份或页面已改变，请回到原身份重新核对原操作。'); };
    const wait = async action => { check(); const result = await action(); check(); return result; };
    return { owner, check, wait };
  }
  const identitySlots = [['new-identity', 'bootstrap'], ['recovery', 'set-recovery'], ['recover-operation', 'recover'], ['recovery-save-operation', 'declare-recovery-saved']];
  function ownsIdentityPending(slot, pending, owner) {
    if (Object.hasOwn(pending, 'owner')) return pending.owner === ownerKey(owner)
      || (slot === 'recover-operation' && owner?.subjectId === pending.subjectId && owner?.deviceId === pending.deviceId);
    // Compatibility for local operations created before explicit initiator metadata.
    if (slot === 'new-identity') return !owner;
    if (slot === 'recover-operation') return !owner || (owner.subjectId === pending.subjectId && owner.deviceId === pending.deviceId);
    return !!owner && owner.subjectId === pending.subjectId;
  }
  async function canUseIdentityPending(slot, pending, lease) {
    if (!ownsIdentityPending(slot, pending, lease.owner)) return false;
    if (Object.hasOwn(pending, 'owner') || slot === 'new-identity' || slot === 'recover-operation') return true;
    // Older recovery records have no owner field: the original signer must
    // still be this exact device, not merely another device of the same ID.
    const material = await lease.wait(() => store.get(`device:${lease.owner.subjectId}:${lease.owner.deviceId}`));
    return !!material && pending.signerKeyId === await lease.wait(() => identityKeyId(material.publicKeyPem));
  }
  const recoveryError = (code, message) => Object.assign(new Error(message), { code });
  function requireDisplayedRecoveryOperation(operationId) {
    if (typeof operationId !== 'string' || !operationId.trim()) throw recoveryError('recovery_display_operation_required', '请使用实际展示的准确恢复材料 operationId 确认保存。');
  }
  function requireRecoveryAtomicStore() {
    if (typeof store.update !== 'function') throw recoveryError('local_atomic_update_unavailable', '本机存储不支持原子更新，不能安全保存恢复材料。');
  }
  const recoveryUpdate = (key, updater, lease) => {
    requireRecoveryAtomicStore();
    return lease.wait(() => store.update(key, value => { lease.check(); return updater(value); }));
  };
  const releaseRecoverySlot = (slot, operationId, lease) => recoveryUpdate(prefix + slot,
    current => current?.operationId === operationId ? null : current, lease);
  function sameRecoveryPreparation(left, right) {
    return !!left && !!right && ['operationId', 'subjectId', 'owner', 'expectedEpoch', 'previousEventHash', 'signerKeyId', 'generation', 'publicKeyPem']
      .every(key => left[key] === right[key]);
  }
  async function retainRecoveryReceipt(subjectId, operationId, receipt, lease, { purge = false, publicKeyPem } = {}) {
    if (receipt.subjectId !== subjectId || receipt.operationId !== operationId || receipt.state !== 'committed') throw new Error('原恢复材料回执不一致。');
    return recoveryUpdate(`pending-recovery:${subjectId}:${operationId}`, current => {
      if (!current || current.operationId !== operationId) throw new Error('原恢复材料已不可用。');
      if (purge) return { operationId, publicKeyPem: current.publicKeyPem ?? publicKeyPem, receipt, saveDeclared: true, status: 'registered-save-declared' };
      return { ...current, receipt, status: current.saveDeclared ? 'registered-save-declared' : 'registered-awaiting-save-declaration' };
    }, lease);
  }
  async function currentOriginalIdentityDevice(pending, receipt, material, lease) {
    const control = await lease.wait(() => publicControl(pending.subjectId)), keyId = await lease.wait(() => identityKeyId(material.publicKeyPem));
    const current = control.devices.find(row => row.device_id === pending.deviceId && row.status === 'active' && row.epoch === control.epoch);
    if (!current || receipt.epoch !== control.epoch || current.public_key !== material.publicKeyPem || current.key_id !== keyId
      || pending.request?.newDevice && pending.request.newDevice.publicKeyPem !== material.publicKeyPem)
      throw recoveryError('recovery_device_not_current', '原操作对应的设备已失效，请核对当前身份控制。');
    return control;
  }
  async function retireOriginalRecovery(pending, record, lease) {
    const requestHash = record?.request ? await lease.wait(() => sha256Hex(JSON.stringify(record.request))) : null;
    await recoveryUpdate(prefix + 'recovery-operation-history:' + pending.subjectId, history => [...(history ?? []).filter(item => item.operationId !== pending.operationId),
      { operationId: pending.operationId, subjectId: pending.subjectId, kind: 'recover', originalOwner: pending.owner ?? null,
        expectedEpoch: pending.request.expectedEpoch, signerKeyId: pending.request.signerKeyId, requestHash, state: record?.state ?? 'local-prepared',
        reason: 'explicit-new-recovery-after-original-ended', retiredAt: now() }], lease);
    await recoveryUpdate(prefix + 'recover-operation', current => {
      if (current?.operationId !== pending.operationId || !equalJson(current, pending)) throw recoveryError('recovery_display_operation_changed', '原恢复操作已经改变，请重新读取。');
      return null;
    }, lease);
    await recoveryUpdate(`pending-recovery:${pending.subjectId}:${pending.operationId}`, current => current ? {
      operationId: pending.operationId, publicKeyPem: current.publicKeyPem, saveDeclared: false, status: 'original-ended-before-recovery' } : current, lease);
  }
  async function archivePriorRecoveryPreparation(pending, lease, currentControl) {
    const record = await lease.wait(() => store.get(`identity-operation:${config.endpoint}:${pending.operationId}`));
    const historyKey = prefix + 'recovery-operation-history:' + pending.subjectId;
    const requestHash = record?.request ? await lease.wait(() => sha256Hex(JSON.stringify(record.request))) : null;
    const retired = { operationId: pending.operationId, subjectId: pending.subjectId, kind: 'set-recovery', originalOwner: pending.owner ?? null,
      signerKeyId: pending.signerKeyId, expectedEpoch: pending.expectedEpoch, requestHash, state: record?.state ?? 'local-prepared',
      reason: 'another-device-or-identity-selected', retiredAt: now() };
    // Keep the exact original operation and its query proof in their existing
    // operation store. This index contains neither recovery code nor retry input.
    await recoveryUpdate(historyKey, history => [...(history ?? []).filter(item => item.operationId !== pending.operationId), retired], lease);
    const replaced = lease.owner?.request?.kind === 'recover' && pending.subjectId === lease.owner.subjectId
      && pending.expectedEpoch < currentControl.epoch
      && currentControl.devices.some(row => row.device_id === lease.owner.deviceId && row.status === 'active' && row.epoch === currentControl.epoch);
    if (replaced) {
      const materialKey = `pending-recovery:${pending.subjectId}:${pending.operationId}`;
      await recoveryUpdate(materialKey, material => material ? { operationId: pending.operationId, publicKeyPem: pending.publicKeyPem,
        saveDeclared: !!material.saveDeclared, status: 'superseded-by-identity-recovery' } : material, lease);
    }
    await recoveryUpdate(prefix + 'recovery', current => {
      if (!sameRecoveryPreparation(current, pending)) throw recoveryError('recovery_display_operation_changed', '原恢复材料已经改变，请重新读取。');
      return null;
    }, lease);
  }
  async function localIdentityOperations(lease) {
    const rows = [];
    for (const [slot, kind] of identitySlots) {
      const pending = await lease.wait(() => store.get(prefix + slot));
      if (!pending || !await canUseIdentityPending(slot, pending, lease)) continue;
      const record = await lease.wait(() => store.get(`identity-operation:${config.endpoint}:${pending.operationId}`));
      if (!record) continue;
      if (record && (record.request.subjectId !== pending.subjectId || record.request.kind !== kind)) throw new Error('原身份操作记录不一致。');
      rows.push({ slot, kind, pending, state: record?.state ?? 'prepared' });
    }
    return rows;
  }
  async function pendingIdentityOperations() {
    const lease = identityLease();
    return (await localIdentityOperations(lease)).map(({ kind, pending, state }) => ({ kind, operationId: pending.operationId, subjectId: pending.subjectId, state }));
  }
  async function readOriginalIdentityOperation(operationId, lease) {
    const row = (await localIdentityOperations(lease)).find(item => item.pending.operationId === operationId);
    if (!row) throw new Error('当前身份没有这个待核对的原操作。');
    const operationKey = `identity-operation:${config.endpoint}:${operationId}`;
    const original = await lease.wait(() => store.get(operationKey));
    if (!original || original.request?.operationId !== operationId || original.request.subjectId !== row.pending.subjectId
      || original.request.kind !== row.kind) throw new Error('原身份操作记录不一致。');
    const originalBytes = JSON.stringify([original.request, original.commit ?? null]);
    const read = async key => {
      const value = await lease.wait(() => store.get(key));
      if (key === operationKey && JSON.stringify([value?.request, value?.commit ?? null]) !== originalBytes)
        throw new Error('原身份请求或已保存签名已变化，请重新读取原操作。');
      return value;
    };
    const client = createIdentityControlClient({ endpoint: config.endpoint, now,
      store: { get: read, put: async (key, value) => { await read(key); return lease.wait(() => store.put(key, value)); } },
      send: (...args) => lease.wait(() => api.send(...args)),
      signController: () => { throw new Error('只查询原操作不会签署新的身份变更。'); } });
    const receipt = await lease.wait(() => client.status(operationId));
    return { ...row, receipt, client, hasOriginalCommit: !!original.commit };
  }
  async function queryIdentityOperation(operationId) {
    const { kind, receipt, hasOriginalCommit } = await readOriginalIdentityOperation(operationId, identityLease());
    return { kind, operationId: receipt.operationId, subjectId: receipt.subjectId, state: receipt.state,
      registered: receipt.registered !== false, hasOriginalCommit,
      canContinueOriginalCommit: receipt.state === 'requested' && hasOriginalCommit,
      requiresOriginalPreparation: !hasOriginalCommit && !['committed', 'expired', 'canceled'].includes(receipt.state) };
  }
  async function continueIdentityOperation(operationId, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认使用这个已确认结果在本机继续。');
    const lease = identityLease(), original = await readOriginalIdentityOperation(operationId, lease);
    const { slot, kind, pending, client, hasOriginalCommit } = original;
    let receipt = original.receipt;
    // A signed original may have stopped before its commit reached the service.
    // Read its exact status first, then transport the same saved commit only.
    // This client has no signing capability and its store fences changed bytes.
    if (receipt.state === 'requested' && hasOriginalCommit)
      receipt = await lease.wait(() => client.retry(operationId, { confirmed: true }));
    if (receipt.state !== 'committed') throw new Error('原操作还没有得到服务确认，不能在本机继续。');
    let replacementCode;
    if (kind === 'bootstrap' || kind === 'recover') {
      const material = await lease.wait(() => store.get(`device:${pending.subjectId}:${pending.deviceId}`));
      if (!material) throw new Error('原操作的本机设备材料已不可用。');
      await currentOriginalIdentityDevice(pending, receipt, material, lease);
      if (kind === 'recover') {
        const next = await lease.wait(() => store.get(`pending-recovery:${pending.subjectId}:${pending.operationId}`));
        replacementCode = next?.code;
        await retainRecoveryReceipt(pending.subjectId, pending.operationId, receipt, lease);
      }
      lease.check();
      await saveActive(pending, { expectedOwner: lease.owner, disconnect: kind === 'recover' });
      if (closed || active !== pending) throw new Error('当前身份或页面已改变，请重新核对。');
      if (kind === 'bootstrap') await store.put(prefix + slot, null);
    } else {
      const recoveryOperationId = kind === 'set-recovery' ? pending.operationId : pending.recoveryOperationId ?? lease.owner?.operationId;
      if (!recoveryOperationId) throw new Error('原恢复材料引用已不可用。');
      if (kind === 'set-recovery') await retainRecoveryReceipt(pending.subjectId, recoveryOperationId, receipt, lease, { purge: true, publicKeyPem: pending.publicKeyPem });
      else await recoveryUpdate(`pending-recovery:${pending.subjectId}:${recoveryOperationId}`, current => {
        if (!current || current.operationId !== recoveryOperationId) throw new Error('原恢复材料引用已不可用。');
        return { operationId: recoveryOperationId, publicKeyPem: current.publicKeyPem, receipt, saveDeclared: true, status: 'registered-save-declared' };
      }, lease);
      await releaseRecoverySlot(slot, pending.operationId, lease);
      if (kind === 'declare-recovery-saved') await releaseRecoverySlot('recover-operation', recoveryOperationId, lease);
    }
    return { ...await status(), kind, operationId,
      ...(kind === 'declare-recovery-saved' ? { recoveryOperationId: pending.recoveryOperationId ?? lease.owner?.operationId } : {}),
      ...(replacementCode ? { replacementCode } : {}) };
  }
  async function device() {
    if (!active) throw new Error('先创建或连接已有银河身份。');
    const material = await store.get(`device:${active.subjectId}:${active.deviceId}`);
    if (!material) throw new Error('本机设备身份材料不可用。'); return material;
  }
  async function createIdentity({ confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认创建本机身份并连接所示银河服务。');
    const lease = identityLease(); lease.check();
    if (active) return status();
    let pending = await lease.wait(() => store.get(prefix + 'new-identity'));
    if (pending && !ownsIdentityPending('new-identity', pending, lease.owner)) throw new Error('请先核对原身份操作。');
    if (!pending) {
      const material = await createDeviceMaterial(), genesis = await createBrowserGenesis({ publicKeyPem: material.publicKeyPem, originCode: '5' });
      lease.check();
      pending = { subjectId: genesis.id, genesisProof: genesis.genesisProof, deviceId: material.deviceId, installationId: crypto.randomUUID(), operationId: crypto.randomUUID(), owner: ownerKey(lease.owner) };
      await lease.wait(() => store.put(`device:${genesis.id}:${material.deviceId}`, material));
      await lease.wait(() => store.put(prefix + 'new-identity', pending));
    }
    lease.check();
    const material = await lease.wait(() => store.get(`device:${pending.subjectId}:${pending.deviceId}`)), client = identityClient(material, material, lease);
    const savedOperation = await lease.wait(() => store.get(`identity-operation:${config.endpoint}:${pending.operationId}`));
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
    lease.check(); await saveActive(pending, { expectedOwner: lease.owner }); await store.put(prefix + 'new-identity', null); return status();
  }
  /** @param {number} intent @param {string[]|null} permittedScopes @param {{bindingId:string,receipt:string}|null} originalBinding */
  async function establishConnection(intent, permittedScopes = null, originalBinding = null) {
    const lease = identityLease(), selected = lease.owner;
    const check = () => { lease.check(); if (!selected || connectionIntent !== intent) throw new Error('当前连接选择已改变。'); };
    check();
    const state = await lease.wait(() => publicControl(selected.subjectId)), material = await lease.wait(device);
    check();
    const current = state.devices.find(row => row.device_id === selected.deviceId && row.status === 'active' && row.epoch === state.epoch);
    if (!current) throw new Error('当前设备已失效，请使用旧设备确认或恢复码恢复。');
    const keyId = await lease.wait(() => identityKeyId(material.publicKeyPem));
    check();
    const scopes = browserScopes.filter(scope => (current.scopes.includes(scope) || current.scopes.includes('*'))
      && (!permittedScopes || permittedScopes.includes(scope)));
    if (!scopes.includes('binding')) throw Object.assign(new Error('当前设备已无法继续原连接。'), {code:'connection_scope_unavailable'});
    const result = await lease.wait(() => api.connect({ subjectId: selected.subjectId, genesisProof: state.genesisProof, installationId: selected.installationId,
      scopes, control: { deviceId: selected.deviceId, keyId, epoch: state.epoch } }, { confirmed: true,
        ...(originalBinding?{binding:originalBinding}:{}) }));
    check();
    await saveConnectionPreference(selected, {version:1,enabled:true,endpoint:config.endpoint,subjectId:selected.subjectId,
      deviceId:selected.deviceId,scopes:[...result.scopes],binding:api.bindingRecord()}, intent);
    check(); return result;
  }
  async function connect({ confirmed = false, scopes = null } = {}) {
    if (!active || !confirmed) throw new Error('请确认连接当前身份。');
    if (scopes && (!Array.isArray(scopes) || !scopes.includes('binding') || new Set(scopes).size !== scopes.length
      || scopes.some(scope => !browserScopes.includes(scope)))) throw new Error('当前连接的权限选择不可用。');
    return establishConnection(++connectionIntent, scopes ? [...scopes] : null);
  }
  async function resumeConnection() {
    const current = api.snapshot(); if (current) return current;
    if (closed || !active) return null;
    if (resumingConnection) return resumingConnection;
    const selected = active, intent = connectionIntent;
    const check = () => { if (closed || active !== selected || connectionIntent !== intent) throw new Error('当前连接选择已改变。'); };
    const resuming = (async () => {
      await connectionPreferenceTail; check();
      const saved = await store.get(connectionPreferenceKey(selected)); check();
      if (!saved?.enabled) return null;
      if (saved.version !== 1 || saved.endpoint !== config.endpoint || saved.subjectId !== selected.subjectId || saved.deviceId !== selected.deviceId
        || !Array.isArray(saved.scopes) || !saved.scopes.includes('binding') || new Set(saved.scopes).size !== saved.scopes.length
        || saved.scopes.some(scope => !browserScopes.includes(scope))) throw new Error('本机保存的连接选择不可用。');
      // Reopening or expiry repeats only the last approved device connection.
      // Current control is checked again, and scopes can shrink but never grow.
      return establishConnection(intent, saved.scopes, saved.binding??null);
    })();
    resumingConnection = resuming;
    try { return await resuming; } finally { if (resumingConnection === resuming) resumingConnection = null; }
  }
  function disconnect() {
    const selected = active, intent = ++connectionIntent; api.disconnect();
    if (!selected) return Promise.resolve();
    return saveConnectionPreference(selected, {version:1,enabled:false,endpoint:config.endpoint,
      subjectId:selected.subjectId,deviceId:selected.deviceId,scopes:[]}, intent);
  }
  async function prepareRecovery() {
    const lease = identityLease(), selected = lease.owner;
    requireRecoveryAtomicStore();
    const material = await lease.wait(device), state = await lease.wait(() => publicControl(selected.subjectId));
    let pending = await lease.wait(() => store.get(prefix + 'recovery'));
    if (pending && !await canUseIdentityPending('recovery', pending, lease)) { await archivePriorRecoveryPreparation(pending, lease, state); pending = null; }
    if (!pending) {
      const operationId = crypto.randomUUID(), recovery = await lease.wait(() => store.prepareRecovery(selected.subjectId, operationId));
      const candidate = { subjectId: selected.subjectId, operationId, owner: ownerKey(selected), expectedEpoch: state.epoch, previousEventHash: state.chainHead,
        signerKeyId: await lease.wait(() => identityKeyId(material.publicKeyPem)), generation: state.recovery?.generation ?? 0, publicKeyPem: recovery.publicKeyPem };
      pending = await recoveryUpdate(prefix + 'recovery', current => current ?? candidate, lease);
      if (pending.operationId !== operationId) await recoveryUpdate(`pending-recovery:${selected.subjectId}:${operationId}`, current => current ? {
        operationId, publicKeyPem: current.publicKeyPem, saveDeclared: false, status: 'unclaimed-local-preparation' } : current, lease);
    }
    if (!await canUseIdentityPending('recovery', pending, lease)) throw recoveryError('recovery_display_operation_changed', '当前恢复材料已改变，请回到原身份重新读取。');
    const recovery = await lease.wait(() => store.get(`pending-recovery:${selected.subjectId}:${pending.operationId}`));
    if (!recovery?.code || recovery.publicKeyPem !== pending.publicKeyPem) throw recoveryError('recovery_display_operation_changed', '当前恢复材料已经保存或改变，请重新读取。');
    return { operationId: pending.operationId, subjectId: selected.subjectId, code: recovery.code, replaces: pending.generation > 0 };
  }
  /** @param {{operationId?: string, confirmed?: boolean}} [options] */
  async function saveRecovery({ operationId, confirmed = false } = {}) {
    if (!confirmed) throw new Error('请在复制或下载后声明已保存。');
    requireDisplayedRecoveryOperation(operationId); requireRecoveryAtomicStore();
    const lease = identityLease(), selected = lease.owner;
    const displayed = await lease.wait(() => store.get(prefix + 'recovery'));
    if (!displayed || displayed.operationId !== operationId || !await canUseIdentityPending('recovery', displayed, lease)) throw recoveryError('recovery_display_operation_changed', '实际展示的恢复材料已经改变，不能确认另一份材料。');
    const pending = await recoveryUpdate(prefix + 'recovery', current => {
      if (!sameRecoveryPreparation(current, displayed)) throw recoveryError('recovery_display_operation_changed', '实际展示的恢复材料已经改变，请重新读取。');
      return current;
    }, lease);
    await recoveryUpdate(`pending-recovery:${selected.subjectId}:${pending.operationId}`, current => {
      if (!current || current.operationId !== operationId || current.publicKeyPem !== pending.publicKeyPem) throw recoveryError('recovery_display_operation_changed', '实际展示的恢复材料已经改变，请重新读取。');
      return { ...current, saveDeclared: true };
    }, lease);
    const material = await lease.wait(device), client = identityClient(material, material, lease), request = { version: 2, kind: 'set-recovery', operationId: pending.operationId,
      subjectId: pending.subjectId, expectedEpoch: pending.expectedEpoch, previousEventHash: pending.previousEventHash, signerKeyId: pending.signerKeyId,
      recoveryGeneration: pending.generation, nextRecoveryPublicKey: pending.publicKeyPem, saveDeclaration: true };
    const savedOperation = await lease.wait(() => store.get(`identity-operation:${config.endpoint}:${pending.operationId}`));
    let receipt = savedOperation?.commit ? await client.status(pending.operationId) : await client.confirm(await client.prepare(request), { confirmed: true });
    if (receipt.state === 'requested') receipt = await client.retry(pending.operationId, { confirmed: true });
    if (receipt.state !== 'committed') throw new Error('恢复材料保存状态待查询。');
    // Once the user has saved it, keep only the local receipt, not a second copy
    // of the recovery secret alongside the device whose loss it should survive.
    await retainRecoveryReceipt(selected.subjectId, pending.operationId, receipt, lease, { purge: true, publicKeyPem: pending.publicKeyPem });
    await releaseRecoverySlot('recovery', pending.operationId, lease); return receipt;
  }
  async function recover(code, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('请确认恢复同一身份并撤销旧设备控制。');
    requireRecoveryAtomicStore();
    const lease = identityLease();
    try { const parsed = parseRecoveryCode(code); parsed.seed.fill(0); }
    catch { throw recoveryError('recovery_code_invalid', '恢复码格式不完整或不受支持，请核对保存的原码。'); }
    const recovery = await lease.wait(() => importRecoveryMaterial(code)), state = await lease.wait(() => publicControl(recovery.subjectId));
    let pending = await lease.wait(() => store.get(prefix + 'recover-operation'));
    if (pending && !ownsIdentityPending('recover-operation', pending, lease.owner)) throw new Error('另一个身份仍有原恢复操作待核对，请先回到原身份。');
    if (pending && pending.subjectId !== recovery.subjectId) throw new Error('请先核对原恢复操作，不会用另一恢复码覆盖它。');
    if (pending) {
      const record = await lease.wait(() => store.get(`identity-operation:${config.endpoint}:${pending.operationId}`));
      const original = record?.commit ? await identityClient(recovery, recovery, lease).status(pending.operationId) : null;
      // Only this explicit recovery choice may prepare again after an exact
      // terminal result (or an unsigned expired local challenge). Background
      // continuation never replaces the original ID, signatures or deadline.
      if (['expired', 'canceled'].includes(original?.state) || record && !record.commit && record.expiresAt <= now()) {
        if (state.recovery?.publicKeyPem !== recovery.publicKeyPem) throw recoveryError('recovery_material_not_current', '恢复码已更换、已使用或不属于当前身份。');
        await retireOriginalRecovery(pending, { ...record, state: original?.state ?? record.state }, lease); pending = null;
      }
    }
    if (!pending) {
      if (state.recovery?.publicKeyPem !== recovery.publicKeyPem) throw recoveryError('recovery_material_not_current', '恢复码已更换、已使用或不属于当前身份。');
      const material = await lease.wait(createDeviceMaterial), operationId = crypto.randomUUID();
      await lease.wait(() => store.put(`device:${recovery.subjectId}:${material.deviceId}`, material));
      const next = await lease.wait(() => store.prepareRecovery(recovery.subjectId, operationId));
      const candidate = { subjectId: recovery.subjectId, genesisProof: state.genesisProof, deviceId: material.deviceId, installationId: crypto.randomUUID(), operationId, owner: ownerKey(lease.owner),
        request: { version: 2, kind: 'recover', operationId, subjectId: recovery.subjectId, expectedEpoch: state.epoch, previousEventHash: state.chainHead,
          signerKeyId: await lease.wait(() => identityKeyId(recovery.publicKeyPem)), recoveryGeneration: state.recovery.generation, nextRecoveryPublicKey: next.publicKeyPem,
          newDevice: { deviceId: material.deviceId, publicKeyPem: material.publicKeyPem, scopes: ['manage-identity', ...browserScopes] } } };
      pending = await recoveryUpdate(prefix + 'recover-operation', current => current ?? candidate, lease);
      if (pending.operationId !== operationId) await recoveryUpdate(`pending-recovery:${recovery.subjectId}:${operationId}`, current => current ? {
        operationId, publicKeyPem: current.publicKeyPem, saveDeclared: false, status: 'unclaimed-local-preparation' } : current, lease);
    }
    if (!ownsIdentityPending('recover-operation', pending, lease.owner) || pending.subjectId !== recovery.subjectId)
      throw recoveryError('recovery_display_operation_changed', '原恢复操作已由另一身份选择，请重新读取。');
    const material = await lease.wait(() => store.get(`device:${pending.subjectId}:${pending.deviceId}`)), client = identityClient(recovery, material, lease);
    if (!material) throw recoveryError('recovery_device_material_unavailable', '原恢复操作的本机设备材料已不可用。');
    const savedOperation = await lease.wait(() => store.get(`identity-operation:${config.endpoint}:${pending.operationId}`));
    if (!savedOperation?.commit && (state.recovery?.publicKeyPem !== recovery.publicKeyPem
      || pending.request.signerKeyId !== await lease.wait(() => identityKeyId(recovery.publicKeyPem))))
      throw recoveryError('recovery_material_not_current', '恢复码已更换、已使用或不属于这次原恢复操作。');
    let receipt = savedOperation?.commit ? await client.status(pending.operationId) : await client.confirm(await client.prepare(pending.request), { confirmed: true });
    if (receipt.state === 'requested') receipt = await client.retry(pending.operationId, { confirmed: true });
    if (receipt.state !== 'committed') throw new Error('恢复操作尚未完成，请查询原操作。');
    await currentOriginalIdentityDevice(pending, receipt, material, lease);
    await retainRecoveryReceipt(pending.subjectId, pending.operationId, receipt, lease);
    const next = await lease.wait(() => store.get(`pending-recovery:${pending.subjectId}:${pending.operationId}`));
    await saveActive(pending, { expectedOwner: lease.owner, disconnect: true });
    if (closed || active !== pending) throw new Error('当前身份或页面已改变，请重新核对。');
    return { ...await status(), replacementCode: next.code, operationId: pending.operationId };
  }
  /** @param {{operationId?: string, confirmed?: boolean}} [options] */
  async function confirmRecoveredCode({ operationId, confirmed = false } = {}) {
    if (!confirmed || !active?.request || active.request.kind !== 'recover') throw new Error('没有待确认的恢复后材料。');
    requireDisplayedRecoveryOperation(operationId); requireRecoveryAtomicStore();
    const lease = identityLease(), selected = lease.owner;
    if (operationId !== selected.operationId) throw recoveryError('recovery_display_operation_changed', '实际展示的恢复后材料已经改变，请重新读取。');
    const state = await lease.wait(() => publicControl(selected.subjectId)), originalGeneration = selected.request.recoveryGeneration + 1;
    if (state.recovery?.generation !== originalGeneration || state.recovery.publicKeyPem !== selected.request.nextRecoveryPublicKey) throw recoveryError('recovery_material_not_current', '实际展示的恢复后材料已被更换，不能声明当前另一份恢复码已保存。');
    const material = await lease.wait(device), client = identityClient(material, material, lease), key = prefix + 'recovery-save-operation';
    let request = await lease.wait(() => store.get(key));
    if (request && !await canUseIdentityPending('recovery-save-operation', request, lease)) throw new Error('请先回到原身份核对新码保存声明。');
    if (!request || request.subjectId !== selected.subjectId) {
      const candidate = { version: 2, kind: 'declare-recovery-saved', operationId: crypto.randomUUID(), subjectId: selected.subjectId, expectedEpoch: state.epoch,
        previousEventHash: state.chainHead, signerKeyId: await lease.wait(() => identityKeyId(material.publicKeyPem)), recoveryGeneration: originalGeneration, saveDeclaration: true,
        owner: ownerKey(selected), recoveryOperationId: operationId };
      request = await recoveryUpdate(key, current => current ?? candidate, lease);
    }
    if (!await canUseIdentityPending('recovery-save-operation', request, lease) || request.subjectId !== selected.subjectId
      || request.recoveryGeneration !== originalGeneration || request.recoveryOperationId && request.recoveryOperationId !== operationId) throw recoveryError('recovery_display_operation_changed', '原恢复后材料保存操作已经改变，请核对原操作。');
    const saved = await lease.wait(() => store.get(`identity-operation:${config.endpoint}:${request.operationId}`));
    const { owner: _owner, recoveryOperationId: _recoveryOperationId, ...publicRequest } = request;
    let receipt = saved?.commit ? await client.status(request.operationId) : await client.confirm(await client.prepare(publicRequest), { confirmed: true });
    if (receipt.state === 'requested') receipt = await client.retry(request.operationId, { confirmed: true });
    if (receipt.state !== 'committed') throw new Error('恢复材料保存声明尚未确认。');
    await recoveryUpdate(`pending-recovery:${selected.subjectId}:${operationId}`, current => {
      if (!current || current.operationId !== operationId || current.publicKeyPem !== selected.request.nextRecoveryPublicKey) throw recoveryError('recovery_display_operation_changed', '原恢复后材料已经改变，请核对原回执。');
      return { operationId, publicKeyPem: current.publicKeyPem, receipt, status: 'registered-save-declared', saveDeclared: true };
    }, lease);
    await releaseRecoverySlot('recover-operation', operationId, lease); await releaseRecoverySlot('recovery-save-operation', request.operationId, lease); return receipt;
  }
  async function pendingRecoveryCode() {
    const lease = identityLease(), selected = lease.owner;
    if (!selected) return null;
    const recovered = selected.request?.kind === 'recover' && await lease.wait(() => store.get(`pending-recovery:${selected.subjectId}:${selected.operationId}`));
    if (recovered?.code) {
      const material = await lease.wait(() => store.get(`device:${selected.subjectId}:${selected.deviceId}`));
      if (!material) throw recoveryError('recovery_device_material_unavailable', '原恢复操作的本机设备材料已不可用。');
      const control = await currentOriginalIdentityDevice(selected, recovered.receipt, material, lease);
      if (control.recovery?.generation !== selected.request.recoveryGeneration + 1 || control.recovery.publicKeyPem !== selected.request.nextRecoveryPublicKey)
        throw recoveryError('recovery_material_not_current', '原恢复后的材料已被更换，不能再作为当前恢复码展示。');
      return { operationId: selected.operationId, subjectId: selected.subjectId, code: recovered.code, recovered: true };
    }
    const pending = await lease.wait(() => store.get(prefix + 'recovery'));
    if (!pending || !await canUseIdentityPending('recovery', pending, lease)) return null;
    const material = await lease.wait(() => store.get(`pending-recovery:${selected.subjectId}:${pending.operationId}`));
    return material?.code ? { operationId: pending.operationId, subjectId: selected.subjectId, code: material.code, recovered: false } : null;
  }
  async function status() { return { identity: active ? { subjectId: active.subjectId, deviceId: active.deviceId } : null, connection: api.snapshot(), endpoint: config.endpoint, localDraftGeneration }; }
  const localKey = name => prefix + (active?.subjectId ?? 'visitor') + ':' + name;
  function taskLease() {
    const connection = api.snapshot();
    if (closed || !connection || !active) throw new Error('请连接当前身份并重新核对本次任务操作。');
    return { owner: active, subjectId: connection.subjectId, endpoint: connection.endpoint, bindingId: connection.bindingId, generation: connection.generation };
  }
  function checkTaskLease(lease) {
    const connection = api.snapshot();
    if (closed || active !== lease.owner || !connection || ['subjectId', 'endpoint', 'bindingId', 'generation'].some(key => connection[key] !== lease[key]))
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
    const key = localKey(taskQueueName(taskId)), historyKey = localKey(stoppedQueueName(taskId)), owner = active;
    const current = await reviewTaskStop(taskId);
    publicationLease?.assertCurrent();
    if (current.state === 'none' || current.state === 'acknowledged') return current;
    if (owner !== active || current.eventId !== preview?.eventId || current.payloadHash !== preview?.payloadHash || current.taskId !== preview?.taskId)
      throw new Error('原操作或身份已经变化，请重新核对停止预览。');
    return withTaskQueue(async () => {
      publicationLease?.assertCurrent();
      if (owner !== active) throw new Error('身份已变化，请在原身份停止原操作。');
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
    const key = localKey(stoppedQueueName(taskId)), owner = active;
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
    if (owner !== active) throw new Error('身份已变化，请在原身份查询。');
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
  const accounts = createAccountVerificationClient({ api, endpoint: config.endpoint, captureLease: captureReceiptLease, now,
    getLocal: (name, subjectId) => store.get(prefix + subjectId + ':' + name),
    updateLocal: (name, updater, subjectId) => {
      if (typeof store.update !== 'function') throw new Error('local_atomic_update_unavailable');
      return store.update(prefix + subjectId + ':' + name, updater);
    },
    sign: async (payload, type, lease) => {
      lease.assertCurrent();
      if (type !== 'galaxy-identity-link+jws') throw new Error('账号关联签名类型不可用。');
      const material = await store.get(`device:${lease.subjectId}:${lease.deviceId}`); lease.assertCurrent();
      if (!material?.privateKey) throw new Error('原设备缺少账号关联签名材料。');
      const signed = await signIdentityPayload(payload, material.privateKey, { type }); lease.assertCurrent(); return signed;
    } });
  const confirmAccountLink = (id, options) => accounts.confirm(id, options);
  const chatClients = new Map();
  function currentChat() {
    const subjectId = active?.subjectId ?? null;
    if (!chatClients.has(subjectId)) {
      const ownerPrefix = prefix + (subjectId ?? 'visitor') + ':';
      chatClients.set(subjectId, createChatClient({ api, subjectId, captureLease: captureReceiptLease,
        getLocal: name => store.get(ownerPrefix + name), putLocal: (name, value) => store.put(ownerPrefix + name, value),
        updateLocal: (name, updater) => {
          if (typeof store.update !== 'function') throw new Error('local_atomic_update_unavailable');
          return store.update(ownerPrefix + name, updater);
        } }));
    }
    return chatClients.get(subjectId);
  }
  function currentNotifications(){
    const lease=captureReceiptLease();
    return createNotificationInboxClient({call:async(path,input,options)=>{
      lease.assertCurrent();const connection=api.snapshot();
      if(!connection)throw Object.assign(new Error('connection_required'),{code:'connection_required'});
      if(!connection.scopes.includes('notifications')&&!connection.scopes.includes('*'))throw Object.assign(new Error('当前浏览器设备未获准读取或处理通知（notifications）。请在已有 Agent 的本机审阅页明确批准这一权限；原任务连接仍可继续。'),{code:'notification_device_scope_required',scope:'notifications'});
      try{const result=await api.call(path,input,options);lease.assertCurrent();return result;}catch(error){lease.assertCurrent();throw error;}
    }});
  }
  const privacy = createPrivacyClient({ api, now, captureLease: captureReceiptLease,
    getLocal: (name, originalSubjectId) => name === 'task-publication' ? readTaskPublication(originalSubjectId) : store.get(originalSubjectId === undefined ? localKey(name) : prefix + originalSubjectId + ':' + name),
    putLocal: (name, value, originalSubjectId) => store.put(originalSubjectId === undefined ? localKey(name) : prefix + originalSubjectId + ':' + name, value),
    identity: async () => active ? { subjectId: active.subjectId, deviceId: active.deviceId } : null,
    sign: async (payload, type, deviceId) => {
      if (closed || !active || !['galaxy-deletion-intent+jws', 'galaxy-deletion-status+jws'].includes(type)) throw new Error('本机删除证明签名不可用。');
      const lease = captureReceiptLease();
      const material = await store.get(`device:${lease.subjectId}:${deviceId}`); lease.assertCurrent();
      if (!material) throw new Error('此浏览器没有原申请设备的身份材料；请使用原设备查询删除后回执。');
      const signed = await signIdentityPayload(payload, material.privateKey, { type }); lease.assertCurrent(); return signed;
    } });
  const trustPackages=Object.freeze({...createTrustPackageClient({api,now,current:trustDevice.current,sign:trustDevice.sign,signVc:trustDevice.signVc,captureLease:captureReceiptLease,
    getLocal:(name,originalSubjectId)=>store.get(originalSubjectId===undefined?localKey(name):prefix+originalSubjectId+':'+name),
    putLocal:(name,value,originalSubjectId)=>store.put(originalSubjectId===undefined?localKey(name):prefix+originalSubjectId+':'+name,value)}),refreshIdentity:trustDevice.refreshIdentity,
    captureLease:async()=>{const lease=captureReceiptLease(),current=await trustDevice.current();lease.assertCurrent();
      return Object.freeze({...lease,keyId:current.keyId,epoch:current.epoch});}});
  let groupSubject=null,groupClient=null;
  const groupSigner=createIdentityGroupDeviceSignerV2({endpoint:config.endpoint,current:trustDevice.refreshIdentity,getMaterial:async()=>{if(closed)throw new Error('identity_group_identity_changed');return device();}});
  function identityGroups(){const subjectId=active?.subjectId;if(closed||!subjectId)return null;
    if(groupSubject!==subjectId){groupSubject=subjectId;const check=()=>{if(closed||active?.subjectId!==subjectId)throw new Error('identity_group_identity_changed');};
      groupClient=createIdentityGroupClientV2({api,subjectId,now,sign:groupSigner,getLocal:async name=>{check();const v=await store.get(prefix+subjectId+':'+name);check();return v;},putLocal:async(name,value)=>{check();await store.put(prefix+subjectId+':'+name,value);check();}});}
    return groupClient;}
  return Object.freeze({ api, accounts, get chat(){return currentChat();}, get notifications(){return currentNotifications();}, privacy, trustPackages, receiptStatus, get identityGroups(){return identityGroups();}, deviceHandoff, deviceManagement, agentContinuity, visitorDrafts, taskDraftScope, createTaskDraftClient, status, createIdentity, connect, resumeConnection, prepareRecovery, saveRecovery, recover, confirmRecoveredCode, pendingRecoveryCode, pendingIdentityOperations, queryIdentityOperation, continueIdentityOperation, confirmAccountLink, publicControl, publishTask, reconcilePublication, resumePublication,
    taskEvent, reconcileTaskEvent, resumeTaskEvent, reviewTaskAuthorization, reauthorizeTaskOperation, proposeParticipation, participationEvent,
    readParticipationComposeDraft, saveParticipationComposeDraft, clearParticipationComposeDraft,
    reviewTaskStop, stopTaskOperation, stoppedTaskOperations, queryStoppedTaskOperation, onTaskOperationStopped,
    getLocal: (name, originalSubjectId) => name === 'task-publication' ? readTaskPublication(originalSubjectId) : store.get(originalSubjectId === undefined ? localKey(name) : prefix + originalSubjectId + ':' + name),
    putLocal: (name, value, originalSubjectId) => store.put(originalSubjectId === undefined ? localKey(name) : prefix + originalSubjectId + ':' + name, value),
    updateLocal: (name, updater, originalSubjectId) => {
      if (typeof store.update !== 'function') throw new Error('local_atomic_update_unavailable');
      return store.update(originalSubjectId === undefined ? localKey(name) : prefix + originalSubjectId + ':' + name, updater);
    },
    disconnect, close() { closed = true; connectionIntent++; api.close(); if (!suppliedStore) store.close(); } });
}
