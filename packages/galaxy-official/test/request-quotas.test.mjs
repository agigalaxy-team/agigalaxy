import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from '../src/http.mjs';
import { ServiceError } from '../src/shared/service-error.mjs';
import { createRequestQuotas,defaultRequestQuotaPolicy,requestQuotaCategory } from '../src/adapters/http/request-quotas.mjs';
import { verifyRequestQuotaWorkflow } from './request-quota-workflow.mjs';

test('request categories separate revocation, anonymous metadata, notifications, binding and exports',()=>{
  assert.equal(requestQuotaCategory('POST','/v1/bindings/'+randomUUID()+'/revoke',true),'revocation');
  assert.equal(requestQuotaCategory('POST','/v1/deletion-requests/submit',true),'revocation');
  assert.equal(requestQuotaCategory('POST','/v1/sessions'),'binding');
  assert.equal(requestQuotaCategory('POST','/v1/data-exports/page',true),'export');
  assert.equal(requestQuotaCategory('POST','/v1/notifications/query',true),'notifications');
  assert.equal(requestQuotaCategory('POST','/v1/history/query',false),'anonymous');
  assert.equal(requestQuotaCategory('POST','/v1/history/query',true),'query');
  assert.equal(requestQuotaCategory('GET','/v1/policy',true),'anonymous');
});
test('HTTP verified subject survives credential rotation and shared IP; revoke quota remains independent',async()=>{
  let now=0;const policy=structuredClone(defaultRequestQuotaPolicy);policy.windowMs=2000;policy.categories.query={ip:100,subject:2,credential:1};
  const a='GUID'+'0'.repeat(28),b='GUID'+'1'.repeat(28),bindingId=randomUUID(),logs=[];
  const server=createApi({requestQuotaPolicy:policy,quotaNow:()=>now,bindings:{endpoint:'https://quota.example.org',revoke:async()=>({revoked:true})},
    access:{authenticate:async token=>{if(!['a1','a2','a3','b1'].includes(token))throw new ServiceError('access_denied',401);return {subjectId:token.startsWith('a')?a:b,bindingId};}},cases:{get:async actor=>({subjectId:actor.subjectId})},logger:entry=>logs.push(entry)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const send=(token,revoking=false)=>fetch('http://127.0.0.1:'+server.address().port+(revoking?'/v1/bindings/'+bindingId+'/revoke':'/v1/cases/'+bindingId),{method:revoking?'POST':'GET',headers:{Authorization:'Bearer '+token,...revoking?{'Content-Type':'application/json'}:{}},...revoking?{body:'{}'}:{}});
  const status=async response=>{await response.arrayBuffer();return response.status;};
  try{
    assert.equal(await status(await send('invalid')),401);
    assert.equal(await status(await send('a1')),200);
    const same=await send('a1');assert.equal(same.headers.get('x-galaxy-quota-dimension'),'credential');assert.equal(same.headers.get('retry-after'),'2');assert.equal(await status(same),429);
    assert.equal(await status(await send('a2')),200);
    const rotated=await send('a3');assert.equal(rotated.headers.get('x-galaxy-quota-dimension'),'subject');assert.equal(await status(rotated),429);
    assert.equal(await status(await send('b1')),200);
    assert.equal(await status(await send('a1',true)),200);
    now=1000;const waiting=await send('a1');assert.equal(waiting.headers.get('retry-after'),'1');await status(waiting);
    now=2000;assert.equal(await status(await send('a1')),200);
    assert.ok(!JSON.stringify(logs).includes('Bearer'));assert.ok(!JSON.stringify(logs).includes(a));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('quota memory capacity and expiry are bounded separately for each category',()=>{
  let now=0;const policy=structuredClone(defaultRequestQuotaPolicy);policy.capacityPerCategory=3;
  const quotas=createRequestQuotas(policy,{now:()=>now}),headers={},response={setHeader:(key,value)=>{headers[key]=value;}};
  const begin=(path,address='one')=>quotas.begin({method:'POST',path,hasCredential:true,address,response});
  begin('/v1/history/query')({subjectId:'GUID'+'0'.repeat(28),credential:'synthetic-first'});
  assert.throws(()=>begin('/v1/history/query','other'),/capacity_limited/);
  assert.equal(headers['X-Galaxy-Quota-Category'],'query');
  begin('/v1/data-exports/revoke')({subjectId:'GUID'+'0'.repeat(28),credential:'synthetic-first'});
  now=60000;begin('/v1/history/query','other');
});
test('real authorization, business submission and revocation remain correct under category limits',()=>verifyRequestQuotaWorkflow());
