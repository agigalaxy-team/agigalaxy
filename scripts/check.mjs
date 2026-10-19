import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? 'all';
if (!['all', 'test', 'core', 'official', 'a2a', 'lint'].includes(mode)) {
  console.error('Usage: node scripts/check.mjs [all|test|core|official|a2a|lint]');
  process.exit(2);
}
const [major, minor] = process.versions.node.split('.').map(Number);
const official = !['core', 'lint'].includes(mode);
if (major < (official ? 24 : 22) || (major === (official ? 24 : 22) && minor < 13)) {
  console.error(official ? 'Combined checks require Node >=24.13.0.' : 'Core checks require Node >=22.13.0.');
  process.exit(2);
}
function run(label, args) {
  console.log(`\n[galaxy-check] ${label}`);
  const env = { ...process.env };
  // A parent node:test context must not turn this fresh CLI invocation into
  // another test-runner child and suppress the requested test discovery.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false, env });
  if (result.error || result.status !== 0) {
    console.error(`[galaxy-check] ${label} failed${result.signal ? ` (${result.signal})` : ''}`);
    process.exit(result.status ?? 1);
  }
}
if (mode !== 'lint') {
  const separate = [];
  const candidateTests = new Set(['native-candidate-case-receipts.test.mjs', 'native-candidate-full-review.test.mjs',
    'native-candidate-moderation-receipt.test.mjs', 'native-owner-candidate.test.mjs', 'native-retained-receipt-candidate.test.mjs']);
  if (!!process.env.GALAXY_NATIVE_TEST_SOURCE !== !!process.env.GALAXY_NATIVE_TEST_CANDIDATE)
    throw new Error('Captured artifact acceptance requires both GALAXY_NATIVE_TEST_SOURCE and GALAXY_NATIVE_TEST_CANDIDATE.');
  const selfContained = (file, available, external) => {
    if (available || !external.has(file)) return true;
    separate.push(file); return false;
  };
  const packages = mode === 'core' ? ['galaxy-core'] : mode === 'official' ? ['galaxy-official']
    : mode === 'a2a' ? ['galaxy-a2a'] : ['galaxy-core', 'galaxy-official', 'galaxy-a2a', 'galaxy-web', 'galaxy-edge-mcp'];
  const files = packages.flatMap(name => {
    const discovered = readdirSync(resolve(root, 'packages', name, 'test'))
      .filter(file => file.endsWith('.test.mjs'))
      // These tests require a separately provisioned, isolated Prosody
      // component. The dedicated runner supplies the environment; silently
      // falling back to a live/default endpoint would make a passing suite
      // unsafe and would turn an absent prerequisite into a false failure.
      .filter(file => selfContained(file, process.env.GALAXY_TEST_CHAT_ISOLATED === '1',
        new Set(['chat-attachments-real.test.mjs', 'chat-prosody.test.mjs', 'outcome-material-real.test.mjs', 'chat-shared-summary-prosody.test.mjs']))).sort();
    if (!discovered.length) throw new Error(`No tests discovered in ${name}`);
    return discovered.map(file => `packages/${name}/test/${file}`);
  });
  if (mode === 'all' || mode === 'test') {
    files.push(...readdirSync(resolve(root, 'scripts/test'))
      .filter(file => file.endsWith('.test.mjs'))
      .filter(file => selfContained(file, !!process.env.GALAXY_NATIVE_TEST_CANDIDATE, candidateTests))
      .sort().map(file => `scripts/test/${file}`));
  }
  if (separate.length) console.log('[galaxy-check] separate environment/artifact acceptance (not executed by this run): '+separate.join(', '));
  // Bound independent test-file processes as the suite grows. Individual tests
  // still run their real concurrent clients/workers and retain timeout checks.
  run(`tests (${packages.join(', ')}; ${files.length} files; concurrency 4)`, ['--test', '--test-concurrency=4', ...files]);
}
if (mode === 'all' || mode === 'lint') {
  run('lint', ['node_modules/oxlint/bin/oxlint', 'app', 'packages', 'scripts', 'lib/browser-demo.mjs']);
}
console.log('[galaxy-check] requested checks passed.');
