import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createBrowserClient, browserScopes } from '../src/browser-client.mjs';
import { digest } from '../src/shared/digest.mjs';
import { createBuildersWebClient } from "../../galaxy-web/src/features/builders/builders-client.mjs";
import { createWorkerPackUseClient } from "../../galaxy-web/src/features/tools/worker-pack-use-client.mjs";
import { builderDeclaration } from './builders-workflow.mjs';

// Synthetic identity and local durable-store substitute; transport, signature,
// binding, Consent and business services use the actual HTTP/PGlite stack.
export async function buildersContinuityFixture() {
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) });
  const publicKey = f.genesis.genesisProof.publicKeyPem, deviceId = randomUUID();
  const upgrade = { version: 2, operationId: randomUUID(), subjectId: f.actor.subjectId,
    kind: 'bootstrap', expectedEpoch: 0, previousEventHash: null, signerKeyId: digest(publicKey),
    genesisProof: f.genesis.genesisProof,
    newDevice: { deviceId, publicKeyPem: publicKey, scopes: ['manage-identity', ...browserScopes] } };
  const challenge = await f.identityControl.challenge(upgrade);
  const signature = await f.signForTest(challenge.challenge, 'galaxy-identity-control-v2+jws');
  await f.identityControl.commit({ operationId: upgrade.operationId,
    controllerSignature: signature, newDeviceProof: signature });
  const server = createApi({ ...f, rateLimit: 2000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, memory = new Map(), calls = [];
  const state = { reconnectOnLoad: false, reconnectOnSave: false, reconnectAfterAuthorization: false,
    reconnectAfterRead: null, receiptUnavailable: false, loseEventAck: false, reconnectAfterEvent: false,
    failConsentBeforeCommit: false, failEventBeforeCommit: false, consentReceiptUnavailable: false, losePackUseAck: false, responses: [] };
  const api = createBrowserClient({ endpoint: f.access.endpoint, now: () => f.now,
    trustedKeys: f.bindings.trustedKeys, sign: f.signForTest,
    fetch: async (url, init) => {
      const path = new URL(url).pathname; calls.push(path);
      if (path === '/v1/builders/events/receipt' && state.receiptUnavailable)
        throw Error('Synthetic receipt network unavailable');
      if (path === '/v1/consents' && state.failConsentBeforeCommit) {
        state.failConsentBeforeCommit = false; throw Error('Synthetic Consent request failed before commit');
      }
      if (path === '/v2/consents/receipt' && state.consentReceiptUnavailable)
        throw Error('Synthetic Consent receipt unavailable');
      if (path === '/v1/builders/events' && state.failEventBeforeCommit) {
        state.failEventBeforeCommit = false; throw Error('Synthetic Builder request failed before commit');
      }
      const response = await fetch(origin + path, init);
      state.responses.push({ path, status: response.status });
      if (path === '/v1/builders/events' && state.reconnectAfterEvent) {
        state.reconnectAfterEvent = false; await connect();
      }
      if (path === '/v1/builders/events' && state.loseEventAck) {
        state.loseEventAck = false; throw Error('Synthetic ACK lost after actual commit');
      }
      if (path === '/v2/builders/pack-uses/events' && state.losePackUseAck) {
        state.losePackUseAck = false; throw Error('Synthetic Pack use ACK lost after actual commit');
      }
      return response;
    } });
  const connect = () => api.connect({ subjectId: f.actor.subjectId,
    genesisProof: f.genesis.genesisProof, installationId: randomUUID(), scopes: browserScopes,
    control: { deviceId, keyId: digest(publicKey), epoch: 1 } }, { confirmed: true });
  await connect();
  // Wrap completed calls rather than defeating the inner request guard. This
  // exposes the consumer's responsibility between two independent API calls.
  const consumerApi = { ...api, call: async (...args) => {
    const value = await api.call(...args);
    if (state.reconnectAfterRead === args[0]) { state.reconnectAfterRead = null; await connect(); }
    return value;
  }, submitAuthorization: async (...args) => {
    const value = await api.submitAuthorization(...args);
    if (state.reconnectAfterAuthorization) { state.reconnectAfterAuthorization = false; await connect(); }
    return value;
  } };
  const runtime = { api: consumerApi,
    getLocal: async key => {
      const value = structuredClone(memory.get(key) ?? null);
      if (state.reconnectOnLoad) { state.reconnectOnLoad = false; await connect(); }
      return value;
    }, putLocal: async (key, value) => {
      memory.set(key, structuredClone(value));
      if (state.reconnectOnSave) { state.reconnectOnSave = false; await connect(); }
    }, updateLocal: async (key, change) => {
      const next = change(structuredClone(memory.get(key) ?? null));
      if (next?.then) throw Error('local_update_async_callback');
      memory.set(key, structuredClone(next));
      if (state.reconnectOnSave) { state.reconnectOnSave = false; await connect(); }
      return structuredClone(next);
    } };
  const client = createBuildersWebClient(runtime, { subjectId: f.actor.subjectId, now: () => f.now });
  const workerClient = createWorkerPackUseClient({ runtime, subjectId: f.actor.subjectId, now: () => f.now });
  const event = { id: randomUUID(), kind: 'declare', builderId: randomUUID(), expectedRevision: 0,
    declaration: builderDeclaration('worker', f.actor.subjectId) };
  return { f, api, runtime, client, workerClient, connect, event, state, memory, calls,
    businessCalls: () => calls.filter(path => path === '/v1/builders/events').length,
    close: async () => { api.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); await f.db.close(); } };
}
