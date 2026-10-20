import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createWebRuntime} from '../src/runtime.mjs';

test('a retired browser identity is never selected, reconnected, or recovered from cached device material',async()=>{
 const endpoint='https://official.example.org',prefix='galaxy-web:'+endpoint+':';
 const legacy={subjectId:'GUID1501M4GF5Z5RCWVJWVVPXDT4CKPZ',deviceId:crypto.randomUUID(),installationId:crypto.randomUUID()},records=new Map([[prefix+'active',legacy],[prefix+'connection:'+legacy.subjectId+':'+legacy.deviceId,{version:1,enabled:true}],[`device:${legacy.subjectId}:${legacy.deviceId}`,{retired:true}]]),reads=[],calls=[];
 const store={get:async key=>{reads.push(key);return structuredClone(records.get(key));},put:async(key,value)=>records.set(key,structuredClone(value)),update:async(key,change)=>{const value=change(structuredClone(records.get(key)));records.set(key,structuredClone(value));return value;}};
 const {publicKey}=generateKeyPairSync('ed25519'),trustedKeys=new Map([['synthetic-pin',{publicKeyPem:publicKey.export({type:'spki',format:'pem'}),notBefore:0,notAfter:4102444800,revoked:false}]]);
 const runtime=await createWebRuntime({endpoint,trustedKeys},{store,website:'https://galaxy.example.org',fetch:async(...args)=>{calls.push(args);throw Error('Unexpected identity network request');}});
 try{assert.equal((await runtime.status()).identity,null);assert.equal(await runtime.resumeConnection(),null);await assert.rejects(runtime.connect({confirmed:true}));await assert.rejects(runtime.createIdentity({confirmed:true}),error=>error.code==='local_galaxy_required');
  assert.equal('recover'in runtime,false);assert.equal('pendingRecoveryCode'in runtime,false);assert.deepEqual(records.get(prefix+'active'),legacy);assert.equal(reads.some(key=>key.startsWith('device:')||key.startsWith(prefix+'connection:')),false);assert.equal(calls.length,0);
 }finally{runtime.close();}
});
