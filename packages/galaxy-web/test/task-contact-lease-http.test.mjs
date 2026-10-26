import test from 'node:test';
import { retainTaskContactAgent, taskContactWebsite } from './task-contact-agent-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserToolOutput } from '../scripts/browser-tool-runtime.mjs';
import { serviceFixture } from '../../galaxy-official/test/service-fixture.mjs';
import { oidcProviderFixture } from '../../galaxy-official/test/oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from "../../galaxy-official/src/identity/authentication/oidc-login.mjs";
import { createApi } from '../../galaxy-official/src/http.mjs';
import { browserScopes } from '../../galaxy-official/src/browser-client.mjs';
import { createExistingWebRuntime, confirmFixtureAccountLink } from '../../galaxy-official/test/existing-web-identity-fixture.mjs';
import { createTaskContactClient } from "../src/features/tasks/contact/task-contact-client.mjs";
import { taskDraft, publicationFromDraft } from "../src/features/tasks/task-bounty-client.mjs";

test('same-subject reconnection cannot continue an old contact-send intent after a delayed local read', { timeout: 60000 }, async () => {
  const now = Math.floor(Date.now() / 1000), endpoint = 'https://official.example.org';
  const issuer = await oidcProviderFixture([endpoint + '/v1/identity/callback/fixture'], { emailVerified: true });
  let fixture, api; const runtimes = [];
  const output = browserToolOutput(import.meta.url);
  try {
    const provider = await createOidcLoginProvider({ id: 'fixture', name: 'Synthetic contact lease OIDC', issuer: issuer.issuer, clientId: 'galaxy-fixture', redirectUri: endpoint + '/v1/identity/callback/fixture', allowLoopbackHttp: true, now: () => now });
    fixture = await serviceFixture(browserScopes, null, { now, identityProviders: [provider], syntheticCommunityQuota: false });
    api = createApi({ ...fixture, rateLimit: 3000 });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${api.address().port}`;
    let writes = 0, delayKey = null, delayReads = 1, hit, release;
    const delayed = new Promise(resolve => hit = resolve), resumed = new Promise(resolve => release = resolve);
    const wire = async (url, init) => {
      const path = new URL(url).pathname;
      if (/^\/v2\/tasks\/.+\/events$/.test(path) && JSON.parse(JSON.parse(init.body).payloadJson).event.kind === 'invite') writes++;
      return fetch(origin + path, init);
    };
    const storage = () => { const data = new Map(); return { get: async key => { const value = structuredClone(data.get(key)); if (key === delayKey && --delayReads === 0) { delayKey = null; hit(); await resumed; } return value; }, put: async (key, value) => data.set(key, structuredClone(value)), update: async (key, updater) => { const next = updater(structuredClone(data.get(key))); if (next && typeof next.then === 'function') throw Error('synchronous_update_required'); const stored = structuredClone(next); data.set(key, stored); return structuredClone(stored); } }; };
    const stores = new WeakMap();
    const make = async store => { const rt = await createExistingWebRuntime({ endpoint, trustedKeys: fixture.bindings.trustedKeys }, { store, fetch: wire, now: () => now, website: taskContactWebsite }); stores.set(rt, store); runtimes.push(rt); return rt; };
    const a = await make(storage()), b = await make(storage());
    for (const [index, rt] of [a, b].entries()) {
      await rt.connect({ confirmed: true }); await retainTaskContactAgent(rt, stores.get(rt), now);
      issuer.setAccount(`synthetic-contact-lease-${index}`);
      const login = await rt.api.call('/v1/identity/begin', { providerId: 'fixture' });
      const callback = await issuer.authorize(login.authorizationUrl);
      assert.equal((await fetch(origin + callback.pathname + callback.search)).status, 200);
      await confirmFixtureAccountLink(rt, login.loginId);
    }
    const aid = a.api.snapshot().subjectId, bid = b.api.snapshot().subjectId;
    const published = await a.publishTask(publicationFromDraft(taskDraft({ title: '同身份重连隔离验收', summary: '合成任务，验证旧联系意图不能跨新连接继续。', goal: '限制到原确认连接', situation: '本机读取被延迟', visibility: 'Public', intent: 'diagnosis' }, now), [], now), { confirmed: true });
    const client = createTaskContactClient(a, published.taskId);
    const reviewed = await client.prepareInvites([{ subjectId: bid, note: '合成邀请：只核对当前任务边界' }]);
    const before = a.api.snapshot();
    const delayMode = process.env.CONTACT_DELAY ?? 'batch';
    delayKey = `galaxy-web:${endpoint}:${aid}:${delayMode === 'inner-event' ? 'task-event' : 'task-contact-batch'}:${published.taskId}`;
    delayReads = delayMode === 'inner-event' ? 2 : 1;
    let rejection = null;
    const pending = client.sendInvites({ confirmed: true, batchId: reviewed.batchId }).catch(error => { rejection = error.message; });
    await delayed;
    await a.connect({ confirmed: true });
    const after = a.api.snapshot();
    release(); await pending;
    const task = await a.api.call(`/v2/tasks/${published.taskId}`, null, { method: 'GET' });
    const observed = { actualWebRuntime: true, actualSignedHttp: true, delayMode, sameSubject: before.subjectId === after.subjectId, sameBinding: before.bindingId === after.bindingId, generationBefore: before.generation, generationAfter: after.generation, inviteWritesAfterRebind: writes, actualInvitationsAfterRebind: task.contacts.responses.invitations.length, oldOperationRejected: !!rejection };
    await mkdir(output, { recursive: true }); await writeFile(resolve(output, `same-subject-rebind-${delayMode}-report.json`), JSON.stringify(observed, null, 2));
    assert.equal(after.subjectId, before.subjectId); assert.notEqual(after.generation, before.generation);
    assert.equal(writes, 0, JSON.stringify(observed)); assert.equal(task.contacts.responses.invitations.length, 0); assert.ok(rejection);
    const fresh = createTaskContactClient(a, published.taskId), retained = await fresh.pending();
    assert.equal(retained.items[0].eventId, reviewed.items[0].eventId);
    assert.equal(retained.items[0].note, reviewed.items[0].note);
    const sent = await fresh.sendInvites({ confirmed: true, batchId: retained.batchId });
    assert.equal(sent.items[0].state, 'acknowledged'); assert.equal(writes, 1);
    assert.equal((await a.api.call(`/v2/tasks/${published.taskId}`, null, { method: 'GET' })).contacts.responses.invitations[0].invitationId, reviewed.items[0].eventId);
    observed.freshExplicitConfirmationCanContinueOriginalId = true;
    await writeFile(resolve(output, `same-subject-rebind-${delayMode}-report.json`), JSON.stringify(observed, null, 2));
  } finally { for (const runtime of runtimes) runtime.close(); if (api) await new Promise(resolve => api.close(resolve)); if (fixture) await fixture.db.close(); await issuer.close(); }
});
