import {nativeData} from './native-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {createNativeToolServer} from '../src/native-v2/server.mjs';
import {startNativeStdio} from '../src/native-v2/stdio.mjs';
import {createNativeWatch} from '../src/native-v2/watch.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const publicConfiguration=directory=>{const now=Math.floor(Date.now()/1000),key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});return{version:2,endpoint:'https://not-connected.example',website:'https://example.org',dataDirectory:join(directory,'data'),trustedKeys:{isolated:{publicKeyPem:key,notBefore:now-10,notAfter:now+1000,revoked:false}}};};
function wire(){
 const pending=new Map();let sequence=0,closes=0;
 return{async start(){},async close(){if(closes++)return;this.onclose?.();},get closes(){return closes;},
  async send(message){const item=pending.get(message.id);if(item){pending.delete(message.id);item.resolve(message);}},
  call(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(id);reject(Error('native test response timeout: '+method+' '+(params.name??'')));},3000);pending.set(id,{resolve:message=>{clearTimeout(timeout);resolve(message);}});this.onmessage({jsonrpc:'2.0',id,method,params});});},
  notify(method,params){this.onmessage({jsonrpc:'2.0',method,...(params?{params}:{})});}};
}
async function initialize(transport){await transport.call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'isolated-lifecycle-test',version:'1'}});transport.notify('notifications/initialized');}
function memory(){const values=new Map();return{get:async key=>structuredClone(values.get(key)),put:async(key,value)=>values.set(key,structuredClone(value)),update:async(key,change)=>{values.set(key,structuredClone(change(structuredClone(values.get(key)))));}};}

test('actual stdio entry close is shared, removes signal handlers and closes an unopened transport',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-entry-close-'));
 const before=['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal));
 try{
  const configPath=join(directory,'config.json');await writeFile(configPath,JSON.stringify(publicConfiguration(directory)));
  const transport=wire(),entry=await startNativeStdio({configPath,transport});
  const first=entry.close(),second=entry.close();assert.equal(first,second);await first;
  assert.equal(transport.closes,1);assert.deepEqual(['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal)),before);
  await entry.close();
 }finally{await rm(directory,{recursive:true,force:true});}
});

for(const signal of ['SIGINT','SIGTERM'])test('actual stdio entry '+signal+' signal dispatch cleans a negotiated server',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-entry-signal-'));
 const before=['SIGINT','SIGTERM'].map(name=>process.listenerCount(name));
 try{
  const configPath=join(directory,'config.json');await writeFile(configPath,JSON.stringify(publicConfiguration(directory)));
  const transport=wire(),entry=await startNativeStdio({configPath,transport});await initialize(transport);
  const list=await transport.call('tools/list');assert.ok(list.result.tools.some(tool=>tool.name==='galaxy_watch_resume'));
  process.emit(signal);await entry.close();
  assert.equal(transport.closes,1);assert.deepEqual(['SIGINT','SIGTERM'].map(name=>process.listenerCount(name)),before);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('native product waits for in-flight work, rejects new tools and releases the review port',async()=>{
 const store=memory();let release,entered;
 const began=new Promise(resolve=>{entered=resolve;});
 const runtime={website:'https://example.org',store,now:()=>1000,api:{endpoint:'https://example.org',snapshot:()=>null,call:async()=>({})},
  status:async()=>({identity:null}),navigation:{open:async()=>({})},helpFlow:{start:async()=>{entered();return new Promise(resolve=>{release=resolve;});}}};
 const server=createNativeToolServer(runtime),transport=wire();await server.connect(transport);await initialize(transport);
 try{
  const review=await transport.call('tools/call',{name:'galaxy_native_initialize',arguments:{profile:'minimal'}});
  const url=nativeData(review.result).url;assert.equal((await fetch(url)).status,200);
  // Every registered plugin tool is also drained, not just the native wrapper.
  const operation=transport.call('tools/call',{name:'galaxy_help_start',arguments:{localTaskRef:'lifecycle-work'}});await began;
  let ended=false;const first=server.close(),observedClose=first.then(()=>{ended=true;});assert.equal(first,server.close());await turn();assert.equal(ended,false);
  const late=await transport.call('tools/call',{name:'galaxy_native_status',arguments:{}});assert.equal(nativeData(late.result).error,'native_runtime_closed');
  release({state:'draft',sent:false});await operation;await observedClose;
  await assert.rejects(fetch(url));assert.equal(transport.closes,1);
 }finally{release?.({});await server.close();}
});

test('native user choices cannot execute after identity/binding changes while review is pending',async()=>{
 const store=memory();let subjectId='GUID'+'A'.repeat(28),bindingId='original-binding',generation=1,executions=0,reviewRequest,entered;
 const reviewStarted=new Promise(resolve=>{entered=resolve;});
 const runtime={website:'https://example.org',store,now:()=>1000,status:async()=>({identity:subjectId}),navigation:{open:async()=>({})},helpFlow:{start:async()=>({})},
  initialize:async()=>{executions++;return{localOnly:true};},api:{endpoint:'https://example.org',snapshot:()=>({subjectId,bindingId,generation}),call:async()=>({})}};
 const server=createNativeToolServer(runtime),transport=wire(),send=transport.send.bind(transport);
 transport.send=async message=>{if(message.method==='elicitation/create'){reviewRequest=message;entered();return;}return send(message);};
 await server.connect(transport);await transport.call('initialize',{protocolVersion:'2025-11-25',capabilities:{elicitation:{form:{}}},clientInfo:{name:'isolated-choice-binding-test',version:'1'}});transport.notify('notifications/initialized');
 try{
  const call=transport.call('tools/call',{name:'galaxy_native_initialize',arguments:{profile:'minimal'}});await reviewStarted;
  assert.match(reviewRequest.params.message,/创建本机身份/);assert.equal(reviewRequest.params.message.includes(subjectId),false);subjectId='GUID'+'B'.repeat(28);bindingId='replacement-binding';generation++;
  transport.onmessage({jsonrpc:'2.0',id:reviewRequest.id,result:{action:'accept',content:{confirm:true}}});
  const result=nativeData((await call).result);assert.equal(result.error,'native_choice_binding_changed');assert.equal(executions,0);
 }finally{await server.close();}
});

test('native private local notes are withheld if identity changes while storage is reading',async()=>{
 const store=memory(),subjectA='GUID'+'A'.repeat(28),subjectB='GUID'+'B'.repeat(28),roomId=randomUUID(),summaryId=randomUUID();let subjectId=subjectA,release,entered;
 const began=new Promise(resolve=>{entered=resolve;});
 const record={summaryId,roomId,endpoint:'https://example.org',localRevision:1,content:{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:true},
  fragments:[{id:randomUUID(),kind:'personal-note',text:'isolated owner A local private note',sourceRefs:[]}],keyMessageRefs:[]},conflicts:[]};
 await store.put('personal-summary:'+subjectA,{schemaVersion:1,subjectId:subjectA,preference:{state:'unset'},summaries:{[summaryId]:record},queue:[]});
 store.read=async key=>{const captured=await store.get(key);entered();await new Promise(resolve=>{release=resolve;});return captured;};
 const runtime={website:'https://example.org',store,now:()=>1000,status:async()=>({identity:subjectId}),navigation:{open:async()=>({})},helpFlow:{start:async()=>({})},
  api:{endpoint:'https://example.org',snapshot:()=>null,call:async()=>({})}};
 const server=createNativeToolServer(runtime),transport=wire();await server.connect(transport);await initialize(transport);
 try{
  const reading=transport.call('tools/call',{name:'galaxy_summary_local_get',arguments:{summaryId}});await began;subjectId=subjectB;release();
  const result=(await reading).result;assert.equal(nativeData(result).error,'native_identity_changed');
  assert.equal(JSON.stringify(result).includes(record.content.fragments[0].text),false);
 }finally{release?.();await server.close();}
});

test('shutdown during an authorized Watch start preserves its record without activating a late runtime',async()=>{
 const store=memory(),read=store.get;let release,entered;
 const began=new Promise(resolve=>{entered=resolve;});const roomId=randomUUID(),agentGrantId=randomUUID(),subjectId='GUID'+'A'.repeat(28);
 store.get=async key=>key.startsWith('native-exact-choice:')?{hash:key.split(':').at(-1),expires:Date.now()+10000}:read(key);
 const runtime={website:'https://example.org',store,now:()=>1000,status:async()=>({identity:subjectId}),navigation:{open:async()=>({})},helpFlow:{start:async()=>({})},
  api:{endpoint:'https://example.org',snapshot:()=>({bindingId:'binding'}),call:async()=>{entered();return new Promise(resolve=>{release=resolve;});}}};
 const server=createNativeToolServer(runtime),transport=wire();await server.connect(transport);await initialize(transport);
 const starting=transport.call('tools/call',{name:'galaxy_watch_start',arguments:{roomId,agentGrantId,purpose:'diagnosis',expiresAt:5000}});await began;
 const closing=server.close();release({items:[{grantId:agentGrantId,state:'active',bindingId:'binding',expiresAt:10000}]});
 const result=nativeData((await starting).result);await closing;
 assert.equal(result.items[0].state,'active');assert.equal(result.hostRuntimeState,'suspended-host');
 const record=await read('native-watch:https://example.org:'+subjectId);assert.ok(record.watches[result.items[0].id]);
});

function watchFixture(){
 const roomId=randomUUID(),oldGrant=randomUUID(),newGrant=randomUUID(),store=memory();let grants,hold;
 grants=[{grantId:oldGrant,state:'active',bindingId:'binding',expiresAt:10000}];
 const api={endpoint:'https://example.org',snapshot:()=>({bindingId:'binding'}),call:async(path,input)=>{
  if(path.endsWith('/agent-revoke'))return{revoked:true};
  if(path.endsWith('/agent-grants'))return hold?hold(input):{items:grants};
  if(path.endsWith('/history'))return{messages:[],scannedThrough:'5',complete:true};
  throw Error('unexpected_watch_request');}};
 return{roomId,oldGrant,newGrant,store,watch:createNativeWatch({store,api,subjectId:'owner',now:()=>1000}),setGrants:value=>{grants=value;},setHold:value=>{hold=value;}};
}
test('pause persists revoke; failed resume preserves original scope; fresh resume keeps cursor',async()=>{
 const f=watchFixture();const started=await f.watch.start({roomId:f.roomId,agentGrantId:f.oldGrant,purpose:'diagnosis',expiresAt:5000},{confirmed:true});const id=started.items[0].id;
 await f.watch.check(id);assert.equal((await f.watch.pause(id)).remoteGrantRevoked,true);
 const paused=(await f.watch.status(id)).items[0];assert.equal(paused.stopAuthorization.state,'revoked');assert.equal(paused.after,'5');
 await assert.rejects(f.watch.resume({id,agentGrantId:f.oldGrant,expiresAt:5000},{confirmed:true}),/watch_new_agent_grant_required/);
 await assert.rejects(f.watch.resume({id,agentGrantId:f.newGrant,expiresAt:5000},{confirmed:true}),/watch_current_binding_grant_required/);
 assert.deepEqual((await f.watch.status(id)).items[0],paused);
 f.setGrants([{grantId:f.newGrant,state:'active',bindingId:'binding',expiresAt:10000}]);
 const resumed=(await f.watch.resume({id,agentGrantId:f.newGrant,expiresAt:5000},{confirmed:true})).items[0];assert.equal(resumed.state,'active');assert.equal(resumed.after,'5');
});
test('resume cannot reactivate a watch stopped while new grant is being read',async()=>{
 const f=watchFixture();const id=(await f.watch.start({roomId:f.roomId,agentGrantId:f.oldGrant,purpose:'diagnosis',expiresAt:5000},{confirmed:true})).items[0].id;await f.watch.pause(id);
 let release;f.setHold(()=>new Promise(resolve=>{release=resolve;}));
 const resuming=f.watch.resume({id,agentGrantId:f.newGrant,expiresAt:5000},{confirmed:true});await turn();await f.watch.stop(id);
 release({items:[{grantId:f.newGrant,state:'active',bindingId:'binding',expiresAt:10000}]});await assert.rejects(resuming,/watch_resume_changed/);
 assert.equal((await f.watch.status(id)).items[0].state,'stopped');
});
