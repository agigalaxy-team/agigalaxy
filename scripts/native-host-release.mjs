import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signRelease, verifyRelease } from "../packages/galaxy-official/src/infrastructure/release-artifact.mjs";

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = message => { throw new Error(message); };
function inside(directory, name) {
  const path = resolve(directory, name), child = relative(directory, path);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) fail('Invalid release source path.');
  return path;
}
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('Regular release input required.');
}
function tar(tarExecutable, args) {
  try { return execFileSync(tarExecutable, args, { timeout: 30000, windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { fail('Native package archive inspection failed.'); }
}

// Reuse the platform tar implementation, without extracting files or running
// package code. The packed bytes, installed bytes and current source must agree.
export async function inspectNativeHostCandidate({ source, tarExecutable }) {
  if (![source, tarExecutable].every(value => typeof value === 'string' && isAbsolute(value))) fail('Absolute package and tar paths required.');
  const receipt = await json(join(source, 'installation.json'));
  const manifest = await json(join(source, 'native-host.json'));
  const packageJson = await json(join(source, 'package.json'));
  const lockBytes = await readFile(join(source, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const sourceBytes = await readFile(join(source, 'source-hashes.json'));
  const hashes = JSON.parse(sourceBytes.toString('utf8'));
  if (packageJson.name !== '@galaxy/native-host' || packageJson.private !== true
    || !same(packageJson.exports, { './opencode': './galaxy.js', './configured': './configured.js' })
    || !same(packageJson.dependencies, lock.packages?.['']?.dependencies)
    || manifest.kind !== 'galaxy-native-host-local-candidate' || !manifest.containsLocalSigner || manifest.containsPrivateKeys !== false
    || !receipt.offlineInstall || !receipt.independentImport || receipt.globalInstallation !== false
    || !isAbsolute(receipt.installed) || !same(await json(join(receipt.installed, 'package.json')), packageJson)
    || manifest.sourceFiles !== Object.keys(hashes).length || receipt.sourceFiles !== manifest.sourceFiles
    || manifest.sourceHashesSha256 !== sha(JSON.stringify(hashes))) fail('Native candidate metadata mismatch.');
  for (const [name, digest] of Object.entries(hashes)) {
    if (!/\.(?:mjs|ts|tsx|json)$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) fail('Invalid native source manifest.');
    const path = inside(root, name); await regular(path);
    if (sha(await readFile(path)) !== digest) fail('Native candidate source is stale.');
  }
  const filename = `galaxy-native-host-${packageJson.version}.tgz`;
  const tarball = join(source, filename); await regular(tarball);
  const artifact = await readFile(tarball);
  if (resolve(receipt.tarball) !== resolve(tarball) || receipt.sha256 !== sha(artifact) || receipt.bytes !== artifact.length)
    fail('Native archive differs from the installed candidate.');
  const scripts = Object.keys(manifest.artifacts);
  if (!scripts.length || scripts.some(name => !/^[a-zA-Z0-9_-]+\.js$/.test(name))) fail('Invalid native build outputs.');
  const expected = [...scripts, 'package.json', 'source-hashes.json', 'native-host.json', 'README.md'].sort();
  const entries = tar(tarExecutable, ['-tf', tarball]).toString('utf8').trim().split(/\r?\n/);
  if (!same([...entries].sort(), expected.map(name => 'package/' + name).sort()) || receipt.packedFiles !== entries.length)
    fail('Unexpected native archive entry.');
  const verbose = tar(tarExecutable, ['-tvf', tarball]).toString('utf8').trim().split(/\r?\n/);
  if (verbose.length !== entries.length || verbose.some(line => !line.startsWith('-'))) fail('Native archive must contain regular files only.');
  for (const name of expected) {
    await regular(join(source, name)); await regular(join(receipt.installed, name));
    const bytes = await readFile(join(source, name));
    if (!bytes.equals(tar(tarExecutable, ['-xOf', tarball, 'package/' + name]))
      || !bytes.equals(await readFile(join(receipt.installed, name)))
      || (manifest.artifacts[name] && sha(bytes) !== manifest.artifacts[name])) fail('Packed native content mismatch.');
  }
  return { receipt, manifest, packageJson, sourceBytes, lockBytes, artifact, tarball, filename,
    sourceSha256: manifest.sourceHashesSha256, artifactsSha256: sha(JSON.stringify(manifest.artifacts)) };
}

// Only a small summary leaves the local evidence directory. No absolute paths,
// terminal text, identities, environment values or signing keys are included.
export async function collectNativeHostAcceptance(candidate, evidenceDirectories) {
  if (!Array.isArray(evidenceDirectories) || !evidenceDirectories.length || evidenceDirectories.length > 32
    || evidenceDirectories.some(path => typeof path !== 'string' || !isAbsolute(path))
    || new Set(evidenceDirectories.map(path => resolve(path))).size !== evidenceDirectories.length) fail('Distinct host evidence directories required.');
  const runs = [];
  for (const directory of evidenceDirectories) {
    const reportBytes = await readFile(join(directory, 'host-report.json'));
    const inputBytes = await readFile(join(directory, 'input.json'));
    const report = JSON.parse(reportBytes.toString('utf8')), input = JSON.parse(inputBytes.toString('utf8'));
    const initialization = input.scenario === 'initialization';
    if (!['initialization', 'legacy', 'offline'].includes(input.scenario)
      || input.originalIdentityUsed !== false || input.globalConfigurationChanged !== false || !input.syntheticFixture
      || resolve(input.installedEntry) !== resolve(candidate.receipt.installed, 'galaxy.js')
      || !report.passed || !Array.isArray(report.events) || !report.events.length)
      fail('Host report does not match the selected installed package.');
    if (input.scenario === 'offline') {
      const fixture = join(input.scratch, 'configured-fixture.mjs');
      const fixtureBytes = await readFile(fixture);
      const expected = `import { createConfiguredGalaxyPlugin } from ${JSON.stringify(pathToFileURL(join(candidate.receipt.installed, 'configured.js')).href)};\n`
        + `export default createConfiguredGalaxyPlugin({ endpoint: 'https://offline.galaxy.invalid', dataDirectory: process.env.GALAXY_DATA_DIR, scopes: ['binding'], trustedKeys: new Map(), installationId: '00000000-0000-4000-8000-000000000001', bindingScopeId: 'fixture' });\n`;
      if (sha(fixtureBytes) !== input.files?.[fixture] || fixtureBytes.toString('utf8') !== expected)
        fail('Offline fixture does not bind the selected configured package.');
    } else if (input.files?.[input.installedEntry] !== candidate.manifest.artifacts['galaxy.js'])
      fail('Host entry hash differs from the selected package.');
    if (initialization) {
      if (!report.syntheticDirectory || !report.identityCreatedByNativeUi || !report.postInitializationFilesUnchanged
        || report.savedFileCount !== 5 || report.connectionState !== 'not-connected'
        || !Array.isArray(report.layoutFindings) || report.layoutFindings.length
        || report.events.some(event => !Array.isArray(event.missingVisibleText) || event.missingVisibleText.length))
        fail('Native initialization acceptance is incomplete.');
    } else if (!report.realOpenCodeProcess || !report.syntheticFixture || !report.localFilesUnchanged
      || report.localFileCount !== 5 || report.scenario !== input.scenario) fail('Native fixture acceptance is incomplete.');
    const version = report.hostVersion ?? report.version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail('An actual host version is required.');
    const terminals = report.events.map(event => event.terminal);
    if (terminals.some(size => !Number.isInteger(size?.width) || !Number.isInteger(size?.height)
      || size.width < 1 || size.height < 1 || size.width !== terminals[0].width || size.height !== terminals[0].height)) fail('Inconsistent host terminal evidence.');
    runs.push({ scenario: input.scenario, host: 'OpenCode', hostVersion: version, platform: process.platform,
      terminal: { width: terminals[0].width, height: terminals[0].height }, statesObserved: report.events.length,
      navigation: report.navigationInput === 'terminal-digits' ? 'terminal-digits' : 'host-api-and-confirmation-input',
      localStateVerified: true, layoutControlsVerified: initialization, synthetic: true,
      reportSha256: sha(reportBytes), inputSha256: sha(inputBytes) });
  }
  const report = { version: 1, profile: 'galaxy-native-host/1', scope: 'real-host-local-fixtures',
    packageSha256: sha(candidate.artifact), sourceSha256: candidate.sourceSha256, artifactsSha256: candidate.artifactsSha256,
    runs, hostCoverage: 'only the listed package, host versions and scenarios',
    humanReview: false, thirdPartyCertification: false, publicationReady: false };
  return Buffer.from(JSON.stringify(report, null, 2) + '\n');
}

export async function createNativeHostRelease({ source, tarExecutable, evidenceDirectories, publisher, purpose, privateKey, kid,
  now = Math.floor(Date.now() / 1000), lifetime = 86400 }) {
  const candidate = await inspectNativeHostCandidate({ source, tarExecutable });
  const reportBytes = await collectNativeHostAcceptance(candidate, evidenceDirectories);
  const manifest = { version: 1, kind: 'galaxy-native-host-release', publisher, purpose, issuedAt: now, expiresAt: now + lifetime,
    package: { name: candidate.packageJson.name, version: candidate.packageJson.version, filename: candidate.filename,
      sha256: sha(candidate.artifact), bytes: candidate.artifact.length, exports: Object.keys(candidate.packageJson.exports),
      dependencies: candidate.packageJson.dependencies, lockSha256: sha(candidate.lockBytes), sourceHashesSha256: sha(candidate.sourceBytes) },
    hostAcceptance: { profile: 'galaxy-native-host/1', reportSha256: sha(reportBytes), sourceSha256: candidate.sourceSha256,
      artifactsSha256: candidate.artifactsSha256, scope: 'real-host-local-fixtures' } };
  return { manifest, signed: await signRelease(manifest, { privateKey, kid }), reportBytes, candidate };
}

export async function prepareNativeHostRelease({ source, tarExecutable, evidenceDirectories, destination, releaseConfigurationFactory }) {
  if (!isAbsolute(destination) || typeof releaseConfigurationFactory !== 'function') fail('New absolute output and explicit signing provider required.');
  // Signing is caller supplied and never stored. A fixture key must use local-validation.
  const configuration = await releaseConfigurationFactory();
  const result = await createNativeHostRelease({ ...configuration, source, tarExecutable, evidenceDirectories });
  const verified = await verifyRelease(result.signed, { ...configuration, artifact: result.candidate.artifact,
    report: result.reportBytes, expectedPackage: '@galaxy/native-host' });
  await mkdir(destination);
  const outputs = { [result.candidate.filename]: result.candidate.artifact, 'release.jws': result.signed + '\n',
    'release.json': JSON.stringify(result.manifest, null, 2) + '\n', 'host-acceptance.json': result.reportBytes,
    'package-lock.json': result.candidate.lockBytes, 'source-hashes.json': result.candidate.sourceBytes };
  const hashes = {};
  for (const [name, bytes] of Object.entries(outputs)) {
    await writeFile(join(destination, name), bytes, { flag: 'wx' }); hashes[name] = sha(bytes);
  }
  const receipt = { version: 1, kind: 'galaxy-native-host-signed-candidate', packageSha256: result.manifest.package.sha256,
    purpose: configuration.purpose, signatureVerified: verified.signatureVerified, expectedPackage: '@galaxy/native-host',
    hostRuns: evidenceDirectories.length, productionTrustEstablished: false, publicationReady: false,
    downloadUrl: null, currentRevocationChecked: false, files: hashes };
  await writeFile(join(destination, 'candidate.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return { destination, ...receipt };
}
