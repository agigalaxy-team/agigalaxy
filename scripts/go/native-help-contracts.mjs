// Build-time schema capture only. No Help flow or network operation runs.
import {writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {z} from '../../packages/galaxy-official/node_modules/zod/index.js';
import {registerHelpTools} from '../../packages/galaxy-edge-mcp/src/help-tools-v2.mjs';
import {helpSessionSchema,helpBasisSchema,helpOfferDraftSchema} from '../../packages/galaxy-official/src/shared/help-schema-v2.mjs';
import {discoveryPageSchema} from '../../packages/galaxy-official/src/shared/discovery-schema.mjs';
const contracts={},flow=new Proxy({},{get(){return()=>{throw Error('No Help actions during contract capture')}}});
registerHelpTools({registerTool(name,d){let schema=z.toJSONSchema(d.inputSchema,{io:'input'});if(!schema.type)schema.type='object';contracts[name]={schema,description:d.description,...d.annotations}}},{flow,review(){throw Error('No review during capture')}});
const schemas=Object.fromEntries(Object.entries({session:helpSessionSchema,basis:helpBasisSchema,offer:helpOfferDraftSchema,legacyDiscoveryPage:discoveryPageSchema}).map(([k,v])=>[k,z.toJSONSchema(v,{io:'input'})]));
const source=await readFile(new URL('../../packages/galaxy-edge-mcp/src/help-tools-v2.mjs',import.meta.url),'utf8');
const recovery=Object.fromEntries([...source.matchAll(/^  (help_[a-z_]+): '([^']+)',?$/gm)].map(m=>[m[1],m[2]]));
const json=JSON.stringify({contracts,schemas,recovery});if(json.includes('`'))throw Error('Contract literal source encoding required');
await writeFile(fileURLToPath(new URL('../../go/internal/native/help-contracts.go',import.meta.url)),`package native\n\n// Generated from the current original Help tools and local record schemas.\nconst nativeHelpContractsJSON = \`${json}\`\n`);
