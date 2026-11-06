import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function loadPlugin(){
 const entry=fileURLToPath(new URL('./native-galaxy-v2.server.ts',import.meta.url));
 const bundle=await build({entryPoints:[entry],bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'fixture-ports',setup(b){
  b.onResolve({filter:/^@opencode\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));
  b.onResolve({filter:/bridge\/host-local-client\.mjs$/},()=>({path:'client',namespace:'fixture'}));
  b.onResolve({filter:/bridge\/native-diagnostics\.mjs$/},()=>({path:'diagnostics',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='plugin'?"export const Plugin={define:x=>x};":path==='client'?"export const createHostLocalClient=()=>globalThis.__galaxyLifecycleClient;":"const d={emit(){},close:async()=>{}};export const hostDiagnostics=()=>d;export const createNativeDiagnostics=async()=>d;export const safeNativeError=()=>({errorCode:'local_work_model_failed'});",loader:'js'}));
 }}]});
 return import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
}
function host(){const hooks=new Map();let notification;return {hooks,get notification(){return notification;},context:{session:{async hook(name,fn){hooks.set(name,fn);return {dispose:async()=>{}};}},rpc:{async register(_contract,handlers){notification=handlers;return {dispose:async()=>{}};}},experimental:{generate:{text:async()=>{throw Error('generation must not start');}}}}};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('closed context cannot inject delayed experience into system',async()=>{
 const search=deferred(),fixture=host();let closed=false;
 globalThis.__galaxyLifecycleClient={history:{experience:{search:()=>search.promise},review:{}},close:async()=>{closed=true;}};
 const {createNativeGalaxyServerPluginV2}=await loadPlugin();const close=await createNativeGalaxyServerPluginV2().setup(fixture.context);
 fixture.hooks.get('prompt')({sessionID:'session',messageID:'user',prompt:{text:'database failure'}});
 const event={sessionID:'session',model:{providerID:'test',id:'model'},system:[]};
 const pending=fixture.hooks.get('context')(event);await turn();await close();assert.equal(closed,true);
 search.resolve({items:[{id:'old'}]});await pending;assert.deepEqual(event.system,[]);delete globalThis.__galaxyLifecycleClient;
});

test('close waits for late ready claim and releases exactly once without model or apply',async()=>{
 const preparing=deferred(),fixture=host();let released=0,applied=0,closed=false;
 globalThis.__galaxyLifecycleClient={history:{experience:{},review:{prepare:()=>preparing.promise,release:async input=>{released++;assert.equal(input.reviewId,'review');},apply:async()=>{applied++;}}},close:async()=>{closed=true;}};
 const {createNativeGalaxyServerPluginV2}=await loadPlugin();const close=await createNativeGalaxyServerPluginV2().setup(fixture.context);
 fixture.hooks.get('prompt')({sessionID:'session',messageID:'user',prompt:{text:''}});
 await fixture.hooks.get('context')({sessionID:'session',model:{providerID:'test',id:'model'},system:[]});
 fixture.hooks.get('experimental.idle')({sessionID:'session',background:[]});
 await fixture.notification.ready({sessionId:'session',galaxyId:'owner',lastUserMessageId:'user'});await turn();
 const closing=close();await turn();assert.equal(closed,false);
 preparing.resolve({status:'ready',reviewId:'review',galaxyId:'owner'});await closing;await turn();
 assert.equal(released,1);assert.equal(applied,0);assert.equal(closed,true);delete globalThis.__galaxyLifecycleClient;
});
