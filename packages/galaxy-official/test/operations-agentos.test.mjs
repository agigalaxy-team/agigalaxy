import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsGateway} from '../src/operations-agentos-gateway.mjs';
import {operationsAgentOsV1MigrationSql} from '../src/infrastructure/operations-agentos-v1-schema.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';

async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 if(!(await f.db.query("SELECT to_regclass('operations_agentos_executions_v1') AS name")).rows[0].name)await f.db.exec(operationsAgentOsV1MigrationSql);
 const admin={kind:'business-operator',operatorId:'synthetic-agentos-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'synthetic-agentos-reader',role:'reader'},roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.invalid',$1,'合成管理者',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId),now:f.now}),
  authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,executorAuthority:authority,now:f.now}),
  forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),
  gateway=new OperationsAgentOsGateway({authority,content:community.content,serviceKey:'synthetic-internal-service-key-not-production'});businessAdmin.executorGateway=gateway;
 const r=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'合成工作台治理',description:'',enabled:true,permissions:['workbench.read','content.read','content.hide','content.restore','audit.read']},{authorize:async()=>admin})).role;
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:r.id,enabled:true},{authorize:async()=>admin});
 async function post(){const owner=f.people[0],payload=await bindForumIds('create-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:owner.accountId,
  title:'已获准公开合成内容',body:'SYNTHETIC_PUBLIC_ONLY',links:[],topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});await forum.publish(owner,{payloadJson:JSON.stringify(payload)});return payload;}
 async function grant(ids,{mode='assisted',executorKind='ai'}={}){return (await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'明确对象合成助手',executorKind,mode,enabled:true,permissions:['content.read','content.hide','content.restore'],resourceIds:ids},{authorize:async()=>admin})).automation;}
 async function execution(grant,ids,preparedCommand=null,who=reader){return (await authority.create(who,{operationId:randomUUID(),grantId:grant.id,expectedGrantVersion:grant.version,domain:'governance',actions:['content.read','content.hide','content.restore'],resourceIds:ids,preparedCommand},{authorize:async()=>who})).execution;}
 return {...f,admin,reader,roles,permissions,authority,businessAdmin,forum,content:community.content,gateway,post,grant,execution};
}

test('AgentOS authority binds current person, assistant and task scope to actual public content commands and preserves human decisions and source expiry',{timeout:60000},async t=>{
 const f=await fixture(t),post=await f.post(),other=await f.post(),grant=await f.grant([post.postId]),command={tool:'content-visibility',targetKind:'post',targetId:post.postId,input:{expectedVersion:1,expectedRevision:0,kind:'hide',until:f.now()+60,reason:'已准备的普通公开内容处置'}},execution=await f.execution(grant,[post.postId],command);
 const actor=await f.authority.actor(execution.id,{resourceIds:[post.postId]});
 assert.throws(()=>f.businessAdmin.require(JSON.parse(JSON.stringify(actor))),{code:'business_admin_denied'});
 await assert.rejects(f.content.get(actor,'post',other.postId),{code:'operations_agentos_scope_denied'});
 const call={executionId:execution.id,runId:randomUUID(),callId:'prepared-command',tool:'execute-prepared-command',arguments:{}};
 const read=await f.gateway.execute({...call,callId:'read',tool:'read-selected-content',arguments:{kind:'post',id:post.postId}});assert.equal(read.body,'SYNTHETIC_PUBLIC_ONLY');
 const result=await f.gateway.execute(call);assert.equal(result.visibility.hidden,true);assert.equal((await f.forum.getPost(post.postId)).availability,'unavailable');
 assert.equal((await f.gateway.execute(call)).replayed,true);
 const row=(await f.db.query('SELECT * FROM business_admin_audit_v1 WHERE operation_id=$1',[result.operationId])).rows[0];assert.equal(row.operator_role,null);assert.equal(row.actor_kind,'operations-executor');assert.equal(row.execution_id,execution.id);assert.equal(row.grant_id,grant.id);
 const audit=businessAuditMetadata(row);assert.equal(audit.actorKind,'operations-executor');assert.equal(JSON.stringify(audit).includes(command.input.reason),false);
 const restore=await f.execution(grant,[post.postId],{...command,input:{expectedVersion:1,expectedRevision:1,kind:'restore',reason:'解除本授权此前自动下架'}});
 assert.equal((await f.gateway.execute({...call,executionId:restore.id,runId:randomUUID()})).visibility.hidden,false);
 await f.content.visibility(f.admin,'post',post.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:2,kind:'hide',until:f.now()+70,reason:'新的人工重要处置'});
 const blocked=await f.execution(grant,[post.postId],{...command,input:{expectedVersion:1,expectedRevision:3,kind:'restore',reason:'不能覆盖人工原决定'}});
 await assert.rejects(f.gateway.execute({...call,executionId:blocked.id,runId:randomUUID()}),{code:'operations_agentos_human_review_required'});
 f.advance(3601);await assert.rejects(f.gateway.authorize({executionId:execution.id,operation:'read',resourceType:null,resourceId:null}),{code:'operations_agentos_source_changed'});
});

test('independent automatic execution never borrows a person role and grant changes block original retries and empty object scopes',{timeout:60000},async t=>{
 const f=await fixture(t),post=await f.post(),grant=await f.grant([post.postId],{mode:'automatic',executorKind:'program'}),execution=await f.execution(grant,[post.postId],null,f.admin);
 assert.equal(execution.operatorId,null);assert.equal(execution.executorKind,'program');
 const actor=await f.authority.actor(execution.id);assert.equal(actor.role,null);assert.equal(actor.onBehalfOf,null);
 f.roles.delete(f.admin.operatorId);
 const read=await f.gateway.execute({executionId:execution.id,runId:randomUUID(),callId:'selected',tool:'read-selected-content',arguments:{kind:'post',id:post.postId}});assert.equal(read.body,'SYNTHETIC_PUBLIC_ONLY');
 await assert.rejects(f.authority.requireAction(actor,'permissions.roles.write'),{code:'business_admin_denied'});
 await f.db.query('UPDATE operations_automation_grants_v1 SET enabled=false,version=version+1 WHERE id=$1',[grant.id]);
 await assert.rejects(f.authority.requireAction(actor,'content.read'),{code:'operations_agentos_authority_changed'});
 f.roles.set(f.admin.operatorId,'administrator');const enabled=await f.grant([post.postId]);
 await assert.rejects(f.execution(enabled,[]),{code:'operations_agentos_scope_required'});
 await assert.rejects(f.execution(enabled,[randomUUID()]),{code:'operations_agentos_scope_denied'});
 assert.throws(()=>f.gateway.verifyService({headers:{authorization:'Bearer wrong'}}),{code:'operations_agentos_service_denied'});
});

test('selected public search tool uses only server task objects and the current public reader and rechecks grant after search',{timeout:60000},async t=>{
 const f=await fixture(t),post=await f.post(),other=await f.post(),grant=await f.grant([post.postId]),execution=await f.execution(grant,[post.postId]);
 let nativeRequest,usageWrites=0,revoke=false;
 const discovery=new DiscoveryRuntime({db:f.db,endpoint:f.endpoint,forum:f.forum,now:f.now,
  meili:{async search(request){nativeRequest=request;if(revoke)await f.db.query('UPDATE operations_automation_grants_v1 SET enabled=false,version=version+1 WHERE id=$1',[grant.id]);return {hits:[
   {id:'post_'+other.postId,version:outside.indexVersion},{id:'post_'+post.postId,version:document.indexVersion}]};}},
  store:{async enqueue(){},async record(){usageWrites++;throw new Error('Search must not record usage');}}});
 const document=await discovery.source.load({kind:'post',id:post.postId}),outside=await discovery.source.load({kind:'post',id:other.postId});
 f.gateway.discovery=discovery;
 const call={executionId:execution.id,runId:randomUUID(),callId:'selected-search',tool:'search-selected-public-content',arguments:{kind:'post',query:'合成'}};
 const result=await f.gateway.execute(call);
 assert.deepEqual(nativeRequest.itemKeys,['post_'+post.postId]);
 assert.deepEqual(result.items,[{kind:'post',id:post.postId,sourceVersion:post.versionId}]);
 assert.equal(result.qualification,'current-anonymous-public-reader');
 for(const excluded of [other.postId,'SYNTHETIC_PUBLIC_ONLY',post.title])assert.equal(JSON.stringify(result).includes(excluded),false);
 await assert.rejects(f.gateway.execute({...call,arguments:{...call.arguments,resourceIds:[other.postId]}}),{code:'invalid_operations_agentos_request'});
 f.advance(3601);assert.deepEqual((await f.gateway.execute(call)).items,[]);
 revoke=true;await assert.rejects(f.gateway.execute(call),{code:'operations_agentos_authority_changed'});
 assert.equal(usageWrites,0);
});
