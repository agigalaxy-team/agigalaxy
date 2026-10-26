import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,cp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createNativeClientRelease} from '../native-client-release.mjs';
import {verifyRelease} from "../../packages/galaxy-official/src/infrastructure/release-artifact.mjs";
const preparedDirectory=process.env.GALAXY_NATIVE_RELEASE_PREPARED;
test('actual prepared native archive signs exact protocol evidence; tampered host claim is refused',{skip:!preparedDirectory},async()=>{
 const{privateKey,publicKey}=generateKeyPairSync('ed25519'),now=Math.floor(Date.now()/1000),options={preparedDirectory,publisher:'synthetic-signing-fixture',privateKey,kid:'synthetic',now,lifetime:60};
 const result=await createNativeClientRelease(options);
 const verified=await verifyRelease(result.signed,{expectedPackage:'@galaxy/native-client',trustedKeys:new Map([['synthetic',{publicKey,notBefore:now-1,notAfter:now+120}]]),
  publisher:options.publisher,artifact:result.artifact,report:result.reportBytes,now});
 assert.equal(verified.signatureVerified,true);assert.equal(verified.manifest.protocolAcceptance.actualHostAcceptance,false);
 const directory=await mkdtemp(join(tmpdir(),'galaxy-native-release-proof-'));
 try{
  const copy=join(directory,'prepared');await cp(preparedDirectory,copy,{recursive:true,errorOnExist:true});
  const path=join(copy,'protocol-report.json'),report=JSON.parse(await readFile(path,'utf8'));report.actualHostAcceptance=true;await writeFile(path,JSON.stringify(report));
  await assert.rejects(createNativeClientRelease({...options,preparedDirectory:copy}),/protocol report scope/);
 }finally{
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep));assert.ok(target.split(sep).at(-1).startsWith('galaxy-native-release-proof-'));
  await rm(target,{recursive:true,force:true});
 }
});
