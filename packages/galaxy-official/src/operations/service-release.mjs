import { readFile, writeFile, mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { migrations } from '../infrastructure/migrations.mjs';
import { assertRecoveryReady } from '../infrastructure/recovery-state.mjs';
import resources from '../../release-resources.json' with { type: 'json' };

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const label = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const migrationPath = 'packages/galaxy-official/src/infrastructure/migrations.mjs';

async function sourceFiles(root) {
  const files = [...resources.service];
  async function walk(relative, extension) {
    for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Release source symlink rejected.');
      const path = `${relative}/${item.name}`;
      if (item.isDirectory()) await walk(path, extension);
      else if (item.isFile() && extension.test(item.name)) files.push(path);
    }
  }
  for (const name of ['galaxy-official', 'galaxy-core']) await walk(`packages/${name}/src`, /\.(mjs|sql)$/);
  await walk('docs', /\.md$/);
  if (files.some(name => !safeName(name))) throw new Error('Invalid release resource path.');
  return [...new Set(files)].sort();
}

export async function createServiceRelease({ directory, releaseId, configurationVersion, sourceDirectory = sourceRoot }) {
  if (!isAbsolute(directory) || !isAbsolute(sourceDirectory) || !label(releaseId) || !label(configurationVersion)) throw new Error('Explicit release configuration required.');
  // The generator knows exactly these SQL versions. Never infer another tree's
  // schema from a package version or execute arbitrary imported migration code.
  const migrationBytes = await readFile(join(sourceDirectory, migrationPath));
  if (sha(migrationBytes) !== sha(await readFile(join(sourceRoot, migrationPath)))) throw new Error('Use the release generator belonging to the selected migration source.');
  const manifest = { version: 1, kind: 'galaxy-official-service-release', releaseId, configurationVersion,
    createdAt: new Date().toISOString(), minimumNode: '24.13.0',
    entries: { api: 'packages/galaxy-official/src/server.mjs', worker: 'packages/galaxy-official/src/worker.mjs',
      migration: 'packages/galaxy-official/src/migrate.mjs' },
    migrations: migrations.map(item => ({ version: item.version, sha256: sha(item.sql) })), files: {} };
  await mkdir(directory, { mode: 0o700 });
  for (const name of await sourceFiles(sourceDirectory)) {
    const source = join(sourceDirectory, name);
    if (await realpath(source) !== resolve(source) || !(await lstat(source)).isFile()) throw new Error('Release source must be regular.');
    const bytes = await readFile(source);
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), bytes, { flag: 'wx' });
    manifest.files[name] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(directory, 'service-release.json'), bytes, { flag: 'wx' });
  return { directory, releaseId, manifestSha256: sha(bytes), files: Object.keys(manifest.files).length,
    schema: manifest.migrations.at(-1).version, dependenciesInstalled: false, deployed: false };
}

export async function inspectServiceRelease(directory, expectedManifestSha256) {
  if (!isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) throw new Error('Pinned release directory and digest required.');
  const bytes = await readFile(join(directory, 'service-release.json'));
  if (sha(bytes) !== expectedManifestSha256) throw new Error('Service release manifest mismatch.');
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 1 || manifest.kind !== 'galaxy-official-service-release' || !label(manifest.releaseId)
    || !label(manifest.configurationVersion) || !Array.isArray(manifest.migrations) || !manifest.migrations.length
    || manifest.migrations.some((item, i) => item.version !== i + 1 || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('Invalid service release manifest.');
  const files = Object.entries(manifest.files);
  if (files.length < 4 || files.length > 2000 || Object.values(manifest.entries).some(name => !manifest.files[name])) throw new Error('Invalid service release files.');
  for (const [name, expected] of files) {
    if (!safeName(name)) throw new Error('Invalid release path.');
    const path = join(directory, name);
    if (await realpath(path) !== resolve(path) || !(await lstat(path)).isFile()) throw new Error('Release file must be regular.');
    const contents = await readFile(path);
    if (contents.length !== expected.bytes || sha(contents) !== expected.sha256) throw new Error('Service release file mismatch.');
  }
  return { ...manifest, directory, manifestSha256: expectedManifestSha256, filesVerified: true };
}

export function assessSchemaTransition(actualVersions, from, to) {
  const actual = actualVersions.map(row => row.version ?? row);
  const expected = to.migrations.map(row => row.version);
  if (from.migrations.some((row, i) => to.migrations[i] && row.sha256 !== to.migrations[i].sha256)) throw new Error('Historical migration SQL changed between releases.');
  if (actual.join(',') !== expected.join(',')) throw new Error('Target release is incompatible with current database; application rollback refused.');
  return { fromRelease: from.releaseId, toRelease: to.releaseId, schema: expected.at(-1),
    applicationOnly: true, databaseDowngrade: false, compatible: true };
}

export async function inspectServiceTransition({ db, fromDirectory, fromDigest, toDirectory, toDigest }) {
  const from = await inspectServiceRelease(fromDirectory, fromDigest);
  const to = await inspectServiceRelease(toDirectory, toDigest);
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const versions = (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
    const result = assessSchemaTransition(versions, from, to);
    await assertRecoveryReady(client);
    await client.query('COMMIT');
    return { ...result, fromManifestSha256: fromDigest, toManifestSha256: toDigest,
      fromConfigurationVersion: from.configurationVersion, toConfigurationVersion: to.configurationVersion,
      inspectedAt: new Date().toISOString(), proxyReloaded: false, runtimeVerified: false };
  } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
}

export async function runtimeServiceRelease(env, role, entryFile) {
  if (!env.GALAXY_RELEASE_DIRECTORY && !env.GALAXY_RELEASE_SHA256) return null;
  const release = await inspectServiceRelease(env.GALAXY_RELEASE_DIRECTORY, env.GALAXY_RELEASE_SHA256);
  if (!release.entries[role] || resolve(entryFile) !== resolve(release.directory, release.entries[role])
    || env.GALAXY_CONFIGURATION_VERSION !== release.configurationVersion) throw new Error('Runtime does not match selected service release.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 13) throw new Error('Service release requires Node24.13+.');
  return release;
}
