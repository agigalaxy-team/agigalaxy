import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { migrations } from '../src/infrastructure/migrations.mjs';
import resources from '../release-resources.json' with { type: 'json' };
import { createServiceRelease, inspectServiceRelease, assessSchemaTransition, runtimeServiceRelease } from '../src/operations/service-release.mjs';

test('frozen service tree and runtime are bound to the pinned manifest and configuration version', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'galaxy-release-test-'));
  try {
    const directory = join(temporary, 'release');
    const receipt = await createServiceRelease({ directory, releaseId: 'candidate-1', configurationVersion: 'cfg-1' });
    const release = await inspectServiceRelease(directory, receipt.manifestSha256);
    assert.deepEqual(release.migrations, migrations.map(item => ({
      version: item.version, sha256: createHash('sha256').update(item.sql).digest('hex')
    })));
    assert.equal(receipt.schema, migrations.at(-1).version);
    for (const name of resources.service) assert.ok(release.files[name], name);
    assert.ok(release.files['docs/operations/deployment.md']);
    assert.equal(release.files['packages/galaxy-official/scripts/test-postgres.mjs'], undefined);
    const env = { GALAXY_RELEASE_DIRECTORY: directory, GALAXY_RELEASE_SHA256: receipt.manifestSha256, GALAXY_CONFIGURATION_VERSION: 'cfg-1' };
    assert.equal((await runtimeServiceRelease(env, 'api', join(directory, release.entries.api))).releaseId, 'candidate-1');
    assert.equal((await runtimeServiceRelease(env, 'migration', join(directory, release.entries.migration))).releaseId, 'candidate-1');
    await assert.rejects(runtimeServiceRelease({ ...env, GALAXY_CONFIGURATION_VERSION: 'cfg-2' }, 'api', join(directory, release.entries.api)), /does not match/);
    await assert.rejects(runtimeServiceRelease(env, 'api', join(temporary, 'wrong-server.mjs')), /does not match/);
    await assert.rejects(inspectServiceRelease(directory, '0'.repeat(64)), /manifest mismatch/);
    await appendFile(join(directory, release.entries.api), '\n// synthetic changed build\n');
    await assert.rejects(inspectServiceRelease(directory, receipt.manifestSha256), /file mismatch/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('application-only rollback requires the exact live schema and unchanged shared migration SQL', () => {
  const older = { releaseId: 'older', migrations: [{ version: 1, sha256: 'a'.repeat(64) }] };
  const newer = { releaseId: 'newer', migrations: [...older.migrations, { version: 2, sha256: 'b'.repeat(64) }] };
  assert.equal(assessSchemaTransition([1], older, older).compatible, true);
  assert.equal(assessSchemaTransition([1, 2], older, newer).schema, 2);
  for (const versions of [[1, 2], [], [2], [1, 999]]) assert.throws(() => assessSchemaTransition(versions, newer, older), /incompatible/);
  assert.throws(() => assessSchemaTransition([1], older, { ...older, migrations: [{ version: 1, sha256: 'c'.repeat(64) }] }), /SQL changed/);
});
