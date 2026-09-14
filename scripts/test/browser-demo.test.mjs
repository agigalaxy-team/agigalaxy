import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDemoNode, encodeDemoState, decodeDemoState, exportDemoState, demoStorageKey } from '../../lib/browser-demo.mjs';
import { verifyGalaxyGenesis } from '../../packages/galaxy-core/src/galaxy-guid.mjs';

test('browser data is explicitly simulated and cannot masquerade as Core identity or signed export', () => {
  const node = createDemoNode();
  assert.match(node.id, /^DEMO-/); assert.equal(verifyGalaxyGenesis(node.id, {}), false);
  const data = { node, cases: [], plans: [], grants: [], proofs: [] };
  assert.deepEqual(decodeDemoState(encodeDemoState(data)), data);
  assert.throws(() => decodeDemoState(JSON.stringify(data)));
  assert.throws(() => decodeDemoState(JSON.stringify({ schemaVersion: 2, kind: 'galaxy-browser-demo', data: { ...data, node: { ...node, id: 'GUID' + '0'.repeat(28) } } })));
  const exported = exportDemoState(data);
  assert.equal(exported.kind, 'galaxy-browser-demo'); assert.equal(exported.signed, false); assert.equal(exported.authoritative, false);
  assert.notEqual(demoStorageKey, 'galaxy-founding-beta-browser-preview-v1');
});

test('demo page uses isolated storage and explicit boundary without importing host services', async () => {
  const page = await readFile(new URL('../../app/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('浏览器演示 · 非正式服务'));
  assert.equal(page.includes('galaxy-founding-beta-browser-preview-v1'), false);
  for (const forbidden of ['galaxy-core', 'galaxy-official', 'local-host-runtime', 'fetch(', 'createBrowserNode'])
    assert.equal(page.includes(forbidden), false);
});
