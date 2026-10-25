import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeA2aSchema,createConfiguredNativeA2a} from '../src/native-v2/adapters/a2a.mjs';

test('peer configuration keeps credential selection explicit and startup reads no environment or identity',()=>{
 const peer={id:'reviewed',endpoint:'https://peer.example/a2a',peerPrincipal:'selected-agent',agentCard:{},cardHash:'a'.repeat(64),trustExpiresAt:Date.now()+60000};
 const authentication={mode:'bearer-environment',variable:'GALAXY_A2A_PEER_REVIEWED_TOKEN'};
 const trap=new Proxy({}, {get(){throw new Error('Must remain lazy until an actual operation');}});
 const host=createConfiguredNativeA2a({runtime:trap,directory:'/synthetic-local-path',configuration:{peers:[{...peer,authentication}]},environment:trap});
 assert.equal(host.peers()[0].id,'reviewed');
 assert.throws(()=>nativeA2aSchema.parse({peers:[{...peer,credential:'forbidden-inline'}]}));
 assert.throws(()=>nativeA2aSchema.parse({peers:[{...peer,authentication:{...authentication,variable:'GALAXY_OFFICIAL_TOKEN'}}]}));
 assert.throws(()=>nativeA2aSchema.parse({peers:[peer,peer]}));
});
