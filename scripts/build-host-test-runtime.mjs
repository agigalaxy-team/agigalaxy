// Private integration fixture: the privileged host assembly is deliberately
// separate from both the service installation and the portable client package.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

function importsOf(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), imports = [];
  if (ast.parseDiagnostics.length) throw new Error(`Invalid host source: ${filename}`);
  function visit(node) {
    let value;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) value = node.moduleSpecifier;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) value = node.arguments[0];
    if (value) {
      if (!ts.isStringLiteral(value)) throw new Error(`Nonliteral host import: ${filename}`);
      imports.push(value.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);return imports;
}

const [release, clientLock, output] = process.argv.slice(2);
if (![release, clientLock, output].every(value => value && isAbsolute(value)))
  throw new Error('Usage: node scripts/build-host-test-runtime.mjs ABS_RELEASE ABS_CLIENT_LOCK ABS_NEW_OUTPUT');
const manifestBytes = await readFile(resolve(release, 'service-release.json'));
const manifest = JSON.parse(manifestBytes), lock = JSON.parse(await readFile(clientLock, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const entries = ['packages/galaxy-core/src/local-store.mjs', 'packages/galaxy-core/src/connection-profile.mjs',
  "packages/galaxy-official/src/clients/local/host-runtime.mjs", 'packages/galaxy-official/src/verification/manifest.mjs'];
const files = new Map(), dependencies = new Set();
async function visit(name) {
  if (files.has(name)) return;
  if (!/^packages\/galaxy-(core|official)\/src\/.+\.mjs$/.test(name) || !manifest.files[name])
    throw new Error(`Host module outside frozen source: ${name}`);
  const bytes = await readFile(resolve(release, name));
  if (sha(bytes) !== manifest.files[name].sha256) throw new Error(`Frozen source mismatch: ${name}`);
  files.set(name, bytes);
  for (const imported of importsOf(bytes.toString('utf8'), name)) {
    if (imported.startsWith('.')) await visit(relative(release, resolve(release, dirname(name), imported)).replaceAll('\\', '/'));
    else if (!imported.startsWith('node:') && imported !== 'bun:sqlite') {
      const dependency = imported.startsWith('@') ? imported.split('/').slice(0, 2).join('/') : imported.split('/')[0];
      if (!lock.packages[''].dependencies[dependency]) throw new Error(`Unpinned host dependency: ${imported}`);
      dependencies.add(dependency);
    }
  }
}
for (const entry of entries) await visit(entry);
const packageJson = { name: 'galaxy-private-host-test-runtime', version: '0.1.0', private: true, type: 'module',
  dependencies: lock.packages[''].dependencies, engines: lock.packages[''].engines };
lock.name = packageJson.name;lock.packages[''].name = packageJson.name;
await mkdir(output);
for (const [name, bytes] of files) {
  const target = resolve(output, name);await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
}
const receipt = { kind: 'private-host-test-runtime', serviceRelease: manifest.releaseId, serviceManifestSha256: sha(manifestBytes),
  entries, files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha(bytes)])),
  dependencies: packageJson.dependencies, usedDependencies: [...dependencies].sort((a, b) => a.localeCompare(b)), nativeHostUiVerified: false, publicRelease: false };
for (const [name, value] of Object.entries({ 'package.json': packageJson, 'package-lock.json': lock, 'host-runtime.json': receipt }))
  await writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, files: files.size, dependencies: packageJson.dependencies, serviceRelease: manifest.releaseId }));
