import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { signRelease, verifyRelease } from '../src/release-artifact.mjs';

test('release JWS binds exact package/report and caller-pinned publisher/key lifetime', async () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const artifact = Buffer.from('synthetic tarball'), report = Buffer.from('synthetic report');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = 2000000000;
  const data = { version: 1, kind: 'galaxy-client-release', publisher: 'fixture', purpose: 'local-validation',
    issuedAt: now, expiresAt: now + 60,
    package: { name: '@galaxy/client', version: '0.1.0', filename: 'galaxy-client-0.1.0.tgz',
      sha256: sha(artifact), bytes: artifact.length, exports: ['./builders'], dependencies: { jose: '6.2.12' },
      lockSha256: sha('lock'), sourceHashesSha256: sha('sources') },
    conformance: { profile: 'galaxy-conformance/2', reportSha256: sha(report), sourceSha256: sha('sources'),
      suiteSha256: sha('suite'), scope: 'local-source-tests' } };
  const signed = await signRelease(data, { privateKey, kid: 'fixture-key' });
  const trust = { publicKey, notBefore: now, notAfter: now + 120 };
  const options = { trustedKeys: new Map([['fixture-key', trust]]), publisher: 'fixture', artifact, report, now };
  assert.equal((await verifyRelease(signed, options)).signatureVerified, true);
  await assert.rejects(verifyRelease(signed, { ...options, expectedPackage: '@galaxy/native-host' }));
  for (const override of [{ artifact: Buffer.from('tampered tarball') }, { report: Buffer.from('wrong report') },
    { publisher: 'wrong' }, { now: now + 60 }, { now: now - 1 }, { trustedKeys: new Map() },
    { trustedKeys: new Map([['fixture-key', { ...trust, revoked: true }]]) },
    { trustedKeys: new Map([['fixture-key', { ...trust, notAfter: now + 30 }]]) }])
    await assert.rejects(verifyRelease(signed, { ...options, ...override }));
  const parts = signed.split('.'); parts[1] = Buffer.from(JSON.stringify({ ...data, publisher: 'other' })).toString('base64url');
  await assert.rejects(verifyRelease(parts.join('.'), options));
  await assert.rejects(signRelease({ ...data, expiresAt: now + 31 * 86400 }, { privateKey, kid: 'fixture-key' }));
});

test('native JWS binds its host evidence and requires explicit native package selection', async () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const artifact = Buffer.from('native fixture'), report = Buffer.from('host fixture');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = 2000000000;
  const data = { version: 1, kind: 'galaxy-native-host-release', publisher: 'fixture', purpose: 'local-validation',
    issuedAt: now, expiresAt: now + 60,
    package: { name: '@galaxy/native-host', version: '0.1.0', filename: 'galaxy-native-host-0.1.0.tgz',
      sha256: sha(artifact), bytes: artifact.length, exports: ['./opencode', './configured'], dependencies: { jose: '6.2.12' },
      lockSha256: sha('lock'), sourceHashesSha256: sha('sources') },
    hostAcceptance: { profile: 'galaxy-native-host/1', reportSha256: sha(report), sourceSha256: sha('sources'),
      artifactsSha256: sha('bundles'), scope: 'real-host-local-fixtures' } };
  const signed = await signRelease(data, { privateKey, kid: 'fixture-key' });
  const trust = { publicKey, notBefore: now, notAfter: now + 120 };
  const options = { trustedKeys: new Map([['fixture-key', trust]]), publisher: 'fixture', artifact, report, now };
  await assert.rejects(verifyRelease(signed, options));
  const native = { ...options, expectedPackage: '@galaxy/native-host' };
  assert.equal((await verifyRelease(signed, native)).manifest.hostAcceptance.reportSha256, sha(report));
  for (const override of [{ artifact: Buffer.from('other') }, { report: Buffer.from('other') }, { publisher: 'other' },
    { now: now + 60 }, { trustedKeys: new Map([['fixture-key', { ...trust, revoked: true }]]) }])
    await assert.rejects(verifyRelease(signed, { ...native, ...override }));
  await assert.rejects(signRelease({ ...data, kind: 'galaxy-client-release' }, { privateKey, kid: 'fixture-key' }));
  await assert.rejects(signRelease({ ...data, expiresAt: now + 31 * 86400 }, { privateKey, kid: 'fixture-key' }));
});

test('shared native client keeps protocol evidence distinct from actual host acceptance',async()=>{
 const sha=x=>createHash('sha256').update(x).digest('hex'),artifact=Buffer.from('synthetic shared client'),report=Buffer.from('synthetic protocol report'),now=2000000000;
 const{privateKey,publicKey}=generateKeyPairSync('ed25519');
 const manifest={version:1,kind:'galaxy-native-client-release',publisher:'fixture',purpose:'local-validation',issuedAt:now,expiresAt:now+60,
  package:{name:'@galaxy/native-client',version:'0.2.0',filename:'galaxy-native-client-0.2.0.tgz',sha256:sha(artifact),bytes:artifact.length,exports:['./runtime','./server'],
   dependencies:{'@modelcontextprotocol/server':'2.0.0',zod:'4.5.4'},lockSha256:sha('lock'),sourceHashesSha256:sha('source')},
  protocolAcceptance:{profile:'galaxy-native-client/1',reportSha256:sha(report),sourceSha256:sha('source'),artifactsSha256:sha('artifacts'),scope:'local-stdio-http-fixtures',actualHostAcceptance:false}};
 const options={trustedKeys:new Map([['fixture',{publicKey,notBefore:now,notAfter:now+120}]]),publisher:'fixture',artifact,report,now,expectedPackage:'@galaxy/native-client'};
 const signed=await signRelease(manifest,{privateKey,kid:'fixture'});assert.equal((await verifyRelease(signed,options)).manifest.protocolAcceptance.actualHostAcceptance,false);
 await assert.rejects(verifyRelease(signed,{...options,expectedPackage:'@galaxy/native-host'}));
 await assert.rejects(verifyRelease(signed,{...options,artifact:Buffer.from('modified')}));
 await assert.rejects(verifyRelease(signed,{...options,report:Buffer.from('other host report')}));
 for(const protocolAcceptance of[{...manifest.protocolAcceptance,actualHostAcceptance:true},{...manifest.protocolAcceptance,scope:'real-host-local-fixtures'}])
  await assert.rejects(signRelease({...manifest,protocolAcceptance},{privateKey,kid:'fixture'}));
 await assert.rejects(signRelease({...manifest,package:{...manifest.package,dependencies:{'@wrong/scope/extra':'1.0.0'}}},{privateKey,kid:'fixture'}));
 await assert.rejects(signRelease({...manifest,expiresAt:now+31*86400},{privateKey,kid:'fixture'}));
});
