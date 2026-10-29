import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const runnerVersion = '3.0.0';
export const checkFiles = Object.freeze({
  ids: ['./internal/identity'],
  evidence: ['./internal/evidence'],
  signatures: ['./internal/deviceauth'],
  schema: ['./internal/publicwrites'],
  import: ['./internal/trustpackages'],
  privacy: ['./internal/subjectlifecycle'],
  revocation: ['./internal/retirement'],
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = path => path.replaceAll('\\', '/');

export async function fingerprint(sourceRoot = root) {
  const files = ['package.json', 'package-lock.json', 'go/go.mod', 'go/go.sum',
    'scripts/run-conformance.mjs', 'docs/technical/reference/version-contract.json'];
  async function walk(directory) {
    for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
      const path = portable(join(directory, entry.name));
      if (entry.isSymbolicLink()) throw new Error('Conformance source tree contains a symbolic link.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(go|sql|mjs|ts|json)$/.test(entry.name)) files.push(path);
    }
  }
  for (const directory of ['go/cmd', 'go/internal', 'packages/galaxy-contracts/src', 'scripts/go']) await walk(directory);
  const source = Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async path =>
    [path, sha(await readFile(join(sourceRoot, path)))])));
  return { files: source, sha256: sha(JSON.stringify(source)) };
}

export function deriveChecks(mapping, summaries, stable = true) {
  return Object.entries(mapping).map(([id, files]) => {
    const results = files.map(file => summaries[file]);
    const failed = results.some(result => result && (!result.success || result.counts.failed > 0 || result.counts.cancelled > 0));
    const incomplete = !stable || results.some(result => !result || result.counts.tests < 1 || result.counts.passed < 1
      || result.counts.skipped > 0 || result.counts.todo > 0);
    const status = failed ? 'fail' : incomplete ? 'not-tested' : 'pass';
    return { id, status, detail: `${files.length} current Go package(s); ${results.reduce((sum, item) => sum + (item?.counts.passed ?? 0), 0)} passing test result(s). `
      + (!stable ? 'Source changed during this run. ' : '')
      + (status === 'pass' ? 'Isolated source regression only; no third-party or platform acceptance.' : 'Missing, failed or skipped checks do not establish acceptance.') };
  });
}

async function runGo(selected) {
  const summaries = {}, failures = [];
  const moduleName = (await readFile(join(root, 'go/go.mod'), 'utf8')).match(/^module\s+(\S+)/m)?.[1];
  if (!moduleName) throw new Error('Go module declaration required.');
  const child = spawn(process.env.GALAXY_BUILD_GO || 'go', ['test', '-json', '-count=1', ...selected], {
    cwd: join(root, 'go'), env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let spawnError;
  const completion = new Promise(resolveResult => {
    child.on('error', error => { spawnError = error; });
    child.on('close', code => resolveResult(code));
  });
  for await (const line of createInterface({ input: child.stdout })) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event.Package?.startsWith(moduleName + '/')) continue;
    const name = '.' + event.Package.slice(moduleName.length);
    if (!selected.includes(name)) continue;
    const result = summaries[name] ??= { success: false, counts: { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 } };
    if (event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) {
      result.counts.tests++;
      result.counts[{ pass: 'passed', fail: 'failed', skip: 'skipped' }[event.Action]]++;
      if (event.Action === 'fail' && failures.length < 100) failures.push({ package: name, name: event.Test });
    }
    if (!event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) {
      result.success = event.Action === 'pass';
      result.durationMs = (event.Elapsed ?? 0) * 1000;
      console.log(`[conformance] ${event.Action} ${name}`);
    }
  }
  const code = await completion;
  if (spawnError) throw spawnError;
  return { summaries, failures, code };
}

export async function runConformance() {
  const before = await fingerprint(), startedAt = new Date().toISOString();
  const selected = [...new Set(Object.values(checkFiles).flat())];
  const { summaries, failures, code } = await runGo(selected);
  const after = await fingerprint(), stable = before.sha256 === after.sha256;
  const checks = deriveChecks(checkFiles, summaries, stable);
  const artifact = { version: 1, profile: 'galaxy-conformance/3', runnerVersion, startedAt, completedAt: new Date().toISOString(),
    runtime: `Go test; ${process.platform}/${process.arch}`, target: { kind: 'local-source-tree', sha256: before.sha256, stableDuringRun: stable },
    suite: { name: 'Galaxy current Go source conformance', version: runnerVersion, checks: checkFiles },
    sourceManifest: before.files, checks, results: summaries, failures, exitCode: code,
    publicationReady: false, publicationRequirements: ['Exact versioned suite/release association', 'Current assessor authorization and exact Consent'],
    capabilityVerified: false, independentThirdPartyExecutionVerified: false };
  const bytes = JSON.stringify(artifact, null, 2) + '\n';
  const directory = join(root, 'outputs', `conformance-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), bytes, { flag: 'wx', mode: 0o600 });
  const result = { output: directory, sha256: sha(bytes), sourceHash: before.sha256, checks: checks.map(({ id, status }) => ({ id, status })),
    success: code === 0 && stable && checks.every(check => check.status === 'pass'), publicationReady: false };
  console.log(JSON.stringify(result));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!(await runConformance()).success) process.exitCode = 1; }
  catch (error) { console.error(`Conformance runner failed: ${error.message}`); process.exitCode = 1; }
}
