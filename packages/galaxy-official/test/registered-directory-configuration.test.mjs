import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {loadRegisteredWebsiteDirectory} from '../src/infrastructure/registered-directory-configuration.mjs';

test('website directory config reuses its reader and loads an independent writer only for API',async()=>{
  const root=await mkdtemp(join(tmpdir(),'galaxy-directory-config-'));
  try{
    const reader=join(root,'reader.json'),writer=join(root,'writer.json'),path=join(root,'operations.json');
    const issuer='https://identity.example.invalid/realms/website';
    await writeFile(reader,JSON.stringify({version:1,clientId:'website-reader',clientSecret:'isolated-fixture-reader'}),{mode:0o600});
    const config={version:1,issuer:'https://identity.example.invalid/realms/management',accountDirectory:{issuer,credentialFile:reader,writerCredentialFile:writer}};
    const save=()=>writeFile(path,JSON.stringify(config),{mode:0o600});
    await save();
    const readOnly=await loadRegisteredWebsiteDirectory(path);
    assert.equal(readOnly.issuer,issuer);assert.equal(readOnly.managementConfigured,false);
    assert.deepEqual(await readOnly.management({issuer,externalSubject:'example-user'}),{state:'not-configured'});
    await assert.rejects(loadRegisteredWebsiteDirectory(path,{write:true}),{code:'ENOENT'});
    await writeFile(writer,JSON.stringify({version:1,clientId:'website-writer',clientSecret:'isolated-fixture-writer'}),{mode:0o600});
    assert.equal((await loadRegisteredWebsiteDirectory(path,{write:true,expectedIssuer:issuer})).managementConfigured,true);
    await assert.rejects(loadRegisteredWebsiteDirectory(path,{expectedIssuer:config.issuer}),/Invalid registered website/);
    config.accountDirectory.writerCredentialFile=reader;await save();
    await assert.rejects(loadRegisteredWebsiteDirectory(path,{write:true}),/Independent registered/);
    config.accountDirectory.writerCredentialFile=writer;
    await writeFile(writer,JSON.stringify({version:1,clientId:'website-reader',clientSecret:'isolated-fixture-writer'}),{mode:0o600});await save();
    await assert.rejects(loadRegisteredWebsiteDirectory(path,{write:true}),/Independent registered/);
    config.accountDirectory.surprise=true;await save();
    await assert.rejects(loadRegisteredWebsiteDirectory(path),/Invalid registered website/);
    assert.equal(await loadRegisteredWebsiteDirectory(null),null);
  }finally{
    const target=resolve(root);
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('galaxy-directory-config-'))throw Error('Unexpected fixture cleanup target.');
    await rm(target,{recursive:true,force:true});
  }
});
