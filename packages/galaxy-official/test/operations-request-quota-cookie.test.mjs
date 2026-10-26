import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestQuotas,defaultRequestQuotaPolicy,hasRequestCredential,requestQuotaCategory} from '../src/adapters/http/request-quotas.mjs';

test('management session declarations use the existing read transport quota without becoming authentication',()=>{
 const token='x'.repeat(43);
 const headers={cookie:'__Host-galaxy-operator='+token},path='/v1/operations/agentos/conversations/overview';
 assert.equal(hasRequestCredential({headers},path),true);assert.equal(requestQuotaCategory('GET',path,hasRequestCredential({headers},path)),'query');
 assert.equal(hasRequestCredential({headers},'/v2/community/posts/query'),false);
 assert.equal(hasRequestCredential({headers},'/v1/operations/login'),false);
 assert.equal(hasRequestCredential({headers:{cookie:headers.cookie+'; '+headers.cookie}},path),false);
 assert.equal(hasRequestCredential({headers:{cookie:'__Host-galaxy-operator=not-valid'}},path),false);
 assert.equal(hasRequestCredential({headers:{cookie:'other='+token}},path),false);
 const reply={setHeader(){}},quotas=createRequestQuotas(defaultRequestQuotaPolicy,{now:()=>1000});
 // More than 60 normal protected reads must not spend anonymous traffic's
 // allowance. No thresholds are raised, and every dispatch still authenticates.
 for(let i=0;i<75;i++)quotas.begin({method:'GET',path,hasCredential:hasRequestCredential({headers},path),address:'explicit-fixture-ip',response:reply});
 for(let i=0;i<60;i++)quotas.begin({method:'GET',path:'/v1/policy',hasCredential:false,address:'explicit-fixture-ip',response:reply});
 assert.throws(()=>quotas.begin({method:'GET',path:'/v1/policy',hasCredential:false,address:'explicit-fixture-ip',response:reply}),{code:'rate_limited'});
});
