import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, lstat, readdir, realpath, writeFile, readFile, chmod, chown, rm, rmdir, rename } from 'node:fs/promises';
import { posix, dirname, isAbsolute, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beneath } from './configuration.mjs';

// Child diagnostics can include provider/backend credentials. Return an exit code,
// never concatenate stderr, the environment, SQL or command arguments into errors.
export function runCommand(file, args, { env = process.env, input, timeout = 3600000, accepted = [0], maxOutput = 8388608 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0, failure = null;
    const timer = setTimeout(() => { failure = new Error('operations_command_timed_out'); child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutput) { failure = new Error('operations_command_output_limit'); child.kill('SIGKILL'); } else chunks.push(chunk); });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('operations_command_unavailable')); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!accepted.includes(code)) reject(Object.assign(new Error('operations_command_failed'), { command: posix.basename(file), exitCode: code, signal }));
      else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function assertTarget(config) {
  if (process.platform !== 'linux' || !config.targetHostname || hostname() !== config.targetHostname) throw new Error('operations_target_host_mismatch');
  if (process.getuid?.() !== 0) throw new Error('operations_root_required');
}
export async function noSymlinkPath(path) {
  if (!isAbsolute(path)) throw new Error('operations_absolute_path_required');
  for (let current = path; current !== parse(current).root; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('operations_symlink_target_rejected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export async function ensureDirectory(path, { mode = 0o700, uid, gid } = {}) {
  await noSymlinkPath(path);
  let existed = true;
  try { await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; existed = false; }
  await mkdir(path, { recursive: true, mode });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error('operations_directory_required');
  if (uid !== undefined && (info.uid !== uid || info.gid !== gid)) {
    if (existed && (await readdir(path)).length) throw new Error('operations_existing_directory_owner_mismatch');
    await chown(path, uid, gid);
  }
  if (!existed) await chmod(path, mode);
}
export async function atomicWrite(path, value, mode = 0o600) {
  await noSymlinkPath(path);
  await ensureDirectory(dirname(path));
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, value, { flag: 'wx', mode }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function newTarget(root, target) {
  if (!beneath(root, target)) throw new Error('operations_target_outside_root');
  await noSymlinkPath(root); await noSymlinkPath(target);
  await ensureDirectory(root);
  await mkdir(target, { mode: 0o700 }); // Existing directories, including empty ones, are never reused for restore.
  if (await realpath(target) !== target) throw new Error('operations_target_changed');
}
export async function removeOwnedTarget(root, target, marker) {
  if (!beneath(root, target) || await realpath(root) !== root || await realpath(target) !== target) throw new Error('operations_cleanup_outside_root');
  await noSymlinkPath(target);
  const current = JSON.parse(await readFile(posix.join(target, '.galaxy-capture'), 'utf8'));
  if (current.id !== marker) throw new Error('operations_cleanup_marker_mismatch');
  await rm(target, { recursive: true, force: false });
}
export async function withJobLock(config, action) {
  const root = config.directories.status;
  await ensureDirectory(root);
  const directory = root + '/.operations-job.lock';
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(directory + '/owner.json', 'utf8'));
    if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('operations_job_lock_unknown');
    try { process.kill(owner.pid, 0); throw new Error('operations_job_already_running'); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    // Only a dead local owner's exact two known paths are removed; an unrelated
    // file or another process prevents rmdir rather than being deleted.
    await rm(directory + '/owner.json'); await rmdir(directory);
    await mkdir(directory, { mode: 0o700 });
  }
  try {
    await writeFile(directory + '/owner.json', JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
    return await action();
  } finally { await rm(directory + '/owner.json', { force: true }); await rmdir(directory); }
}

const credentialVariables = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_DEFAULT_REGION', 'AWS_REGION', 'B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY', 'AZURE_ACCOUNT_NAME', 'AZURE_ACCOUNT_KEY', 'AZURE_ACCOUNT_SAS', 'GOOGLE_APPLICATION_CREDENTIALS']);
export async function resticEnvironment(config) {
  // Start with a small environment so inherited RESTIC_PASSWORD_COMMAND or other
  // repository/transport overrides cannot silently select a different backup.
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.RESTIC_REPOSITORY_FILE = config.backup.repositoryFile;
  env.RESTIC_PASSWORD_FILE = config.backup.passwordFile;
  const file = config.backup.credentialEnvironmentFile;
  if (file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 65536) throw new Error('operations_private_credential_reference_required');
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith('#')) continue;
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match || !credentialVariables.has(match[1]) || /[\p{Cc}]/u.test(match[2])) throw new Error('operations_credential_environment_invalid');
      env[match[1]] = match[2]; // Literal values: no shell evaluation or interpolation.
    }
  }
  for (const path of [config.backup.repositoryFile, config.backup.passwordFile]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('operations_private_credential_reference_required');
  }
  return env;
}

export function postgresSqlArguments(pg, query) {
  return ['exec', '--user', 'postgres', pg.container, 'psql', '--no-psqlrc', '--no-password', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--host', pg.socketPath, '--username', pg.administrator, '--dbname', pg.database, '--command', query];
}
export async function inspectPostgres(config, pg, run = runCommand) {
  const result = await run(config.tools.docker, postgresSqlArguments(pg, `SELECT json_build_object('dataPath',current_setting('data_directory'),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'version',current_setting('server_version_num')::int,'archiveMode',current_setting('archive_mode'),'tablespaces',(SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')))`));
  const value = JSON.parse(result.stdout.trim());
  if (Math.floor(Number(value.version) / 10000) !== 18 || value.dataPath !== pg.dataPath || (pg.systemIdentifier && value.systemIdentifier !== pg.systemIdentifier)) throw new Error('operations_postgres_target_mismatch');
  if (Number(value.tablespaces) !== 0) throw new Error('operations_external_tablespaces_need_explicit_restore_mapping');
  return value;
}
export async function writerIsRunning(config, writer, run = runCommand) {
  if (writer.kind === 'systemd') {
    const result = await run(config.tools.systemctl, ['show', '--property=ActiveState', '--value', writer.name]);
    if (!['active', 'inactive', 'failed'].includes(result.stdout.trim())) throw new Error('operations_writer_state_unknown');
    return result.stdout.trim() === 'active';
  }
  const listing = await run(config.tools.docker, ['ps', '-a', '--format', '{{.Names}}']);
  if (!listing.stdout.split('\n').includes(writer.name)) return false;
  const result = await run(config.tools.docker, ['inspect', '--format', '{{.State.Running}}', writer.name]);
  if (!['true', 'false'].includes(result.stdout.trim())) throw new Error('operations_writer_state_unknown');
  return result.stdout.trim() === 'true';
}
export async function changeWriter(config, writer, active, run = runCommand, timeout = 60000) {
  return writer.kind === 'systemd'
    ? run(config.tools.systemctl, [active ? 'start' : 'stop', writer.name], { timeout })
    : run(config.tools.docker, active ? ['start', writer.name] : ['stop', '--time', '30', writer.name], { timeout });
}
export async function quiesce(config, action, run = runCommand) {
  const stopped = [], restartFailures = [];
  const ledger = config.directories.status + '/paused-writers.json';
  try { await lstat(ledger); throw new Error('operations_previous_pause_needs_resume'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const save = () => atomicWrite(ledger, JSON.stringify({ version: 1, hostname: hostname(), pid: process.pid, writers: stopped }) + '\n');
  const deadline = Date.now() + config.backup.maxPauseSeconds * 1000;
  const remaining = () => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('operations_capture_pause_limit');
    return timeout;
  };
  let result, failure;
  try {
    for (const writer of config.backup.writers) if (await writerIsRunning(config, writer, run)) {
      // Record before issuing stop: even a lost stop acknowledgement must be resumed.
      stopped.push(writer);
      await save();
      await changeWriter(config, writer, false, run, remaining());
    }
    result = await action(remaining);
  } catch (error) { failure = error; }
  finally {
    for (const writer of [...stopped].reverse()) try { await changeWriter(config, writer, true, run); } catch { restartFailures.push(writer.name); }
    if (!restartFailures.length) await rm(ledger, { force: true });
  }
  if (restartFailures.length) throw Object.assign(new Error('operations_writer_restart_failed'), { writers: restartFailures, cause: failure });
  if (failure) throw failure;
  return result;
}
export async function resumePausedWriters(config, run = runCommand) {
  const file = config.directories.status + '/paused-writers.json';
  let ledger;
  try { ledger = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { state: 'nothing-paused' }; throw error; }
  if (ledger.hostname !== hostname() || ledger.version !== 1 || !Array.isArray(ledger.writers)) throw new Error('operations_pause_ledger_invalid');
  if (ledger.pid !== process.pid) {
    try { process.kill(ledger.pid, 0); throw new Error('operations_backup_still_running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const writers = ledger.writers.map(writer => config.backup.writers.find(current => current.kind === writer.kind && current.name === writer.name));
  if (writers.some(writer => !writer)) throw new Error('operations_pause_target_changed');
  for (const writer of writers.reverse()) await changeWriter(config, writer, true, run);
  await rm(file);
  return { state: 'resumed' };
}
