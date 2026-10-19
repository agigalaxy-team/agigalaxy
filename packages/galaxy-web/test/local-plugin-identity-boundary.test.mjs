import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createWebRuntime} from '../src/runtime.mjs';

const endpoint='https://official.example.org';
const prefix=`galaxy-web:${endpoint}:`;
const server=generateKeyPairSync('ed25519');
const config={endpoint,trustedKeys:new Map([['boundary-test',{publicKeyPem:server.publicKey.export({type:'spki',format:'pem'}),notBefore:0,notAfter:4102444800,revoked:false}]])};

async function fixture(t,seed=[]){
 const rows=new Map(seed),writes=[],requests=[];
 const store={get:async key=>structuredClone(rows.get(key)),put:async(key,value)=>{writes.push(key);rows.set(key,structuredClone(value));},
  update:async(key,change)=>{writes.push(key);const value=change(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);}};
 const runtime=await createWebRuntime(config,{store,fetch:async(...args)=>{requests.push(args);throw Error('Boundary test must not contact a service.');}});
 t.after(()=>runtime.close());return{runtime,rows,writes,requests};
}

test('a webpage cannot mint a Galaxy ID, even when an old caller supplies confirmation',async t=>{
 const f=await fixture(t);
 for(const options of [undefined,{confirmed:true},{confirmed:false}])await assert.rejects(f.runtime.createIdentity(options),{code:'local_galaxy_required'});
 assert.equal((await f.runtime.status()).identity,null);
 assert.deepEqual(f.writes,[]);assert.deepEqual(f.requests,[]);assert.equal(f.rows.size,0);
});

test('an old pending browser bootstrap is preserved without signing or retrying it as a new creation',async t=>{
 const pending={subjectId:'GUID1500000000000000000000000000',deviceId:'saved-device',operationId:'saved-operation',owner:null};
 const seed=[[prefix+'new-identity',pending],['visitor-draft',{title:'未完成的原稿'}]],f=await fixture(t,seed);
 await assert.rejects(f.runtime.createIdentity({confirmed:true}),{code:'local_galaxy_required'});
 assert.deepEqual([...f.rows],seed);assert.deepEqual(f.writes,[]);assert.deepEqual(f.requests,[]);
});

test('existing identity and draft records remain available without implying local plugin contact',async t=>{
 const active={subjectId:'GUID1500000000000000000000000000',deviceId:'saved-device',installationId:'saved-installation'},draft={title:'继续原来的事情'};
 const seed=[[prefix+'active',active],['visitor-draft',draft]],f=await fixture(t,seed),result=await f.runtime.createIdentity({confirmed:true});
 assert.deepEqual(result.identity,{subjectId:active.subjectId,deviceId:active.deviceId});assert.equal(result.connection,null);
 assert.equal(Object.hasOwn(result,'localPluginConnected'),false);
 assert.deepEqual([...f.rows],seed);assert.deepEqual(f.writes,[]);assert.deepEqual(f.requests,[]);
});
