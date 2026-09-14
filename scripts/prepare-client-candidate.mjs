import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformance, fingerprint } from './run-conformance.mjs';
import { buildAndVerifyClient, localReleaseFixture } from './test-client-install.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

// One source report, one package build, one independent installation. The caller
// can inject its selected signing configuration without serializing secrets.
export async function prepareClientCandidate({ npm, releaseConfigurationFactory = localReleaseFixture } = {}) {
  const conformance = await runConformance();
  if (!conformance.success) throw new Error('Conformance did not pass; candidate not built.');
  const reportBytes = await readFile(join(conformance.output, 'report.json'));
  const releaseConfiguration = await Promise.resolve(releaseConfigurationFactory());
  const client = await buildAndVerifyClient({ npm, reportBytes, releaseConfiguration });
  if ((await fingerprint()).sha256 !== conformance.sourceHash)
    throw new Error('Source changed during packaging; no current candidate declaration.');
  const candidate = { version: 1, kind: 'galaxy-client-local-candidate',
    package: { name: '@galaxy/client', version: '0.1.0', filename: 'galaxy-client-0.1.0.tgz',
      sha256: client.sha256, bytes: client.bytes, files: client.files, exports: client.exports, dependencies: client.dependencies },
    conformance: { report: 'conformance-report.json', sha256: sha(reportBytes), sourceHash: conformance.sourceHash,
      checks: conformance.checks, counts: conformance.counts },
    signature: { filename: 'release.jws', purpose: releaseConfiguration.purpose,
      verifiedWithCallerPin: true, productionTrustEstablished: false },
    runtime: `Node ${process.versions.node}; ${process.platform}/${process.arch}`,
    offlineInstall: client.offlineInstall, consumerSmoke: client.consumerSmoke,
    hostAcceptance: 'pending-actual-supported-host', downloadUrl: null,
    publicationReady: false, capabilityVerified: false };
  await writeFile(join(client.output, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  // Export only artifact metadata, never the signing configuration.
  return { output: client.output, sha256: client.sha256, sourceHash: conformance.sourceHash,
    checks: conformance.checks, counts: conformance.counts, files: client.files, exports: client.exports.length,
    signaturePurpose: releaseConfiguration.purpose, publicationReady: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/prepare-client-candidate.mjs');
  // CLI is explicitly a local-validation run; formal signing is an injected
  // caller operation after publisher/key/host/release decisions are available.
  console.log(JSON.stringify(await prepareClientCandidate({ npm: process.env.GALAXY_TEST_NPM_CLI })));
}
