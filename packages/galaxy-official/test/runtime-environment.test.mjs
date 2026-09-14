import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertRuntimeEnvironment, assertRuntimePaths } from '../src/runtime-environment.mjs';

test('runtime stages reject mixed databases and inherited signing material without exposing secrets', () => {
  for (const stage of ['local', 'integration', 'pilot']) {
    const env = { GALAXY_ENVIRONMENT: stage, DATABASE_URL: `postgresql://worker:synthetic@localhost/galaxy_${stage}` };
    assert.deepEqual(assertRuntimeEnvironment(env, 'worker'), { environment: stage, role: 'worker' });
    assert.throws(() => assertRuntimeEnvironment({ ...env, DATABASE_URL: 'postgresql://worker:synthetic@localhost/wrong' }, 'worker'), /Invalid isolated/);
    assert.throws(() => assertRuntimeEnvironment({ ...env, DATABASE_URL: env.DATABASE_URL + '?dbname=other' }, 'worker'));
    assert.throws(() => assertRuntimeEnvironment({ ...env, GALAXY_SIGNING_KEY_FILE: 'secret' }, 'migration'));
  }
  assert.throws(() => assertRuntimeEnvironment({}, 'api'));
});

test('API paths remain within the explicit environment and reject directory aliases', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'galaxy-isolation-'));
  try {
    const root = join(temporary, 'local'); await mkdir(root);
    const env = { GALAXY_ENVIRONMENT: 'local', DATABASE_URL: 'postgresql://api:synthetic@localhost/galaxy_local',
      GALAXY_ENVIRONMENT_DIRECTORY: root, GALAXY_SIGNING_KEY_ID: 'fixture' };
    for (const field of ['GALAXY_SIGNING_KEY_FILE', 'GALAXY_ROOT_PINS_FILE', 'GALAXY_KEYRING_FILE']) {
      env[field] = join(root, field); await writeFile(env[field], 'synthetic, not key material');
    }
    env.GALAXY_TRUST_DIRECTORY = join(root, 'trust'); await mkdir(env.GALAXY_TRUST_DIRECTORY);
    assertRuntimeEnvironment(env, 'api'); await assertRuntimePaths(env);
    assert.throws(() => assertRuntimeEnvironment({ ...env, GALAXY_SIGNING_KEY_FILE: join(temporary, 'pilot', 'key') }, 'api'));
    const alias = join(root, 'alias'); await symlink(temporary, alias, 'junction');
    await assert.rejects(assertRuntimePaths({ ...env, GALAXY_TRUST_DIRECTORY: alias }), /Invalid isolated runtime paths/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('all executable entrypoints fail before connections with missing environment and sanitized output', () => {
  for (const name of ['server', 'worker', 'migrate']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GALAXY_') && key !== 'DATABASE_URL'));
    env.DATABASE_URL = 'postgresql://synthetic:never-print-this@127.0.0.1:1/galaxy_pilot';
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../src/${name}.mjs`, import.meta.url))],
      { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('never-print-this'));
    if (name === 'server') assert.equal(JSON.parse(result.stderr.trim()).phase, 'environment');
    assert.match(result.stderr, /"event":"(?:startup_failed|worker_startup_failed|migration_failed)"/);
  }
});
