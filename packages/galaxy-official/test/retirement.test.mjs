import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRetirementController, loadRetirementController } from '../src/retirement.mjs';
import { retirementFixturePolicy, verifyRetirementWorkflow } from './retirement-workflow.mjs';

test('retirement API allows takeout and revocation, clips downloads, closes enrollment and reports remaining deletion work', () => verifyRetirementWorkflow());
test('retirement policy rejects invalid windows and unknown fields and reads an explicit public configuration', async () => {
  const policy = retirementFixturePolicy(), directory = await mkdtemp(join(tmpdir(), 'galaxy-retirement-'));
  try {
    assert.throws(() => createRetirementController({ ...policy, takeoutUntil: policy.stopWritesAt }));
    assert.throws(() => createRetirementController({ ...policy, privateKey: 'not accepted' }));
    assert.throws(() => createRetirementController(policy, { endpoint: 'https://different.example.org' }), /endpoint/);
    await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
    const controller = await loadRetirementController(join(directory, 'policy.json'), { endpoint: policy.endpoint, now: () => policy.stopWritesAt });
    assert.equal(controller.phase(), 'takeout');
    assert.throws(() => controller.assertRoute('POST', '/v1/context-grants'), /writes_stopped/);
    assert.throws(() => controller.assertRoute('POST', '/v1/audit/grants/approve'), /writes_stopped/);
    assert.throws(() => controller.assertRoute('POST', '/v1/future-write'), /writes_stopped/);
    assert.throws(() => controller.assertRoute('POST', '/mcp/personal'), /writes_stopped/);
    assert.equal(controller.assertRoute('POST', '/v1/data-exports/page'), undefined);
    assert.equal((await loadRetirementController(null, { endpoint: policy.endpoint })).phase(), 'normal');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
