import {verifyIdentityControlLifecycle} from './identity-control-workflow.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createPrivateKey,createPublicKey} from 'node:crypto';
import {compactVerify,importSPKI} from 'jose';
import {createGalaxyGenesis,verifyGalaxyGenesis} from '../../galaxy-core/src/galaxy-guid.mjs';
import {createDeviceMaterial,createRecoveryMaterial,importRecoveryMaterial,parseRecoveryCode,signIdentityPayload} from '../../galaxy-core/src/domain/identity-material.mjs';
import {createBrowserGenesis} from '../../galaxy-core/src/domain/guid-browser-adapter.mjs';

const pem=key=>key.export({type:'spki',format:'pem'});

test('browser/Node device and user-held recovery material use the same GUID and mature Ed25519 implementations',async()=>{
  const material=await createDeviceMaterial();assert.equal(material.privateKey.extractable,false);
  const nonce=randomBytes(32),issuedAtMs=1900000000000,options={publicKeyPem:material.publicKeyPem,nonce,issuedAtMs,originCode:'5'};
  const browser=await createBrowserGenesis(options),node=createGalaxyGenesis(options);assert.deepEqual(browser,node);assert.ok(verifyGalaxyGenesis(browser.id,browser.genesisProof));
  const recovery=await createRecoveryMaterial(browser.id),parsed=parseRecoveryCode(recovery.code);
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(parsed.seed)]),format:'der',type:'pkcs8'});
  assert.equal(pem(createPublicKey(privateKey)),recovery.publicKeyPem);
  const imported=await importRecoveryMaterial(recovery.code);assert.equal(imported.publicKeyPem,recovery.publicKeyPem);assert.equal(imported.privateKey.extractable,false);
  const signed=await signIdentityPayload('same challenge',imported.privateKey);
  const checked=await compactVerify(signed,await importSPKI(recovery.publicKeyPem,'Ed25519'));assert.equal(Buffer.from(checked.payload).toString(),'same challenge');
  assert.throws(()=>parseRecoveryCode(recovery.code+'='));assert.throws(()=>parseRecoveryCode(recovery.code.replace('v1:','v9:')));
});

test('legacy identity upgrades, multiple devices work, recovery consumes once and current consumers reject stale devices',()=>verifyIdentityControlLifecycle());
