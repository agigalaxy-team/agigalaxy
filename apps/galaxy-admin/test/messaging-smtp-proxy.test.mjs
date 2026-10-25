import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy,operationsReadPath,operationsRequestBodyLimit} from '../src/lib/proxy-policy.mjs';

test('messaging and SMTP proxy forwards exact paths, single query keys and bounded bodies under the existing origin rule',()=>{
 const publicOrigin='https://admin.example.invalid',id='11111111-2222-4333-8444-555555555555';
 const policy=(path,method='GET',headers={'sec-fetch-site':'same-origin'})=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers(headers),publicOrigin});
 for(const path of ['/v1/operations/messaging/plans?state=active&after=1&limit=25','/v1/operations/messaging/plans/'+id,'/v1/operations/messaging/plans/'+id+'/history?after=1&limit=25',
  '/v1/operations/messaging/runs?planId='+id+'&limit=25','/v1/operations/messaging/runs/'+id,'/v1/operations/messaging/runs/'+id+'/recipients?channel=email&state=unknown&after=1&limit=25',
  '/v1/operations/smtp','/v1/operations/smtp/identities','/v1/operations/smtp/queue?after=1&limit=25','/v1/operations/smtp/tests?limit=25','/v1/operations/smtp/history?limit=25','/v1/operations/smtp/bounces','/v1/operations/smtp/domains']){
  assert.equal(operationsReadPath(path),true,path);assert.equal(policy(path).allowed,true,path);assert.equal(policy(path,'GET',{'sec-fetch-site':'cross-site'}).allowed,false);
 }
 for(const path of ['/v1/operations/messaging/plans','/v1/operations/messaging/plans/'+id+'/save','/v1/operations/messaging/plans/'+id+'/activate','/v1/operations/messaging/plans/'+id+'/pause',
  '/v1/operations/messaging/plans/'+id+'/resume','/v1/operations/messaging/plans/'+id+'/stop','/v1/operations/messaging/plans/'+id+'/withdraw','/v1/operations/messaging/runs/'+id+'/retry',
  '/v1/operations/smtp/settings','/v1/operations/smtp/tests/connection','/v1/operations/smtp/tests/delivery']){
  assert.equal(policy(path,'POST',{origin:publicOrigin}).allowed,true,path);assert.equal(policy(path,'POST').allowed,false);assert.equal(policy(path+'?operatorId=forged','POST',{origin:publicOrigin}).allowed,false);
 }
 for(const path of ['/v1/operations/messaging/plans?scope=all','/v1/operations/messaging/plans?after=1&after=2','/v1/operations/messaging/runs?state=active','/v1/operations/messaging/plans/'+id+'?after=1',
  '/v1/operations/messaging/runs/'+id+'/recipients?query=private','/v1/operations/smtp?env=PASSWORD','/v1/operations/smtp/domains?selector=forged','/v1/operations/smtp/queue?to=private@example.invalid',
  '/v1/operations/smtp/tests?limit=1&limit=2','/v1/operations/messaging/plans?after='+'1'.repeat(8193)]){assert.equal(operationsReadPath(path),false,path);assert.equal(policy(path).allowed,false,path);}
 for(const path of ['/v1/operations/messaging/execute','/v1/operations/smtp/credentials','/v1/operations/smtp/webhook','/v1/operations/smtp/connect/'+id,'/v1/announcements'])assert.equal(policy(path).allowed,false);
 for(const queue of ['messaging-run','messaging-delivery']){assert.equal(policy('/v1/operations/jobs/'+queue+'/'+id).allowed,true);assert.equal(policy('/v1/operations/jobs/'+queue+'/'+id+'/retry','POST',{origin:publicOrigin}).allowed,true);}
 assert.equal(operationsRequestBodyLimit('/v1/operations/messaging/plans'),65536);assert.equal(operationsRequestBodyLimit('/v1/operations/messaging/plans/'+id+'/save'),65536);assert.equal(operationsRequestBodyLimit('/v1/operations/messaging/plans/'+id+'/activate'),32768);
 assert.equal(operationsRequestBodyLimit('/v1/operations/smtp/settings'),16384);assert.equal(operationsRequestBodyLimit('/v1/operations/content/publications'),1048576);
});
