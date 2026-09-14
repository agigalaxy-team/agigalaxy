import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

// Always creates a new synthetic cluster; never accepts a database URL.
const bin = process.env.GALAXY_TEST_PG_BIN;
if (!bin) throw new Error('Set GALAXY_TEST_PG_BIN to an installed PostgreSQL bin directory.');
const fault = process.env.GALAXY_TEST_PG_FAULT;
if (fault && !['after-init', 'after-start'].includes(fault)) throw new Error('Unsupported test fault');
const selected = process.env.GALAXY_TEST_PG_CASE;
if (selected && !['capsule-recovery-v2','watch-control-v2','identity-group-v2','target-governance-v2','information-v2','worker-pack-uses-v2','hubs-v2','trust-package-permissions','qualification-permission-web-v2','bounty-web-v2','chat-attachments','configuration-v2','builder-support-v2', 'capsule-web-v2', 'choice-snapshots-v2', 'task-comments-v2', 'search-v2', 'context-lifecycle-v2', 'ci-observation-v2', 'context-v2', 'identity-control', 'public-writes', 'verification-records', 'history-v2', 'chat', 'lifecycle-v2', 'discovery-v2', 'capsules-v2', 'personal-summaries', 'chat-shared-summaries', 'projects-contacts-v2', 'discovery-lifecycle-v2', 'recruitment-v2', 'qualification-v2', 'honor-v2', 'concurrency', 'lifecycle', 'interruption', 'context', 'governance', 'incident', 'history', 'search', 'discovery', 'backup', 'release', 'capacity', 'capacity-sustained', 'hub', 'honor', 'bindings', 'identity', 'personal-mcp', 'revocation', 'visibility', 'adverse'].includes(selected)) throw new Error('Unsupported test case');
const executable = name => join(resolve(bin), name + (process.platform === 'win32' ? '.exe' : ''));
await access(executable('initdb'));
const root = await mkdtemp(join(tmpdir(), 'galaxy-pg-test-'));
if (!resolve(root).startsWith(join(resolve(tmpdir()), 'galaxy-pg-test-'))) throw new Error('Unsafe cleanup path');
const data = join(root, 'data');
const password = randomBytes(32).toString('hex');
const pwfile = join(root, 'password');
await writeFile(pwfile, password, { mode: 0o600 });
const socket = createServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
let startAttempted = false;
function command(name, args) {
  // Windows postgres descendants can retain captured pg_ctl pipes after start.
  // Output was never consumed; use closed streams and keep the bounded exit check.
  const result = spawnSync(executable(name), args, { stdio: 'ignore', windowsHide: true, timeout: 60000 });
  if (result.status !== 0) {
    // Do not print raw DB configuration, authentication payloads or tool output.
    throw new Error(`${name} failed (exit ${result.status}, signal ${result.signal ?? 'none'})`);
  }
}
async function cleanup() {
  if (startAttempted) {
    const status = spawnSync(executable('pg_ctl'), ['-D', data, 'status'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (status.status === 0) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    else if (status.status !== 3) throw new Error('Cluster status unknown; temporary data preserved');
  }
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ event: 'postgres_test_cleanup', removed: true }));
}
try {
  command('initdb', ['-D', data, '-U', 'galaxy_test', '--auth=scram-sha-256', '--pwfile', pwfile, '--encoding=UTF8', '--locale=C']);
  await rm(pwfile);
  if (fault === 'after-init') throw new Error('Injected failure after initialization');
  // A timed-out start can still leave a live server. Inspect its actual status
  // during cleanup instead of relying on whether start returned successfully.
  startAttempted = true;
  command('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-w', 'start', '-o', `-h 127.0.0.1 -p ${port}`]);
  if (fault === 'after-start') throw new Error('Injected failure after startup');
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'galaxy_test',
    PGPASSWORD: password, PGDATABASE: 'postgres', GALAXY_TEST_PG_ROOT: root,
    GALAXY_TEST_PG_BIN: resolve(bin), GALAXY_TEST_PG_ISOLATED: '1' };
  delete env.NODE_TEST_CONTEXT;
  const files = selected ? [`test/postgres/${selected}.test.mjs`] : ['test/postgres/concurrency.test.mjs', 'test/postgres/lifecycle.test.mjs',
    'test/postgres/context.test.mjs', ...(process.env.GALAXY_TEST_RESTIC_BIN ? ['test/postgres/backup.test.mjs'] : []),
    ...(process.env.GALAXY_TEST_CADDY_BIN ? ['test/postgres/release.test.mjs'] : [])];
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit', windowsHide: true, timeout: 240000 });
  if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await cleanup();
}
