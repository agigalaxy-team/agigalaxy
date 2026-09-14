import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [source, npm] = process.argv.slice(2);
if (![source, npm].every(value => value && isAbsolute(value))) throw new Error('Absolute built package and npm CLI required');
const consumer = await mkdtemp(join(tmpdir(), 'galaxy-native-consumer-'));
const user = join(consumer, 'user.npmrc'), global = join(consumer, 'global.npmrc');
await writeFile(user, ''); await writeFile(global, '');
const env = { ...process.env };
for (const name of Object.keys(env)) if (name.toLowerCase().startsWith('npm_config_')) delete env[name];
function run(cwd, args) {
  return execFileSync(process.execPath, [npm, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--userconfig', user, '--globalconfig', global, '--registry', 'https://registry.npmjs.org/'],
  { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
run(source, ['ci']);
const packed = JSON.parse(run(source, ['pack', '--json']))[0];
assert.equal(packed.filename, 'galaxy-native-host-0.1.0.tgz');
const tarball = resolve(source, packed.filename);
await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run(consumer, ['install', tarball]);
const installed = join(consumer, 'node_modules/@galaxy/native-host');
const manifest = JSON.parse(await readFile(join(installed, 'native-host.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, expected] of Object.entries(manifest.artifacts)) assert.equal(sha(await readFile(join(installed, name))), expected);
await mkdir(join(consumer, 'unused-data'));
const check = "import assert from 'node:assert/strict'; import { readdir } from 'node:fs/promises'; "
  + "const local = await import('@galaxy/native-host/opencode'); const configured = await import('@galaxy/native-host/configured'); "
  + "assert.equal(local.default.id, 'galaxy.opencode.stable.tui'); assert.equal(typeof configured.createConfiguredGalaxyPlugin, 'function'); "
  + "assert.deepEqual(await readdir(process.env.GALAXY_DATA_DIR), []);";
execFileSync(process.execPath, ['--input-type=module', '-e', check], { cwd: consumer,
  env: { ...env, GALAXY_DATA_DIR: join(consumer, 'unused-data') }, windowsHide: true, timeout: 30000, stdio: 'pipe' });
const receipt = { timestamp: new Date().toISOString(), tarball, sha256: sha(await readFile(tarball)), bytes: packed.size,
  packedFiles: packed.files.length, sourceFiles: manifest.sourceFiles, installed, offlineInstall: true,
  independentImport: true, globalInstallation: false, signedRelease: false, publicationReady: false };
await writeFile(join(source, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
