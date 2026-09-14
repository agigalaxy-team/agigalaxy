import { run } from 'node:test';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const runnerVersion = '2.1.0';
export const checkFiles = Object.freeze({
  ids: ['packages/galaxy-core/test/galaxy-guid.test.mjs'],
  evidence: ['packages/galaxy-official/test/evidence-source.test.mjs', 'packages/galaxy-official/test/evidence.test.mjs', 'packages/galaxy-a2a/test/mapping.test.mjs'],
  signatures: ['packages/galaxy-official/test/independent-envelope.test.mjs', 'packages/galaxy-official/test/signed-envelope.test.mjs', 'packages/galaxy-official/test/release-artifact.test.mjs'],
  schema: ['packages/galaxy-official/test/conformance-profile.test.mjs', 'packages/galaxy-official/test/builders.test.mjs'],
  import: ['packages/galaxy-a2a/test/host.test.mjs'],
  privacy: ['packages/galaxy-official/test/cases.test.mjs', 'packages/galaxy-a2a/test/bridge.test.mjs'],
  revocation: ['packages/galaxy-official/test/conformance.test.mjs'],
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const portable = path => path.replaceAll('\\', '/');

// No arbitrary commands, URLs or loaded test manifests. Only the fixed local
// source suite is executed. Credentials and user data are not runner inputs.
export async function fingerprint(sourceRoot = root) {
  const files = ['package.json', 'package-lock.json', 'packages/galaxy-official/package.json', 'packages/galaxy-official/package-lock.json',
    'packages/galaxy-a2a/package.json', 'packages/galaxy-a2a/package-lock.json', 'scripts/run-conformance.mjs',
    'scripts/build-client.mjs', 'scripts/client-release.mjs', 'scripts/test-client-install.mjs',
    'scripts/prepare-client-candidate.mjs', 'scripts/build-api-reference.mjs',
    'packages/galaxy-official/public-docs.json', 'packages/galaxy-official/api-reference.mjs',
    'packages/galaxy-official/deploy/caddy-routes.mjs', 'packages/galaxy-official/scripts/build_public_docs.py',
    'docs/version-contract.json'];
  async function walk(directory) {
    for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
      const path = portable(join(directory, entry.name));
      if (entry.isSymbolicLink()) throw new Error('Conformance source tree contains an untracked symbolic link.');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(mjs|ts|json)$/.test(entry.name)) files.push(path);
    }
  }
  for (const name of ['galaxy-core', 'galaxy-official', 'galaxy-a2a']) {
    await walk(`packages/${name}/src`); await walk(`packages/${name}/test`);
  }
  await walk('integrations/host-adapters/opencode-stable');
  const source = Object.fromEntries(await Promise.all([...new Set(files)].sort((a,b)=>a<b?-1:a>b?1:0).map(async path => [path, sha(await readFile(join(sourceRoot, path)))])));
  return { files: source, sha256: sha(JSON.stringify(source)) };
}

export function deriveChecks(mapping, summaries, stable = true) {
  return Object.entries(mapping).map(([id, files]) => {
    const results = files.map(file => summaries[file]);
    const failed = results.some(result => result && (!result.success || result.counts.failed > 0 || result.counts.cancelled > 0));
    const incomplete = !stable || results.some(result => !result || result.counts.tests < 1 || result.counts.passed < 1
      || result.counts.skipped > 0 || result.counts.todo > 0);
    const status = failed ? 'fail' : incomplete ? 'not-tested' : 'pass';
    return { id, status, detail: `${files.length} fixed test file(s); ${results.reduce((sum, item) => sum + (item?.counts.passed ?? 0), 0)} passing test result(s). `
      + (!stable ? 'Source changed during this run. ' : '')
      + (status === 'pass' ? 'Synthetic local source suite only; no third-party execution/capability certification.' : 'Inspect per-file results; no missing/skipped check is treated as passing.') };
  });
}

export async function runConformance() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 13) throw new Error('Conformance runner requires Node >=24.13.0.');
  const before = await fingerprint(), startedAt = new Date().toISOString();
  const selected = [...new Set(Object.values(checkFiles).flat())];
  const summaries = {}, failures = [];
  let overall = null;
  // An explicit empty execArgv prevents a parent --eval/loader/test invocation
  // from replacing the intended test file in child processes.
  const stream = run({ files: selected.map(file => join(root, file)), concurrency: 4, execArgv: [], timeout: 120000 });
  for await (const event of stream) {
    if (event.type === 'test:summary') {
      const summary = { success: event.data.success, counts: event.data.counts, durationMs: event.data.duration_ms };
      if (event.data.file) {
        const file = portable(relative(root, event.data.file));
        if (selected.includes(file)) {
          summaries[file] = summary;
          process.stdout.write(`[conformance] ${summary.success ? 'finished' : 'failed'} ${file}\n`);
        }
      } else overall = summary;
    }
    if (event.type === 'test:fail' && failures.length < 100) failures.push({ file: portable(relative(root, event.data.file ?? root)),
      name: String(event.data.name).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 200) });
  }
  const after = await fingerprint(), stable = before.sha256 === after.sha256;
  const checks = deriveChecks(checkFiles, summaries, stable);
  const manifest = { version: runnerVersion, checks: checkFiles, sourceHash: before.sha256 };
  const artifact = { version: 1, profile: 'galaxy-conformance/2', runnerVersion, startedAt, completedAt: new Date().toISOString(),
    runtime: `Node ${process.versions.node}; ${process.platform}/${process.arch}`,
    target: { kind: 'local-source-tree', sha256: before.sha256, stableDuringRun: stable },
    suite: { name: 'Galaxy local source conformance', version: runnerVersion, sha256: sha(JSON.stringify(manifest)) },
    sourceManifest: before.files, checks, results: summaries, failures, overall,
    publicationReady: false, publicationRequirements: ['Operator-selected versioned suite source URL', 'Explicit association to the exact tested release/declaration', 'Current assessor authorization and exact Consent'],
    capabilityVerified: false, independentThirdPartyExecutionVerified: false };
  const bytes = JSON.stringify(artifact, null, 2) + '\n';
  const directory = join(root, 'outputs', `conformance-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), bytes, { flag: 'wx', mode: 0o600 });
  const result = { output: directory, sha256: sha(bytes), sourceHash: before.sha256, checks: checks.map(({ id, status }) => ({ id, status })),
    counts: overall?.counts ?? null, success: stable && overall?.success === true && checks.every(check => check.status === 'pass'), publicationReady: false };
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!(await runConformance()).success) process.exitCode = 1; }
  catch { process.stderr.write('Conformance runner failed; inspect the local run state.\n'); process.exitCode = 1; }
}
