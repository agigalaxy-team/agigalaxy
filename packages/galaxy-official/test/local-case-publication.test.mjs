import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeGalaxyIntegration, createCaseDraft } from '../../galaxy-core/src/local-store.mjs';
import { listLocalPublicationCases, prepareLocalCasePublication, recordLocalCasePublication } from '../src/local-case-publication.mjs';

test('local publication persists one frozen event per identity/endpoint/case and records exact acknowledgements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-publication-'));
  const endpoint = 'https://official.example.org';
  try {
    await initializeGalaxyIntegration(directory, { profile: 'coding-case', source: 'test' });
    const local = await createCaseDraft(directory, { title: 'Compiler failure', failureSummary: 'Fails to build', attemptedApproaches: ['unverified local text'] });
    const before = await readFile(join(directory, 'galaxy-local-state.json'), 'utf8');
    assert.equal((await listLocalPublicationCases(directory, endpoint))[0].status, 'not-prepared');
    assert.equal(await readFile(join(directory, 'galaxy-local-state.json'), 'utf8'), before);
    const records = await Promise.all([prepareLocalCasePublication(directory, endpoint, local.id), prepareLocalCasePublication(directory, endpoint, local.id)]);
    assert.deepEqual(records[0], records[1]);
    const event = JSON.parse(records[0].payloadJson);
    assert.equal(event.summary, local.failureSummary); assert.equal(event.attemptedApproaches, undefined);
    assert.deepEqual(await prepareLocalCasePublication(directory, endpoint, local.id), records[0]);
    const other = await prepareLocalCasePublication(directory, 'https://hub.example.org', local.id);
    assert.notEqual(other.eventId, records[0].eventId);
    await assert.rejects(recordLocalCasePublication(directory, endpoint, local.id, { eventId: other.eventId }), /mismatch/);
    await recordLocalCasePublication(directory, endpoint, local.id, { caseId: event.id, eventId: event.id, version: 1, verification: 'unverified' });
    assert.equal((await listLocalPublicationCases(directory, endpoint))[0].status, 'acknowledged');
    const state = JSON.parse(await readFile(join(directory, 'galaxy-local-state.json'), 'utf8'));
    assert.equal(state.cases[0].localOnly, true); assert.equal(state.cases[0].status, 'draft');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
