import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadIdentityProviders,identityConfigurationSchema } from '../src/identity-config.mjs';

test('explicit identity config resolves only named per-provider credentials and records a secret-free config hash',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-identity-config-'));
  try{
    const item={id:'enterprise',name:'Example SSO',issuer:'https://login.example.org',clientId:'galaxy',clientSecretEnv:'GALAXY_OIDC_ENTERPRISE_SECRET'};
    const path=join(directory,'identity.json');await writeFile(path,JSON.stringify({version:1,providers:[item]}));
    let argument;const factory=async input=>{argument=input;return {describe:()=>({id:input.id})};};
    const options={endpoint:'https://official.example.org',factory,env:{GALAXY_OIDC_ENTERPRISE_SECRET:'synthetic-first-secret'}};
    const result=await loadIdentityProviders(path,options);
    assert.equal(argument.redirectUri,'https://official.example.org/v1/identity/callback/enterprise');
    assert.equal(argument.clientSecret,options.env.GALAXY_OIDC_ENTERPRISE_SECRET);
    const second=await loadIdentityProviders(path,{...options,env:{GALAXY_OIDC_ENTERPRISE_SECRET:'synthetic-rotated-secret'}});
    assert.equal(result.configurationHash,second.configurationHash,'runtime history describes config, not resolved secret values');
    assert.ok(!JSON.stringify(result).includes('synthetic-first-secret'));
    await assert.rejects(loadIdentityProviders(path,{...options,env:{}}),/credential unavailable/);
    assert.equal(identityConfigurationSchema.safeParse({version:1,providers:[{...item,clientSecret:'not-allowed-in-file'}]}).success,false);
    assert.equal(identityConfigurationSchema.safeParse({version:1,providers:[{...item,issuer:'http://127.0.0.1'}]}).success,false);
    assert.deepEqual((await loadIdentityProviders(undefined,options)).providers,[]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
