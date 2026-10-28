// Preserve the current tool contracts and exact temporary browser UI source.
// This capture never starts a server or opens a browser.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {z} from '../../packages/galaxy-official/node_modules/zod/index.js';
import {registerNativeIdentityWebConnectTools} from '../../integrations/native-v2/identity-web-connect-tools.mjs';
import {nativeIdentityScopeGroups} from '../../packages/galaxy-edge-mcp/src/native-v2/identity/scope-presentation.mjs';
import {browserScopes} from '../../packages/galaxy-official/src/browser-client.mjs';
const contracts={};
registerNativeIdentityWebConnectTools({registerTool(name,d){contracts[name]={schema:z.toJSONSchema(d.inputSchema,{io:'input'}),description:d.description,...d.annotations}}},{runtime:{}});
const source=(await readFile(new URL('../../packages/galaxy-edge-mcp/src/native-v2/identity/web-handoff.mjs',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const start=source.indexOf("res.end('<!doctype html"),end=source.indexOf(');\n    return;',start);
if(start<0||end<0)throw Error('Original web handoff HTML not found');
const html=vm.runInNewContext(source.slice(start+8,end),{escape:x=>x,targetDescription:()=> '{{DESCRIPTION}}',targetPath:'{{TARGET}}',context:{endpoint:'{{ENDPOINT}}',subjectId:'{{SUBJECT}}'},scriptNonce:'{{NONCE}}',script:'{{SCRIPT}}'},{timeout:1000});
const browser=source.slice(source.indexOf('function browserBridge(boot){'));
const data={contracts,scopeGroups:nativeIdentityScopeGroups(browserScopes)};
let output='package native\n\n// Generated from the original web-connect contracts and unchanged browser bridge.\n';
for(const[id,value]of Object.entries({webHandoffContractsJSON:JSON.stringify(data),webHandoffHTML:html,webHandoffBrowser:browser})){
 if(value.includes('`'))output+=`const ${id} = ${JSON.stringify(value)}\n`;else output+=`const ${id} = \`${value}\`\n`;
}
await writeFile(fileURLToPath(new URL('../../go/internal/native/web-handoff-contracts.go',import.meta.url)),output);
