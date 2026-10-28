// One merged local-only path through the final Go artifact and real TS SDK.
// Runtime data stays in an OS-temporary directory, retained on failure.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {getGalaxyIntegrationStatus,listLocalHistory} from '../../packages/galaxy-core/src/local-store.mjs';

const binary=resolve(process.argv[2]);
const directory=await mkdtemp(join(tmpdir(),'galaxy-integration-stdio-'));
const invalidConfiguration=join(directory,'invalid-service-config.json');
await writeFile(invalidConfiguration,'{not-a-service-configuration');
const environment=Object.fromEntries(Object.entries(process.env).filter(([,value])=>typeof value==='string'));
environment.GALAXY_NATIVE_CONFIG=invalidConfiguration;
const require=createRequire(new URL('../../packages/galaxy-official/package.json',import.meta.url));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client/stdio')).href);
const transport=new StdioClientTransport({command:binary,args:['integration-mcp','--data-dir',directory],env:environment,stderr:'pipe'});
const client=new Client({name:'go-local-integration-fixture',version:'1'},{capabilities:{}});
const call=async(name,input={})=>{const reply=await client.callTool({name,arguments:input});assert(!reply.isError,JSON.stringify({name,result:reply}));return JSON.parse(reply.content.find(x=>x.type==='text').text);};
try{
  await client.connect(transport);
  const listed=await client.listTools(),names=listed.tools.map(x=>x.name);
  assert.equal(new Set(names).size,names.length);
  assert(!names.some(name=>/^galaxy_(?:task|chat|watch|help|hub|personal_summary|identity_web)_/.test(name)||/_(?:cloud|sync)_/.test(name)||/^galaxy_native_(?:connect|disconnect|authorize|status)$/.test(name)),'local factory exposed a service tool');
  const before=await call('galaxy_integration_status');assert.equal(before.initialized,false);
  const initialized=await call('galaxy_integration_initialize',{profile:'coding-case',confirmation:'I_CONFIRM_LOCAL_GALAXY_INITIALIZATION'});
  assert.equal(initialized.localOnly,true);assert(initialized.galaxyId?.id);
  const draft=await call('galaxy_case_create_escalation_draft',{title:'Isolated local case',failureSummary:'Synthetic local failure for the merged fixture.',attemptedApproaches:['Inspect the selected local input']});
  const disclosure=await call('galaxy_case_preview_disclosure',{caseId:draft.id,recipient:'isolated-future-recipient',purpose:'Local fixture observation',include:['failure_summary','verification_note'],expiresInHours:1});
  const confirmed=await call('galaxy_case_confirm_local_proof_draft',{caseId:draft.id,disclosurePlanId:disclosure.id,verificationNote:'This is a synthetic local observation, without remote verification.'});
  assert.equal(confirmed.consentGrant.caseId,draft.id);assert.equal(confirmed.localProofDraft.consentGrantId,confirmed.consentGrant.id);
  assert.equal(confirmed.localProofDraft.visibility,'local-only');
  const privacy=await call('galaxy_local_upload_privacy_get');assert.equal(privacy.uploadStarted,false);assert.equal(privacy.settings.includeFullConversations,false);
  const connection=await call('galaxy_connection_status');assert.equal(connection.state,'not-connected');assert.equal(connection.remoteEffects,'none');
  // Read the actual Go writes with the original JS consumer, not a copied DTO.
  const originalStatus=await getGalaxyIntegrationStatus(directory),history=await listLocalHistory(directory);
  assert.equal(originalStatus.galaxyId.id,initialized.galaxyId.id);assert.equal(history.cases[0].id,draft.id);
  assert.equal(history.consentGrants[0].id,confirmed.consentGrant.id);assert.equal(history.localProofDrafts[0].id,confirmed.localProofDraft.id);
  await client.close();await transport.close();
  const result=await promisify(execFile)(binary,['status','--data-dir',directory],{env:environment,windowsHide:true});
  const cli=JSON.parse(result.stdout);assert.equal(cli.counts.cases,1);assert.equal(cli.counts.localProofDrafts,1);
  assert.equal(await readFile(invalidConfiguration,'utf8'),'{not-a-service-configuration');
  console.log(JSON.stringify({integrationStdio:true,originalCaseDisclosureProofReadable:true,cliLocalStatus:true,invalidServiceConfigurationIgnored:true,serviceToolsExposed:false,fixtureDirectory:directory}));
}catch(error){console.error(JSON.stringify({fixtureDirectory:directory}));throw error;}
finally{await client.close();await transport.close();}
