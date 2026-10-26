import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {createNativeRuntime} from '../src/native-v2/runtime.mjs';
import {createNativeStore} from '../src/native-v2/store.mjs';

async function cleanup(directory){const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-native-selection-'));await rm(target,{recursive:true,force:true});}

test('two real Node processes commit one atomic Native connection record without losing either change',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-native-selection-lock-')),endpoint='https://selected.invalid',store=createNativeStore(directory);
 try{
  const owner={subjectId:'GUID'+'A'.repeat(28),deviceId:randomUUID()};await store.updateConnection(endpoint,()=>({active:owner,permission:{enabled:true,count:0}}));
  const childFile=join(directory,'writer.mjs');await writeFile(childFile,`import {createNativeStore} from ${JSON.stringify(new URL('../src/native-v2/store.mjs',import.meta.url).href)};
const store=createNativeStore(process.argv[2]);for(let n=0;n<5;n++)await store.updateConnection(process.argv[3],row=>({active:row.active,permission:{...row.permission,count:row.permission.count+1}}));`);
  const run=()=>new Promise((done,reject)=>{let error='';const child=spawn(process.execPath,[childFile,directory,endpoint],{stdio:['ignore','ignore','pipe'],windowsHide:true,shell:false});
   child.stderr.on('data',bytes=>{error+=bytes.toString();});child.once('error',reject);child.once('exit',code=>{if(code===0)done();else reject(Error('atomic Native writer exited '+code+': '+error));});});
  await Promise.all([run(),run()]);const current=await store.readConnection(endpoint);assert.equal(current.revision,11);assert.equal(current.permission.count,10);assert.deepEqual(current.active,owner);
  assert.deepEqual(await store.get('native-active:'+endpoint),owner);assert.equal((await store.get('native-connection:'+endpoint)).count,10);
 }finally{await cleanup(directory);}
});

test('cold Native runtime uses saved scopes, does not overwrite selection, and rejects a result held across disconnect/reconnect',{timeout:60000},async()=>{
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-native-selection-runtime-'));
 let server,first,second,foreign,otherService,hold=false,entered,release;
 const calls=[],arrived=new Promise(resolve=>{entered=resolve;});
 try{
  server=createApi({...f,rateLimit:1000});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
  const fetcher=async(url,options)=>{assert.equal(new URL(url).origin,f.bindings.endpoint);const response=await fetch(local+new URL(url).pathname,options);calls.push({path:new URL(url).pathname,status:response.status});
   if(hold){hold=false;entered();await new Promise(resolve=>{release=resolve;});}return response;};
  const options={dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,fetch:fetcher,openBrowser:async()=>({launched:false})};
  first=await createNativeRuntime(options);await first.initialize({profile:'minimal'},{confirmed:true});await first.connect({confirmed:true});const subjectId=(await first.status()).identity;
  const savedScopes=['binding','consent','assistance'];await first.store.updateConnection(options.endpoint,row=>({active:row.active,permission:{...row.permission,scopes:savedScopes}}));
  const selected=await first.store.readConnection(options.endpoint);second=await createNativeRuntime(options);
  const resumedStatus=await second.status({restoreSelected:true});assert.equal(resumedStatus.connected,true);assert.deepEqual(resumedStatus.connection.scopes,savedScopes);
  await Promise.all([second.ensureConnection(),second.ensureConnection()]);await second.ensureConnection();assert.deepEqual((await second.status()).connection.scopes,savedScopes);
  assert.deepEqual(await second.store.readConnection(options.endpoint),selected,'Cold reads/reconnects do not replace the shared choice or expand scopes.');
  const oldSession=await second.helpFlow.start({localTaskRef:'synthetic-original-unsent-work',caseId:null,taskId:null});assert.equal((await second.helpFlow.get(oldSession.id)).id,oldSession.id);
  hold=true;const old=second.api.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false});await arrived;
  await first.disconnect();await first.connect({confirmed:true});release();await assert.rejects(old,/native_connection_selection_changed/);
  await second.ensureConnection();assert.equal((await second.status()).identity,subjectId);
  await first.disconnect();await assert.rejects(second.ensureConnection(),/native_connection_choice_required/);const beforeStopped=calls.length;assert.equal((await second.status({restoreSelected:true})).connected,false);assert.equal(calls.length,beforeStopped,'A stopped saved connection is not resumed by normal status.');
  const before=calls.length;otherService=await createNativeRuntime({...options,endpoint:'https://other.invalid'});
  await assert.rejects(otherService.helpFlow.get(oldSession.id),/help_session_not_found/);assert.equal(calls.length,before,'An old Help locator cannot send or read from another selected service.');
  foreign=await createNativeRuntime({...options,dataDirectory:join(directory,'other-owner')});await foreign.initialize({profile:'minimal'},{confirmed:true});await foreign.connect({confirmed:true});
  const foreignSelection=await foreign.store.readConnection(options.endpoint);await first.store.updateConnection(options.endpoint,()=>({active:foreignSelection.active,permission:foreignSelection.permission}));
  const beforeForeign=calls.length;await assert.rejects(second.helpFlow.get(oldSession.id),/help_session_not_found/);assert.equal(calls.length,beforeForeign,'An old Help locator is not authorization for another current owner.');
  assert.notEqual((await second.status()).identity,subjectId);
  // The original owner-scoped journal remains a historical record, not a new
  // operation silently rebound to the foreign device or service.
  const scope=createHash('sha256').update(JSON.stringify([options.endpoint,subjectId])).digest('hex');
  const original=JSON.parse(await readFile(join(directory,'help-v2',scope,oldSession.id+'.json'),'utf8'));assert.equal(original.subjectId,subjectId);assert.equal(original.endpoint,options.endpoint);
 }finally{release?.();await first?.close();await second?.close();await foreign?.close();await otherService?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));await f.db.close();await cleanup(directory);}
});
