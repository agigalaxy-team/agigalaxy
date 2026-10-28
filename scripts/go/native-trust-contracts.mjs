// Build-only capture of the current Native Trust tools; handlers never run.
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {z} from '../../packages/galaxy-official/node_modules/zod/index.js';
import {registerNativeTrustTools} from '../../integrations/native-v2/trust-tools.mjs';
const contracts={};
registerNativeTrustTools({registerTool(name,d){const schema=z.toJSONSchema(d.inputSchema,{io:'input'});if(!schema.type)schema.type='object';contracts[name]={schema,description:d.description,write:d.annotations?.readOnlyHint!==true}}},{runtime:{trustPackages:{}},review(){throw Error('No review while building contracts')}});
const json=JSON.stringify(contracts);if(json.includes('`'))throw Error('Contract source encoding required');
await writeFile(fileURLToPath(new URL('../../go/internal/native/trust-contracts.go',import.meta.url)),`package native\n\n// Generated from the original current Native Trust tools.\nconst nativeTrustContractsJSON = \`${json}\`\n`);
