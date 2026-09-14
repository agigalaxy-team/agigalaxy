import { mkdtemp, writeFile, readFile, readdir, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildClient } from './build-client.mjs';
import { createGalaxyGenesis } from '../packages/galaxy-core/src/galaxy-guid.mjs';
import { createClientRelease } from './client-release.mjs';
import { verifyRelease } from '../packages/galaxy-official/src/release-artifact.mjs';

// Reusable package/install/sign pipeline. A production caller supplies its own
// pinned release configuration; only the CLI test wrapper creates fixture keys.
export function resolveNpmCli(candidate = process.env.GALAXY_TEST_NPM_CLI) {
  const paths = [candidate, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean);
  return paths.find(path => isAbsolute(path)) ?? null;
}

export async function buildAndVerifyClient({ npm, reportBytes = null, releaseConfiguration = null,
  outputRoot = fileURLToPath(new URL('../outputs/', import.meta.url)) }) {
npm = resolveNpmCli(npm);
if (!npm || !isAbsolute(npm)) throw new Error('An absolute npm-cli.js path is required.');
if (!isAbsolute(outputRoot)) throw new Error('An absolute output root is required.');
if ((reportBytes === null) !== (releaseConfiguration === null)) throw new Error('Report and release configuration must be supplied together.');
const temporary = await mkdtemp(join(tmpdir(), 'galaxy-client-install-'));
try {
  const source = join(temporary, 'package'), consumer = join(temporary, 'consumer');
  const built = await buildClient(source);
  await mkdir(consumer);
  const user = join(temporary, 'user.npmrc'), global = join(temporary, 'global.npmrc');
  await writeFile(user, ''); await writeFile(global, '');
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toLowerCase().startsWith('npm_config_')) delete env[name];
  const run = (cwd, args) => {
    try { return execFileSync(process.execPath, [npm, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--userconfig', user, '--globalconfig', global, '--registry', 'https://registry.npmjs.org/'],
      { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('Isolated offline npm operation failed.'); }
  };
  run(source, ['ci']);
  const packed = JSON.parse(run(source, ['pack', '--json']))[0];
  assert.equal(packed.filename, 'galaxy-client-0.1.0.tgz');
  const tarball = join(source, packed.filename);
  let release = null;
  if (releaseConfiguration) {
    const { publisher, purpose, privateKey, kid, trustedKeys, now, lifetime } = releaseConfiguration;
    release = await createClientRelease({ source, tarball, reportBytes, publisher, purpose, privateKey, kid, now, lifetime });
    const verified = await verifyRelease(release.signed, { publisher, trustedKeys,
      artifact: await readFile(tarball), report: reportBytes, now });
    assert.equal(verified.signatureVerified, true);
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(consumer, ['install', tarball]);
  const installed = join(consumer, 'node_modules/@galaxy/client');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(Object.keys(manifest.exports).length, 22);
  const hashes = JSON.parse(await readFile(join(installed, 'source-hashes.json'), 'utf8'));
  if (release) {
    assert.deepEqual(Object.keys(manifest.exports), release.manifest.package.exports);
    assert.deepEqual(manifest.dependencies, release.manifest.package.dependencies);
    assert.equal(manifest.version, release.manifest.package.version);
    assert.equal(createHash('sha256').update(await readFile(join(installed, 'source-hashes.json'))).digest('hex'),
      release.manifest.package.sourceHashesSha256);
  }
  for (const [name, hash] of Object.entries(hashes))
    assert.equal(createHash('sha256').update(await readFile(join(installed, 'lib', name))).digest('hex'), hash);
  const inventory = await readdir(join(installed, 'lib/packages/galaxy-official/src'));
  for (const forbidden of ['local-host-runtime.mjs', 'database.mjs', 'signing-service.mjs', 'access.mjs'])
    assert.ok(!inventory.includes(forbidden));
  const nodeKey=generateKeyPairSync('ed25519'),registryKey=generateKeyPairSync('ed25519');
  const genesis = createGalaxyGenesis({ publicKeyPem: nodeKey.publicKey.export({ type: 'spki', format: 'pem' }) });
  await writeFile(join(consumer, 'genesis.json'), JSON.stringify(genesis));
  const time=Math.floor(Date.now()/1000),endpoint='https://official.example.org',builderId=randomUUID(),controlId=randomUUID(),declarationId=randomUUID(),declarationHash='a'.repeat(64);
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const compact=(header,payload,key)=>{const signingInput=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');return signingInput+'.'+sign(null,Buffer.from(signingInput),key).toString('base64url');};
  const control={kind:'node-control',id:controlId,builderId,expectedRevision:1,ownerId:genesis.id,nodeId:genesis.id,declarationId,declarationHash,expiresAt:time+300};
  const data={version:1,id:controlId,builderId,ownerId:genesis.id,nodeId:genesis.id,declarationId,declarationHash,control,controlPayloadJson:JSON.stringify(control),sourceEventHash:sha(JSON.stringify(control)),
    checkedAt:time,expiresAt:time+300,authority:'registry-attested-node-authorization',capabilityVerified:false,endpointControlVerified:false,maintenance:{delisted:false,securityIssue:false},statusPath:'/v1/builders/node-control/export'};
  const registrySigned=compact({alg:'Ed25519',typ:'galaxy-node-control+jwt',kid:'fixture'},{data,iss:endpoint,aud:endpoint,iat:time,nbf:time,exp:time+300,jti:controlId},registryKey.privateKey);
  const claims={version:1,purpose:'node-control-portable-proof',endpoint,builderId,controlId,ownerId:genesis.id,nodeId:genesis.id,declarationId,declarationHash,registryHash:sha(registrySigned),issuedAt:time,expiresAt:time+300};
  await writeFile(join(consumer,'node-proof-fixture.json'),JSON.stringify({proof:{version:1,registrySigned,nodeSigned:compact({alg:'Ed25519',typ:'galaxy-node-control-proof+jws'},claims,nodeKey.privateKey),genesisProof:genesis.genesisProof},
    endpoint,builderId,controlId,now:time,pin:{publicKeyPem:registryKey.publicKey.export({type:'spki',format:'pem'}),notBefore:time-1,notAfter:time+600,revoked:false}}));
  // Independent producer: built-in crypto signs the Hub JWT. These literal
  // objects are already in JCS key order; no Galaxy Manifest producer is used.
  const hubData={capabilities:['binding','sessions'],displayName:'Independent Hub',endpoint:'https://hub.example.org',
    hub:{charter:'https://hub.example.org/charter',exit:'Revoke this binding.',export:'Export selected data.',profile:'galaxy-hub/1',scope:'Independent fixture'},
    networkType:'hub',operator:'Independent operator',policy:{automaticUpload:false,privateKeyCustody:'client',url:'https://hub.example.org/v1/policy'},
    region:'fixture',revocationPath:'/v1/signing-keys/status',schemaVersion:1,serviceVersion:'0.2.0',signingKeyId:'independent-hub'};
  const hubDeclaration={type:'hub',name:hubData.displayName,scope:hubData.hub.scope,operator:hubData.operator,region:hubData.region,endpoint:hubData.endpoint,
    charter:hubData.hub.charter,policy:hubData.policy.url,exit:hubData.hub.exit,export:hubData.hub.export,contact:hubData.endpoint+'/contact',proofIds:[],redactionConfirmed:true,
    manifest:{url:hubData.endpoint+'/.well-known/galaxy-network.json',specVersion:'galaxy-hub/1',sha256:sha(JSON.stringify(hubData))},
    release:{version:'0.2.0',buildHash:'a'.repeat(64),sourceCommit:'b'.repeat(40),artifact:hubData.endpoint+'/client.tgz',dependencies:[],upgrade:'Preserve identity.',rollback:'Restore previous build.'}};
  await writeFile(join(consumer,'hub-fixture.json'),JSON.stringify({declaration:hubDeclaration,now:time,
    document:{signed:compact({alg:'Ed25519',typ:'galaxy-manifest+jwt',kid:'independent-hub'},
      {data:Object.fromEntries(Object.entries(hubData).reverse()),iss:hubData.endpoint,aud:hubData.endpoint,iat:time,nbf:time,exp:time+300,jti:randomUUID()},registryKey.privateKey)},
    pin:{publicKeyPem:registryKey.publicKey.export({type:'spki',format:'pem'}),notBefore:time-1,notAfter:time+600,revoked:false}}));
  const ciData={version:1,type:'ci-execution-observation',id:randomUUID(),subject:genesis.id,issuer:endpoint,evidenceId:randomUUID(),observationId:randomUUID(),
    scope:'referenced-ci-run-only',strength:'ci-execution-fact',independence:'repository-controlled',attribution:'submitter-asserted',
    source:{provider:'github-actions',owner:'fixture',repository:'example',runId:12345,attempt:1,commit:'a'.repeat(40),repositoryId:123,sourceUpdatedAt:new Date(time*1000).toISOString()},
    conclusion:'success',taskOutcomeVerification:'not-independently-verified',capabilityVerified:false,preparedAt:time,observedAt:time,expiresAt:time+300,limitations:['Independent synthetic producer only.']};
  ciData.statusPath='/v1/proofs/'+ciData.id+'/status';
  const ciSigned=compact({alg:'Ed25519',typ:'galaxy-proof+jwt',kid:'independent-ci'},{data:ciData,iss:endpoint,aud:endpoint,iat:time,nbf:time,exp:time+300,jti:ciData.id},registryKey.privateKey);
  await writeFile(join(consumer,'ci-fixture.json'),JSON.stringify({document:{endpoint,signed:ciSigned},now:time,pin:{publicKeyPem:registryKey.publicKey.export({type:'spki',format:'pem'}),notBefore:time-1,notAfter:time+600,revoked:false}}));
  await writeFile(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import https from 'node:https'; import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
let calls = 0;
https.request = dns.lookup = () => { calls++; throw new Error('Unexpected network'); };
syncBuiltinESMExports();
for (const name of ${JSON.stringify(Object.keys(manifest.exports).map(name => name.slice(2)))})
  await import('@galaxy/client/' + name);
const { createConnectionClient } = await import('@galaxy/client/connection');
const { createSessionMemory } = await import('@galaxy/client/session-memory');
const { createBindingStatusClient, createBindingManagementClient } = await import('@galaxy/client/binding-status');
assert.equal(typeof createBindingManagementClient,'function');
const { createHostConnectionController } = await import('@galaxy/client/host-controller');
const { createSearchClient } = await import('@galaxy/client/history');
const { createAssistanceClient } = await import('@galaxy/client/assistance');
const { createContextClient } = await import('@galaxy/client/context');
const { verifyNodeControlProof } = await import('@galaxy/client/builders');
const { verifyCiProofCollection,githubBridgeMapping } = await import('@galaxy/client/proofs');
assert.equal(githubBridgeMapping.sourceSystem,'GitHub Actions REST API');
const ciFixture=JSON.parse(await readFile(new URL('./ci-fixture.json',import.meta.url),'utf8'));
const ciCollection=await verifyCiProofCollection([ciFixture.document,ciFixture.document],{trustedEndpoints:new Map([[ciFixture.document.endpoint,new Map([['independent-ci',ciFixture.pin]])]]),now:ciFixture.now});
assert.equal(ciCollection.rejected.length,0);assert.equal(ciCollection.summary.sourceGroupCount,1);assert.equal(ciCollection.summary.duplicateProofRecordCount,1);assert.equal(ciCollection.summary.independentlyVerifiedSourceCount,0);assert.equal(ciCollection.revocationChecked,false);
const { verifyHubDirectoryManifest } = await import('@galaxy/client/builders');
const { discoverHub, discoverHubWithRoot } = await import('@galaxy/client/discovery');
assert.equal(typeof discoverHub,'function');assert.equal(typeof discoverHubWithRoot,'function');
const hubFixture=JSON.parse(await readFile(new URL('./hub-fixture.json',import.meta.url),'utf8'));
await assert.rejects(verifyHubDirectoryManifest(hubFixture.document,{...hubFixture,trustedKeys:new Map()}));
const hubResult=await verifyHubDirectoryManifest(hubFixture.document,{...hubFixture,trustedKeys:new Map([['independent-hub',hubFixture.pin]])});
assert.equal(hubResult.directoryState,'matched');assert.equal(hubResult.connected,false);assert.equal(hubResult.capabilityVerified,false);
const nodeProof = JSON.parse(await readFile(new URL('./node-proof-fixture.json', import.meta.url),'utf8'));
assert.equal((await verifyNodeControlProof(nodeProof.proof,{...nodeProof,trustedKeys:new Map([['fixture',nodeProof.pin]])})).nodeSignatureVerified,true);
const genesis = JSON.parse(await readFile(new URL('./genesis.json', import.meta.url), 'utf8'));
const endpoint = 'https://official.example.org';
const client = createConnectionClient({ endpoint, trustedKeys: new Map(), assertCurrent: async () => true,
  sign() { throw new Error('Unexpected signing'); } });
const request = { subjectId: genesis.id, genesisProof: genesis.genesisProof, installationId: randomUUID(), scopes: ['binding'] };
const preview = client.prepare(request); client.cancel(preview);
const sessions = createSessionMemory({ isCurrent: async () => true });
const { createHonorClient } = await import('@galaxy/client/honor');
const honorClient=createHonorClient({endpoint,sessions,send:async(url,input)=>{
  assert.equal(new URL(url).pathname,'/v1/honor/rule-history');assert.equal(input.credential,undefined);
  assert.deepEqual(JSON.parse(input.bodyJson),{ruleId:'old-rule',after:5,limit:8});
  return {issuer:endpoint,items:[],nextAfter:null,capabilityVerified:false};
}});
const honorController=createHostConnectionController({endpoint,sessions,honorClient});
assert.deepEqual((await honorController.honorRuleHistory({ruleId:'old-rule',after:5})).items,[]);honorController.cancel();
const { createModerationClient } = await import('@galaxy/client/moderation');
const moderationClient=createModerationClient({endpoint,sessions});
const verifierReportId=randomUUID(),verifierInvitationId=randomUUID();
for(const kind of ['accept-verifier','decline-verifier','withdraw-verifier','verification-response']){
  const payload={id:randomUUID(),reportId:verifierReportId,expectedVersion:2,kind,invitationId:verifierInvitationId,summary:'Portable voluntary participation',
    ...(kind==='verification-response'?{conclusion:'inconclusive',references:[]}: {})};
  const prepared=moderationClient.prepare({consentId:randomUUID(),payloadJson:JSON.stringify(payload)});
  assert.equal(JSON.parse(prepared.payloadJson).invitationId,verifierInvitationId);moderationClient.cancel(prepared);
}
const statusClient = createBindingStatusClient({ endpoint, sessions });
const searchClient = createSearchClient({ endpoint, sessions });
const controller = createHostConnectionController({ endpoint, client, sessions, statusClient, searchClient, readRequest: async () => request });
await assert.rejects(controller.querySearch({type:'proof',query:{}}),/authorization required/);
assert.equal((await controller.checkRemote()).state, 'no-session');
assert.equal((await controller.status()).state, 'no-session');
const assistance=createAssistanceClient({endpoint,sessions,send:async(url,input)=>{
  assert.equal(new URL(url).pathname,'/v1/assistance/events/receipt');
  return {...JSON.parse(input.bodyJson),state:'absent'};
}});
const receiptQuery={assistanceId:randomUUID(),eventId:randomUUID(),payloadHash:'a'.repeat(64)};
await assert.rejects(assistance.receipt(receiptQuery),/authorization required/);
const currentTime=Math.floor(Date.now()/1000);
sessions.adopt({endpoint,subjectId:genesis.id,bindingId:randomUUID(),scopes:['binding','assistance','context'],
  expiresAt:currentTime+300,bindingExpiresAt:currentTime+600,takeCredential:()=> Buffer.alloc(32,1).toString('base64url')});
assert.equal((await assistance.receipt(receiptQuery)).state,'absent');
const contexts=createContextClient({endpoint,sessions,send:async(url,input)=>{
  assert.equal(new URL(url).pathname,'/v1/context-grants/receipt');
  return {...JSON.parse(input.bodyJson),state:'absent'};
}});
const grantId=randomUUID();
assert.equal((await contexts.receipt({kind:'grant',grantId,eventId:grantId,payloadHash:'b'.repeat(64)})).state,'absent');
await assert.rejects(import('@galaxy/client/lib/packages/galaxy-official/src/local-host-runtime.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(calls, 0); sessions.close();
`);
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumer, env, windowsHide: true, stdio: 'pipe', timeout: 15000 });
  await mkdir(outputRoot, { recursive: true });
  const output = join(outputRoot, 'client-complete-' + randomUUID()); await mkdir(output);
  await copyFile(tarball, join(output, packed.filename));
  if (release) {
    await writeFile(join(output, 'release.jws'), release.signed + '\\n', { flag: 'wx' });
    await writeFile(join(output, 'release-manifest.json'), JSON.stringify(release.manifest, null, 2) + '\\n', { flag: 'wx' });
    await writeFile(join(output, 'conformance-report.json'), reportBytes, { flag: 'wx' });
    if (releaseConfiguration.purpose === 'local-validation' && releaseConfiguration.fixturePublicJwk)
      await writeFile(join(output, 'fixture-public-key.json'), JSON.stringify(releaseConfiguration.fixturePublicJwk) + '\\n', { flag: 'wx' });
    await copyFile(join(source, 'package-lock.json'), join(output, 'package-lock.json'));
  }
  const result = { files: built.files, exports: Object.keys(manifest.exports), dependencies: manifest.dependencies,
    offlineInstall: 'passed', consumerSmoke: 'passed', sourceHashes: 'matched', output,
    releaseSignature: release ? (releaseConfiguration.purpose === 'local-validation' ? 'temporary-fixture-verified-before-install' : 'caller-pinned-key-verified-before-install') : 'not-requested',
    conformanceSourceHash: release?.manifest.conformance.sourceSha256 ?? null, publicationReady: false,
    bytes: (await readFile(tarball)).length, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex') };
  await writeFile(join(output, 'verification.json'), JSON.stringify(result, null, 2) + '\\n');
  return result;
} finally {
  const child = relative(tmpdir(), temporary);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
  await rm(temporary, { recursive: true, force: true });
}
}

export function localReleaseFixture(now = Math.floor(Date.now() / 1000)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { publisher: 'galaxy-local-release-fixture', purpose: 'local-validation',
    privateKey, kid: 'temporary-release-test', now, lifetime: 86400,
    trustedKeys: new Map([['temporary-release-test', { publicKey, notBefore: now, notAfter: now + 86400 }]]),
    fixturePublicJwk: publicKey.export({ format: 'jwk' }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportBytes = process.argv[2] ? await readFile(resolve(process.argv[2])) : null;
  console.log(JSON.stringify(await buildAndVerifyClient({ npm: resolveNpmCli(), reportBytes,
    releaseConfiguration: reportBytes ? localReleaseFixture() : null })));
}




