import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.GALAXY_TEST_NPM_CLI && isAbsolute(process.env.GALAXY_TEST_NPM_CLI) ? process.env.GALAXY_TEST_NPM_CLI : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
export function catalog(env = process.env) {
  return [
    { id: 'requirements', args: ['scripts/check-requirements.mjs'], scope: 'Read-only source, reading-packet and preserved legacy-plan checks; not proof of intent understanding or product acceptance' },
    { id: 'fast', args: ['scripts/check.mjs', 'all'] },
    { id: 'adapter', args: ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json', '--noEmit', '--incremental', 'false', '--pretty', 'false'], scope: 'Root strict TypeScript including configured native entry; not rendered host acceptance' },
    { id: 'host-contract', args: ['--test', '--test-concurrency=2', 'packages/galaxy-core/test/l3-initialization.test.mjs',
      'packages/galaxy-core/test/host-connection.test.mjs', 'packages/galaxy-core/test/host-lifecycle.test.mjs', 'packages/galaxy-official/test/configured-adapter.test.mjs',
      'packages/galaxy-official/test/history-adapter.test.mjs', 'packages/galaxy-official/test/remote-tools.test.mjs',
      'packages/galaxy-official/test/remote-host-integration.test.mjs'], scope: 'Native API contract simulations and real MCP client with synthetic local service records; no live OpenCode rendering' },
    { id: 'core-runtime', args: ['scripts/check-core-runtime.mjs'] },
    { id: 'postgres', args: ['packages/galaxy-official/scripts/test-postgres.mjs'], prerequisite: env.GALAXY_TEST_PG_BIN && join(env.GALAXY_TEST_PG_BIN, process.platform === 'win32' ? 'initdb.exe' : 'initdb') },
    { id: 'proxy', args: ['--test', 'packages/galaxy-official/test/proxy/caddy.test.mjs'], prerequisite: env.GALAXY_TEST_CADDY_BIN },
    { id: 'tls', args: ['--test', 'packages/galaxy-official/test/tls/public-tls.test.mjs'], prerequisite: env.GALAXY_TEST_OPENSSL_BIN },
    { id: 'client-install', args: ['scripts/test-client-install.mjs'], prerequisite: npmCli },
    { id: 'web-build', args: [npmCli, 'run', 'build'], prerequisite: npmCli },
  ];
}

export async function runLayer(layer, { directory, env = process.env, overdueMs = 180000, onProgress = () => {} }) {
  const record = { id: layer.id, status: 'running', startedAt: new Date().toISOString(), overdue: false, scope: layer.scope ?? 'Selected automated layer' };
  const log = join(directory, layer.id + '.log');
  let output = '', truncated = false;
  const started = Date.now();
  const childEnv = { ...env }; delete childEnv.NODE_TEST_CONTEXT;
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, layer.args, { cwd: root, env: childEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    record.pid = child.pid ?? null;
    onProgress({ ...record });
    const timer = setTimeout(() => {
      record.overdue = true;
      onProgress({ ...record, elapsedMs: Date.now() - started });
      // Do not kill a database/proxy harness and strand its managed services.
      // It remains running until its own bounded checks and cleanup complete.
    }, overdueMs);
    const collect = chunk => {
      if (output.length < 1048576) output += chunk.toString('utf8').slice(0, 1048576 - output.length);
      else truncated = true;
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    let spawnError = false;
    child.on('error', () => { spawnError = true; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(log, output + (truncated ? '\\n[output truncated]\\n' : ''));
      resolveResult({ ...record, status: !spawnError && code === 0 ? 'passed' : 'failed', exitCode: code,
        signal, spawnError, elapsedMs: Date.now() - started, log, finishedAt: new Date().toISOString() });
    });
  });
}

export function outcome(layers) {
  const selected = layers.filter(row => row.status !== 'not-run' && row.status !== 'manual');
  return { selectedPassed: selected.length > 0 && selected.every(row => row.status === 'passed'),
    automatedComplete: layers.filter(row => row.status !== 'manual').every(row => row.status === 'passed'),
    releaseReady: false };
}

async function main() {
  const layers = catalog();
  if (process.argv.length !== 3 || !process.argv[2].startsWith('--layers='))
    throw new Error('Usage: node scripts/verify-layers.mjs --layers=all|fast,tls,...');
  const value = process.argv[2].slice(9);
  const selected = value === 'all' ? layers.map(row => row.id) : value.split(',');
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !layers.some(row => row.id === id)))
    throw new Error('Unknown or duplicate layer.');
  const directory = resolve(root, 'outputs', 'layer-check-' + Date.now() + '-' + randomUUID());
  mkdirSync(directory);
  const report = { schemaVersion: 1, node: process.version, platform: process.platform, startedAt: new Date().toISOString(),
    layers: [...layers.map(row => ({ id: row.id, status: 'not-run', reason: 'not selected' })),
      { id: 'host-and-user-acceptance', status: 'manual', reason: 'Requires real host/user review; no synthetic substitution.' },
      { id: 'production-release', status: 'manual', reason: 'Separate deployment and release evidence required.' }] };
  const save = () => {
    Object.assign(report, outcome(report.layers));
    const temporary = join(directory, 'report.next.json');
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n'); renameSync(temporary, join(directory, 'report.json'));
  };
  save(); console.log('Layer report: ' + join(directory, 'report.json'));
  for (const id of selected) {
    const layer = layers.find(row => row.id === id), index = report.layers.findIndex(row => row.id === id);
    if ('prerequisite' in layer && (!layer.prerequisite || !isAbsolute(layer.prerequisite) || !existsSync(layer.prerequisite))) {
      report.layers[index] = { id, status: 'blocked', reason: 'Required tool path is missing or invalid.' }; save(); continue;
    }
    console.log('[layer] ' + id + ' started');
    report.layers[index] = await runLayer(layer, { directory, onProgress: record => {
      report.layers[index] = record; save(); if (record.overdue) console.log('[layer] ' + id + ' overdue; process still running');
    } });
    save(); console.log('[layer] ' + id + ': ' + report.layers[index].status);
  }
  report.finishedAt = new Date().toISOString(); save();
  process.exitCode = report.selectedPassed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();





