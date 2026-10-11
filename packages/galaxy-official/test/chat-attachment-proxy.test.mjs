import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createAttachmentPrivateProxy} from './chat-attachment-private-proxy.mjs';
import {createAttachmentProxyConfiguration} from './chat-attachment-proxy-client.mjs';
import {defaultAttachmentPolicy} from '../src/shared/chat-attachments-schema.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-attachment-proxy-test-')),objects=new Map(),calls=[],
  namespace=randomUUID(),token=randomBytes(32).toString('hex'),secretFile=join(directory,'proxy.key');
 await writeFile(secretFile,token);
 const storage={policy:defaultAttachmentPolicy,store:{bucket:'explicit-contract-only',keyId:'contract-key',
  async head({key}){calls.push(['head',key]);const value=objects.get(key);return value?{size:value.length,sha256:hash(value)}:null;},
  async put({key,bytes}){calls.push(['put',key]);objects.set(key,Buffer.from(bytes));},
  async get({key}){calls.push(['get',key]);return objects.get(key)??null;},
  async erase({key}){calls.push(['erase',key]);objects.delete(key);},close(){}},
  scanner:{async scan(bytes){calls.push(['scan',hash(bytes)]);return{state:'clean',engine:'explicit-proxy-contract',guaranteedSafe:false};}}};
 const proxy=await createAttachmentPrivateProxy({storage,directory,namespace,token}),endpoint='http://127.0.0.1:'+proxy.port;
 const adapter=await createAttachmentProxyConfiguration({endpoint,secretFile,namespace});
 async function call(path,value,{authorization='Bearer '+token,binary=null,headers={}}={}){
  return fetch(endpoint+path,{method:'POST',headers:{authorization,'content-type':binary?'application/octet-stream':'application/json',...headers},
   body:binary??JSON.stringify(value)});
 }
 async function close(){
  await proxy.close({cleanupObjects:true});
  if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('galaxy-attachment-proxy-test-'))throw Error('unsafe-test-directory');
  await rm(directory,{recursive:true});
 }
 return{directory,namespace,objects,calls,storage,proxy,adapter,call,close};
}
test('SSH-loopback adapter carries exact synthetic bytes and only mapped run objects',async()=>{
 const f=await fixture(),key='attachments/'+randomUUID(),bytes=Buffer.from('[Synthetic local] ordinary chat file.\n'),sha256=hash(bytes);
 try{
  await f.adapter.store.put({key,bytes,sha256});
  assert.equal(f.objects.size,1);assert.ok(!f.objects.has(key),'caller key is never a production object key');
  assert.deepEqual(await f.adapter.store.head({key,keyId:f.adapter.store.keyId}),{size:bytes.length,sha256});
  assert.deepEqual(await f.adapter.store.get({key,keyId:f.adapter.store.keyId,size:bytes.length}),bytes);
  assert.equal((await f.adapter.scanner.scan(bytes)).engine,'explicit-proxy-contract');
  await f.adapter.store.erase({key});assert.equal(f.objects.size,0);
  const verify=await f.proxy.verify();assert.equal(verify.counts.put,1);assert.equal(verify.counts.scan,1);assert.equal(verify.counts.erase,1);
  assert.equal(verify.credentialsReturned,false);
 }finally{await f.close();}
});
test('authorization, unknown routes, bad namespace and non-loopback endpoint fail closed',async()=>{
 const f=await fixture();
 try{
  assert.equal((await f.call('/store/head',{key:'attachments/'+randomUUID(),keyId:f.adapter.store.keyId},{authorization:'Bearer wrong'})).status,401);
  assert.equal((await f.call('/unexpected',{})).status,404);
  assert.equal((await f.call('/configuration',{namespace:randomUUID()})).status,400);
  assert.equal(f.calls.length,0);
  await assert.rejects(createAttachmentProxyConfiguration({endpoint:'http://example.test',secretFile:'not-read',namespace:f.namespace}),/loopback_required/);
 }finally{await f.close();}
});
test('a production-shaped caller key cannot read or erase its unmapped object',async()=>{
 const f=await fixture(),key='attachments/'+randomUUID(),unrelated=Buffer.from('unrelated object'),bytes=Buffer.from('isolated file');
 f.objects.set(key,unrelated);
 try{
  assert.equal(await f.adapter.store.head({key,keyId:f.adapter.store.keyId}),null);
  assert.equal(await f.adapter.store.get({key,keyId:f.adapter.store.keyId,size:unrelated.length}),null);
  await f.adapter.store.erase({key});assert.deepEqual(f.objects.get(key),unrelated);assert.equal(f.calls.length,0);
  await f.adapter.store.put({key,bytes,sha256:hash(bytes)});
  const result=await (await f.call('/cleanup',{namespace:f.namespace})).json();
  assert.equal(result.pending,0);assert.equal(result.erased,1);assert.equal(f.objects.size,1);assert.deepEqual(f.objects.get(key),unrelated);
 }finally{await f.close();}
});
test('digest, size and scan scope validation precede private adapter work',async()=>{
 const f=await fixture(),bytes=Buffer.from('test'),key='attachments/'+randomUUID();
 try{
  const invalid=await f.call('/store/put',null,{binary:bytes,headers:{'x-galaxy-object-key':key,'x-galaxy-sha256':'0'.repeat(64)}});
  assert.equal(invalid.status,400);
  assert.equal((await f.call('/scan',null,{binary:bytes,headers:{'x-galaxy-sha256':hash(bytes)}})).status,403);assert.equal(f.calls.length,0);
  await f.adapter.store.put({key,bytes,sha256:hash(bytes)});
  await assert.rejects(f.adapter.store.get({key,keyId:f.adapter.store.keyId,size:999}),/size_mismatch/);
  assert.equal(f.calls.filter(([kind])=>kind==='get').length,0);
  const changed=await f.call('/store/put',null,{binary:Buffer.from('other'),headers:{'x-galaxy-object-key':key,'x-galaxy-sha256':hash('other')}});
  assert.equal(changed.status,409);assert.equal(f.calls.filter(([kind])=>kind==='put').length,1);
 }finally{await f.close();}
});
test('cleanup preserves a changed mapped object and does not enumerate a bucket',async()=>{
 const f=await fixture(),key='attachments/'+randomUUID(),bytes=Buffer.from('original'),other=Buffer.from('changed elsewhere');
 try{
  await f.adapter.store.put({key,bytes,sha256:hash(bytes)});const mapped=[...f.objects.keys()][0];f.objects.set(mapped,other);
  const result=await(await f.call('/cleanup',{namespace:f.namespace})).json();
  assert.equal(result.pending,1);assert.equal(result.failures[0].code,'isolated_attachment_proxy_object_changed');
  assert.equal(f.calls.filter(([kind])=>kind==='erase').length,0);assert.deepEqual(f.objects.get(mapped),other);
  f.objects.set(mapped,bytes);
 }finally{await f.close();}
});
test('durable run ledger rejects another namespace and preserves an unknown put acknowledgement',async()=>{
 const f=await fixture(),key='attachments/'+randomUUID(),bytes=Buffer.from('committed but unknown'),original=f.storage.store.put.bind(f.storage.store);
 try{
  f.storage.store.put=async input=>{await original(input);throw Object.assign(new Error('lost storage acknowledgement'),{code:'attachment_storage_unavailable',status:503});};
  await assert.rejects(f.adapter.store.put({key,bytes,sha256:hash(bytes)}),/storage_unavailable/);
  assert.equal(f.objects.size,1);
  f.storage.store.put=original;
  await f.adapter.store.put({key,bytes,sha256:hash(bytes)});assert.equal(f.objects.size,1);
  const ledger=JSON.parse(await readFile(join(f.directory,'objects.json'),'utf8'));assert.equal(ledger.items.length,1);assert.equal(ledger.items[0].stored,true);
  await assert.rejects(createAttachmentPrivateProxy({storage:f.storage,directory:f.directory,namespace:randomUUID(),token:randomBytes(32).toString('hex')}),/ledger_mismatch/);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory,'objects.json'),'utf8')),ledger);
 }finally{await f.close();}
});
