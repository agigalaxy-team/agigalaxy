import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Task } from '@a2a-js/sdk';
import { snapshot } from '../src/facts/mapping.mjs';

test('foreign IDs, terminal regression and unspecified state cannot overwrite a known Task', () => {
  const task = Task.fromJSON({ id: randomUUID(), contextId: randomUUID(), status: { state: 'TASK_STATE_COMPLETED' } });
  const known = snapshot(task);
  assert.throws(() => snapshot({ ...task, id: randomUUID() }, known), /task ID changed/);
  assert.throws(() => snapshot({ ...task, contextId: randomUUID() }, known), /context ID changed/);
  assert.throws(() => snapshot({ ...task, status: { state: 2 } }, known), /terminal state changed/);
  assert.throws(() => snapshot({ ...task, status: { state: 0 } }), /task\/state/);
});

test('binary/data parts use SDK ProtoJSON decoding and actual content hashes without fetching URLs', () => {
  const raw = Buffer.from([0, 255, 42]);
  const linked = 'https://example.org/not-fetched?access=SYNTHETIC-URL-CONTENT';
  const task = Task.fromJSON({ id: randomUUID(), contextId: randomUUID(), status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [{ artifactId: 'result', parts: [{ raw: raw.toString('base64'), mediaType: 'application/octet-stream' },
      { data: { answer: 42, privateBody: 'SYNTHETIC-DATA-NOT-STORED' }, mediaType: 'application/json' },
      { url: linked, mediaType: 'application/octet-stream' },
      { text: 'x'.repeat(1600), mediaType: 'text/plain' }] }] });
  const result = snapshot(task);
  assert.equal(result.artifacts[0].parts[0].bytes, 3);
  assert.equal(result.artifacts[0].parts[0].sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.artifacts[0].parts[1].kind, 'data');
  assert.equal(result.artifacts[0].parts[2].downloaded, false);
  assert.equal(result.artifacts[0].parts[2].referenceHash, createHash('sha256').update(linked).digest('hex'));
  assert.equal(result.artifacts[0].parts[3].text.length, 1200);
  const retained = JSON.stringify(result);
  assert.ok(!retained.includes(raw.toString('base64')));
  assert.ok(!retained.includes('SYNTHETIC-DATA-NOT-STORED'));
  assert.ok(!retained.includes(linked));
  assert.ok(!retained.includes('SYNTHETIC-URL-CONTENT'));
  assert.equal(result.verification, 'peer-reported');
});
