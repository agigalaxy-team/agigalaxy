import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBackupSpace, requiredBackupSpace } from '../operations-stack/backup-space.mjs';

test('capture reserves both staging and repository growth without spending the reserve', async () => {
  const config = { directories: { captures: '/registered/staging' }, backup: { minimumFreeBytes: 32 } };
  assert.equal(requiredBackupSpace(10, 32), 52);
  await assertBackupSpace(config, 10, async () => ({ bavail: 52, bsize: 1 }));
  await assert.rejects(assertBackupSpace(config, 10, async () => ({ bavail: 51, bsize: 1 })), /space_unavailable/);
  await assert.rejects(assertBackupSpace(config, 0, async () => ({ bavail: 31, bsize: 1 })), /space_unavailable/);
});

test('unknown and overflowing sizes cannot bypass the guard', async () => {
  for (const bytes of [-1, NaN, Infinity, 1.5]) assert.throws(() => requiredBackupSpace(bytes, 0));
  assert.throws(() => requiredBackupSpace(Number.MAX_SAFE_INTEGER, 0));
});
