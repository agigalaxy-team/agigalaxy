import test from 'node:test';
import assert from 'node:assert/strict';
import {identityTransferLink,readIdentityTransfer} from '../src/identity-transfer.mjs';

const subjectId='GUID1501M4GF5Z5RCWVJWVVPXDT4CKPZ';
const request={version:1,type:'galaxy-device-request',subjectId,endpoint:'http://127.0.0.1:5208',deviceId:'synthetic-device',operationId:'synthetic-operation',publicKeyPem:'PUBLIC TEST VALUE',scopes:['binding'],label:'我的第二台设备'};
const invalid=fn=>assert.throws(fn,{code:'device_transfer_invalid'});

test('device links preserve the original public transfer and support the existing JSON fallback',()=>{
 const identity={kind:'identity',subjectId};
 assert.deepEqual(readIdentityTransfer(identityTransferLink('https://galaxy.example/app',identity)),identity);
 assert.deepEqual(readIdentityTransfer(subjectId),identity);
 for(const packet of [request,{version:1,type:'galaxy-device-approval',offer:request,challenge:'original challenge',controllerSignature:'synthetic public signature'}]){
  const expected={kind:packet===request?'request':'approval',value:packet};
  assert.deepEqual(readIdentityTransfer(identityTransferLink('https://galaxy.example',packet)),expected);
  assert.deepEqual(readIdentityTransfer(JSON.stringify(packet)),expected);
 }
});

test('a copied website link cannot replace the packet API destination or add authorization',()=>{
 const link=new URL(identityTransferLink('https://other-browser.example',request));
 link.searchParams.set('endpoint','https://untrusted.example');
 const parsed=readIdentityTransfer(link.href);
 assert.deepEqual(parsed,{kind:'request',value:request});
 assert.equal(parsed.value.endpoint,request.endpoint);
 // This reader only decodes transport. The existing handoff must validate the
 // exact schema, pinned endpoint, signatures, current control and original offer.
});

test('malformed links and private recovery material are rejected before preview',()=>{
 const link=identityTransferLink('https://galaxy.example',request);
 for(const input of ['javascript:alert(1)',link.replace('/app/settings/identity','/app/other'),link+'&device=another',link.replace('#device=','#device=%%%'),JSON.stringify({...request,privateKey:'-----BEGIN PRIVATE KEY-----'}),JSON.stringify({...request,recovery:'galaxy-recovery-v1:synthetic'}),'x'.repeat(48001)])invalid(()=>readIdentityTransfer(input));
 invalid(()=>identityTransferLink('https://user:password@galaxy.example',request));
 invalid(()=>identityTransferLink('file:///tmp/',request));
 invalid(()=>identityTransferLink('https://galaxy.example',{...request,privateKey:'-----BEGIN PRIVATE KEY-----'}));
});
