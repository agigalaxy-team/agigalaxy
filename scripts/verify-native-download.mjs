// Public preview verifier. Uses the shared release verifier and a pinned publisher key.
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { calculateJwkThumbprint, importJWK } from 'jose';
import { verifyRelease } from "../packages/galaxy-official/src/infrastructure/release-artifact.mjs";

const publisher = 'https://agigalaxy.org';
const kid = 'galaxy-release-20260911';
const thumbprint = 'mpeo6qMIGNl-uw1MPlQH3SKqmrMuZqdNjAP0YgsQ2U4';
try {
  if (process.argv.length !== 3) throw new Error('usage');
  const directory = resolve(process.argv[2]);
  const response = await fetch(publisher + '/releases/keys.json', { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('key-source');
  const document = await response.json();
  if (document.publisher !== publisher || !Array.isArray(document.keys) || !Array.isArray(document.validity)) throw new Error('key-document');
  const keys = document.keys.filter(key => key.kid === kid), periods = document.validity.filter(key => key.kid === kid);
  if (keys.length !== 1 || periods.length !== 1 || keys[0].alg !== 'EdDSA'
    || await calculateJwkThumbprint(keys[0], 'sha256') !== thumbprint) throw new Error('publisher-key');
  const key = await importJWK(keys[0], 'EdDSA');
  const signed = (await readFile(join(directory, 'release.jws'), 'utf8')).trim();
  const result = await verifyRelease(signed, { publisher, trustedKeys: new Map([[kid, { publicKey: key,
    notBefore: periods[0].notBefore, notAfter: periods[0].notAfter, revoked: periods[0].revoked !== false }]]),
    expectedPackage: '@galaxy/native-host', artifact: await readFile(join(directory, 'galaxy-native-host-0.1.0.tgz')),
    report: await readFile(join(directory, 'host-acceptance.json')) });
  if (result.manifest.purpose !== 'release-candidate') throw new Error('release-channel');
  console.log(JSON.stringify({ verified: true, publisher, package: result.manifest.package.name,
    version: result.manifest.package.version, sha256: result.manifest.package.sha256,
    currentPublisherKeyStatusFetched: true, channel: 'development-candidate', stableRelease: false }));
} catch {
  console.error('Download verification failed. Check the files, publisher key status, current time and signature expiry.');
  process.exitCode = 1;
}
