import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {Writable} from 'node:stream';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import * as serverLogger from '../src/operations/runtime-log.mjs';
import {consoleRuntimeLogger,runtimeLogConfiguration} from '../src/shared/runtime-logger.mjs';
import {createNativeDiagnostics} from '../../galaxy-edge-mcp/src/native-v2/diagnostics.mjs';

test('shared logger keeps real Native/server closed projections and file drain without importing the server HTTP layer',async()=>{
 const sentinel='SYNTHETIC_PRIVATE_BODY_TOKEN_PASSWORD_08';
 const directory=await mkdtemp(join(tmpdir(),'galaxy-shared-logger-'));
 let diagnostics;
 try{
  assert.deepEqual(Object.keys(serverLogger).sort(),['consoleRuntimeLogger','createRuntimeLogger','installRuntimeFailureHandlers','runtimeLogConfiguration','runtimeLogEvent']);
  assert.equal(serverLogger.runtimeLogConfiguration,runtimeLogConfiguration);
  assert.throws(()=>consoleRuntimeLogger('native'),/Invalid log component/,'No shared raw-input default formatter is permitted');
  const lines=[],sink=new Writable({write(chunk,_encoding,done){lines.push(chunk.toString());done();}});
  const api=serverLogger.consoleRuntimeLogger('api',{destination:sink,release:'synthetic-08',environment:'test'});
  api.write({event:'http_completed',status:500,stage:'http-request',body:sentinel,query:sentinel,
   route:'POST /v2/private?token='+sentinel,error:Error(sentinel)});
  api.write({event:sentinel,message:sentinel,password:sentinel});
  await api.close();
  assert.equal(sink.destroyed,false,'The existing non-owned sink is not closed');
  const apiRows=lines.join('').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(apiRows[0].event,'http_completed');assert.equal(apiRows[0].status,500);
  assert.equal(apiRows[0].errorCode,'unclassified_error');
  assert.equal(apiRows[1].event,'runtime_event_rejected');
  assert(!lines.join('').includes(sentinel));sink.destroy();

  diagnostics=await createNativeDiagnostics({component:'native',env:{GALAXY_RUNTIME_LOG_DIRECTORY:directory,
   GALAXY_RUNTIME_LOG_INSTANCE:'boundary',GALAXY_NATIVE_RELEASE:'synthetic-08',GALAXY_ENVIRONMENT:'test'}});
  assert.equal(diagnostics.status().mode,'file');
  diagnostics.emit({event:'native_http',stage:'http',outcome:'failed',body:sentinel,input:sentinel,
   tool:'galaxy_unregistered_'+sentinel,message:sentinel,error:Object.assign(Error(sentinel),{code:sentinel})});
  await diagnostics.close();
  const file=await readFile(join(directory,'native-boundary/runtime.jsonl'),'utf8');
  const nativeRows=file.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(nativeRows.length,1);assert.equal(nativeRows[0].event,'native_http');
  assert.equal(nativeRows[0].errorCode,'native_operation_failed');assert.equal(nativeRows[0].component,'native');
  assert(!file.includes(sentinel));assert.equal(nativeRows[0].tool,undefined);assert.equal(nativeRows[0].body,undefined);
  assert.equal(diagnostics.status().ready,false);

  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const graph=await build({absWorkingDir:root,entryPoints:{
   galaxy:'packages/galaxy-edge-mcp/src/native-v2-entry.mjs',runtime:'packages/galaxy-edge-mcp/src/native-v2/runtime.mjs',
   server:'packages/galaxy-edge-mcp/src/native-v2/server.mjs',opencode:'integrations/host-adapters/opencode-stable/native-galaxy.tui.ts'},
   outdir:resolve(root,'outputs/native-log-boundary-memory-only'),bundle:true,splitting:true,platform:'node',format:'esm',target:'node22',
   packages:'external',external:['bun:sqlite'],metafile:true,write:false,sourcemap:false});
  const inputs=Object.keys(graph.metafile.inputs).map(path=>path.replaceAll('\\','/'));
  assert(inputs.includes('packages/galaxy-official/src/shared/runtime-logger.mjs'));
  assert(!inputs.some(path=>path.includes('/adapters/http/')||path.endsWith('/operations/runtime-log.mjs')||/\/(database|migrations)\.mjs$/.test(path)));
  const externals=new Set(Object.values(graph.metafile.outputs).flatMap(row=>row.imports.filter(i=>i.external).map(i=>i.path)));
  assert(externals.has('pino'));assert(externals.has('rotating-file-stream'));
 }finally{
  await diagnostics?.close();
  const target=resolve(directory);assert(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-shared-logger-'));
  await rm(target,{recursive:true,force:true});
 }
});
