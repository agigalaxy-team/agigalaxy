import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, chmod, chown } from 'node:fs/promises';
import { posix } from 'node:path';
import { beginBackupStatus, finishBackupStatus } from '../../src/operations/backup-status.mjs';
import { requireConfiguration, beneath } from './configuration.mjs';
import { runCommand, ensureDirectory, atomicWrite, newTarget, removeOwnedTarget, withJobLock, resticEnvironment, inspectPostgres, postgresSqlArguments, quiesce } from './host.mjs';
import { pgBackRestConfiguration } from './render.mjs';
import { assertBackupSpace } from './backup-space.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
const labelPattern = /^[0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?$/;
const capturePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pointPattern = /^galaxy_[0-9a-f]{32}$/;
export const invalidateRestoredSessionsSql = `DO $galaxy_restore$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'official_account_sessions_v1','official_account_logins_v1',
    'operations_operator_sessions_v1','operations_operator_logins_v1',
    'oidc_login_transactions_v1'
  ] LOOP
    IF to_regclass('public.' || relation_name) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I', relation_name);
    END IF;
  END LOOP;
END $galaxy_restore$;`;

async function publishStatus(config, action, work) {
  const directory = config.directories.status;
  await ensureDirectory(directory);
  if (config.backup.statusGroupId !== null) { await chown(directory, 0, config.backup.statusGroupId); await chmod(directory, 0o750); }
  const adjust = async () => {
    if (config.backup.statusGroupId !== null) { await chown(directory + '/' + action + '.json', 0, config.backup.statusGroupId); await chmod(directory + '/' + action + '.json', 0o640); }
  };
  const status = await beginBackupStatus(directory, action); await adjust();
  try {
    const result = await work();
    await finishBackupStatus(status, true); await adjust();
    return result;
  } catch (error) {
    await finishBackupStatus(status, false); await adjust();
    throw error;
  }
}
export function backrestArguments(pg, args) {
  return ['exec', '--user', 'postgres', pg.container, '/usr/local/bin/galaxy-pgbackrest', '--stanza=' + pg.id, ...args];
}
export function chooseBackup(info, { before } = {}) {
  const backups = info.flatMap(stanza => stanza.backup ?? []).filter(backup => labelPattern.test(backup.label) && Number.isFinite(backup.timestamp?.stop) && (before === undefined || backup.timestamp.stop <= before));
  backups.sort((a, b) => b.timestamp.stop - a.timestamp.stop);
  if (!backups.length) throw new Error('operations_no_eligible_database_backup');
  return backups[0];
}
async function repositorySize(config, paths, run) {
  let total = 0;
  for (const path of paths) {
    const result = await run('/usr/bin/du', ['-s', '--block-size=1', '--', path]);
    const bytes = Number(result.stdout.split(/\s/)[0]);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('operations_capture_size_unknown');
    total += bytes;
  }
  if (total > config.backup.maxCaptureBytes) throw new Error('operations_capture_size_limit');
  await assertBackupSpace(config, total);
  return total;
}
async function sourcesForCapture(config) {
  const sources = [], omitted = [];
  for (const source of config.backup.sources) {
    let path;
    try { path = await realpath(source.path); }
    catch (error) { if (error.code === 'ENOENT' && source.optional) { omitted.push({ id: source.id, reason: 'optional-source-absent' }); continue; } throw Object.assign(new Error('operations_capture_source_unavailable'), { sourceId: source.id }); }
    const info = await lstat(path);
    if (source.kind === 'tree' ? !info.isDirectory() : !info.isFile()) throw new Error('operations_capture_source_type_mismatch');
    if ([config.directories.captures, config.directories.restores].some(root => root === path || beneath(path, root) || beneath(root, path))) throw new Error('operations_recursive_capture_rejected');
    sources.push({ ...source, resolvedPath: path });
  }
  return { sources, omitted };
}
async function copyTree(run, source, destination, { timeout = 3600000, addOnly = false } = {}) {
  await ensureDirectory(posix.dirname(destination));
  return run('/usr/bin/cp', ['--archive', '--reflink=auto', '--one-file-system', ...(addOnly ? ['--update'] : []), '--', source, destination], { timeout, maxOutput: 1024 });
}
async function restic(config, args, run, options = {}) {
  return run(config.tools.restic, args, { ...options, env: await resticEnvironment(config) });
}
export async function initializeRestic(config, run = runCommand) {
  requireConfiguration(config, 'backup');
  // A pre-existing repository is opened, never reinitialized or replaced.
  const opened = await restic(config, ['cat', 'config'], run, { accepted: [0, 1, 10, 12], maxOutput: 65536 });
  if (opened.code === 0) return { state: 'existing' };
  // restic itself refuses init on an existing repository, including wrong-password cases.
  await restic(config, ['init'], run);
  return { state: 'created' };
}

export async function createProductBackup(config, { type = 'auto', run = runCommand, now = () => new Date(), captureContext = null, beforeTransfer = null, onPhase = null } = {}) {
  const phase=async value=>{if(typeof onPhase==='function')try{await onPhase(value);}catch{/* Diagnostics do not change this command's result. */}};
  await phase('prepare');
  requireConfiguration(config, 'backup');
  if (!['auto', 'full', 'diff', 'incr'].includes(type)) throw new Error('operations_backup_type_invalid');
  return withJobLock(config, () => publishStatus(config, 'create', async () => {
    await ensureDirectory(config.directories.captures);
    await assertBackupSpace(config, 0);
    const id = randomUUID(), stage = config.directories.captures + '/' + id;
    await newTarget(config.directories.captures, stage);
    await atomicWrite(stage + '/.galaxy-capture', json({ id, purpose: 'backup' }));
    let completed = false;
    try {
      const preliminary = await sourcesForCapture(config), databases = [];
      await phase('database-backup');
      for (const pg of config.postgres) {
        const current = await inspectPostgres(config, pg, run);
        if (current.archiveMode !== 'on') throw new Error('operations_postgres_archive_not_enabled');
        const info = JSON.parse((await run(config.tools.docker, backrestArguments(pg, ['info', '--output=json']))).stdout);
        const selectedType = type === 'auto' ? (now().getUTCDay() === 0 ? 'full' : 'diff') : type;
        const effectiveType = info.some(stanza => stanza.backup?.length) ? selectedType : 'full';
        await run(config.tools.docker, backrestArguments(pg, ['--type=' + effectiveType, 'backup']), { timeout: 14400000 });
        const after = JSON.parse((await run(config.tools.docker, backrestArguments(pg, ['info', '--output=json']))).stdout);
        const chosen = chooseBackup(after);
        databases.push({ id: pg.id, systemIdentifier: current.systemIdentifier, backupLabel: chosen.label, backupStoppedAt: chosen.timestamp.stop, restorePoint: 'galaxy_' + id.replaceAll('-', ''), dataPath: pg.dataPath, database: pg.database });
      }
      await phase('size-check');
      await repositorySize(config, [...preliminary.sources.map(source => source.resolvedPath), ...config.postgres.map(pg => pg.repository)], run);
      // Completed pgBackRest backups and WAL segment objects are immutable. Copy
      // these before the pause; only newly archived WAL is added during capture.
      await phase('precopy');
      for (const pg of config.postgres) await copyTree(run, pg.repository, stage + '/pgbackrest/' + pg.id);
      const precopied=new Map(),early=config.backup.precopySourceIds??[];
      if(!Array.isArray(early)||new Set(early).size!==early.length||early.some(id=>!['api-release','admin-release'].includes(id))||early.length&&captureContext===null)throw new Error('operations_capture_context_invalid');
      for(const id of early){
        const source=preliminary.sources.find(source=>source.id===id);
        if(!source||source.kind!=='tree'||source.path!==source.resolvedPath||!/^\/(?:opt\/galaxy\/releases|srv\/galaxy\/admin\/releases)\/[A-Za-z0-9._-]+$/.test(source.path))throw new Error('operations_target_changed');
        await copyTree(run,source.resolvedPath,stage+'/files/'+source.id);precopied.set(id,source);
      }
      const captureStartedAt = Math.floor(Date.now() / 1000);
      await phase('capture-and-resume');
      await quiesce(config, async remaining => {
        // A publisher may have switched current during the online database
        // backup. Resolve release pointers only after every writer is paused.
        const { sources, omitted } = await sourcesForCapture(config);
         // The maintenance adapter resolves current service releases and owned
         // volumes before this call. Recheck that same footprint after writers
         // stop, and bind its closed coverage facts to this immutable capture.
         // No command or path is obtained from an HTTP/model request here.
         const maintenance = captureContext === null ? null : await captureContext({
           captureId: id, sourceIds: sources.map(source => source.id),
           postgresStanzas: config.postgres.map(pg => pg.id), remaining,
         });
         if (maintenance !== null && (maintenance?.version !== 1 || !/^[a-f0-9]{64}$/.test(maintenance.footprintDigest ?? '') || !Array.isArray(maintenance.coverage)
           || maintenance.coverage.some(item => !['covered','uncovered','unknown','not-applicable'].includes(item?.state)
             || !Array.isArray(item.sourceIds) || item.sourceIds.some(value => !sources.some(source => source.id === value))
             || !Array.isArray(item.postgresStanzas) || item.postgresStanzas.some(value => !config.postgres.some(pg => pg.id === value))))) throw new Error('operations_capture_context_invalid');
         if(early.length&&(maintenance===null||!Array.isArray(maintenance.immutableSourceIds)||early.some(id=>!maintenance.immutableSourceIds.includes(id))))throw new Error('operations_capture_context_invalid');
        for (const pg of config.postgres) {
          const database = databases.find(item => item.id === pg.id);
          const query = `SELECT pg_create_restore_point('${database.restorePoint}'); SELECT pg_switch_wal();`;
          await run(config.tools.docker, postgresSqlArguments(pg, query), { timeout: remaining(), maxOutput: 1024 });
          await run(config.tools.docker, backrestArguments(pg, ['check']), { timeout: remaining() });
          await copyTree(run, pg.repository + '/archive/.', stage + '/pgbackrest/' + pg.id + '/archive', { timeout: remaining(), addOnly: true });
        }
        for(const [id,old]of precopied){const current=sources.find(source=>source.id===id);if(!current||current.path!==old.path||current.resolvedPath!==old.resolvedPath||current.kind!==old.kind)throw new Error('operations_target_changed');}
        for (const source of sources) if(!precopied.has(source.id))await copyTree(run, source.resolvedPath, stage + '/files/' + source.id, { timeout: remaining() });
        const manifest = { version: 1, id, captureStartedAt, captureFinishedAt: Math.floor(Date.now() / 1000), databases,
          precopySourceIds:[...precopied.keys()],files: sources.map(({ id: sourceId, path, resolvedPath, kind }) => ({ id: sourceId, path, resolvedPath, kind })), omittedSources: omitted,
          keycloakRealms: config.backup.keycloakRealms, restoreScope: 'named-database-points-and-files-in-this-capture' };
         if (maintenance !== null) manifest.maintenance = maintenance;
        await atomicWrite(stage + '/capture.json', json(manifest));
      }, run);
      // Writers are already resumed before potentially slow remote transfer.
       await phase('before-transfer');
       if (beforeTransfer !== null) await beforeTransfer();
      await phase('repository-transfer');
      const response = await restic(config, ['--no-cache', 'backup', stage, '--json', '--host', config.backup.resticHost, '--tag', 'galaxy-product', '--tag', 'capture:' + id], run, { timeout: 14400000, maxOutput: 16777216 });
      await phase('repository-result');
      const summary = response.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(item => item.message_type === 'summary');
      if (!/^[a-f0-9]{64}$/.test(summary?.snapshot_id ?? '')) throw new Error('operations_restic_snapshot_unknown');
      const receipt = { version: 1, captureId: id, snapshotId: summary.snapshot_id, snapshotSubfolder: stage, finishedAt: Math.floor(Date.now() / 1000), databaseRestorePoints: databases.map(({ id: stanza, restorePoint, backupLabel }) => ({ stanza, restorePoint, backupLabel })) };
      await phase('record-receipt');
      await atomicWrite(config.directories.status + '/last-capture.json', json(receipt));
      completed = true;
      return receipt;
    } finally {
      // A failed capture is retained for diagnosis; it is private and never
      // advertised as a successful restore point. Only this exact successful
      // staging directory is removed; repository history is untouched.
      if (completed){await phase('cleanup');await removeOwnedTarget(config.directories.captures, stage, id);}
    }
  }));
}

export function restoreReceipt(input) {
  if (input?.version !== 1 || !capturePattern.test(input.captureId ?? '') || !/^[a-f0-9]{64}$/.test(input.snapshotId ?? '') || typeof input.snapshotSubfolder !== 'string' || !input.snapshotSubfolder.startsWith('/') || posix.basename(input.snapshotSubfolder) !== input.captureId || posix.normalize(input.snapshotSubfolder) !== input.snapshotSubfolder) throw new Error('operations_restore_receipt_invalid');
  return input;
}
export function restoreManifest(input, config, captureId) {
  if (input?.version !== 1 || input.id !== captureId || !Array.isArray(input.databases) || input.databases.length !== config.postgres.length) throw new Error('operations_restore_manifest_invalid');
  for (const pg of config.postgres) {
    const record = input.databases.find(item => item.id === pg.id);
    if (!record || record.systemIdentifier !== pg.systemIdentifier || record.dataPath !== pg.dataPath || record.database !== pg.database || !labelPattern.test(record.backupLabel ?? '') || !pointPattern.test(record.restorePoint ?? '')) throw new Error('operations_restore_database_mismatch');
  }
  return input;
}
export function isolatedPostgresArguments(config, pg, { root, repository, configurationFile, name, entrypoint, args, socketDirectory=null }) {
  return ['run', ...(entrypoint === 'postgres' ? ['--detach', '--name', name] : ['--rm']), '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', pg.uid + ':' + pg.gid,
    '--tmpfs', '/tmp:rw,nosuid,size=64m', '--tmpfs', '/var/run/pgbackrest:rw,nosuid,size=16m,uid=' + pg.uid + ',gid=' + pg.gid,
    '--tmpfs', '/var/log/pgbackrest:rw,nosuid,size=16m,uid=' + pg.uid + ',gid=' + pg.gid,
    '--tmpfs', '/var/spool/pgbackrest:rw,nosuid,size=64m,uid=' + pg.uid + ',gid=' + pg.gid,
    '--mount', 'type=bind,src=' + root + ',dst=/var/lib/postgresql',
    '--mount', 'type=bind,src=' + repository + ',dst=/var/lib/pgbackrest,readonly',
    '--mount', 'type=bind,src=' + configurationFile + ',dst=/etc/pgbackrest/pgbackrest.conf,readonly',
    ...(socketDirectory ? ['--mount', 'type=bind,src=' + socketDirectory + ',dst=/galaxy-recovery-socket'] : []),
    '--mount', 'type=bind,src=' + pg.cipherFile + ',dst=/run/secrets/pgbackrest_repository_cipher,readonly',
    '--entrypoint', entrypoint, config.images.postgresBackup, ...args];
}
async function restoreDatabase(config, pg, record, target, repository, run, { type = 'name', recoveryTarget = record.restorePoint, privateSocket=false } = {}) {
  const root = target + '/postgres/' + pg.id, configurationFile = target + '/restore-config/' + pg.id + '.conf';
  await ensureDirectory(root, { uid: pg.uid, gid: pg.gid });
  let dataPath = root;
  for (const segment of pg.dataPath.slice('/var/lib/postgresql/'.length).split('/')) {
    dataPath = posix.join(dataPath, segment);
    await ensureDirectory(dataPath, { uid: pg.uid, gid: pg.gid });
  }
  await atomicWrite(configurationFile, pgBackRestConfiguration(pg), 0o644);
  const name = 'galaxy-restore-' + randomUUID().replaceAll('-', '').slice(0, 12) + '-' + pg.id;
  const restoreArgs = ['--stanza=' + pg.id, '--set=' + record.backupLabel, '--type=' + type, '--target=' + recoveryTarget, '--target-action=promote', '--archive-mode=off', 'restore'];
  await run(config.tools.docker, isolatedPostgresArguments(config, pg, { root, repository, configurationFile, entrypoint: '/usr/local/bin/galaxy-pgbackrest', args: restoreArgs }), { timeout: 14400000 });
  const socketDirectory=privateSocket?target+'/sockets/'+pg.id:null;
  if(socketDirectory){await ensureDirectory(socketDirectory,{uid:pg.uid,gid:pg.gid});await atomicWrite(socketDirectory+'/pg_hba.conf','local all all trust\n',0o644);}
  const socketPath=socketDirectory?'/galaxy-recovery-socket':'/tmp';
  const command = ['-D', pg.dataPath, '-c', 'listen_addresses=', '-c', 'unix_socket_directories='+socketPath, ...(socketDirectory?['-c','hba_file=/galaxy-recovery-socket/pg_hba.conf']:[]), '-c', 'archive_mode=off', '-c', 'primary_conninfo=', '-c', 'primary_slot_name=', '-c', 'synchronous_standby_names=', '-c', `restore_command=/usr/local/bin/galaxy-pgbackrest --stanza=${pg.id} archive-get %f "%p"`];
  await run(config.tools.docker, isolatedPostgresArguments(config, pg, { root, repository, configurationFile, name, entrypoint: 'postgres', args: command,socketDirectory }));
  const clone = { ...pg, container: name, socketPath };
  try {
    const deadline = Date.now() + 300000;
    let ready = false;
    while (Date.now() < deadline) {
      const result = await run(config.tools.docker, ['exec', '--user', 'postgres', name, 'pg_isready', '--host', socketPath, '--username', pg.administrator, '--dbname', pg.database], { accepted: [0, 1, 2], timeout: 10000, maxOutput: 1024 });
      if (result.code === 0) {
        const recovery = await run(config.tools.docker, postgresSqlArguments(clone, 'SELECT pg_is_in_recovery()'));
        if (recovery.stdout.trim() === 'f') { ready = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('operations_isolated_restore_not_ready');
    const restored = await inspectPostgres(config, clone, run);
    if (restored.archiveMode !== 'off') throw new Error('operations_isolated_archive_mode_invalid');
    // The clone has no network and no application. Clearing session rows never
    // touches the source cluster, principal mappings, UID or audit history.
    await run(config.tools.docker, postgresSqlArguments(clone, invalidateRestoredSessionsSql));
    return { stanza: pg.id, container: name, dataPath, repository, network: 'none', ports: [], sessionsInvalidated: true,...(socketDirectory?{socketDirectory,socketPath}:{}) };
  } catch (error) {
    await run(config.tools.docker, ['stop', '--time', '10', name]).catch(() => {});
    throw error;
  }
}

export async function applyResticRetention(config, run = runCommand) {
  requireConfiguration(config, 'backup');
  return withJobLock(config, () => publishStatus(config, 'retention', async () => {
    const policy = config.backup.retention;
    await restic(config, ['forget', '--host', config.backup.resticHost, '--tag', 'galaxy-product', '--group-by', 'host',
      '--keep-last', '2', '--keep-daily', String(policy.daily), '--keep-weekly', String(policy.weekly), '--keep-monthly', String(policy.monthly), '--prune'], run, { timeout: 14400000 });
    return { state: 'retained', host: config.backup.resticHost, tag: 'galaxy-product', ...policy };
  }));
}
export async function restoreProductBackup(config, { receipt: supplied, directory, run = runCommand, lockHeld = false, privateSockets=false, selectedStanzas=null }) {
  requireConfiguration(config, 'restore');
  const receipt = restoreReceipt(supplied);
  if (!beneath(config.directories.restores, directory)) throw new Error('operations_restore_outside_root');
  const restore = () => publishStatus(config, 'restore', async () => {
    await newTarget(config.directories.restores, directory);
    await atomicWrite(directory + '/.galaxy-capture', json({ id: receipt.captureId, purpose: 'restore' }));
    const bundle = directory + '/bundle'; await mkdir(bundle, { mode: 0o700 });
    await restic(config, ['restore', receipt.snapshotId + ':' + receipt.snapshotSubfolder, '--target', bundle], run, { timeout: 14400000, maxOutput: 1048576 });
    const manifest = restoreManifest(JSON.parse(await readFile(bundle + '/capture.json', 'utf8')), config, receipt.captureId);
    const databases = [];
    try {
      if(selectedStanzas!==null&&(!Array.isArray(selectedStanzas)||!selectedStanzas.length||selectedStanzas.some(id=>!config.postgres.some(pg=>pg.id===id))))throw new Error('operations_restore_stanza_scope_invalid');
      for (const pg of config.postgres.filter(pg=>selectedStanzas===null||selectedStanzas.includes(pg.id))) databases.push(await restoreDatabase(config, pg, manifest.databases.find(item => item.id === pg.id), directory, bundle + '/pgbackrest/' + pg.id, run,{privateSocket:privateSockets}));
    } catch (error) {
      for (const database of databases) await run(config.tools.docker, ['stop', '--time', '10', database.container]).catch(() => {});
      await atomicWrite(directory + '/restore.json', json({ version: 1, state: 'failed', target: directory, databases, publicActivation: false }));
      throw error;
    }
    const result = { version: 1, state: 'isolated', target: directory, captureId: receipt.captureId, databases, files: bundle + '/files', publicActivation: false,
      keycloakLogoutAllRequired: config.backup.keycloakRealms, upstreamSessionsInvalidated: false };
    await atomicWrite(directory + '/restore.json', json(result));
    return result;
  });
  // The fixed maintenance executor holds this same host lock across all phases.
  // The standalone isolated-restore CLI retains its existing lock behavior.
  return lockHeld ? restore() : withJobLock(config, restore);
}

export async function restoreDatabaseAtTime(config, { stanza, at, directory, run = runCommand }) {
  requireConfiguration(config, 'restore');
  const pg = config.postgres.find(item => item.id === stanza), timestamp = Date.parse(at);
  if (!pg || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at ?? '') || !Number.isFinite(timestamp) || timestamp > Date.now()) throw new Error('operations_pitr_target_invalid');
  return withJobLock(config, () => publishStatus(config, 'restore', async () => {
    await newTarget(config.directories.restores, directory);
    await atomicWrite(directory + '/.galaxy-capture', json({ id: randomUUID(), purpose: 'database-pitr' }));
    const info = JSON.parse((await run(config.tools.docker, backrestArguments(pg, ['info', '--output=json']))).stdout);
    const backup = chooseBackup(info, { before: Math.floor(timestamp / 1000) });
    const restored = await restoreDatabase(config, pg, { backupLabel: backup.label }, directory, pg.repository, run, { type: 'time', recoveryTarget: at });
    const result = { version: 1, state: 'isolated', target: directory, databases: [restored], databaseTarget: at, files: null, publicActivation: false, keycloakLogoutAllRequired: config.backup.keycloakRealms, upstreamSessionsInvalidated: false };
    await atomicWrite(directory + '/restore.json', json(result));
    return result;
  }));
}
