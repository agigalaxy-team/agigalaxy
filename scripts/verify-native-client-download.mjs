// Uses the existing Galaxy publisher pin and standard release verifier.
// Run only after checking this script's published SHA-256 and HTTPS source.
import { resolve } from 'node:path';
import { downloadedLocal as local,nativeArtifactFilename } from './native-download-inputs.mjs';
import { calculateJwkThumbprint, importJWK } from 'jose';
import { verifyRelease } from "../packages/galaxy-contracts/src/release-artifact.mjs";

const publisher = 'https://agigalaxy.org', kid = 'galaxy-release-20260911';
const thumbprint = 'mpeo6qMIGNl-uw1MPlQH3SKqmrMuZqdNjAP0YgsQ2U4';
try {
  if (process.argv.length !== 3) throw new Error('Expected downloaded release directory');
  const directory = resolve(process.argv[2]);
  const response = await fetch(publisher + '/releases/keys.json', {
    redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) throw new Error('Publisher public key status unavailable');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 16384) throw new Error('Publisher key status too large');
    chunks.push(Buffer.from(chunk));
  }
  const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (document.publisher !== publisher || !Array.isArray(document.keys) || !Array.isArray(document.validity))
    throw new Error('Unexpected publisher document');
  const keys = document.keys.filter(key => key.kid === kid), periods = document.validity.filter(key => key.kid === kid);
  if (keys.length !== 1 || periods.length !== 1 || keys[0].alg !== 'EdDSA'
    || await calculateJwkThumbprint(keys[0], 'sha256') !== thumbprint) throw new Error('Publisher pin changed');
  const key = await importJWK(keys[0], 'EdDSA');
  const packageMetadata=JSON.parse((await local(directory,'package-metadata.json',65536)).toString('utf8'));
  const artifactFilename=nativeArtifactFilename(packageMetadata);
  const result = await verifyRelease((await local(directory, 'release.jws', 65536)).toString('utf8').trim(), {
    publisher, expectedPackage: '@galaxy/native-client',
    artifact: await local(directory, artifactFilename, 64 * 1024 * 1024),
    report: await local(directory, 'protocol-report.json', 256 * 1024),
    trustedKeys: new Map([[kid, { publicKey: key, notBefore: periods[0].notBefore,
      notAfter: periods[0].notAfter, revoked: periods[0].revoked !== false }]]),
  });
  if (result.manifest.purpose !== 'release-candidate' || result.manifest.kind !== 'galaxy-native-client-release'
    ||result.manifest.package.version!==packageMetadata.version||result.manifest.package.filename!==artifactFilename)
    throw new Error('Unexpected release channel');
  console.log(JSON.stringify({ verified: true, publisher, package: result.manifest.package.name,
    version: result.manifest.package.version, sha256: result.manifest.package.sha256,
    currentPublisherKeyStatusFetched: true, channel: 'development-candidate',
    actualHostAcceptance: false, stableRelease: false, installed: false, connected: false }));
} catch {
  process.stderr.write('Download verification failed. Check exact files, publisher status, clock and signature expiry. Nothing was installed or connected.\n');
  process.exitCode = 1;
}
