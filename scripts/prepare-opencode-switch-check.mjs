import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { initializeGalaxyIntegration } from '../packages/galaxy-core/src/local-store.mjs';
import { createConnectionProfile, saveConnectionProfile } from '../packages/galaxy-core/src/connection-profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [binary, installed, ...addresses] = process.argv.slice(2);
if (addresses.length !== 2 || addresses.some(value => new URL(value).hostname !== '127.0.0.1')) throw new Error('Two explicit loopback services required');
const prepared = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/prepare-opencode-host-check.mjs'), binary, 'binding', installed, addresses[0]], { encoding: 'utf8' }));
const inputPath = join(prepared.scratch, 'binding-input.json');
const input = JSON.parse(await readFile(inputPath, 'utf8'));
input.services = await Promise.all(addresses.map(async address => ({ ...await (await fetch(address + '/fixture/meta')).json(), address })));
input.firstDirectory = join(prepared.scratch, 'galaxy-uninitialized');
input.secondDirectory = join(prepared.scratch, 'galaxy-second');
await initializeGalaxyIntegration(input.secondDirectory, { source: 'synthetic-host-switch' });
input.profiles = input.services.map((service, index) => createConnectionProfile({
  targets: [{ id: 'fixture-' + index, kind: 'official', endpoint: service.endpoint }],
  scopes: [{ id: 'binding-' + index, targetId: 'fixture-' + index, action: 'binding',
    recipient: service.endpoint, purpose: 'Synthetic native configuration switch',
    visibleFields: ['subjectId', 'genesisProof', 'installationId', 'scopes'], expiresAt: new Date((service.now + 90000) * 1000).toISOString() }],
}));
for (const directory of [input.firstDirectory, input.secondDirectory]) await saveConnectionProfile(directory, input.profiles[0]);
await writeFile(inputPath, JSON.stringify(input));
const bridge = join(root, 'scripts/opencode-switch-bridge.mjs'), probe = join(root, 'scripts/opencode-switch-probe.mjs');
await writeFile(join(prepared.scratch, 'tui.json'), JSON.stringify({ plugin: [bridge, probe].map(path => pathToFileURL(path).href) }));
const descriptorPath = join(prepared.output, 'input.json'), descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
descriptor.scenario = 'switching';
descriptor.files = {};
for (const path of [binary, installed, join(dirname(installed), 'configured.js'), bridge, probe])
  descriptor.files[path] = createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n');
const hashes = {};
for (const directory of [input.firstDirectory, input.secondDirectory]) {
  hashes[directory] = {};
  for (const name of await readdir(directory)) hashes[directory][name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
}
await writeFile(join(prepared.output, 'switch-fixture-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log(JSON.stringify(prepared));
