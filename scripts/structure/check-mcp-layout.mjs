import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

// Compile the actual runtime entry graphs without creating a release or
// executing a service. Current request/source authorization is tested by the
// affected MCP integration tests, not inferred from a successful bundle.
const root=fileURLToPath(new URL('../../',import.meta.url));
const canonical='packages/galaxy-official/src/adapters/mcp/personal/';
const tools=(await readdir(resolve(root,canonical,'tools'))).filter(name=>name.endsWith('.mjs')).sort();
assert(tools.length>0,'The MCP tools directory must contain runtime sources');
for(const [old,current] of [
 ["packages/galaxy-official/src/adapters/mcp/personal/handler.mjs",canonical+'handler.mjs'],
 ["packages/galaxy-official/src/adapters/mcp/personal/configuration.mjs",canonical+'configuration.mjs'],
]){
 const entry=await import(pathToFileURL(resolve(root,old)));
 const implementation=await import(pathToFileURL(resolve(root,current)));
 assert.deepEqual(Object.keys(entry),Object.keys(implementation));
 for(const name of Object.keys(entry))assert.equal(entry[name],implementation[name]);
}

const definitions={
 official:{
  api:'packages/galaxy-official/src/server.mjs',
  worker:'packages/galaxy-official/src/worker.mjs',
 },
 native:{
  galaxy:'packages/galaxy-edge-mcp/src/native-v2-entry.mjs',
  runtime:'packages/galaxy-edge-mcp/src/native-v2/runtime.mjs',
  server:'packages/galaxy-edge-mcp/src/native-v2/server.mjs',
  opencode:'integrations/host-adapters/opencode-stable/native-galaxy.tui.ts',
 },
};
const summary={},allInputs=new Set();
for(const [profile,entryPoints] of Object.entries(definitions)){
 const result=await build({absWorkingDir:root,entryPoints,
  outdir:resolve(root,'outputs/source-layout-memory-only',profile),bundle:true,splitting:true,
  platform:'node',format:'esm',target:profile==='native'?'node22':'node24',packages:'external',
  external:['bun:sqlite'],metafile:true,write:false,sourcemap:false});
 const inputs=Object.keys(result.metafile.inputs).map(path=>path.replaceAll('\\','/'));
 for(const path of inputs)allInputs.add(path);
 summary[profile]={entryPoints:Object.values(entryPoints),outputFiles:result.outputFiles.length,
  personalMcpSources:inputs.filter(path=>path.startsWith(canonical)).sort(),write:false};
}
for(const name of tools)assert(allInputs.has(canonical+'tools/'+name),'Runtime graphs omit '+name);
assert(allInputs.has(canonical+'handler.mjs'));
assert(allInputs.has(canonical+'configuration.mjs'));
console.log(JSON.stringify({profiles:summary,movedSourcesIncluded:tools.length+2,compatibleEntries:2,
 serviceSourceCapture:'recursive-official-src',providerCalls:0,deployed:false}));
