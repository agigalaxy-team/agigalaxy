import { build, version as esbuildVersion } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function buildNativeHost({ destination, dependencyLock }) {
  if (![destination, dependencyLock].every(isAbsolute)) throw new Error('Absolute output and dependency lock paths required');
  const lock = JSON.parse(await readFile(dependencyLock, 'utf8'));
  const adapter = 'integrations/host-adapters/opencode-stable/';
  const result = await build({ absWorkingDir: root, entryPoints: {
    galaxy: adapter + 'galaxy.tui.ts', configured: adapter + 'configured-galaxy.tui.ts',
  }, outdir: destination, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22',
    packages: 'external', external: ['bun:sqlite'], metafile: true, write: false, sourcemap: false });
  const dependencies = new Set();
  for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) {
    if (!item.external || item.path.startsWith('node:') || item.path === 'bun:sqlite') continue;
    const name = item.path.startsWith('@') ? item.path.split('/').slice(0, 2).join('/') : item.path.split('/')[0];
    if (!lock.packages[''].dependencies[name]) throw new Error('Dependency is not pinned: ' + name);
    dependencies.add(name);
  }
  const sourceHashes = {};
  for (const name of Object.keys(result.metafile.inputs)) sourceHashes[name] = sha(await readFile(join(root, name)));
  const packageJson = { name: '@galaxy/native-host', version: '0.1.0', private: true, type: 'module',
    description: 'Galaxy trusted local host runtime and native OpenCode adapter',
    exports: { './opencode': './galaxy.js', './configured': './configured.js' },
    files: ['*.js', 'source-hashes.json', 'native-host.json', 'README.md'],
    engines: { node: '>=22.13.0' }, dependencies: lock.packages[''].dependencies };
  lock.name = packageJson.name; lock.packages[''].name = packageJson.name;
  await mkdir(destination);
  const artifactHashes = {};
  for (const file of result.outputFiles) {
    const name = relative(destination, file.path).replaceAll('\\', '/');
    await writeFile(file.path, file.contents, { flag: 'wx' }); artifactHashes[name] = sha(file.contents);
  }
  const manifest = { kind: 'galaxy-native-host-local-candidate', builder: 'esbuild ' + esbuildVersion,
    sourceFiles: Object.keys(sourceHashes).length, sourceHashesSha256: sha(JSON.stringify(sourceHashes)),
    artifacts: artifactHashes, usedDependencies: [...dependencies].sort((a, b) => a.localeCompare(b)),
    containsLocalSigner: true, containsPrivateKeys: false, publicRelease: false, actualHostAcceptance: 'pending' };
  for (const [name, data] of Object.entries({ 'package.json': packageJson, 'package-lock.json': lock,
    'source-hashes.json': sourceHashes, 'native-host.json': manifest }))
    await writeFile(join(destination, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(destination, 'README.md'), '# Galaxy native host\n\nLocal candidate, not a public release.\n\n'
    + 'Use the opencode export (galaxy.js) as an OpenCode TUI plugin. The configured export provides createConfiguredGalaxyPlugin. '
    + 'The package contains trusted local identity/signing code, not private keys. Do not install it as an untrusted remote MCP tool. '
    + 'Loading alone does not create an identity, read a Manifest or connect remotely. Keep the existing data directory; upgrades never call init/reset. '
    + 'Install and check the pinned package in an independent directory before switching a host.\n', { flag: 'wx' });
  return { destination, manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildNativeHost({ destination: resolve(process.argv[2]), dependencyLock: resolve(process.argv[3]) })));
