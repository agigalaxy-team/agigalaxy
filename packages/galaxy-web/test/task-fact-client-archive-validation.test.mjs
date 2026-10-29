import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFactClient } from "../src/features/work-records/client.mjs";

const subjectId = 'GUID' + 'A'.repeat(28), endpoint = 'https://fictional.invalid';
const payloadHash = 'a'.repeat(64), alternativeHash = 'b'.repeat(64);
const privateText = 'PRIVATE FICTIONAL archive text';
const invalid = error => error.code === 'fact_operation_invalid';

// Local archive contract fixture only. The companion continuity suite exercises
// actual signatures, Consent, HTTP and service persistence. No private bodies
// are needed to consume a legitimate original accepted-operation locator.
function archived(kind = 'fact') {
  const taskId = randomUUID(), caseId = randomUUID(), operationId = randomUUID();
  const path = kind === 'case-link' ? `/v2/tasks/${taskId}/case-link/receipt`
    : kind === 'fact' ? '/v2/cases/events/receipt' : '/v2/verification-records/receipt';
  const input = kind === 'case-link' ? { taskId, operationId, payloadHash }
    : kind === 'fact' ? { caseId, eventId: operationId, payloadHash }
      : { type: 'evidence', id: randomUUID(), operationId, payloadHash };
  const common = { ...input, state: 'acknowledged', authority: 'accepted-operation-only', currentAccessGranted: false };
  const receipt = kind === 'verification' ? {
    ...common, audience: 'owner-only', contentReturned: false, sourceAccessChecked: false,
    receipt: { ...input, version: 1, acceptedAt: new Date().toISOString() },
  } : {
    ...common, checkedAt: new Date().toISOString(), caseVersion: 2,
    ...(kind === 'case-link' ? { caseId, taskVersion: 1, taskCaseLinkVersion: 1 }
      : { verification: 'not-provided', acceptance: 'not-provided', resolution: 'separate' }),
  };
  const record = { kind, taskId, caseId, operationId, payloadHash, state: 'acknowledged',
    currentAccessGranted: false, subjectId, endpoint, queries: [{ path, input }], receipt };
  return record;
}

function fixture(record) {
  const data = new Map([[`task-fact-receipts:${subjectId}:${record.taskId}`, [record]]]);
  let network = 0, writes = 0;
  const runtime = {
    api: { endpoint, snapshot: () => ({ subjectId, endpoint, bindingId: randomUUID() }),
      call: async () => { network += 1; throw new Error('Archived ACK must not dispatch'); } },
    getLocal: async key => structuredClone(data.get(key)),
    putLocal: async (key, value) => { writes += 1; data.set(key, structuredClone(value)); },
  };
  // A stable connection snapshot is required across the await boundaries.
  const binding = runtime.api.snapshot(); runtime.api.snapshot = () => binding;
  return { client: getFactClient(runtime, subjectId), counters: () => ({ network, writes }) };
}

test('correct cached Case-link, Case event and Verification receipts are body-free metadata without dispatch', async () => {
  for (const kind of ['case-link', 'fact', 'verification']) {
    const record = archived(kind), h = fixture(record);
    const result = await h.client.reconcile(record.taskId, { operationId: record.operationId });
    assert.equal(result.state, 'acknowledged'); assert.equal(result.operationId, record.operationId);
    assert.equal(result.payloadHash, payloadHash); assert.equal(result.currentAccessGranted, false);
    assert.equal(JSON.stringify(result).includes('payloadJson'), false);
    assert.deepEqual(h.counters(), { network: 0, writes: 0 });
  }
});

test('legacy accepted Case-link hash remains associated with its original operation', async () => {
  const record = archived('case-link');
  record.queries.push({ path: record.queries[0].path, input: { ...record.queries[0].input, payloadHash: alternativeHash } });
  record.receipt.payloadHash = alternativeHash;
  const h = fixture(record), result = await h.client.reconcile(record.taskId);
  assert.equal(result.state, 'acknowledged'); assert.equal(result.operationId, record.operationId);
  assert.equal(result.payloadHash, alternativeHash); assert.deepEqual(h.counters(), { network: 0, writes: 0 });
});

test('cached receipt locator must retain exact original operation and strict metadata fields', async t => {
  const mutations = [
    ['fact event ID', 'fact', r => { r.queries[0].input.eventId = r.receipt.eventId = randomUUID(); }],
    ['fact Case ID', 'fact', r => { r.queries[0].input.caseId = r.receipt.caseId = randomUUID(); }],
    ['fact hash', 'fact', r => { r.queries[0].input.payloadHash = r.receipt.payloadHash = alternativeHash; }],
    ['Case-link Task ID', 'case-link', r => { r.queries[0].input.taskId = r.receipt.taskId = randomUUID(); }],
    ['Case-link operation ID', 'case-link', r => { r.queries[0].input.operationId = r.receipt.operationId = randomUUID(); }],
    ['Verification operation ID', 'verification', r => {
      r.queries[0].input.operationId = r.receipt.operationId = r.receipt.receipt.operationId = randomUUID();
    }],
    ['Verification hash', 'verification', r => {
      r.queries[0].input.payloadHash = r.receipt.payloadHash = r.receipt.receipt.payloadHash = alternativeHash;
    }],
    ['fact query private field', 'fact', r => { r.queries[0].input.summary = r.receipt.summary = privateText; }],
    ['Case-link query private field', 'case-link', r => { r.queries[0].input.payloadJson = r.receipt.payloadJson = privateText; }],
    ['archive query path', 'fact', r => { r.queries[0].path = '/v2/cases/' + r.caseId + '/read'; }],
    ['archive query extra property', 'fact', r => { r.queries[0].body = privateText; }],
    ['unexpected duplicate locator', 'fact', r => { r.queries.push(structuredClone(r.queries[0])); }],
    ['unassociated Case-link original hash', 'case-link', r => { r.payloadHash = alternativeHash; }],
    ['acknowledged archive with absent receipt', 'verification', r => {
      delete r.receipt.receipt; r.receipt.state = 'absent'; r.receipt.absenceMeaning = 'no-retained-owner-operation';
    }],
    ['Verification receipt extra private field', 'verification', r => { r.receipt.receipt.summary = privateText; }],
  ];
  for (const [name, kind, mutate] of mutations) await t.test(name, async () => {
    const record = archived(kind); mutate(record); const h = fixture(record);
    await assert.rejects(h.client.reconcile(record.taskId), invalid);
    assert.deepEqual(h.counters(), { network: 0, writes: 0 });
  });
});
