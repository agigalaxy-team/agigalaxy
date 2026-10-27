import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {publicConfiguration} from '../../../packages/galaxy-web/server/public-configuration.mjs';
import {GET} from '../src/app/galaxy-web-config.json/route.ts';
test('public runtime configuration is an exact projection and fails closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'galaxy-public-config-')),old=process.env.GALAXY_WEB_CONFIG_FILE;
 t.after(async()=>{if(old===undefined)delete process.env.GALAXY_WEB_CONFIG_FILE;else process.env.GALAXY_WEB_CONFIG_FILE=old;assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
 delete process.env.GALAXY_WEB_CONFIG_FILE;assert.equal((await GET()).status,503);
 const path=join(root,'configuration.json');process.env.GALAXY_WEB_CONFIG_FILE=path;
 const pin={kid:'fixture',publicKeyPem:'-----BEGIN PUBLIC KEY-----\nPUBLIC_FIXTURE\n-----END PUBLIC KEY-----',notBefore:1,notAfter:9999999999,revoked:false,privatePath:'PRIVATE_CANARY'};
 const source={version:1,endpoint:'https://api.example.invalid/',signingKeys:[pin],privateKey:'PRIVATE_CANARY',filePath:'PRIVATE_PATH_CANARY'};
 await writeFile(path,JSON.stringify(source));const value=await publicConfiguration();assert.deepEqual(Object.keys(value).sort(),['endpoint','operator','signingKeys','version']);assert.deepEqual(Object.keys(value.signingKeys[0]).sort(),['kid','notAfter','notBefore','publicKeyPem','revoked']);assert.equal(JSON.stringify(value).includes('PRIVATE_'),false);assert.equal(value.endpoint,'https://api.example.invalid');
 await writeFile(path,JSON.stringify({...source,endpoint:'https://user:password@api.example.invalid'}));assert.equal((await GET()).status,503);
 await writeFile(path,JSON.stringify({...source,signingKeys:[{...pin,publicKeyPem:'-----BEGIN PRIVATE KEY-----'}]}));const response=await GET();assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'website_configuration_required'});
});
