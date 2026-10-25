import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApi} from '../src/http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {AutonomyReadModel} from '../src/operations/autonomy/views.mjs';

const endpoint='https://autonomy.synthetic.invalid',root='/v1/operations/autonomy',id='11111111-2222-4333-8444-555555555555';

test('canonical request URL admits only exact autonomy read query shapes',()=>{
 const read=(path,method='GET')=>requestUrl({url:path,method,headers:{}},endpoint);
 assert.equal(read(root+'/tasks?page=1&limit=20').pathname,root+'/tasks');
 assert.equal(read(root+'/tasks?page=2&limit=100&domain=governance&source=event&state=queued&mode=code&targetType=content-post&targetId='+id).pathname,root+'/tasks');
 assert.equal(read(root+'/overview?days=7').search,'?days=7');
 for(const path of [root+'/tasks?page=1&page=2',root+'/tasks?limit=1&limit=2',root+'/tasks?operatorId=forged',root+'/tasks?targetId='+ 'x'.repeat(2048),root+'/overview?days=7&days=14',root+'/overview?page=1'])
  assert.throws(()=>read(path),error=>error.code==='invalid_request'&&error.status===400,path);
 for(const path of [root+'/tasks/'+id,root+'/settings',root+'/options',root+'/accounts/governance/config',root+'/operations/'+id])
  assert.throws(()=>read(path+'?page=1'),error=>error.code==='invalid_request',path);
 for(const method of ['POST','OPTIONS','PUT','DELETE'])for(const path of [root+'/tasks?page=1&limit=20',root+'/overview?days=7'])
  assert.throws(()=>read(path,method),error=>error.code==='invalid_request',method+' '+path);
});

test('real HTTP task pagination and overview pass the canonical gate, retaining service validation and authorization',async t=>{
 const actor={kind:'business-operator',operatorId:'synthetic-reader',endpoint,role:'reader'},authorized=[],queries=[],overviews=[];
 const service=Object.assign(Object.create(AutonomyReadModel.prototype),{
  endpoint,actor:async actual=>{assert.equal(actual,actor);return actor;},stamp:()=>({checkedAt:'2026-10-26T00:00:00.000Z'}),
  db:{async query(sql,values){queries.push({sql,values});return {rows:sql.startsWith('SELECT count(')?[{total:0,controlled:false}]:[]};}},
  async overview(actual,input){assert.equal(actual,actor);overviews.push(input);return {accounts:[],summary:{},...this.stamp()};}
 });
 const server=createApi({bindings:{endpoint},operationsAutonomy:service,operations:{portal:{authorizeOperator:async(_request,options)=>{authorized.push(options);return actor;}}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const send=async(path,method='GET')=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method});return {status:response.status,body:await response.json()};};
 const page=await send(root+'/tasks?page=1&limit=20');
 assert.equal(page.status,200);assert.deepEqual(page.body.items,[]);assert.equal(page.body.page,1);assert.equal(page.body.limit,20);assert.equal(page.body.total,0);
 const bounded=await send(root+'/tasks?page=2&limit=100&domain=governance&source=event&state=queued&mode=code&targetType=content-post&targetId='+id);
 assert.equal(bounded.status,200);assert.equal(bounded.body.page,2);assert.equal(bounded.body.limit,100);
 assert.deepEqual(queries.at(-1).values,[endpoint,'governance','event','queued','code','content-post',id,100,100]);
 assert.equal((await send(root+'/overview?days=7')).status,200);assert.deepEqual(overviews,[{days:7}]);
 assert.ok(authorized.every(options=>options.action==='autonomy.read'&&options.write===false));
 const beforeQueries=queries.length;
 for(const query of ['limit=101','page=0','page=100001','domain=unknown','targetType=content-post']){
  const rejected=await send(root+'/tasks?'+query);assert.equal(rejected.status,400);assert.equal(rejected.body.error,'invalid_operations_autonomy_request');
 }
 const invalidDays=await send(root+'/overview?days=invalid');assert.equal(invalidDays.status,400);assert.equal(invalidDays.body.error,'invalid_operations_autonomy_request');
 assert.equal(queries.length,beforeQueries,'invalid values never reach task SQL');
 const beforeAuth=authorized.length;
 for(const path of [root+'/tasks?limit=1&limit=2',root+'/tasks?operatorId=forged',root+'/tasks?targetId='+'x'.repeat(2048),root+'/overview?days=7&days=14',root+'/settings?days=7',root+'/tasks/'+id+'?page=1']){
  const rejected=await send(path);assert.equal(rejected.status,400);assert.equal(rejected.body.error,'invalid_request');
 }
 for(const path of [root+'/tasks?page=1',root+'/accounts/governance/config?days=7',root+'/settings?days=7',root+'/tasks/'+id+'/control?page=1']){
  const rejected=await send(path,'POST');assert.equal(rejected.status,400);assert.equal(rejected.body.error,'invalid_request');
 }
 assert.equal(authorized.length,beforeAuth,'unknown, repeated and write queries fail before authorization or dispatch');
 assert.equal(queries.length,beforeQueries);assert.equal(overviews.length,1);
});
