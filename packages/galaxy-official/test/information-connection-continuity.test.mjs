import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createBrowserClient } from '../src/browser-client.mjs';
import { digest } from '../src/shared/digest.mjs';
import { createInformationClientV2 } from '../../galaxy-web/src/information-client-v2.mjs';
const scopes = [
  'binding',
  'consent',
  'assistance',
  'history',
  'notifications',
  'proof',
  'capsules',
  'builders',
  'data-export',
];
async function fixture() {
  const f = await serviceFixture(scopes),
    publicKey = f.genesis.genesisProof.publicKeyPem,
    deviceId = randomUUID();
  const upgrade = {
    version: 2,
    operationId: randomUUID(),
    subjectId: f.actor.subjectId,
    kind: 'bootstrap',
    expectedEpoch: 0,
    previousEventHash: null,
    signerKeyId: digest(publicKey),
    genesisProof: f.genesis.genesisProof,
    newDevice: {
      deviceId,
      publicKeyPem: publicKey,
      scopes: ['manage-identity', ...scopes],
    },
  };
  const challenge = await f.identityControl.challenge(upgrade),
    signature = await f.signForTest(
      challenge.challenge,
      'galaxy-identity-control-v2+jws',
    );
  await f.identityControl.commit({
    operationId: upgrade.operationId,
    controllerSignature: signature,
    newDeviceProof: signature,
  });
  const server = createApi({ ...f, rateLimit: 2000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port,
    calls = [],
    memory = new Map(),
    state = { reconnectOnLoad: false, reconnectOnSave: false, receiptUnavailable: false, loseCommandAck: false, reconnectAfterCommand: false };
  const api = createBrowserClient({
    endpoint: f.access.endpoint,
    now: () => f.now,
    trustedKeys: f.bindings.trustedKeys,
    sign: f.signForTest,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if(path==='/v2/information/watches/receipt'&&state.receiptUnavailable)throw Error('Synthetic receipt network unavailable');
      const response=await fetch(origin + path, init);
      if(path==='/v2/information/watches/command'&&state.reconnectAfterCommand){state.reconnectAfterCommand=false;await connect();}
      if(path==='/v2/information/watches/command'&&state.loseCommandAck){state.loseCommandAck=false;throw Error('Synthetic ACK lost after actual commit');}
      return response;
    },
  });
  const connect = () =>
    api.connect(
      {
        subjectId: f.actor.subjectId,
        genesisProof: f.genesis.genesisProof,
        installationId: randomUUID(),
        scopes,
        control: { deviceId, keyId: digest(publicKey), epoch: 1 },
      },
      { confirmed: true },
    );
  await connect();
  const runtime = {
    api,
    getLocal: async (key) => {
      const value = structuredClone(memory.get(key) ?? null);
      if (state.reconnectOnLoad) {
        state.reconnectOnLoad = false;
        await connect();
      }
      return value;
    },
    putLocal: async (key, value) => {
      memory.set(key, structuredClone(value));
      if(state.reconnectOnSave){state.reconnectOnSave=false;await connect();}
    },
    updateLocal: async (key, change) => {
      const value = change(structuredClone(memory.get(key) ?? null));
      memory.set(key, structuredClone(value));
      if(state.reconnectOnSave){state.reconnectOnSave=false;await connect();}
      return structuredClone(value);
    },
  };
  const client = createInformationClientV2({
    runtime,
    subjectId: f.actor.subjectId,
  });
  const command = {
    action: 'start',
    operationId: randomUUID(),
    watchId: randomUUID(),
    expectedRevision: 0,
    plan: {
      purpose: 'Exact original watch connection continuity',
      sources: [
        {
          key: 'tasks',
          source: {
            kind: 'search',
            request: { type: 'task', query: { limit: 8 } },
          },
        },
      ],
      expiresAt: f.now + 900,
    },
  };
  return {
    f,
    api,
    client,
    command,
    connect,
    state,
    calls,
    memory,
    close: async () => {
      api.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await f.db.close();
    },
  };
}
for (const phase of ['after-preview', 'local-load'])
  test(
    `actual information HTTP consumer refuses old watch after same-subject reconnect at ${phase}`,
    { timeout: 60000 },
    async () => {
      const f = await fixture();
      try {
        await f.client.prepare(f.command);
        const prior = f.api.snapshot();
        if (phase === 'after-preview') await f.connect();
        else f.state.reconnectOnLoad = true;
        await assert.rejects(
          f.client.execute(f.command.operationId, { confirmed: true }),
          /身份|连接|预览|重新/,
        );
        assert.equal(
          f.calls.filter((x) => x === '/v2/information/watches/command').length,
          0,
        );
        assert.equal(f.api.snapshot().subjectId, prior.subjectId);
        assert.notEqual(f.api.snapshot().generation, prior.generation);
        const operations = [...f.memory.values()][0].operations;
        assert.equal(operations[0].command.operationId, f.command.operationId);
      } finally {
        await f.close();
      }
    },
  );

test('actual information lost ACK is recovered after rebind by original receipt without a second command', {timeout:60000}, async()=>{
 const f=await fixture();try{
  const preview=await f.client.prepare(f.command),originalHash=preview.requestHash;
  f.state.loseCommandAck=true;
  await assert.rejects(f.client.execute(f.command.operationId,{confirmed:true}),/ACK lost/);
  assert.equal([...f.memory.values()][0].operations[0].state,'result-unknown');
  await f.connect();
  const recovered=await f.client.execute(f.command.operationId,{confirmed:true});
  assert.equal(recovered.watchId,f.command.watchId);
  assert.equal(f.calls.filter(p=>p==='/v2/information/watches/command').length,1);
  const row=(await f.f.db.query('SELECT operation_id,request_hash FROM information_watch_operations_v2 WHERE operation_id=$1',[f.command.operationId])).rows[0];
  assert.deepEqual(row,{operation_id:f.command.operationId,request_hash:originalHash});
  assert.equal([...f.memory.values()][0].operations[0].state,'acknowledged');
 }finally{await f.close();}
});

test('unavailable receipt stays unknown and reconnect needs a fresh original preview before any command', {timeout:60000}, async()=>{
 const f=await fixture();try{
  const preview=await f.client.prepare(f.command);
  f.state.receiptUnavailable=true;
  await assert.rejects(f.client.execute(f.command.operationId,{confirmed:true}),/receipt network unavailable/);
  assert.equal(f.calls.filter(p=>p==='/v2/information/watches/command').length,0);
  const pending=(await f.client.pending())[0];
  assert.equal(pending.command.operationId,f.command.operationId);assert.equal(pending.requestHash,preview.requestHash);
  f.state.receiptUnavailable=false;await f.connect();
  assert.equal((await f.client.reconcile(f.command.operationId)).state,'absent');
  await assert.rejects(f.client.execute(f.command.operationId,{confirmed:true}),/预览|重新/);
  assert.equal(f.calls.filter(p=>p==='/v2/information/watches/command').length,0);
  const fresh=await f.client.prepare(f.command);assert.equal(fresh.requestHash,preview.requestHash);
  await f.client.execute(f.command.operationId,{confirmed:true});
  assert.equal(f.calls.filter(p=>p==='/v2/information/watches/command').length,1);
 }finally{await f.close();}
});

test('local save completion on a new binding withholds the preview and never dispatches a business command', {timeout:60000}, async()=>{
 const f=await fixture();try{
  f.state.reconnectOnSave=true;
  await assert.rejects(f.client.prepare(f.command),/身份|连接/);
  const record=[...f.memory.values()][0].operations[0];
  assert.equal(record.command.operationId,f.command.operationId);assert.equal(record.state,'prepared');
  await assert.rejects(f.client.execute(f.command.operationId,{confirmed:true}),/预览|重新/);
  assert.equal(f.calls.filter(p=>p==='/v2/information/watches/command').length,0);
 }finally{await f.close();}
});

test('actual command accepted before a connection change retains its original journal and only reconciles metadata', {timeout:60000}, async()=>{
 const f=await fixture();try{
  const preview=await f.client.prepare(f.command);f.state.reconnectAfterCommand=true;
  await assert.rejects(f.client.execute(f.command.operationId,{confirmed:true}),/connection|连接|changed/i);
  const op=[...f.memory.values()][0].operations[0];assert.equal(op.state,'result-unknown');assert.equal(op.requestHash,preview.requestHash);
  const recovered=await f.client.reconcile(f.command.operationId);assert.equal(recovered.state,'acknowledged');
  assert.equal(f.calls.filter(p=>p==='/v2/information/watches/command').length,1);
  assert.equal(Number((await f.f.db.query('SELECT count(*) AS n FROM information_watch_operations_v2 WHERE operation_id=$1',[f.command.operationId])).rows[0].n),1);
 }finally{await f.close();}
});

test('information client itself captures queued intent and withholds late receipts after the same binding generation changes',async()=>{
 let generation=1,resolveReceipt,receiptStarted;
 const receiptReady=new Promise(resolve=>{receiptStarted=resolve;}),receiptResponse=new Promise(resolve=>{resolveReceipt=resolve;}),memory=new Map(),calls=[];
 const subjectId=randomUUID(),bindingId=randomUUID(),endpoint='https://official.example.org';
 const runtime={api:{endpoint,snapshot:()=>({subjectId,bindingId,generation,endpoint}),call:async(path)=>{calls.push(path);if(path.endsWith('/receipt')){receiptStarted();return receiptResponse;}throw Error('No business call expected');}},
  getLocal:async key=>structuredClone(memory.get(key)??null),putLocal:async(key,value)=>{memory.set(key,structuredClone(value));},
  updateLocal:async(key,change)=>{const value=change(structuredClone(memory.get(key)??null));memory.set(key,structuredClone(value));return structuredClone(value);}};
 const client=createInformationClientV2({runtime,subjectId}),command={action:'start',operationId:randomUUID(),watchId:randomUUID(),expectedRevision:0,plan:{purpose:'Queued original connection intent',sources:[{key:'tasks',source:{kind:'search',request:{type:'task',query:{limit:8}}}}],expiresAt:Math.floor(Date.now()/1000)+900}};
 await client.prepare(command);
 const execute=client.execute(command.operationId,{confirmed:true}),rejectedExecute=assert.rejects(execute,/身份|连接/);
 await receiptReady;
 const queued=client.pending(),rejectedQueued=assert.rejects(queued,/身份|连接/);
 generation++;resolveReceipt({state:'absent'});
 await Promise.all([rejectedExecute,rejectedQueued]);
 assert.deepEqual(calls,['/v2/information/watches/receipt']);
 const original=[...memory.values()][0].operations[0];assert.equal(original.command.operationId,command.operationId);assert.equal(original.state,'prepared');
});
