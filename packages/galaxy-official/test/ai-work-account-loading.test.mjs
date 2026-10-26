import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {AiWorkAccountsReadModel} from '../src/operations/accounts/ai-work-read-model.mjs';
import {dispatchOperationsAiWorkAccounts} from '../src/adapters/http/operations-ai-work-accounts-http.mjs';
import {operationsPermissionCodes} from '../src/operations-permission-catalog.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {aiWorkReadPath,aiWorkWritePath,aiWorkQueryAllowed} from '../../../apps/galaxy-admin/src/lib/ai-work-proxy-policy.mjs';
import {operationsProxyPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';
import {automationAiOptionsWithin} from '../src/operations/permissions/ai-binding.mjs';
import {automationBindingIssue,permissionAiExecutionIssue} from '../../../apps/galaxy-admin/src/lib/permissions-view-model.ts';

const actor={kind:'business-operator',endpoint:'https://api.example.invalid',operatorId:'a'.repeat(64),businessAuthorization:{version:'1',permissions:operationsPermissionCodes}};
const row={id:'11111111-1111-4111-8111-111111111111',domain:'overview',name:'总控',description:'日常运营',enabled:true,version:1,authorization_version:1,created_at:new Date(),updated_at:new Date()};
const roles=[{id:'22222222-2222-4222-8222-222222222222',name:'测试全部权限',description:'完整角色',enabled:true,version:1,permissions:operationsPermissionCodes},{id:'33333333-3333-4333-8333-333333333333',name:'旧角色',description:'',enabled:false,version:1,permissions:['content.read']}];
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(runtime){
 const state={revoked:false,checks:0};
 const db={transaction:async task=>task(db),query:async sql=>{
  if(sql.includes('FROM operations_ai_work_accounts_v1'))return{rows:[row]};
  if(sql.includes('FROM operations_business_roles_v1'))return{rows:roles};
  if(sql.includes('FROM operations_ai_work_assignments_v1')||sql.includes('FROM operations_automation_grants_v1')||sql.includes('FROM operations_ai_work_commands_v1'))return{rows:[]};
  throw Error('Unexpected fixture read');
 }};
 const businessAdmin={authorizeAction:async current=>{state.checks++;if(state.revoked)throw new ServiceError('operations_permission_denied',403);return current;}};
 return{state,service:new AiWorkAccountsReadModel({db,endpoint:actor.endpoint,businessAdmin,runtime})};
}

test('account roles remain available while engine health is pending',async()=>{
 const pending=deferred(),started=deferred(),{service}=fixture({status:()=>{started.resolve();return pending.promise;}});
 const health=service.runtimeStatus(actor,'overview');await started.promise;
 const detail=await Promise.race([service.detail(actor,'overview'),delay(500).then(()=>{throw Error('Role detail waited for engine health');})]);
 assert.equal(detail.account.name,'总控');assert.equal(detail.roles.find(role=>role.name==='测试全部权限').canAssign,true);assert.equal(detail.runtime.state,'pending');
 pending.resolve({state:'connected',configuredDomains:['overview']});
 assert.equal((await health).runtime.modelState,'configured');
});

test('parallel runtime reads coalesce engine I/O without sharing reader authorization',async()=>{
 const pending=deferred(),started=deferred();let calls=0;
 const {service,state}=fixture({status:()=>{calls++;started.resolve();return pending.promise;}});
 const one=service.runtimeStatus(actor,'overview'),two=service.runtimeStatus(actor,'messaging');
 await started.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 pending.resolve({state:'connected',configuredDomains:['overview']});
 const [a,b]=await Promise.all([one,two]);assert.equal(a.runtime.modelState,'configured');assert.equal(b.runtime.modelState,'not-configured');assert.ok(state.checks>=8);
});

test('runtime rechecks permission after waiting and never calls the engine for a denied reader',async()=>{
 const pending=deferred(),started=deferred();let calls=0;
 const {service,state}=fixture({status:()=>{calls++;started.resolve();return pending.promise;}});
 const read=service.runtimeStatus(actor,'overview');await started.promise;state.revoked=true;pending.resolve({state:'connected',configuredDomains:['overview']});
 await assert.rejects(read,error=>error.status===403);
 await assert.rejects(service.runtimeStatus(actor,'overview'),error=>error.status===403);assert.equal(calls,1);
});

test('unavailable roles retain explicit reasons without widening assignability',async()=>{
 const {service}=fixture(null),full=await service.detail(actor,'overview');
 assert.equal(full.roles[0].assignmentReason,null);assert.equal(full.roles[1].assignmentReason,'role-disabled');
 const limited={...actor,businessAuthorization:{version:'2',permissions:['ai.accounts.read','ai.accounts.roles.write','content.read']}};
 const value=await service.detail(limited,'overview');assert.equal(value.roles[0].canAssign,false);assert.equal(value.roles[0].assignmentReason,'exceeds-permissions');
 assert.equal(value.roles.length,2);
});

test('runtime route is a closed GET with no query or write access',async()=>{
 let calls=0;
 const dispatch=async(path,{method='GET'}={})=>{let sent;await dispatchOperationsAiWorkAccounts({aiWorkAccounts:{runtimeStatus:async(current,domain)=>{assert.equal(current,actor);calls++;return {domain};}},authorizeOperator:async(request,options)=>{assert.equal(options.write,false);assert.equal(options.action,'ai.accounts.read');return actor;},request:{method},requestId:'headless-runtime',url:new URL(path,'https://api.example.invalid'),send:(status,value)=>{sent={status,value};}});return sent;};
 const target='/v1/operations/ai-work-accounts/overview/runtime';assert.equal((await dispatch(target)).value.domain,'overview');assert.equal(calls,1);
 for(const path of [target+'?url=https://other.invalid',target+'?after=1','/v1/operations/ai-work-accounts/unknown/runtime'])await assert.rejects(dispatch(path),error=>error.status===404);
 await assert.rejects(dispatch(target,{method:'POST'}),error=>error.status===404);assert.equal(calls,1);
 assert.equal(aiWorkReadPath.test(target),true);assert.equal(aiWorkWritePath.test(target),false);assert.equal(aiWorkQueryAllowed(target,''),true);assert.equal(aiWorkQueryAllowed(target,'?x=1'),false);
 const publicOrigin='https://admin.example.invalid',policy=(path,method='GET')=>operationsProxyPolicy({url:publicOrigin+path,method,headers:new Headers({origin:publicOrigin}),publicOrigin});
 assert.equal(operationsReadPath(target),true);assert.equal(policy(target).allowed,true);assert.equal(policy(target,'POST').allowed,false);assert.equal(policy(target+'?url=other').allowed,false);
});

test('automatic authorization distinguishes missing roles from unconnected execution',async()=>{
 const accounts=[{...row,domain:'overview'},{...row,id:roles[0].id,domain:'governance'}];
 const db={query:async()=>({rows:accounts})};
 const aiWorkAccounts={authorizationWithin:async(db,domain)=>({enabled:true,permissions:domain==='overview'?operationsPermissionCodes:[]})};
 const result=await automationAiOptionsWithin(db,{endpoint:actor.endpoint,aiWorkAccounts,actor});
 assert.equal(result.items[0].unavailableReason,'execution-not-connected');assert.equal(result.items[1].unavailableReason,'role-missing');
 for(const item of result.items)assert.equal(item.canEnable,false);
 assert.match(permissionAiExecutionIssue(result.items[0]),/尚未接通/);assert.match(permissionAiExecutionIssue(result.items[1]),/先.*分配/);
 const draft={executorKind:'ai',enabled:true,aiAccountId:row.id,permissions:['content.read']};
 assert.match(automationBindingIssue(draft,result),/尚未接通/);
 const supported=await automationAiOptionsWithin(db,{endpoint:actor.endpoint,aiWorkAccounts:{authorizationWithin:async()=>({enabled:true,permissions:['content.read','content.hide']})},actor});
 assert.equal(supported.items[0].canEnable,false);assert.equal(supported.items[1].canEnable,true);assert.deepEqual(supported.items[1].executablePermissions,['content.read','content.hide']);
});
