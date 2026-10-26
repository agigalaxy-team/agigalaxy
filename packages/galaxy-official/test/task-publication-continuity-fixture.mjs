import assert from 'node:assert/strict';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from "../src/identity/authentication/oidc-login.mjs";
import { createApi } from '../src/http.mjs';
import { browserScopes } from '../src/browser-client.mjs';
import { createWebRuntime } from '../../galaxy-web/src/runtime.mjs';
import { confirmFixtureAccountLink } from './existing-web-identity-fixture.mjs';
import { digest } from '../src/shared/digest.mjs';

// Real WebRuntime, signed HTTP and synthetic verified OIDC account on PGlite.
// Map completion hooks control await boundaries; no physical IDB/people/model.
export async function publicationFixture() {
  const endpoint = 'https://official.example.org', now = Math.floor(Date.now() / 1000);
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], { emailVerified: true });
  let f, server, runtime;
  const values = new Map(), counts = { consents: 0, publications: 0, receipts: 0 };
  const hooks = { get: null, put: null, response: null, loseAck: false };
  const close = async () => {
    runtime?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await f?.db.close(); await issuer.close();
  };
  try {
    const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic OIDC', issuer: issuer.issuer,
      clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => now });
    f = await serviceFixture(browserScopes, null, { now, identityProviders: [provider], syntheticCommunityQuota: false });
    server = createApi({ ...f, browserOrigins: ['https://galaxy.example.org'], rateLimit: 1000 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const local = 'http://127.0.0.1:' + server.address().port;
    runtime = await createWebRuntime({ endpoint, trustedKeys: f.bindings.trustedKeys }, {
      now: () => now,
      website: 'https://galaxy.example.org',
      store: {
        get: async key => { const value = structuredClone(values.get(key)); await hooks.get?.(key, value); return value; },
        put: async (key, value) => { values.set(key, structuredClone(value)); await hooks.put?.(key, value); },
        update: async (key, change) => {
          const next = change(structuredClone(values.get(key)));
          if (next?.then) throw new Error('local_update_async_callback');
          values.set(key, structuredClone(next)); await hooks.put?.(key, next); return structuredClone(next);
        },
      },
      fetch: async (url, options) => {
        const parsed = new URL(url), path = parsed.pathname;
        if (path === '/v1/consents') counts.consents++;
        if (path === '/v2/tasks') counts.publications++;
        if (path === '/v2/tasks/receipt') counts.receipts++;
        const response = await fetch(local + path + parsed.search, { ...options, headers: { ...options.headers, Origin: 'https://galaxy.example.org' } });
        await hooks.response?.(path, response);
        if (hooks.loseAck && path === '/v2/tasks' && response.status === 200) {
          hooks.loseAck = false; await response.arrayBuffer(); throw new Error('synthetic lost task publication ACK');
        }
        return response;
      },
    });
    // The actor is the fixture's real Native genesis. Transfer a distinct web
    // key through signed control and handoff, rather than inventing an Agent
    // flag or relaxing the product's Task prerequisite.
    const subjectId = f.genesis.id, nativeDeviceId = crypto.randomUUID(), publicKeyPem = f.genesis.genesisProof.publicKeyPem,
      keyId = digest(publicKeyPem), scopes = ['manage-identity', ...browserScopes];
    const bootstrap = { version: 2, kind: 'bootstrap', operationId: crypto.randomUUID(), subjectId,
      expectedEpoch: 0, previousEventHash: null, signerKeyId: keyId, genesisProof: f.genesis.genesisProof,
      newDevice: { deviceId: nativeDeviceId, publicKeyPem, scopes } };
    const initial = await f.identityControl.challenge(bootstrap), signature = await f.signForTest(initial.challenge, 'galaxy-identity-control-v2+jws');
    await f.identityControl.commit({ operationId: bootstrap.operationId, controllerSignature: signature, newDeviceProof: signature });
    const state = await f.identityControl.publicState(subjectId), offer = await runtime.deviceHandoff.createOffer(subjectId, { scopes, confirmed: true }),
      request = { version: 2, kind: 'authorize-device', operationId: offer.operationId, subjectId,
        expectedEpoch: state.epoch, previousEventHash: state.chainHead, signerKeyId: keyId,
        newDevice: { deviceId: offer.deviceId, publicKeyPem: offer.publicKeyPem, scopes: offer.scopes } },
      challenged = await f.identityControl.challenge(request),
      approval = { version: 1, type: 'galaxy-device-approval', endpoint, offer, request, challenge: challenged.challenge,
        controllerSignature: await f.signForTest(challenged.challenge, 'galaxy-identity-control-v2+jws') };
    const handoffId = crypto.randomUUID(), navigationId = crypto.randomUUID(), nonce = crypto.randomUUID(), bridgeOrigin = 'http://127.0.0.1:39841',
      context = { endpoint, website: 'https://galaxy.example.org', subjectId,
        controller: { deviceId: nativeDeviceId, keyId, epoch: state.epoch, chainHead: state.chainHead },
        scopes, expiresAt: now + 120, targetPath: '/app/publish', existingDevice: null },
      proofJson = JSON.stringify({ protocol: 'galaxy-web-identity-handoff', version: 1, handoffId, navigationId, nonce, bridgeOrigin, context });
    await runtime.agentContinuity.retainHandoff({ handoffId, navigationId, offer, approval,
      context: { ...context, nonce, bridgeOrigin, proof: { payloadJson: proofJson,
        signature: await f.signForTest(proofJson, 'galaxy-web-identity-handoff-v1+jws') } } });
    const joined = await runtime.deviceHandoff.acceptApproval(approval, { confirmed: true });
    await runtime.agentContinuity.retainReceipt(joined.receipt); await runtime.connect({ confirmed: true });
    issuer.setAccount('synthetic-task-publication-lease-owner');
    const started = await runtime.api.call('/v1/identity/begin', { providerId: 'fixture' });
    const callback = await issuer.authorize(started.authorizationUrl);
    const response = await fetch(local + callback.pathname + callback.search);
    assert.equal(response.status, 200); await response.arrayBuffer();
    await confirmFixtureAccountLink(runtime, started.loginId, { store: { get: async key => structuredClone(values.get(key)) } });
    assert.equal((await runtime.api.call('/v2/account/quotas', {})).accountVerified, true);
    const draft = { caseId: null, intent: 'proactive-review',
      workContext: { goal: 'Review synthetic continuity', currentSituation: 'No failed attempt', attemptRefs: [] },
      title: 'Synthetic publication continuity', summary: 'Controlled local consumer boundary', visibility: 'Private',
      collaboration: 'open-assistance', enrollmentExpiresAt: now + 3600 };
    return { f, runtime, values, counts, hooks, draft, close, async reconnect() {
      runtime.disconnect(); await runtime.connect({ confirmed: true }); return runtime.api.snapshot();
    } };
  } catch (error) { await close(); throw error; }
}
