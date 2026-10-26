import test from 'node:test';
import assert from 'node:assert/strict';
import { sdkPeer } from '../../galaxy-a2a/test/sdk-peer.mjs';
import { observeBuilderEndpoint } from "../src/builders/builder-probe-observer.mjs";

test('SDK read-only probe observes exact A2A interface without dispatch, credentials, redirects or task contents',async()=>{
  const peer=await sdkPeer(),now=2000000000;
  const target={protocol:'a2a/1.0',transport:'JSONRPC',endpoint:peer.endpoint,cardUrl:'https://peer.example.org/.well-known/agent-card.json',tenant:'fixture'};
  try{
    const observe=(changes={},transport={})=>observeBuilderEndpoint({...target,...changes},{get:url=>peer.get(url),post:(url,args)=>peer.post(url,args),now:()=>now,...transport});
    const result=await observe();assert.equal(result.status,'reachable');assert.equal(result.reason,'task-not-found-response');
    assert.equal(result.endpointReachable,true);assert.equal(result.protocolResponded,true);assert.equal(result.validUntil,now+300);assert.equal(result.capabilityVerified,false);
    assert.equal(peer.requests.length,1);assert.equal(peer.requests[0].body.method,'GetTask');assert.equal(peer.requests[0].authorization,undefined);
    assert.equal(peer.requests[0].version,'1.0');assert.equal(peer.requests[0].body.params.tenant,'fixture');
    assert.equal(JSON.stringify(result).includes(peer.requests[0].body.params.id),false);
    assert.equal((await observe({tenant:'different'})).status,'protocol-mismatch');assert.equal(peer.requests.length,1);
    const denied=()=>{const error=new Error('Fixture auth boundary');error.code='GALAXY_REMOTE_REJECTED';throw error;};
    const privateRpc=await observe({}, {post:denied});assert.equal(privateRpc.status,'authentication-required');assert.equal(privateRpc.endpointReachable,true);
    const privateCard=await observe({}, {get:denied});assert.equal(privateCard.status,'authentication-required');assert.equal(privateCard.endpointReachable,null);
    const offline=await observe({}, {post:()=>{throw new Error('Fixture offline');}});assert.equal(offline.status,'unavailable');assert.equal(offline.endpointReachable,false);
    for(const endpoint of ['https://127.0.0.1/a2a','https://169.254.169.254/a2a','https://[::1]/a2a','https://peer.example.org:8443/a2a','https://user:pass@peer.example.org/a2a'])
      await assert.rejects(observe({endpoint}),/Unsafe/);
  }finally{await peer.close();}
});
