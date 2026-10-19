import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { serviceFixture } from './service-fixture.mjs';
import { createServices } from '../src/services.mjs';
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { seedExistingWebIdentity } from './existing-web-identity-fixture.mjs';
import { createRecoveryMaterial, importRecoveryMaterial } from '../../galaxy-core/src/domain/identity-material.mjs';

// Synthetic materials remain in memory. The consumer and signed HTTP service
// are real; this shared synchronous store models the existing atomic contract.
async function setup() {
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000), syntheticCommunityQuota: false });
  const key = generateKeyPairSync('ed25519'), trustedKeys = new Map([['recovery-material-test', {
    publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }), notBefore: f.now - 1, notAfter: f.now + 86400, revoked: false,
  }]]);
  const services = createServices({ db: f.db, endpoint: f.access.endpoint, kid: 'recovery-material-test', signingKey: key.privateKey,
    trustedKeys, allowedScopes: browserScopes, operator: 'Synthetic', region: 'isolated', now: () => f.now });
  const server = createApi({ ...services, rateLimit: 1000 }), stores = [], runtimes = [], data = new Map(), wire = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, config = { endpoint: f.access.endpoint, trustedKeys };
  const hooks = { read: null, afterCommit: null, dropCommit: false, failUpdate: null, dropBeforeCommit: false, afterStatus: null }, sentCommits=[];
  const fetchLocal = async (url, init) => {
    const parsed = new URL(url);
    if(parsed.pathname==='/v2/identity/control/commit'){
      sentCommits.push(JSON.parse(init.body));
      if(hooks.dropBeforeCommit){hooks.dropBeforeCommit=false;throw Error('synthetic interruption before original commit');}
    }
    const response = await fetch(origin + parsed.pathname + parsed.search, init);
    wire.push({ path: parsed.pathname, status: response.status });
    if(parsed.pathname==='/v2/identity/control/status'&&hooks.afterStatus)await hooks.afterStatus(response);
    if (parsed.pathname === '/v2/identity/control/commit' && hooks.afterCommit) await hooks.afterCommit(response);
    if (parsed.pathname === '/v2/identity/control/commit' && response.ok && hooks.dropCommit) {
      hooks.dropCommit = false; await response.text(); throw Error('synthetic committed identity ACK lost');
    }
    return response;
  };
  function store(materials = data) {
    const get = async name => {
      const value = structuredClone(materials.get(name));
      if (hooks.read) await hooks.read(name, value);
      return value;
    }, put = async (name, value) => { materials.set(name, structuredClone(value)); };
    const result = { get, put,
      async update(name, updater) {
        if (hooks.failUpdate === name) { hooks.failUpdate = null; throw Error('synthetic atomic storage unavailable'); }
        const value = updater(structuredClone(materials.get(name)));
        if (value && typeof value.then === 'function') throw Error('local_update_async_callback');
        const committed = structuredClone(value); materials.set(name, committed); return structuredClone(committed);
      },
      async prepareRecovery(subjectId, operationId) {
        const name = `pending-recovery:${subjectId}:${operationId}`, existing = await get(name);
        if (existing) return existing;
        const value = { ...await createRecoveryMaterial(subjectId), operationId, saveDeclared: false, status: 'local-pending-registration' };
        await put(name, value); return value;
      },
      async declareSaved(subjectId, operationId) {
        const name = `pending-recovery:${subjectId}:${operationId}`, value = await get(name);
        if (!value) throw Error('Recovery material unavailable.'); await put(name, { ...value, saveDeclared: true });
      },
      async recordReceipt(subjectId, operationId, receipt) {
        if (receipt.subjectId !== subjectId || receipt.operationId !== operationId || receipt.state !== 'committed') throw Error('Mismatched recovery receipt.');
        const name = `pending-recovery:${subjectId}:${operationId}`, value = await get(name);
        if (!value) throw Error('Recovery material unavailable.');
        await put(name, { ...value, receipt, status: value.saveDeclared ? 'registered-save-declared' : 'registered-awaiting-save-declaration' });
      }, close() {},
    };
    stores.push(result); return result;
  }
  async function runtime(materials = data, { initialize = false } = {}) {
    const options = { store: store(materials), fetch: fetchLocal, now: () => f.now };
    if (initialize) await seedExistingWebIdentity(config, options);
    const rt = await createWebRuntime(config, options);
    runtimes.push(rt); return rt;
  }
  const a = await runtime(data, { initialize: true });
  return { ...f, a, data, hooks, stores, wire, runtime, sentCommits, advance:seconds=>{f.now+=seconds;}, recoverySlot: `galaxy-web:${f.access.endpoint}:recovery`,
    commits: () => wire.filter(v => v.path === '/v2/identity/control/commit').length,
    async close() { for (const rt of runtimes) rt.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.db.close(); },
  };
}

test('two runtimes atomically claim the same displayed recovery material and save that exact operation', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const b = await f.runtime(); let readers = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    f.hooks.read = async (name, value) => { if (name === f.recoverySlot && !value) { if (++readers === 2) release(); await gate; } };
    const timeout = setTimeout(() => release(), 10000); let preparations;
    try { preparations = await Promise.all([f.a.prepareRecovery(), b.prepareRecovery()]); }
    finally { clearTimeout(timeout); f.hooks.read = null; }
    assert.equal(readers, 2); assert.equal(preparations[0].operationId, preparations[1].operationId);
    assert.equal(preparations[0].code === preparations[1].code, true, 'Both displays must contain the same material.');
    const pending = await b.pendingRecoveryCode();
    assert.equal(pending.operationId, preparations[1].operationId); assert.equal(pending.recovered, false);
    const expected = await importRecoveryMaterial(preparations[0].code), before = f.commits();
    const receipt = await f.a.saveRecovery({ operationId: preparations[0].operationId, confirmed: true });
    assert.equal(receipt.operationId, preparations[0].operationId); assert.equal(f.commits() - before, 1);
    const control = await f.a.publicControl((await f.a.status()).identity.subjectId);
    assert.equal(control.recovery.publicKeyPem, expected.publicKeyPem); assert.equal(control.recoveryReadiness, 'registered-save-declared');
    assert.equal(await b.pendingRecoveryCode(), null);
  } finally { await f.close(); }
});

test('missing or changed displayed operation cannot declare saved or sign another shared slot', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const original = await f.a.prepareRecovery(), slot = structuredClone(f.data.get(f.recoverySlot));
    const replacementId = randomUUID(), material = await f.stores[0].prepareRecovery(slot.subjectId, replacementId);
    f.data.set(f.recoverySlot, { ...slot, operationId: replacementId, publicKeyPem: material.publicKeyPem });
    const before = f.commits();
    await assert.rejects(f.a.saveRecovery({ confirmed: true }), /准确|operation|展示/);
    await assert.rejects(f.a.saveRecovery({ operationId: original.operationId, confirmed: true }), /改变|准确|展示/);
    assert.equal(f.commits(), before); assert.equal(f.data.get(f.recoverySlot).operationId, replacementId);
    assert.equal(f.data.get(`pending-recovery:${slot.subjectId}:${replacementId}`).saveDeclared, false);
  } finally { await f.close(); }
});

test('an accepted original save never clears a later replacement and original ACK can be reconciled', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const original = await f.a.prepareRecovery(), slot = structuredClone(f.data.get(f.recoverySlot)), replacementId = randomUUID();
    f.hooks.afterCommit = async response => { if (response.status === 200) { f.hooks.afterCommit = null;
      const next = await f.stores[0].prepareRecovery(slot.subjectId, replacementId);
      f.data.set(f.recoverySlot, { ...slot, operationId: replacementId, publicKeyPem: next.publicKeyPem });
    } };
    const receipt = await f.a.saveRecovery({ operationId: original.operationId, confirmed: true });
    assert.equal(receipt.operationId, original.operationId); assert.equal(receipt.state, 'committed');
    assert.equal(f.data.get(f.recoverySlot)?.operationId, replacementId);
    assert.equal(f.data.get(`pending-recovery:${slot.subjectId}:${original.operationId}`).code, undefined);
    assert.equal(f.data.get(`identity-operation:${f.access.endpoint}:${original.operationId}`).receipt.operationId, original.operationId);
  } finally { await f.close(); }
});

test('recovered-code declaration uses its exact original generation; a later code cannot inherit that declaration', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const saved = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: saved.operationId, confirmed: true });
    const recoveredStore = new Map(), recovering = await f.runtime(recoveredStore), recovered = await recovering.recover(saved.code, { confirmed: true });
    const pending = await recovering.pendingRecoveryCode();
    assert.equal(pending.operationId, recovered.operationId); assert.equal(pending.recovered, true);
    const another = await f.runtime(recoveredStore), changed = await another.prepareRecovery();
    await another.saveRecovery({ operationId: changed.operationId, confirmed: true });
    const before = f.commits();
    await assert.rejects(recovering.confirmRecoveredCode({ confirmed: true }), /准确|operation|展示/);
    await assert.rejects(recovering.confirmRecoveredCode({ operationId: recovered.operationId, confirmed: true }), /更换|改变|当前/);
    await assert.rejects(recovering.pendingRecoveryCode(), error => error.code === 'recovery_material_not_current');
    assert.equal(f.commits(), before);
    const control = await recovering.publicControl(recovered.identity.subjectId);
    assert.notEqual(control.recovery.publicKeyPem, (await importRecoveryMaterial(recovered.replacementCode)).publicKeyPem);
    assert.equal(recoveredStore.get(`pending-recovery:${recovered.identity.subjectId}:${recovered.operationId}`).saveDeclared, false);
  } finally { await f.close(); }
});

test('unknown save ACK survives runtime reload and original status continuation without another commit', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const displayed = await f.a.prepareRecovery(); f.hooks.dropCommit = true;
    await assert.rejects(f.a.saveRecovery({ operationId: displayed.operationId, confirmed: true }), /ACK lost/);
    const commits = f.commits(), reloaded = await f.runtime(), pending = await reloaded.pendingRecoveryCode();
    assert.equal(pending.operationId, displayed.operationId); assert.equal(pending.code === displayed.code, true);
    const original = await reloaded.queryIdentityOperation(displayed.operationId);
    assert.equal(original.operationId, displayed.operationId); assert.equal(original.state, 'committed');
    await reloaded.continueIdentityOperation(displayed.operationId, { confirmed: true });
    assert.equal(f.commits(), commits); assert.equal(await reloaded.pendingRecoveryCode(), null);
    const retained = f.data.get(`pending-recovery:${pending.subjectId}:${displayed.operationId}`);
    assert.equal(retained.receipt.operationId, displayed.operationId); assert.equal(retained.code, undefined); assert.equal(retained.privateKey, undefined);
  } finally { await f.close(); }
});

test('requested identity continuation transports only the exact stored commit, while unsigned, expired and unreadable originals write zero', {timeout:60000}, async()=>{
  const f=await setup();const subtle=globalThis.crypto.subtle,originalSign=subtle.sign.bind(subtle),originalSignDescriptor=Object.getOwnPropertyDescriptor(subtle,'sign');let signatures=0;
  try{
    const unsigned=await f.a.prepareRecovery();
    subtle.sign=()=>{throw Error('synthetic interruption before identity signing');};
    await assert.rejects(f.a.saveRecovery({operationId:unsigned.operationId,confirmed:true}),/before identity signing/);subtle.sign=originalSign;
    const noCommit=await f.a.queryIdentityOperation(unsigned.operationId);
    assert.equal(noCommit.registered,false);assert.equal(noCommit.hasOriginalCommit,false);
    assert.equal(noCommit.requiresOriginalPreparation,true);assert.equal(noCommit.canContinueOriginalCommit,false);
    const beforeUnsigned=f.sentCommits.length;
    await assert.rejects(f.a.continueIdentityOperation(unsigned.operationId,{confirmed:true}),/没有得到服务确认/);
    assert.equal(f.sentCommits.length,beforeUnsigned);
    f.hooks.dropBeforeCommit=true;
    await assert.rejects(f.a.saveRecovery({operationId:unsigned.operationId,confirmed:true}),/before original commit/);
    const saved=structuredClone(f.data.get(`identity-operation:${f.access.endpoint}:${unsigned.operationId}`));
    const metadata=await f.a.queryIdentityOperation(unsigned.operationId);
    assert.equal(metadata.state,'requested');assert.equal(metadata.registered,true);assert.equal(metadata.canContinueOriginalCommit,true);
    f.hooks.afterStatus=async()=>{throw Error('synthetic original status unavailable');};const beforeUnknown=f.sentCommits.length;
    await assert.rejects(f.a.continueIdentityOperation(unsigned.operationId,{confirmed:true}),/status unavailable/);
    assert.equal(f.sentCommits.length,beforeUnknown);f.hooks.afterStatus=null;
    subtle.sign=function(...args){signatures++;return originalSign.apply(this,args);};
    const result=await f.a.continueIdentityOperation(unsigned.operationId,{confirmed:true});
    assert.equal(result.operationId,unsigned.operationId);assert.equal(signatures,0,'original signed continuation has no new signing');
    assert.deepEqual(f.sentCommits.at(-1),saved.commit);assert.equal(f.sentCommits.length,beforeUnknown+1);
    const exact=f.data.get(`identity-operation:${f.access.endpoint}:${unsigned.operationId}`);
    assert.deepEqual(exact.request,saved.request);assert.deepEqual(exact.commit,saved.commit);assert.equal(exact.state,'committed');
    subtle.sign=originalSign;
    const expired=await f.a.prepareRecovery();f.hooks.dropBeforeCommit=true;
    await assert.rejects(f.a.saveRecovery({operationId:expired.operationId,confirmed:true}),/before original commit/);
    f.advance(181);const beforeExpired=f.sentCommits.length,expiry=await f.a.queryIdentityOperation(expired.operationId);
    assert.equal(expiry.state,'expired');assert.equal(expiry.canContinueOriginalCommit,false);
    subtle.sign=function(...args){signatures++;return originalSign.apply(this,args);};const beforeSigns=signatures;
    await assert.rejects(f.a.continueIdentityOperation(expired.operationId,{confirmed:true}),/没有得到服务确认/);
    assert.equal(signatures,beforeSigns);assert.equal(f.sentCommits.length,beforeExpired);
  }finally{if(originalSignDescriptor)Object.defineProperty(subtle,'sign',originalSignDescriptor);else Reflect.deleteProperty(subtle,'sign');await f.close();}
});

test('late requested identity status cannot submit after its original owner changes or its stored commit changes', {timeout:60000},async()=>{
  const f=await setup();
  try{
    const savedRecovery=await f.a.prepareRecovery();await f.a.saveRecovery({operationId:savedRecovery.operationId,confirmed:true});
    const selected=await f.a.prepareRecovery();f.hooks.dropBeforeCommit=true;
    await assert.rejects(f.a.saveRecovery({operationId:selected.operationId,confirmed:true}),/before original commit/);
    const key=`identity-operation:${f.access.endpoint}:${selected.operationId}`,original=structuredClone(f.data.get(key));
    f.hooks.afterStatus=async()=>{f.hooks.afterStatus=null;const changed=structuredClone(f.data.get(key));changed.commit.controllerSignature='different saved bytes';f.data.set(key,changed);};
    let baseline=f.sentCommits.length;
    await assert.rejects(f.a.continueIdentityOperation(selected.operationId,{confirmed:true}),/签名已变化/);
    assert.equal(f.sentCommits.length,baseline);f.data.set(key,original);
    const oldOwner=(await f.a.status()).identity;
    f.hooks.afterStatus=async()=>{f.hooks.afterStatus=null;await f.a.recover(savedRecovery.code,{confirmed:true});};
    baseline=f.sentCommits.length;
    await assert.rejects(f.a.continueIdentityOperation(selected.operationId,{confirmed:true}),/当前身份或页面已改变/);
    assert.equal(f.sentCommits.length,baseline+1,'only the separately authorized recovery was submitted');
    assert.notEqual((await f.a.status()).identity.deviceId,oldOwner.deviceId);
    assert.equal(f.sentCommits.at(-1).operationId===selected.operationId,false);
    assert.deepEqual(f.data.get(key).commit,original.commit);
  }finally{await f.close();}
});

test('unknown recovered declaration ACK keeps the displayed recover ID and only reconciles the original declaration', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const saved = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: saved.operationId, confirmed: true });
    const recoveredStore = new Map(), recovering = await f.runtime(recoveredStore), shown = await recovering.recover(saved.code, { confirmed: true });
    f.hooks.dropCommit = true;
    await assert.rejects(recovering.confirmRecoveredCode({ operationId: shown.operationId, confirmed: true }), /ACK lost/);
    const key = f.recoverySlot.replace(/recovery$/, 'recovery-save-operation'), declaration = recoveredStore.get(key), commits = f.commits();
    assert.equal(declaration.recoveryOperationId, shown.operationId); assert.notEqual(declaration.operationId, shown.operationId);
    const reloaded = await f.runtime(recoveredStore), pending = await reloaded.pendingRecoveryCode();
    assert.equal(pending.operationId, shown.operationId); assert.equal(pending.code === shown.replacementCode, true);
    assert.equal((await reloaded.queryIdentityOperation(declaration.operationId)).state, 'committed');
    await reloaded.continueIdentityOperation(declaration.operationId, { confirmed: true });
    assert.equal(f.commits(), commits); assert.equal(await reloaded.pendingRecoveryCode(), null);
    assert.equal(recoveredStore.get(`pending-recovery:${pending.subjectId}:${shown.operationId}`).receipt.operationId, declaration.operationId);
  } finally { await f.close(); }
});

test('accepted recovered declaration clears only its original slots and retains a later operation', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const saved = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: saved.operationId, confirmed: true });
    const recoveredStore = new Map(), recovering = await f.runtime(recoveredStore), shown = await recovering.recover(saved.code, { confirmed: true });
    const recoverKey = f.recoverySlot.replace(/recovery$/, 'recover-operation'), saveKey = f.recoverySlot.replace(/recovery$/, 'recovery-save-operation');
    const laterRecover = randomUUID(), laterDeclaration = randomUUID();
    f.hooks.afterCommit = async response => { if (response.ok) { f.hooks.afterCommit = null;
      recoveredStore.set(recoverKey, { ...recoveredStore.get(recoverKey), operationId: laterRecover });
      recoveredStore.set(saveKey, { ...recoveredStore.get(saveKey), operationId: laterDeclaration });
    } };
    const receipt = await recovering.confirmRecoveredCode({ operationId: shown.operationId, confirmed: true });
    assert.equal(receipt.state, 'committed'); assert.equal(recoveredStore.get(recoverKey).operationId, laterRecover);
    assert.equal(recoveredStore.get(saveKey).operationId, laterDeclaration);
    const retained = recoveredStore.get(`pending-recovery:${shown.identity.subjectId}:${shown.operationId}`);
    assert.equal(retained.receipt.operationId, receipt.operationId); assert.equal(retained.code, undefined); assert.equal(retained.privateKey, undefined);
  } finally { await f.close(); }
});

test('a supplied store without atomic update fails before recovery reads, material writes or network dispatch', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const prepared = await f.a.prepareRecovery(), store = f.stores[0], update = store.update;
    const snapshot = new Map(f.data), calls = f.wire.length; let reads = 0;
    f.hooks.read = async () => { reads++; }; delete store.update;
    try {
      await assert.rejects(f.a.prepareRecovery(), error => error.code === 'local_atomic_update_unavailable');
      await assert.rejects(f.a.saveRecovery({ operationId: prepared.operationId, confirmed: true }), error => error.code === 'local_atomic_update_unavailable');
      await assert.rejects(f.a.recover(prepared.code, { confirmed: true }), error => error.code === 'local_atomic_update_unavailable');
      assert.equal(reads, 0); assert.equal(f.wire.length, calls); assert.equal(isDeepStrictEqual(f.data, snapshot), true);
    } finally { store.update = update; f.hooks.read = null; }
  } finally { await f.close(); }
});

test('local atomic receipt persistence failure after real acceptance keeps the original operation available for readonly recovery', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const displayed = await f.a.prepareRecovery(), pending = await f.a.pendingRecoveryCode();
    const materialKey = `pending-recovery:${pending.subjectId}:${displayed.operationId}`;
    f.hooks.afterCommit = async response => { if (response.ok) { f.hooks.afterCommit = null; f.hooks.failUpdate = materialKey; } };
    await assert.rejects(f.a.saveRecovery({ operationId: displayed.operationId, confirmed: true }), /atomic storage unavailable/);
    const commits = f.commits(); assert.equal(f.data.get(f.recoverySlot).operationId, displayed.operationId);
    assert.equal(f.data.get(`identity-operation:${f.access.endpoint}:${displayed.operationId}`).receipt.operationId, displayed.operationId);
    const reloaded = await f.runtime(); assert.equal((await reloaded.queryIdentityOperation(displayed.operationId)).state, 'committed');
    await reloaded.continueIdentityOperation(displayed.operationId, { confirmed: true });
    assert.equal(f.commits(), commits); assert.equal(f.data.get(materialKey).code, undefined); assert.equal(await reloaded.pendingRecoveryCode(), null);
  } finally { await f.close(); }
});

test('an independent browser recovers the same identity, saves the exact replacement and rejects the used code without another write', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    await f.a.connect({ confirmed: true }); const originalIdentity = (await f.a.status()).identity;
    const prepared = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: prepared.operationId, confirmed: true });
    const storage = new Map(), b = await f.runtime(storage), recovered = await b.recover(prepared.code, { confirmed: true });
    assert.equal(recovered.identity.subjectId, originalIdentity.subjectId); assert.notEqual(recovered.identity.deviceId, originalIdentity.deviceId);
    assert.equal(recovered.connection, null); assert.equal((await b.pendingRecoveryCode()).operationId, recovered.operationId);
    const current = await b.publicControl(originalIdentity.subjectId);
    assert.equal(current.epoch, 2); assert.equal(current.recovery.generation, 2); assert.equal(current.recoveryReadiness, 'registered-awaiting-save-declaration');
    assert.equal(current.devices.find(row => row.device_id === originalIdentity.deviceId).status, 'revoked');
    await assert.rejects(f.a.connect({ confirmed: true }), /设备已失效/);
    assert.ok((await f.db.query('SELECT revoked_at FROM bindings WHERE subject_id=$1',[originalIdentity.subjectId])).rows.every(row => row.revoked_at));
    await b.confirmRecoveredCode({ operationId: recovered.operationId, confirmed: true });
    assert.equal(await b.pendingRecoveryCode(), null); assert.equal((await b.publicControl(originalIdentity.subjectId)).recoveryReadiness, 'registered-save-declared');
    await b.connect({ confirmed: true }); assert.equal((await b.status()).connection.subjectId, originalIdentity.subjectId);
    const before = f.sentCommits.length, c = await f.runtime(new Map());
    await assert.rejects(c.recover(prepared.code, { confirmed: true }), error => error.code === 'recovery_material_not_current');
    await assert.rejects(c.recover('incomplete-local-input', { confirmed: true }), error => error.code === 'recovery_code_invalid');
    assert.equal(f.sentCommits.length, before); assert.equal((await c.status()).identity, null);
    assert.equal(storage.get(`pending-recovery:${originalIdentity.subjectId}:${recovered.operationId}`).code, undefined);
  } finally { await f.close(); }
});

test('lost recovery and save-declaration responses resume their exact original commits and code locator without signing anew', { timeout: 60000 }, async () => {
  const f = await setup(), subtle = globalThis.crypto.subtle, sign = subtle.sign.bind(subtle), signDescriptor = Object.getOwnPropertyDescriptor(subtle,'sign');
  try {
    const code = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: code.operationId, confirmed: true });
    const storage = new Map(), b = await f.runtime(storage); f.hooks.dropCommit = true;
    await assert.rejects(b.recover(code.code, { confirmed: true }), /ACK lost/);
    const row = (await b.pendingIdentityOperations()).find(item => item.kind === 'recover'), originalCommit = structuredClone(f.sentCommits.at(-1)), before = f.sentCommits.length;
    const reloaded = await f.runtime(storage);
    subtle.sign = () => { throw Error('continuation must not sign a new recovery'); };
    const receipt = await reloaded.queryIdentityOperation(row.operationId); assert.equal(receipt.state, 'committed');
    const recovered = await reloaded.continueIdentityOperation(row.operationId, { confirmed: true });
    assert.equal(recovered.operationId, row.operationId); assert.ok(typeof recovered.replacementCode === 'string');
    assert.equal(f.sentCommits.length, before); assert.ok(isDeepStrictEqual(f.sentCommits.at(-1), originalCommit));
    assert.ok((await reloaded.pendingRecoveryCode()).code === recovered.replacementCode);
    subtle.sign = sign; f.hooks.dropCommit = true;
    await assert.rejects(reloaded.confirmRecoveredCode({ operationId: recovered.operationId, confirmed: true }), /ACK lost/);
    const declaration = (await reloaded.pendingIdentityOperations()).find(item => item.kind === 'declare-recovery-saved'), sent = f.sentCommits.length;
    subtle.sign = () => { throw Error('continuation must not sign a new declaration'); };
    const resumed = await f.runtime(storage), declared = await resumed.continueIdentityOperation(declaration.operationId, { confirmed: true });
    assert.equal(declared.kind, 'declare-recovery-saved'); assert.equal(declared.recoveryOperationId, recovered.operationId);
    assert.equal(f.sentCommits.length, sent); assert.equal(await resumed.pendingRecoveryCode(), null);
  } finally { if (signDescriptor) Object.defineProperty(subtle,'sign',signDescriptor); else Reflect.deleteProperty(subtle,'sign'); await f.close(); }
});

test('a historical successful recovery cannot reactivate a device revoked by a later recovery', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const code = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: code.operationId, confirmed: true });
    const firstStorage = new Map(), first = await f.runtime(firstStorage), recovered = await first.recover(code.code, { confirmed: true });
    const second = await f.runtime(new Map()); await second.recover(recovered.replacementCode, { confirmed: true });
    const before = f.sentCommits.length, oldActive = structuredClone(firstStorage.get(f.recoverySlot.replace(/recovery$/, 'active'))), reloaded = await f.runtime(firstStorage);
    await assert.rejects(reloaded.recover(code.code, { confirmed: true }), error => error.code === 'recovery_device_not_current');
    await assert.rejects(reloaded.continueIdentityOperation(recovered.operationId, { confirmed: true }), error => error.code === 'recovery_device_not_current');
    await assert.rejects(reloaded.pendingRecoveryCode(), error => error.code === 'recovery_device_not_current');
    assert.equal(f.sentCommits.length, before); assert.ok(isDeepStrictEqual(firstStorage.get(f.recoverySlot.replace(/recovery$/, 'active')), oldActive));
    assert.notEqual((await second.status()).identity.deviceId, recovered.identity.deviceId);
  } finally { await f.close(); }
});

test('an expired original recovery keeps its history and only an explicit valid-code choice prepares a distinct new operation', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const code = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: code.operationId, confirmed: true });
    const storage = new Map(), b = await f.runtime(storage); f.hooks.dropBeforeCommit = true;
    await assert.rejects(b.recover(code.code, { confirmed: true }), /before original commit/);
    const row = (await b.pendingIdentityOperations()).find(item => item.kind === 'recover'), key = `identity-operation:${f.access.endpoint}:${row.operationId}`,
      original = structuredClone(storage.get(key)); f.advance(181);
    assert.equal((await b.queryIdentityOperation(row.operationId)).state, 'expired'); const before = f.sentCommits.length;
    await assert.rejects(b.continueIdentityOperation(row.operationId, { confirmed: true }), /没有得到服务确认/); assert.equal(f.sentCommits.length, before);
    const recovered = await b.recover(code.code, { confirmed: true }); assert.notEqual(recovered.operationId, row.operationId); assert.equal(recovered.identity.subjectId, row.subjectId);
    assert.ok(isDeepStrictEqual(storage.get(key).request, original.request)); assert.ok(isDeepStrictEqual(storage.get(key).commit, original.commit));
    assert.equal(storage.get(f.recoverySlot.replace(/recovery$/, 'recovery-operation-history:') + row.subjectId).find(item => item.operationId === row.operationId).state, 'expired');
    assert.equal((await f.db.query('SELECT state FROM identity_control_operations WHERE id=$1', [row.operationId])).rows[0].state, 'requested');
    assert.equal(storage.get(`pending-recovery:${row.subjectId}:${row.operationId}`).code, undefined);
  } finally { await f.close(); }
});

test('two empty-owner browsers atomically keep one exact recovery operation and never overwrite its code or device', { timeout: 60000 }, async () => {
  const f = await setup();
  try {
    const code = await f.a.prepareRecovery(); await f.a.saveRecovery({ operationId: code.operationId, confirmed: true });
    const storage = new Map(), b = await f.runtime(storage), c = await f.runtime(storage), slot = f.recoverySlot.replace(/recovery$/, 'recover-operation');
    let readers = 0, release; const gate = new Promise(resolve => { release = resolve; });
    f.hooks.read = async (name, value) => { if (name === slot && !value) { if (++readers === 2) release(); await gate; } };
    const timeout = setTimeout(() => release(), 10000); let results;
    try { results = await Promise.all([b.recover(code.code, { confirmed: true }), c.recover(code.code, { confirmed: true })]); }
    finally { clearTimeout(timeout); f.hooks.read = null; }
    assert.equal(readers, 2); assert.equal(results[0].operationId, results[1].operationId); assert.equal(results[0].identity.deviceId, results[1].identity.deviceId);
    assert.ok(results[0].replacementCode === results[1].replacementCode); assert.equal(storage.get(slot).operationId, results[0].operationId);
    const events = (await f.db.query("SELECT id FROM subject_control_events WHERE subject_id=$1 AND kind='recover'", [results[0].identity.subjectId])).rows;
    assert.equal(events.length, 1); assert.equal(events[0].id, results[0].operationId);
  } finally { await f.close(); }
});
