import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { saveLocalSearchFeedback } from "../src/clients/local/search-feedback.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";

test('explicit feedback is tied to shown results, stored locally, replaceable and removable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-search-feedback-'));
  try {
    await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
    const identity = JSON.parse(await readFile(join(directory, 'galaxy-id.json'), 'utf8'));
    const read = async () => JSON.parse(await readFile(join(directory, 'galaxy-local-state.json'), 'utf8'));
    const item = { caseId: randomUUID(), projectionHash: 'a'.repeat(64), sourceVersion: 4 };
    let writes = 0;
    const controller = createHostConnectionController({ endpoint: 'https://official.example.org', client: {},
      readRequest: async () => ({}), sessions: { status: async () => ({ state: 'session-local', subjectId: identity.id, scopes: ['history'] }) },
      historyClient: { query: async () => ({ items: [item] }) },
      saveSearchFeedback: input => { writes++; return saveLocalSearchFeedback(directory, input); } });
    await controller.queryHistory({ query: 'compiler', limit: 8 });
    assert.equal(writes, 0); assert.equal((await read()).searchFeedback, undefined);
    await assert.rejects(controller.recordSearchFeedback(randomUUID(), { relevance: 'relevant', helpedSelection: true }), /Current search result/);
    await controller.recordSearchFeedback(item.caseId, { relevance: 'relevant', helpedSelection: true });
    const first = Object.values((await read()).searchFeedback);
    assert.equal(first.length, 1); assert.equal(first[0].projectionHash, item.projectionHash);
    assert.equal(first[0].verificationEffect, 'none'); assert.equal(first[0].localOnly, true);
    await controller.queryHistory({ query: 'compiler', limit: 20, after: randomUUID() });
    await controller.recordSearchFeedback(item.caseId, { relevance: 'not-relevant', helpedSelection: false });
    const replaced = Object.values((await read()).searchFeedback);
    assert.equal(replaced.length, 1); assert.equal(replaced[0].relevance, 'not-relevant');
    await controller.recordSearchFeedback(item.caseId, null);
    assert.deepEqual((await read()).searchFeedback, {});
    await controller.queryHistory({query:'compiler',capabilityId:'compiler',verificationStrength:'ci-execution-fact'});
    await controller.recordSearchFeedback(item.caseId,{relevance:'relevant',helpedSelection:true});
    await controller.queryHistory({query:'compiler',capabilityId:'compiler',verificationStrength:'reported-only'});
    await controller.recordSearchFeedback(item.caseId,{relevance:'unsure',helpedSelection:null});
    const distinct=Object.values((await read()).searchFeedback);
    assert.equal(distinct.length,2);assert.deepEqual(distinct.map(row=>row.criteria.verificationStrength).sort((a,b)=>a.localeCompare(b)),['ci-execution-fact','reported-only']);
    controller.cancel();
    await assert.rejects(controller.recordSearchFeedback(item.caseId, null), /Current search result/);
    assert.deepEqual((await read()).cases, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
