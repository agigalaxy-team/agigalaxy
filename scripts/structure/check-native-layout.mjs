import assert from 'node:assert/strict';
import {access,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

// Compile the real Native entry graph; write:false creates no release files,
// starts no host, and supplies neither an identity nor a model configuration.
const root=fileURLToPath(new URL('../../',import.meta.url));
const base='packages/galaxy-edge-mcp/src/native-v2/';
const groups=['work','identity','watch','tools','adapters','interaction'];
const moved=[];
for(const group of groups){
 const names=(await readdir(resolve(root,base,group))).filter(name=>name.endsWith('.mjs')).sort();
 assert(names.length>0,'Empty source category: '+group);
 for(const name of names)moved.push(base+group+'/'+name);
}
const entryPoints={
 galaxy:'packages/galaxy-edge-mcp/src/native-v2-entry.mjs',
 runtime:base+'runtime.mjs',
 server:base+'server.mjs',
 opencode:'integrations/host-adapters/opencode-stable/native-galaxy.tui.ts',
};
for(const path of Object.values(entryPoints))await access(resolve(root,path));
const native=await build({absWorkingDir:root,entryPoints,
 outdir:resolve(root,'outputs/native-layout-memory-only'),bundle:true,splitting:true,
 platform:'node',format:'esm',target:'node22',packages:'external',external:['bun:sqlite'],
 metafile:true,write:false,sourcemap:false});
const inputs=new Set(Object.keys(native.metafile.inputs).map(path=>path.replaceAll('\\','/')));
for(const path of moved)assert(inputs.has(path),'Actual Native entry graph omits '+path);
const webEntry='packages/galaxy-web/src/agent-work-continuation.tsx';
const web=await build({absWorkingDir:root,entryPoints:[webEntry],
 outfile:resolve(root,'outputs/native-layout-memory-only/web-continuation.js'),bundle:true,
 platform:'browser',format:'esm',target:'es2022',packages:'external',metafile:true,write:false});
assert(Object.hasOwn(web.metafile.inputs,base+'work/continuation-link.mjs'));
console.log(JSON.stringify({native:{entryPoints:Object.values(entryPoints),
 outputFiles:native.outputFiles.length,categorizedSources:moved.sort()},
 web:{entryPoint:webEntry,outputFiles:web.outputFiles.length},
 newCompatibilityStubs:0,write:false,providerCalls:0,deployed:false}));
