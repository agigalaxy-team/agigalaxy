import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serviceFixture } from './service-fixture.mjs';
import { initializeGalaxyIntegration, createCaseDraft } from '../../galaxy-core/src/local-store.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createLocalPublicationFlow } from "../src/clients/local/publication-flow.mjs";

test('local publication previews once, preserves Consent after lost response and completes real service writes', async () => {
  const f = await serviceFixture();
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-publication-flow-'));
  const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true });
  const endpoint = f.bindings.endpoint;
  sessions.adopt({ endpoint, subjectId: f.actor.subjectId, bindingId: f.actor.bindingId, scopes: f.actor.scopes,
    expiresAt: f.now + 500, bindingExpiresAt: f.now + 1000, takeCredential: () => f.credential });
  let consentCalls = 0, caseCalls = 0, dropResponse = true, dropCase = false, mismatch = false;
  try {
    await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
    // Synthetic public identity matches the fixture signer injected below; no production key is read.
    await writeFile(join(directory, 'galaxy-id.json'), JSON.stringify({ id: f.genesis.id, genesisProof: f.genesis.genesisProof }));
    const local = await createCaseDraft(directory, { title: 'Publication fixture', failureSummary: 'Build failure' });
    const flow = createLocalPublicationFlow({ dataDirectory: directory, endpoint, sessions, now: () => f.now,
      signIntent: f.signForTest,
      consentSend: async (_url, options) => {
        consentCalls++;
        const response = await f.consents.create(await f.access.authenticate(options.credential), JSON.parse(options.bodyJson).signedIntent);
        if (dropResponse) { dropResponse = false; throw new Error('Response lost'); }
        return response;
      },
      caseSend: async (_url, options) => {
        caseCalls++;
        const receipt = await f.cases.submit(await f.access.authenticate(options.credential), JSON.parse(options.bodyJson));
        if (dropCase) throw new Error('Case response lost');
        return receipt;
      },
      caseRead: async (url, options) => {
        const record = await f.cases.get(await f.access.authenticate(options.credential), new URL(url).pathname.split('/')[3]);
        if (mismatch) record.events[0].summary = 'Different content';
        return record;
      } });
    const first = await flow.prepare(local.id);
    assert.equal(consentCalls, 0); assert.equal(caseCalls, 0);
    await assert.rejects(flow.execute(first, 'wrong'), /confirmation/);
    await assert.rejects(flow.execute(first, first.confirmation), /Response lost/);
    assert.equal(caseCalls, 0);
    const retry = await flow.prepare(local.id);
    assert.equal(retry.intentJson, first.intentJson); assert.equal(retry.payloadJson, first.payloadJson);
    const receipt = await flow.execute(retry, retry.confirmation);
    assert.equal(receipt.eventId, first.eventId); assert.equal(caseCalls, 1);
    assert.equal((await f.cases.get(f.actor, receipt.caseId)).events.length, 1);
    assert.equal((await flow.list())[0].status, 'acknowledged');
    await assert.rejects(flow.prepare(local.id), /already acknowledged/);
    const another = await createCaseDraft(directory, { title: 'Cancel fixture', failureSummary: 'No send' });
    const canceled = await flow.prepare(another.id); flow.cancel(canceled);
    await assert.rejects(flow.execute(canceled, canceled.confirmation), /confirmation/);
    assert.equal(consentCalls, 2); assert.equal(caseCalls, 1);
    assert.equal((await flow.reconcile(another.id)).state, 'unknown', 'Unreadable does not prove absent');
    const lost = await createCaseDraft(directory, { title: 'Lost receipt', failureSummary: 'Original bytes' });
    const lostPreview = await flow.prepare(lost.id); dropCase = true;
    await assert.rejects(flow.execute(lostPreview, lostPreview.confirmation), /Case response lost/);
    mismatch = true;
    assert.equal((await flow.reconcile(lost.id)).state, 'mismatch');
    assert.equal((await flow.list()).find(item => item.localCaseId === lost.id).status, 'prepared');
    mismatch = false;
    assert.equal((await flow.reconcile(lost.id)).state, 'acknowledged');
    assert.equal((await flow.list()).find(item => item.localCaseId === lost.id).status, 'acknowledged');
    assert.equal(caseCalls, 2, 'Reconciliation never repeats the write');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(flow.reconcile(lost.id, { signal: aborted.signal }));
  } finally { sessions.close(); await f.db.close(); await rm(directory, { recursive: true, force: true }); }
});
