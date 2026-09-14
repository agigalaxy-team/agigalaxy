import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fingerprint, deriveChecks, checkFiles, runnerVersion } from './run-conformance.mjs';
import { signRelease } from '../packages/galaxy-official/src/release-artifact.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createClientRelease({ source, tarball, reportBytes, publisher, purpose, privateKey, kid,
  now = Math.floor(Date.now() / 1000), lifetime = 86400 }) {
  const report = JSON.parse(reportBytes.toString('utf8')), current = await fingerprint();
  if (report.profile !== 'galaxy-conformance/2' || !report.target?.stableDuringRun
    || report.target.kind !== 'local-source-tree' || report.target.sha256 !== current.sha256
    || sha(JSON.stringify(report.sourceManifest)) !== current.sha256
    || report.overall?.success !== true || report.overall?.counts?.failed !== 0
    || report.failures?.length !== 0 || report.runnerVersion !== runnerVersion
    || report.suite?.sha256 !== sha(JSON.stringify({ version: runnerVersion, checks: checkFiles, sourceHash: current.sha256 })))
    throw new Error('Conformance report does not match the current tested source.');
  const expected = deriveChecks(checkFiles, report.results, true);
  if (!expected.every(check => check.status === 'pass')
    || JSON.stringify(report.checks) !== JSON.stringify(expected)) throw new Error('Incomplete conformance report.');
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const sourceBytes = await readFile(join(source, 'source-hashes.json'));
  const hashes = JSON.parse(sourceBytes.toString('utf8'));
  for (const [name, hash] of Object.entries(hashes)) {
    if (report.sourceManifest[name] !== hash || sha(await readFile(join(source, 'lib', name))) !== hash)
      throw new Error('Client source differs from tested source.');
  }
  const artifact = await readFile(tarball);
  const data = { version: 1, kind: 'galaxy-client-release', publisher, purpose, issuedAt: now, expiresAt: now + lifetime,
    package: { name: manifest.name, version: manifest.version, filename: `galaxy-client-${manifest.version}.tgz`,
      sha256: sha(artifact), bytes: artifact.length, exports: Object.keys(manifest.exports), dependencies: manifest.dependencies,
      lockSha256: sha(await readFile(join(source, 'package-lock.json'))), sourceHashesSha256: sha(sourceBytes) },
    conformance: { profile: report.profile, reportSha256: sha(reportBytes), sourceSha256: current.sha256,
      suiteSha256: report.suite.sha256, scope: 'local-source-tests' } };
  return { manifest: data, signed: await signRelease(data, { privateKey, kid }) };
}
