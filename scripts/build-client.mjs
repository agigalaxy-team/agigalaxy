import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'packages/galaxy-official/src/';
const entries = { './discovery': base + 'discovery-client.mjs', './connection': base + 'connection-client.mjs',
  './project-discovery': base + 'project-discovery-client.mjs',
  './identity': base + 'identity-link-client.mjs',
  './proofs': base + 'proof-client.mjs',
  './history': base + 'history-client.mjs',
  './builders': base + 'builder-client.mjs',
  './audit': base + 'audit-client.mjs',
  './deletion': base + 'deletion-client.mjs',
  './data-export': base + 'data-export-client.mjs',
  './capsules': base + 'capsule-client.mjs',
  './honor': base + 'honor-client.mjs',
  './moderation': base + 'moderation-client.mjs',
  './notifications': base + 'notifications-client.mjs',
  './context': base + 'context-client.mjs',
  './assistance': base + 'assistance-client.mjs',
  './case': base + 'case-client.mjs',
  './consent': base + 'consent-client.mjs', './session-memory': base + 'session-memory.mjs',
  './binding-status': base + 'binding-status-client.mjs', './host-controller': base + 'host-connection-controller.mjs',
  './verification/connection': base + 'verification/connection.mjs' };
const allowed = new Set(['discovery-client.mjs', 'connection-client.mjs', 'consent-client.mjs', 'public-fetch.mjs',
  'project-discovery-client.mjs',
  'proof-client.mjs','verification/ci-proof.mjs','shared/ci-provenance.mjs','shared/github-evidence-schema.mjs',
  'shared/node-control-proof-schema.mjs', 'verification/node-control.mjs',
  'verification/hub-directory.mjs',
  'shared/search-feedback-schema.mjs',
  'shared/discovery-schema.mjs',
  'audit-client.mjs', 'shared/audit-schema.mjs',
  'deletion-client.mjs', 'shared/deletion-schema.mjs', 'shared/deletion-event-payload.mjs',
  'data-export-client.mjs', 'shared/data-export-schema.mjs',
  'history-client.mjs', 'shared/history-schema.mjs', 'shared/history-rebuild.mjs', 'profile-client.mjs', 'shared/profile-schema.mjs', 'search-client.mjs', 'shared/search-schema.mjs',
  'builder-client.mjs', 'shared/builders-schema.mjs', 'shared/conformance-schema.mjs', 'verification/conformance.mjs', 'shared/digest.mjs',
  'capsule-client.mjs', 'shared/capsule-schema.mjs',
  'honor-client.mjs', 'shared/honor-schema.mjs',
  'moderation-client.mjs', 'shared/moderation-schema.mjs',
  'notifications-client.mjs', 'shared/notifications-schema.mjs',
  'context-client.mjs', 'shared/context-schema.mjs',
  'identity-link-client.mjs', 'shared/identity-link-schema.mjs',
  'binding-management-client.mjs', 'shared/binding-management-schema.mjs',
  'assistance-client.mjs', 'shared/assistance-schema.mjs', 'shared/qualification-schema.mjs',
  'case-client.mjs', 'shared/cases-schema.mjs',
  'trust-store.mjs', 'session-memory.mjs', 'binding-status-client.mjs', 'host-connection-controller.mjs', 'verification/envelope.mjs', 'verification/manifest.mjs', 'verification/keyring.mjs',
  'verification/connection.mjs', 'verification/identity-control.mjs', 'domain/identity-control.mjs', 'shared/trust-package-control-chain-engine.mjs', 'shared/identity-control-schema.mjs', 'shared/trust-package-control-schema-factory.mjs', 'shared/product-v2-export-datasets.mjs', 'shared/task-schema-v2.mjs', 'shared/qualification-v2-schema.mjs', 'shared/web-primitives.mjs', 'shared/envelope-policy.mjs', 'shared/consents-schema.mjs',
  'shared/service-error.mjs', 'domain/consent-policy.mjs'].map(name => base + name));
allowed.add('packages/galaxy-core/src/galaxy-guid.mjs');
const platform = new Set(['node:crypto', 'node:util', 'node:fs/promises', 'node:path', 'node:https', 'node:dns/promises', 'node:net']);
const external = new Set(['jose', 'zod', 'ipaddr.js','canonicalize']);
const normalize = path => path.replaceAll('\\', '/');

export function importsOf(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('Invalid client source syntax.');
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error('Nonliteral module import.');
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && ['require', 'eval', 'createRequire'].includes(node.expression.text))))
      throw new Error('Dynamic module/code loading is not allowed in the client artifact.');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}

// Build only into a new directory. Canonical implementation remains in src;
// generated copies must never be edited or used as a second source of truth.
export async function buildClient(destination) {
  if (!isAbsolute(destination)) throw new Error('Absolute new output directory required.');
  const files = new Map(), dependencies = new Set();
  async function inspect(name) {
    if (files.has(name)) return;
    if (!allowed.has(name)) throw new Error(`Module outside client allowlist: ${name}`);
    const path = resolve(root, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Client source must be a regular file.');
    const bytes = await readFile(path);
    files.set(name, bytes);
    for (const specifier of importsOf(bytes.toString('utf8'), name)) {
      if (specifier.startsWith('.')) await inspect(normalize(relative(root, resolve(dirname(path), specifier))));
      else if (specifier.startsWith('node:')) {
        if (!platform.has(specifier)) throw new Error(`Unexpected platform dependency: ${specifier}`);
      } else {
        const packageName = specifier.split('/')[0];
        if (!external.has(packageName)) throw new Error(`Unexpected client dependency: ${specifier}`);
        dependencies.add(packageName);
      }
    }
  }
  for (const entry of Object.values(entries)) await inspect(entry);
  const official = JSON.parse(await readFile(resolve(root, 'packages/galaxy-official/package.json'), 'utf8'));
  const sourceLock = JSON.parse(await readFile(resolve(root, 'packages/galaxy-official/package-lock.json'), 'utf8'));
  const manifest = { name: '@galaxy/client', version: '0.1.0', private: true, type: 'module',
    engines: { node: '>=22.13.0' }, exports: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, './lib/' + value])),
    files: ['lib', 'source-hashes.json', 'README.md'], dependencies: {} };
  const locked = {};
  for (const name of [...dependencies].sort((a, b) => a.localeCompare(b))) {
    const record = sourceLock.packages['node_modules/' + name];
    if (!record || record.version !== official.dependencies[name] || record.dependencies || record.optionalDependencies
      || record.peerDependencies || record.hasInstallScript || typeof record.integrity !== 'string'
      || !record.integrity.startsWith('sha512-'))
      throw new Error('Client dependency requires explicit lock review.');
    const url = new URL(record.resolved);
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password)
      throw new Error('Nonpublic dependency origin.');
    manifest.dependencies[name] = record.version;
    locked['node_modules/' + name] = record;
  }
  const hashes = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  await mkdir(destination); // EEXIST deliberately refuses even an empty directory.
  for (const [name, bytes] of files) {
    const path = resolve(destination, 'lib', name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' });
  }
  const json = value => JSON.stringify(value, null, 2) + '\n';
  await writeFile(resolve(destination, 'package.json'), json(manifest), { flag: 'wx' });
  await writeFile(resolve(destination, 'package-lock.json'), json({ name: manifest.name, version: manifest.version,
    lockfileVersion: 3, requires: true, packages: { '': { name: manifest.name, version: manifest.version,
      dependencies: manifest.dependencies, engines: manifest.engines }, ...locked } }), { flag: 'wx' });
  await writeFile(resolve(destination, 'source-hashes.json'), json(hashes), { flag: 'wx' });
  await writeFile(resolve(destination, 'README.md'), '# Galaxy client local artifact\n\nGenerated from reviewed source; do not edit generated files. Private/local distribution only.\n\nImport @galaxy/client/discovery for explicit public reads; /connection and /consent require trusted host confirmation and local signing callbacks. No automatic initialization, network discovery or credential persistence on import. Trust-state metadata writes occur only on explicit discovery.\n\nThe host must obtain explicit user approval, provide pinned trust and current local authorization, store credentials securely, and handle unknown remote outcomes without automatic replay. The identity entry manages signed external-account associations through the configured service; it does not implement an authorization server, keep OAuth tokens, or claim deployed Official/Hub support.\n', { flag: 'wx' });
  return { files: files.size, dependencies: manifest.dependencies, output: destination };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-client.mjs ABSOLUTE_NEW_DIRECTORY');
  console.log(JSON.stringify(await buildClient(process.argv[2])));
}
