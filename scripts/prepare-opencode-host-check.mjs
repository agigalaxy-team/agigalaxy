import { mkdtemp, mkdir, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { initializeGalaxyIntegration } from '../packages/galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile } from '../packages/galaxy-core/src/connection-profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = resolve(process.argv[2] ?? '');
const scenario = process.argv[3] ?? 'uninitialized';
if (!['uninitialized', 'initialization', 'initialized', 'legacy', 'recovery', 'invalid-connection', 'offline', 'binding'].includes(scenario)) throw new Error('Unknown host scenario');
if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-opencode-host-check.mjs <installed-opencode-binary>');
const scratch = await mkdtemp(join(tmpdir(), 'galaxy-opencode-host-'));
const output = join(root, 'outputs', 'opencode-host-' + Date.now());
await mkdir(output);
const env = {};
for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH']) {
  const key = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase());
  if (key) env[name] = process.env[key];
}
for (const name of ['data', 'config', 'cache', 'state', 'home', 'tmp', 'project', 'managed']) await mkdir(join(scratch, name));
Object.assign(env, { XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'),
  XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'),
  OPENCODE_TEST_HOME: join(scratch, 'home'), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
  APPDATA: join(scratch, 'data'), LOCALAPPDATA: join(scratch, 'data'), ProgramData: join(scratch, 'managed'),
  TEMP: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'),
  OPENCODE_CONFIG_DIR: join(scratch, 'config', 'opencode'),
  OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_TERMINAL_TITLE: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
  GALAXY_DATA_DIR: join(scratch, 'galaxy-uninitialized'), GALAXY_HOST_CHECK_REPORT: join(output, 'host-report.json'),
  GALAXY_HOST_CHECK_SCENARIO: scenario,
  OPENCODE_TUI_CONFIG: join(scratch, 'tui.json'), TERM: 'xterm-256color' });
await mkdir(env.OPENCODE_CONFIG_DIR);
await writeFile(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), JSON.stringify({ autoupdate: false,
  share: 'disabled', enabled_providers: [], plugin: [], mcp: {}, permission: 'deny' }));
let adapter = process.argv[4] ? resolve(process.argv[4]) : join(root, 'integrations/host-adapters/opencode-stable/galaxy.tui.ts');
const installedEntry = adapter;
if (!['uninitialized', 'initialization'].includes(scenario)) {
  if (scenario === 'recovery') {
    await mkdir(env.GALAXY_DATA_DIR); await writeFile(join(env.GALAXY_DATA_DIR, '.galaxy-reset.json'), '{"version":1,"operation":"reset"}');
  } else {
    await initializeGalaxyIntegration(env.GALAXY_DATA_DIR, { ...(scenario === 'legacy' ? { profile: 'coding-case' } : {}), source: 'synthetic-host-acceptance' });
    if (scenario === 'legacy') for (const [current, old] of [['galaxy-id.json', 'node.json'], ['galaxy-local-state.json', 'local-state.json'],
      ['galaxy-id-private-key.pem', 'node-private-key.pem'], ['galaxy-id-public-key.pem', 'node-public-key.pem']])
      await rename(join(env.GALAXY_DATA_DIR, current), join(env.GALAXY_DATA_DIR, old));
    if (scenario === 'invalid-connection') {
      const path = join(env.GALAXY_DATA_DIR, 'galaxy-local-state.json');
      const state = JSON.parse(await readFile(path, 'utf8')); state.integration.connectionProfile = { version: 999 };
      await writeFile(path, JSON.stringify(state));
    }
  }
}
if (scenario === 'offline') {
  const configured = process.argv[4] ? join(dirname(adapter), 'configured.js') : join(dirname(adapter), 'configured-galaxy.tui.ts');
  adapter = join(scratch, 'configured-fixture.mjs');
  await writeFile(adapter, `import { createConfiguredGalaxyPlugin } from ${JSON.stringify(pathToFileURL(configured).href)};\n`
    + `export default createConfiguredGalaxyPlugin({ endpoint: 'https://offline.galaxy.invalid', dataDirectory: process.env.GALAXY_DATA_DIR, scopes: ['binding'], trustedKeys: new Map(), installationId: '00000000-0000-4000-8000-000000000001', bindingScopeId: 'fixture' });\n`);
}
if (scenario === 'binding') {
  const address = new URL(process.argv[5]);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1') throw new Error('Explicit loopback fixture required');
  const meta = await (await fetch(address.origin + '/fixture/meta')).json();
  await saveConnectionProfile(env.GALAXY_DATA_DIR, createConnectionProfile({
    targets: [{ id: 'fixture', kind: 'official', endpoint: meta.endpoint }],
    scopes: [{ id: 'binding-intent', targetId: 'fixture', action: 'binding', recipient: meta.endpoint,
      purpose: 'Synthetic native host binding acceptance', visibleFields: ['subjectId', 'genesisProof', 'installationId', 'scopes'],
      expiresAt: new Date((meta.now + 90000) * 1000).toISOString() }],
  }));
  env.GALAXY_HOST_BINDING_INPUT = join(scratch, 'binding-input.json');
  env.GALAXY_HOST_BINDING_PHASE = join(output, 'phase.json');
  adapter = join(root, 'scripts/opencode-binding-bridge.mjs');
  env.GALAXY_HOST_BINDING_BRIDGE = pathToFileURL(adapter).href;
  await writeFile(env.GALAXY_HOST_BINDING_INPUT, JSON.stringify({ ...meta, address: address.origin,
    configuredEntry: join(dirname(installedEntry), 'configured.js'), scopes: ['binding'],
    installationId: '00000000-0000-4000-8000-000000000002', bindingScopeId: 'binding-intent' }));
}
const fixtureHashes = {};
if (!['uninitialized', 'initialization'].includes(scenario)) for (const name of await readdir(env.GALAXY_DATA_DIR))
  fixtureHashes[name] = createHash('sha256').update(await readFile(join(env.GALAXY_DATA_DIR, name))).digest('hex');
await writeFile(join(output, 'fixture-hashes.json'), JSON.stringify(fixtureHashes, null, 2) + '\n');
env.GALAXY_HOST_CHECK_FIXTURES = join(output, 'fixture-hashes.json');
const probe = join(root, 'scripts', scenario === 'binding' ? 'opencode-binding-probe.mjs'
  : scenario === 'initialization' ? 'opencode-initialization-probe.mjs' : 'opencode-host-probe.mjs');
await writeFile(env.OPENCODE_TUI_CONFIG, JSON.stringify({ plugin: [pathToFileURL(adapter).href, pathToFileURL(probe).href] }));
const files = {};
for (const path of [binary, adapter, probe]) files[path] = createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(join(output, 'input.json'), JSON.stringify({ binary, scratch, files, environmentNames: Object.keys(env),
  scenario, installedEntry, syntheticFixture: scenario !== 'uninitialized', globalConfigurationChanged: false, originalIdentityUsed: false }, null, 2));
await writeFile(join(output, 'launch.mjs'), `import { spawn } from 'node:child_process';\nconst child = spawn(${JSON.stringify(binary)}, [${JSON.stringify(join(scratch, 'project'))}], { cwd: ${JSON.stringify(join(scratch, 'project'))}, env: ${JSON.stringify(env)}, stdio: 'inherit', windowsHide: true, shell: false });\nchild.on('exit', code => process.exitCode = code ?? 1);\nchild.on('error', error => { console.error(error.message); process.exitCode = 1; });\n`);
console.log(JSON.stringify({ output, scratch, launch: join(output, 'launch.mjs') }));
