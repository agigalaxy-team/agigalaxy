// Build-only extraction; business handlers are captured, never invoked.
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {z} from '../../packages/galaxy-official/node_modules/zod/index.js';
import {nativeHttpDefinitions} from '../../packages/galaxy-edge-mcp/src/native-v2/tools/http.mjs';
import {registerNativeWatchControlTools} from '../../packages/galaxy-edge-mcp/src/native-v2/watch/control-tools.mjs';
const definitions=nativeHttpDefinitions({call(){throw Error('No remote calls while extracting contracts')}});
const watch={};
registerNativeWatchControlTools((name,inputSchema,description,run,options={})=>{watch[name]={inputSchema,description,...options}},{});
for(const [group,id,entries] of [
 ['contacts','remoteContactsContractsJSON',Object.entries(definitions).filter(([n])=>/^galaxy_contact(?:s)?_v2_|^galaxy_recruitment_v2_/.test(n))],
 ['information','remoteInformationContractsJSON',Object.entries(definitions).filter(([n])=>n.startsWith('galaxy_information_'))],
 ['watch','remoteWatchContractsJSON',Object.entries(watch)]
]){
 const contracts={};for(const[name,d]of entries){const schema=z.toJSONSchema(d.inputSchema,{io:'input'});if(!schema.type)schema.type='object';contracts[name]={schema,description:d.description,write:d.write===true,needsChoice:d.needsChoice===true};}
 const json=JSON.stringify(contracts);if(json.includes('`'))throw Error('Contract source encoding required');
 await writeFile(fileURLToPath(new URL(`../../go/internal/native/remote-${group}-contracts.go`,import.meta.url)),`package native\n\n// Generated from the original current Native tool definitions.\nconst ${id} = \`${json}\`\n`);
}
