import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, copyFile } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, isAbsolute, resolve, relative, dirname } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import pg from 'pg';
import { assertSupportedSchema } from '../infrastructure/migrations.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function removeStaging(parent, directory) {
  const child = relative(resolve(parent), resolve(directory));
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Unsafe staging cleanup.');
  await rm(directory, { recursive: true, force: true });
}
async function fileDigest(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}
function commandEnvironment(client, provided = {}) {
  const p = client.connectionParameters;
  const ssl = Object.fromEntries(Object.entries(provided).filter(([key]) => ['PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL'].includes(key)));
  if (p.ssl && !['verify-ca', 'verify-full'].includes(ssl.PGSSLMODE)) throw new Error('Explicit verified PostgreSQL TLS configuration required for backup tools.');
  return { ...ssl, PGHOST: p.host, PGPORT: String(p.port), PGUSER: p.user,
    PGPASSWORD: p.password ?? '', PGSSLMODE: p.ssl ? ssl.PGSSLMODE : 'disable' };
}
const identifier = value => { if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid database identifier.'); return `"${value}"`; };
const nameOf = value => {
  if (typeof value !== 'string' || value.length > 200 || !/^[a-z0-9][a-z0-9._/-]*$/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..') || ['database.dump', 'manifest.json'].includes(value))
    throw new Error('Invalid backup file name.');
  return value;
};
export async function runBackupCommand(binary, args, { env = {}, cwd, timeoutMs = 300000 } = {}) {
  if (!isAbsolute(binary)) throw new Error('Absolute backup executable required.');
  return new Promise((accept, reject) => {
    // Child-only configuration. The caller supplies explicit PG/restic secrets;
    // no inherited repository/password/URL settings or raw stderr are returned.
    const platform = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['systemroot', 'windir', 'temp', 'tmp', 'path', 'home'].includes(name.toLowerCase())));
    const child = spawn(binary, args, { env: { ...platform, ...env }, cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', overflow = false;
    child.stdout.on('data', data => { if (output.length + data.length <= 8388608) output += data; else overflow = true; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Backup command could not start.')); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0 || overflow) reject(new Error(`Backup command failed (exit ${code}).`)); else accept(output); });
  });
}
const binary = (directory, name) => join(directory, name + (process.platform === 'win32' ? '.exe' : ''));
const restic = (config, args, extra = {}) => runBackupCommand(config.binary, ['--repo', config.repository, '--json', '--no-cache', ...args], { env: { ...config.environment, ...extra } });

// Uses the standard restic repository format; initialization is explicit.
export const initializeBackupRepository = config => restic(config, ['init']);
export async function backupRepositoryCheck(config) { await restic(config, ['check', '--read-data']); return { checked: true }; }
export async function copyBackupSnapshot(source, destination, snapshotId) {
  if (!/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error('Exact snapshot ID required.');
  await restic(destination, ['copy', '--from-repo', source.repository, snapshotId],
    { RESTIC_FROM_PASSWORD: source.environment.RESTIC_PASSWORD });
  const items = JSON.parse(await restic(destination, ['snapshots']));
  const copy = items.find(item => item.original === snapshotId || item.id === snapshotId);
  if (!copy) throw new Error('Copied snapshot not found.');
  return { snapshotId: copy.id, sourceSnapshotId: snapshotId };
}
export async function retentionPreview(config, { keepDaily = 7, keepWeekly = 4, keepMonthly = 6 } = {}) {
  if (![keepDaily, keepWeekly, keepMonthly].every(value => Number.isInteger(value) && value >= 1 && value <= 365)) throw new Error('Invalid retention policy.');
  return JSON.parse(await restic(config, ['forget', '--dry-run', '--group-by', 'host,tags', '--keep-daily', String(keepDaily), '--keep-weekly', String(keepWeekly), '--keep-monthly', String(keepMonthly)]));
}
export async function databaseInventory(client, { ordering = 'jsonb-text-c-v1' } = {}) {
  if (!['jsonb-text-c-v1', 'legacy-database-default'].includes(ordering)) throw new Error('Unsupported backup inventory ordering.');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result = {};
  for (const { tablename } of tables) {
    const hash = createHash('sha256'); let count = 0;
    // A database's language collation can reorder identical rows on another OS.
    // V2 inventories use PostgreSQL's explicit byte ordering on both hosts.
    const collation = ordering === 'jsonb-text-c-v1' ? ' COLLATE "C"' : '';
    await client.query(`DECLARE galaxy_backup_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS payload FROM public.${identifier(tablename)} t ORDER BY to_jsonb(t)::text${collation}`);
    while (true) {
      const rows = (await client.query('FETCH FORWARD 256 FROM galaxy_backup_rows')).rows;
      if (!rows.length) break;
      for (const row of rows) { hash.update(row.payload).update('\n'); count++; }
    }
    await client.query('CLOSE galaxy_backup_rows'); result[tablename] = { rows: count, sha256: hash.digest('hex') };
  }
  return result;
}

export async function createBackup({ pool, database, pgBin, pgEnvironment, repository, stagingParent, files = [],
  endpoint, configurationVersion, rpoTargetSeconds, rtoTargetSeconds }) {
  identifier(database);
  if (!isAbsolute(stagingParent) || !isAbsolute(pgBin) || ![rpoTargetSeconds, rtoTargetSeconds].every(value => Number.isInteger(value) && value > 0)
    || typeof configurationVersion !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(configurationVersion) || !Array.isArray(files) || files.length > 10000)
    throw new Error('Explicit backup configuration required.');
  if (new URL(endpoint).origin !== endpoint || !endpoint.startsWith('https://')) throw new Error('Invalid backup endpoint.');
  const client = await pool.connect(), id = randomUUID(), startedAt = new Date().toISOString();
  let directory;
  try {
    if ((await client.query('SELECT current_database() AS name')).rows[0].name !== database) throw new Error('Backup database target mismatch.');
    const commandEnv = commandEnvironment(client, pgEnvironment);
    directory = await mkdtemp(join(stagingParent, 'galaxy-backup-stage-'));
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assertSupportedSchema((await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const schema = (await client.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version;
    const inventory = await databaseInventory(client);
    await runBackupCommand(binary(pgBin, 'pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', '--snapshot', snapshot,
      '--file', join(directory, 'database.dump'), '--dbname', database], { env: commandEnv });
    const selected = {}, originals = new Map();
    for (const file of files) {
      const name = nameOf(file.name), target = join(directory, name);
      if (selected[name] || !isAbsolute(file.path) || !['file', 'sqlite'].includes(file.kind)) throw new Error('Invalid selected backup file.');
      const info = await lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup source must be a regular file.');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (file.kind === 'sqlite') {
        const sqlite = new DatabaseSync(file.path, { readOnly: true });
        try { await sqliteBackup(sqlite, target); } finally { sqlite.close(); }
      } else {
        originals.set(file.path, (await fileDigest(file.path)).sha256);
        await copyFile(file.path, target, constants.COPYFILE_EXCL);
      }
      selected[name] = { kind: file.kind, ...await fileDigest(target) };
      if (file.kind === 'file' && selected[name].sha256 !== originals.get(file.path)) throw new Error('Backup file changed during copy.');
    }
    for (const [path, hash] of originals) if ((await fileDigest(path)).sha256 !== hash) throw new Error('Backup configuration/object changed during capture.');
    const dump = await fileDigest(join(directory, 'database.dump'));
    const manifest = { version: 2, id, schema, endpoint, configurationVersion, startedAt, capturedAt: new Date().toISOString(),
      database: { name: database, ...dump, inventoryOrdering: 'jsonb-text-c-v1', tables: inventory }, files: selected,
      targets: { rpoSeconds: rpoTargetSeconds, rtoSeconds: rtoTargetSeconds },
      consistency: 'PostgreSQL exported transaction snapshot; selected ordinary files stable during capture; SQLite online snapshots',
      requiresQuarantinedRestore: true };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await client.query('COMMIT');
    const output = await runBackupCommand(repository.binary, ['--repo', repository.repository, '--json', '--no-cache',
      'backup', '.', '--host', 'galaxy-official', '--tag', `galaxy-${schema}`, '--tag', configurationVersion],
    { env: repository.environment, cwd: directory });
    const completed = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.message_type === 'summary');
    if (!/^[a-f0-9]{64}$/.test(completed?.snapshot_id ?? '')) throw new Error('Backup completion unconfirmed.');
    return { id, snapshotId: completed.snapshot_id, startedAt, completedAt: new Date().toISOString(), manifest,
      manifestSha256: sha(await readFile(join(directory, 'manifest.json'))), encryptedRepository: true, restoreVerified: false };
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
    if (directory) await removeStaging(stagingParent, directory);
  }
}

export async function restoreBackup({ admin, pgBin, pgEnvironment, repository, snapshotId, targetDirectory, targetDatabase,
  expectedManifestSha256, failureAt = new Date().toISOString() }) {
  identifier(targetDatabase);
  if (!/^galaxy_restore_[a-z0-9_]+$/.test(targetDatabase) || !isAbsolute(targetDirectory)
    || !Number.isFinite(Date.parse(failureAt))
    || !/^[a-f0-9]{64}$/.test(snapshotId) || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) throw new Error('Explicit new restore target required.');
  await mkdir(targetDirectory, { mode: 0o700 }); // Existing paths deliberately fail.
  const startedAt = Date.now(), recoveryId = randomUUID();
  await restic(repository, ['restore', snapshotId, '--target', targetDirectory, '--verify']);
  const manifestBytes = await readFile(join(targetDirectory, 'manifest.json'));
  if (sha(manifestBytes) !== expectedManifestSha256) throw new Error('Restore manifest mismatch.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (![1, 2].includes(manifest.version) || manifest.requiresQuarantinedRestore !== true
    || manifest.version === 2 && manifest.database?.inventoryOrdering !== 'jsonb-text-c-v1') throw new Error('Unsupported backup manifest.');
  for (const [name, record] of Object.entries({ 'database.dump': manifest.database, ...manifest.files })) {
    if (name !== 'database.dump') nameOf(name);
    const digest = await fileDigest(join(targetDirectory, name));
    if (digest.bytes !== record.bytes || digest.sha256 !== record.sha256) throw new Error('Restored file hash mismatch.');
  }
  const administrator = await admin.connect();
  let connection;
  try {
    const p = administrator.connectionParameters;
    // Never copy a connectionString: pg would let its database override our new target.
    connection = { host: p.host, port: p.port, user: p.user, password: p.password, ssl: p.ssl, database: targetDatabase };
    await administrator.query(`CREATE DATABASE ${identifier(targetDatabase)}`);
    await administrator.query(`REVOKE CONNECT ON DATABASE ${identifier(targetDatabase)} FROM PUBLIC`);
    await runBackupCommand(binary(pgBin, 'pg_restore'), ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', targetDatabase,
      join(targetDirectory, 'database.dump')], { env: commandEnvironment(administrator, pgEnvironment) });
  } finally { administrator.release(); }
  const pool = new pg.Pool(connection);
  const client = await pool.connect();
  let invalidated;
  try {
    if ((await client.query('SELECT current_database() AS name')).rows[0].name !== targetDatabase) throw new Error('Restore database target mismatch.');
    // Persist quarantine before checking facts: a failed candidate remains closed.
    await client.query(`INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status) VALUES(true,$1,$2,'quarantined')
      ON CONFLICT(singleton) DO UPDATE SET recovery_id=$1,snapshot_id=$2,status='quarantined',activated_at=NULL`, [recoveryId, snapshotId]);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    assertSupportedSchema((await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
    const inventory = await databaseInventory(client, { ordering: manifest.version === 1 ? 'legacy-database-default' : manifest.database.inventoryOrdering });
    const facts = value => Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'recovery_state'));
    if (JSON.stringify(facts(inventory)) !== JSON.stringify(facts(manifest.database.tables))) throw new Error('Restored database facts differ.');
    invalidated = {};
    for (const table of ['bindings', 'access_credentials', 'consents', 'proofs', 'context_grants', 'audit_access_grants', 'data_exports', 'external_identity_links']) {
      const result = await client.query(`UPDATE ${identifier(table)} SET revoked_at=now() WHERE revoked_at IS NULL`);
      invalidated[table] = result.rowCount;
    }
    for (const table of ['binding_challenges', 'session_challenges']) {
      invalidated[table] = (await client.query(`UPDATE ${identifier(table)} SET expires_at=now() WHERE expires_at>now()`)).rowCount;
    }
    await client.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,client_id,idempotency_key)
      VALUES('galaxy-recovery','recovery.authorization.invalidate',$1,$1,'quarantined','galaxy-recovery',$1)`, [recoveryId]);
    await client.query('COMMIT');
  } finally { try { await client.query('ROLLBACK'); } finally { client.release(); await pool.end(); } }
  const rtoSeconds = (Date.now() - startedAt) / 1000;
  const recoveryPointAgeSeconds = Math.max(0, (Date.parse(failureAt) - Date.parse(manifest.startedAt)) / 1000);
  return { recoveryId, targetDatabase, targetDirectory, snapshotId, schema: manifest.schema,
    databaseAndFilesMatched: true, comparisonException: 'recovery_state replaced by new quarantine marker', invalidated, quarantined: true, publicActivationReady: false,
    rtoSeconds, recoveryPointAgeSeconds, targets: manifest.targets,
    withinDevelopmentTargets: rtoSeconds <= manifest.targets.rtoSeconds && recoveryPointAgeSeconds <= manifest.targets.rpoSeconds,
    rtoScope: 'artifact restore, database verification and quarantine; excludes approved public reactivation' };
}
