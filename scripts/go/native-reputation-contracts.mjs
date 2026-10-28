// Build-only extraction of the existing Native extended HTTP contracts.
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {z} from '../../packages/galaxy-official/node_modules/zod/index.js';
import {extendedNativeHttpDefinitions} from '../../packages/galaxy-edge-mcp/src/native-v2/tools/extended-http.mjs';
import {qualificationToolDefinitions} from '../../packages/galaxy-official/src/adapters/mcp/personal/tools/qualification-v2.mjs';
import {honorToolDefinitions} from '../../packages/galaxy-official/src/adapters/mcp/personal/tools/honor-v2.mjs';
import {ciToolDefinitions} from '../../packages/galaxy-official/src/adapters/mcp/personal/tools/ci-v2.mjs';
const spy=new Proxy(()=>{throw Error('Business operations cannot run while extracting contracts')},{get:()=>spy});
const definitions=extendedNativeHttpDefinitions({call:()=>{throw Error('No remote calls while extracting contracts')}});
for(const[group,factories]of [['reputation',[qualificationToolDefinitions,honorToolDefinitions]],['ci',[ciToolDefinitions]]]){
 const contracts={};for(const factory of factories)for(const name of Object.keys(factory(spy,null))){
  const d=definitions[name],schema=z.toJSONSchema(d.inputSchema,{io:'input'});if(!schema.type)schema.type='object';contracts[name]={schema,description:d.description,write:d.write===true};
 }
 const json=JSON.stringify(contracts);if(json.includes('`'))throw Error('Contract literal requires quoted source encoding');
 const identifier=group==='ci'?'remoteCIContractsJSON':'remoteReputationContractsJSON';
 await writeFile(fileURLToPath(new URL(`../../go/internal/native/remote-${group}-contracts.go`,import.meta.url)),`package native\n\n// Generated from the original current Native extended HTTP tool definitions.\nconst ${identifier} = \`${json}\`\n`);
}
