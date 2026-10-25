import {createBrowserClient,browserScopes} from "../../galaxy-official/src/browser-client.mjs";
import {openDeviceKeyStore} from "../../galaxy-core/src/domain/device-key-store.mjs";
import {createWebStorage,openWebContentStore} from "./web-content-store.mjs";
import {createIdentityDeviceHandoff} from "../../galaxy-core/src/domain/identity-device-handoff.mjs";
import {createIdentityDeviceManagement} from "../../galaxy-core/src/domain/identity-device-management.mjs";
import {createVisitorDraftAdoption} from "../../galaxy-core/src/domain/visitor-draft-adoption.mjs";
import {identityKeyId,signIdentityPayload} from "../../galaxy-core/src/domain/identity-material.mjs";
import {equalJson} from "../../galaxy-official/src/shared/web-primitives.mjs";
import {createChatClient} from "./chat-client.mjs";
import {createPrivacyClient} from "./privacy-client.mjs";
import {createTrustPackageClient} from "../../galaxy-official/src/trust-package-client.mjs";
import {createTrustPackageDeviceAdapter} from "../../galaxy-official/src/trust-package-device-adapter.mjs";
import {createReceiptStatusClient,createReceiptStatusDeviceSigner} from "../../galaxy-official/src/receipt-status-client.mjs";
import {createIdentityGroupClientV2} from "../../galaxy-official/src/identity-group-client-v2.mjs";
import {createIdentityGroupDeviceSignerV2} from "../../galaxy-official/src/identity-group-device-signer-v2.mjs";
import {createAgentIdentityEvidence} from "./agent-identity-evidence.mjs";
import {createNotificationInboxClient} from "../../galaxy-official/src/personal-summary-client.mjs";
import {createAccountVerificationClient} from "./account-verification-client.mjs";
import {createTaskLocalDraftClient,taskLocalDraftView} from "./task-local-draft-client.mjs";
import {createWebTaskOperations} from './runtime/task-operations.mjs';
import {markTaskRead} from './runtime/task-source.mjs';

export {loadWebConfiguration} from './runtime/configuration.mjs';

export async function createWebRuntime(config, { store: suppliedStore, openIdentityStore=openDeviceKeyStore,openContentStore=openWebContentStore,fetch, now = () => Math.floor(Date.now() / 1000), waitForClock, website = globalThis.location?.origin } = {}) {
  const prefix = `galaxy-web:${config.endpoint}:`, activeKey = prefix + 'active';
  const store=suppliedStore??createWebStorage({prefix,openIdentityStore,openContentStore});
  let savedActive=null,handoff=null;
  try{
    savedActive=await store.get(activeKey);
    handoff=savedActive&&await store.get(prefix+savedActive.subjectId+':agent-continuity:'+savedActive.deviceId);
  }catch(error){if(suppliedStore)throw error;savedActive=null;handoff=null;}
  // A browser-minted identity is retired. Only a device introduced by the
  // installed client's signed handoff may be selected by this web runtime.
  // Retain old records without loading their key or connection preferences.
  let active = handoff?.type === 'galaxy-web-agent-handoff-history'
    && handoff.endpoint === config.endpoint && handoff.context?.subjectId === savedActive.subjectId
    ? savedActive : null, closed = false;
  const retiredSelection=active===null?savedActive:null;
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
  const api = Object.freeze({ ...browserApi,
    async call(...args) { const scope = taskDraftScope().key, result = await browserApi.call(...args);
      const purpose=args[0].startsWith('/v2/requester-history/')?'requester-history':args[0].startsWith('/v2/contributions/')?args[1]?.purpose??'honor':null;
      if (markTaskRead(result, scope, new WeakSet(), null, null, purpose) && scope !== taskDraftScope().key) throw Object.assign(new Error('任务读取期间身份或连接已改变。'), { code: 'task_material_scope_changed' });
      return result; },
    async connect(...args) { await agentContinuity.requireCurrent(); const result = await browserApi.connect(...args); invalidateReceiptLifecycle(); return result; },
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
      const checked = Object.hasOwn(options, 'expectedOwner');
      const changed = () => { throw Object.assign(new Error('当前身份或页面已改变，请重新核对原身份操作。'), { code:'device_handoff_owner_changed' }); };
      if (closed || checked && options.expectedOwner !== active) changed();
      const assertSelection=()=>{if(closed||checked&&options.expectedOwner!==active)changed();};
      // Device authorization alone cannot reintroduce the retired manual web
      // route. The installed client's signed handoff must name this device.
      const nativeEvidence=createAgentIdentityEvidence({endpoint:config.endpoint,website,store,getActive:()=>value,getPendingHandoff:()=>null,publicControl,
        captureIdentityLease:()=>({check:assertSelection,wait:async action=>{assertSelection();const result=await action();assertSelection();return result;}}),now});
      await nativeEvidence.requireCurrent();assertSelection();
      if (checked) {
        if (typeof store.update !== 'function') throw Object.assign(new Error('本机存储暂不能安全切换设备，原身份仍保留。'), { code:'local_atomic_update_unavailable' });
        await store.update(activeKey, current => {
          if (closed || options.expectedOwner !== active) changed();
          // Another window may have completed this same confirmed operation.
          // Keep its exact result; only a different selection is a conflict.
          if (equalJson(current ?? null, value ?? null)) return current;
          if(options.expectedOwner===null&&retiredSelection&&equalJson(current,retiredSelection))return value;
          if (!equalJson(current ?? null, options.expectedOwner ?? null)) changed();
          return value;
        });
      } else await store.put(activeKey, value);
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
  function identityLease() {
    const owner = active;
    const check = () => { if (closed || active !== owner) throw new Error('当前身份或页面已改变，请回到原身份重新核对原操作。'); };
    const wait = async action => { check(); const result = await action(); check(); return result; };
    return { owner, check, wait };
  }
  async function device() {
    if (!active) throw new Error('先创建或连接已有银河身份。');
    const material = await store.get(`device:${active.subjectId}:${active.deviceId}`);
    if (!material) throw new Error('本机设备身份材料不可用。'); return material;
  }
  /** @param {{confirmed?: boolean}} [_options] */
  async function createIdentity(_options = {}) {
    identityLease().check();
    throw Object.assign(new Error('请先安装并打开本机银河客户端，在本地插件中创建银河 ID，再接洽此网页。'), { code: 'local_galaxy_required' });
  }
  /** @param {number} intent @param {string[]|null} permittedScopes @param {{bindingId:string,receipt:string}|null} originalBinding */
  async function establishConnection(intent, permittedScopes = null, originalBinding = null) {
    const lease = identityLease(), selected = lease.owner;
    const check = () => { lease.check(); if (!selected || connectionIntent !== intent) throw new Error('当前连接选择已改变。'); };
    check();
    await lease.wait(() => agentContinuity.requireCurrent());
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
  async function status() { return { identity: active ? { subjectId: active.subjectId, deviceId: active.deviceId, source:'native-handoff' } : null, connection: api.snapshot(), endpoint: config.endpoint, localDraftGeneration }; }
  const localKey = name => prefix + (active?.subjectId ?? 'visitor') + ':' + name;
  const {readTaskPublication,publishTask,reconcilePublication,resumePublication,taskEvent,reconcileTaskEvent,resumeTaskEvent,reviewTaskAuthorization,reauthorizeTaskOperation,proposeParticipation,participationEvent,readParticipationComposeDraft,saveParticipationComposeDraft,clearParticipationComposeDraft,reviewTaskStop,stopTaskOperation,stoppedTaskOperations,queryStoppedTaskOperation,onTaskOperationStopped} = createWebTaskOperations({
    api,prefix,store,captureTaskDraftLease,now,taskDraftScope,receiptStatus,localKey,agentContinuity,createTaskDraftClient,config,
    runtimeState: { get active(){return active;}, get closed(){return closed;} },
  });
  const accounts = createAccountVerificationClient({ api, endpoint: config.endpoint, captureLease: captureReceiptLease, now,
    getLocal: (name, subjectId) => store.get(prefix + subjectId + ':' + name),
    updateLocal: (name, updater, subjectId) => {
      if (typeof store.update !== 'function') throw new Error('local_atomic_update_unavailable');
      return store.update(prefix + subjectId + ':' + name, updater);
    },
    sign: async (payload, type, lease) => {
      lease.assertCurrent();
      if (type !== 'galaxy-identity-link+jws') throw new Error('账号关联签名类型不可用。');
      // Account association requires the installed local plugin's reviewed
      // identity.link intent. A browser device key cannot stand in for it.
      throw Object.assign(new Error('请在当前设备的银河插件中审阅并完成银河账户关联。'), { code: 'local_galaxy_required' });
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
  return Object.freeze({ api, accounts, get chat(){return currentChat();}, get notifications(){return currentNotifications();}, privacy, trustPackages, receiptStatus, get identityGroups(){return identityGroups();}, deviceHandoff, deviceManagement, agentContinuity, visitorDrafts, taskDraftScope, createTaskDraftClient, status, createIdentity, connect, resumeConnection, confirmAccountLink, publicControl, publishTask, reconcilePublication, resumePublication,
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
