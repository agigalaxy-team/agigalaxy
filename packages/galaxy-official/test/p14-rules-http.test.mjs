import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {dispatchP14Rules} from '../src/adapters/http/operations-rules-http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {operationsReadPath,operationsProxyPolicy,operationsRequestBodyLimit} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';
import {p14Fixture} from './p14-rules-fixture.mjs';
import {migrate} from "../src/infrastructure/database.mjs";

test('P14 exact HTTP/BFF routes keep fresh CSRF and strict parameters while actual SQL roles cannot mutate immutable rule history',async t=>{
 const f=await p14Fixture(t),origin='https://admin.example.invalid',base='/v1/operations/rules',headers=new Headers({origin,'sec-fetch-site':'same-origin'}),calls=[];
 const role=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'仅规则功能',description:'本地功能授权',enabled:true,permissions:['rules.read','rules.write']},{authorize:f.authorize})).role;
 const assignment=(await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),expectedVersion:0,operatorId:f.reader.operatorId,roleId:role.id,enabled:true},{authorize:f.authorize})).assignment;
 await migrate(f.db,{roles:['api','worker']});await f.db.exec('SET ROLE galaxy_api');
 const authorizeOperator=async(request,options)=>{calls.push(options);if(options.write&&request.headers['x-galaxy-operator-csrf']!=='p14-local-csrf')throw Object.assign(Error('synthetic CSRF rejected'),{code:'operations_csrf_invalid'});return f.reader;};
 const invoke=async(path,{method='GET',csrf='p14-local-csrf',input}={})=>{const request=Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]);Object.assign(request,{method,url:path,headers:{origin,'content-type':'application/json','x-galaxy-operator-csrf':csrf}});let result;
  await dispatchP14Rules({p14Rules:f.rules,authorizeOperator,request,response:{setHeader(){}},requestId:'p14-http-local',url:requestUrl(request,f.endpoint,[origin]),send:(_,value)=>{result=value;}});return result;};
 for(const path of [base+'/overview',base+'/business-controls/detail',base+'/business-controls/versions?limit=20',base+'/operations/'+randomUUID()]){
  assert.equal(operationsReadPath(path),true,path);assert.equal(operationsProxyPolicy({url:origin+path,method:'GET',headers,publicOrigin:origin}).allowed,true,path);assert(await invoke(path));
 }
 for(const path of [base+'/overview?query=secret',base+'/business-controls/detail?limit=1',base+'/business-controls/versions?limit=1&limit=2',base+'/business-controls/versions?accountId='+randomUUID(),base+'/operations/'+randomUUID()+'?scope=all']){
  assert.equal(operationsReadPath(path),false,path);assert.equal(operationsProxyPolicy({url:origin+path,method:'GET',headers,publicOrigin:origin}).allowed,false,path);await assert.rejects(invoke(path));
 }
 const detail=await invoke(base+'/business-controls/detail'),input={operationId:randomUUID(),expectedRevision:detail.revision,policy:detail.active.policy,reason:'HTTP本地原意图'};
 const path=base+'/business-controls/draft';assert.equal(operationsRequestBodyLimit(path),262144);assert.equal(operationsProxyPolicy({url:origin+path,method:'POST',headers,publicOrigin:origin}).allowed,true);
 await assert.rejects(invoke(path,{method:'POST',csrf:'wrong',input}),{code:'operations_csrf_invalid'});
 const saved=await invoke(path,{method:'POST',input});assert.equal(saved.kind,'draft');assert.equal(saved.publishedVersion,null);
 assert.equal((await f.db.query('SELECT operator_role FROM business_admin_audit_v1 WHERE operation_id=$1',[input.operationId])).rows[0].operator_role,'reader');
 assert.equal((await invoke(base+'/operations/'+input.operationId)).state,'recorded');
 await assert.rejects(invoke(base+'/community-quota',{method:'POST',input}),{code:'operations_rule_explicit_publication_required'});
 assert.equal(operationsProxyPolicy({url:origin+path+'?key=other',method:'POST',headers,publicOrigin:origin}).allowed,false);
 assert.equal(operationsProxyPolicy({url:origin+path,method:'POST',headers:new Headers({origin:'https://foreign.invalid'}),publicOrigin:origin}).allowed,false);
 assert(calls.some(call=>call.action==='rules.write'&&call.write));assert(calls.some(call=>call.write&&call.action===undefined),'fresh command callback authenticates inside the original PG transaction');
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:role.id,enabled:false},{authorize:f.authorize});
 await assert.rejects(invoke(path,{method:'POST',input}),{code:'operations_permission_denied'});
 for(const sql of ['DELETE FROM operations_p14_rule_heads_v1','UPDATE operations_p14_rule_versions_v1 SET policy=\'{}\'','DELETE FROM operations_p14_rule_events_v1','UPDATE operations_p14_rule_commands_v1 SET input=\'{}\'','UPDATE operations_p14_rule_decisions_v1 SET target=\'other\''])await assert.rejects(f.db.query(sql),{code:'42501'});
 await f.db.exec('RESET ROLE; SET ROLE galaxy_evidence_worker');
 assert((await f.db.query('SELECT policy_key FROM operations_product_rules_v1 LIMIT 1')).rows.length);
 await assert.rejects(f.db.query('SELECT input FROM operations_p14_rule_commands_v1'),{code:'42501'});await assert.rejects(f.db.query('DELETE FROM operations_p14_rule_versions_v1'),{code:'42501'});
 await f.db.exec('RESET ROLE');
});
