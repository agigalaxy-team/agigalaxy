import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsProxyPolicy} from '../src/lib/proxy-policy.mjs';
const origin='https://admin.example.invalid';
const task='11111111-1111-4111-8111-111111111111',operation='22222222-2222-4222-8222-222222222222';
const path=`/v1/operations/autonomy/tasks/${task}/operations/${operation}`;
const policy=(url,method='GET')=>operationsProxyPolicy({url:origin+url,method,headers:new Headers({origin}),publicOrigin:origin});
test('original AI receipt proxy permits only the exact read-only UUID route',()=>{
 assert.equal(policy(path).allowed,true);
 for(const bad of [path+'?x=1',path+'/extra',path.replace(operation,'not-a-uuid'),path.replace(task,'not-a-uuid')])assert.equal(policy(bad).allowed,false,bad);
 for(const method of ['POST','PUT','DELETE'])assert.equal(policy(path,method).allowed,false,method);
});

test('confirmed task assignment can be read through the same authenticated proxy',()=>{
 for(const domain of ['overview','governance','messaging','discovery','maintenance']){
  const dispatch=`/v1/operations/autonomy/dispatches/${domain}/${operation}`;
  assert.equal(policy(dispatch).allowed,true);
  assert.equal(policy(dispatch+'?x=1').allowed,false);
  assert.equal(policy(dispatch,'POST').allowed,false);
 }
});
