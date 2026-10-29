import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCapsuleVisibilityClient} from '../src/features/capsules/capsule-visibility-client.mjs';

test('accepted capsule withdrawal with a lost ACK reconciles the exact original consent without a second write',async()=>{
 const endpoint='https://official.example.invalid',subjectId='GUID'+'A'.repeat(28),target={type:'use',operationId:randomUUID(),consentId:randomUUID(),payloadHash:'a'.repeat(64)},store=new Map(),calls=[];
 const intent={subjectId,endpoint,recipient:endpoint,objectId:target.operationId,payloadHash:target.payloadHash,action:'capsule.use',visibility:'Public',viewers:[],expiresAt:2000003600};let status='active',lose=true;
 const api={endpoint,snapshot:()=>({subjectId,bindingId:'binding-1',generation:1}),call:async(path,input)=>{calls.push(path);if(path==='/v2/consents/receipt')return{state:'recorded',consentId:target.consentId,status,intent};if(path==='/v2/capsules/receipt')return{state:'acknowledged',operationId:target.operationId,consentId:target.consentId,payloadHash:target.payloadHash};if(path===`/v1/consents/${target.consentId}/revoke`){status='revoked';if(lose){lose=false;throw Error('synthetic lost revoke ACK');}return{};}throw Error(`unexpected ${path}`);}};
 const make=()=>createCapsuleVisibilityClient({api,subjectId,now:()=>2000000000,getLocal:async key=>structuredClone(store.get(key)),putLocal:async(key,value)=>store.set(key,structuredClone(value))});
 let client=make();const preview=await client.prepare(target);await assert.rejects(client.execute(preview,{confirmed:true}),/lost revoke ACK/);const journal=[...store.values()][0];assert.equal(journal[0].target.consentId,target.consentId);assert.equal(journal[0].state,'result-unknown');
 client=make();const result=await client.reconcile(target.consentId);assert.equal(result.state,'revoked');assert.equal(result.externalCopiesErased,false);assert.equal(calls.filter(path=>path.endsWith('/revoke')).length,1);
 const wrong=await client.prepare({...target,operationId:randomUUID()}).then(()=>null,error=>error);assert.match(wrong.message,/精确对象授权|原对象授权/);
});
