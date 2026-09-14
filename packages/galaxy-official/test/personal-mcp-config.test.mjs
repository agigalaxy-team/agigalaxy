import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { personalMcpConfigurationSchema,loadPersonalMcp } from '../src/personal-mcp-config.mjs';
import { runtimeConfigSnapshot } from '../src/operations/runtime-config-audit.mjs';
import { createApi } from '../src/http.mjs';

test('Personal MCP is opt-in and requires selected provider, client restrictions, binding scope and an external secret reference',async()=>{
  const root=await mkdtemp(join(tmpdir(),'galaxy-personal-mcp-config-'));
  assert.ok(resolve(root).startsWith(join(resolve(tmpdir()),'galaxy-personal-mcp-config-')));
  const path=join(root,'mcp.json'),config={version:1,providerId:'fixture',introspectionClientId:'resource',clientSecretEnv:'GALAXY_OAUTH_RESOURCE',
    allowedClientIds:['client'],allowedScopes:['binding','case-teaser']};
  try {
    assert.equal(await loadPersonalMcp(),null);
    for(const patch of [{allowedScopes:[]},{allowedScopes:['case-teaser']},{allowedClientIds:[]},{clientSecretEnv:'OTHER_SECRET'},{clientSecret:'never-inline'},
      {allowedOrigins:['http://identity.example']},{allowedOrigins:['https://identity.example/path']}])assert.equal(personalMcpConfigurationSchema.safeParse({...config,...patch}).success,false);
    await writeFile(path,JSON.stringify(config));
    await assert.rejects(loadPersonalMcp(path,{identityProviders:[],env:{}}),/configured OIDC/);
    await assert.rejects(loadPersonalMcp(path,{identityProviders:[{describe:()=>({id:'fixture'})}],env:{}}),/credential unavailable/);
    assert.equal(runtimeConfigSnapshot({personalMcpConfigurationHash:'a'.repeat(64)}).personalMcpConfigurationHash,'a'.repeat(64));
    assert.equal(runtimeConfigSnapshot({personalMcpConfigurationHash:null}).personalMcpConfigurationHash,null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('an unconfigured resource has no OAuth metadata or protected MCP endpoint',async()=>{
  const api=createApi({bindings:{endpoint:'https://official.example.org'}});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  try {
    for(const path of ['/mcp/personal','/.well-known/oauth-protected-resource/mcp/personal']){
      const response=await fetch(`http://127.0.0.1:${api.address().port}`+path);assert.equal(response.status,404);await response.arrayBuffer();
    }
  }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}
});
