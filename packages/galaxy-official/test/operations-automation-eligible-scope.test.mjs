import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {p13Fixture} from './p13-strategies-fixture.mjs';
import {attachAiWorkFixture} from './fixtures/ai-work.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {operationsAutomationScopeV1MigrationSql} from '../src/infrastructure/operations-automation-scope-v1-schema.mjs';
import {automationScopeForSave,automationResourceScope} from '../src/shared/operations-automation-scope.mjs';
import {safeDelta} from '../src/operations/permissions/history-delta.mjs';

const contentActions=['content.read','content.hide','content.restore'];
const strategyActions=['strategies.read','strategies.ordinary.configure','strategies.ordinary.publish'];

test('explicit eligible automation covers future qualified objects while legacy scopes, frozen tasks and current authority remain bounded',{timeout:120000},async t=>{
 // Apply the actual new DDL to old-shape rows, not a projection of a new row.
 const migrationDb=new PGlite(),oldId=randomUUID();
 try{
  await migrationDb.exec('CREATE TABLE operations_automation_grants_v1(id integer PRIMARY KEY,resource_ids uuid[] NOT NULL)');
  await migrationDb.query("INSERT INTO operations_automation_grants_v1 VALUES(1,'{}'),(2,ARRAY[$1]::uuid[])",[oldId]);
  await migrationDb.exec(operationsAutomationScopeV1MigrationSql);
  const rows=(await migrationDb.query('SELECT * FROM operations_automation_grants_v1 ORDER BY id')).rows;
  assert.equal(rows[0].resource_scope_kind,null);
  assert.deepEqual(automationResourceScope(rows[0]),{kind:'unresolved'});
  assert.equal(rows[1].resource_scope_kind,'selected');
  assert.deepEqual(automationResourceScope(rows[1]),{kind:'selected',resourceIds:[oldId]});
  await assert.rejects(migrationDb.query("UPDATE operations_automation_grants_v1 SET resource_scope_kind='eligible' WHERE id=2"),{code:'23514'});
 }finally{await migrationDb.close();}

 // Real migrations, PG role, grants, content readers/commands, original audit
 // and P13 ordinary commands. The fixture's native transport is an explicit
 // double; this group never calls a model, Prosody or a production service.
 const f=await p13Fixture(t);f.authority.content=f.content;
 // This group's later assisted read has an explicit AI work identity and role.
 // Program grants above it remain independent of human AI-use rights.
 const {ids:aiIds}=await attachAiWorkFixture({db:f.db,endpoint:f.endpoint,permissions:f.permissions,
  businessAdmin:f.businessAdmin,authority:f.authority,admin:f.admin,domains:['governance'],
  codes:['workbench.read','content.read'],now:f.now});
 const legacyEmptyId=randomUUID(),legacySelectedId=randomUUID(),legacyObject=randomUUID(),at=new Date(f.now()*1000);
 for(const [id,resourceIds] of [[legacyEmptyId,[]],[legacySelectedId,[legacyObject]]])await f.db.query(`INSERT INTO operations_automation_grants_v1
  (id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at)
  VALUES($1,$2,'旧授权合成记录','program','automatic',true,1,$3,$4,$5,$5,$6,$6)`,[id,f.endpoint,contentActions,resourceIds,f.admin.operatorId,at]);
 await f.db.query('SET ROLE galaxy_api');
 const save=(input)=>f.permissions.saveAutomation(f.admin,input,{authorize:async()=>f.admin});
 const grantInput=(permissions=contentActions,extra={})=>({operationId:randomUUID(),expectedVersion:0,name:'持续适用的合成条件授权',executorKind:'program',mode:'automatic',enabled:true,permissions,resourceIds:[],resourceScope:{kind:'eligible'},...extra});
 const create=(grant,resourceIds,{actions=contentActions,preparedCommand=null,who=f.admin}={})=>f.authority.create(who,{operationId:randomUUID(),grantId:grant.id,expectedGrantVersion:grant.version,domain:'governance',actions,resourceIds,preparedCommand},{authorize:async()=>who});
 const commandFor=post=>({tool:'content-visibility',targetKind:'post',targetId:post.postId,input:{expectedVersion:1,expectedRevision:0,kind:'hide',until:f.now()+120,reason:'本次普通公开内容合成处置'}});
 async function post(owner,extra={}){
  const payload=await bindForumIds('create-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:owner.accountId,
   title:'当前获准公开内容',body:'SYNTHETIC_SCOPE_PUBLIC_ONLY',links:[],topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600,...extra});
  await f.forum.publish(owner,{payloadJson:JSON.stringify(payload)});return payload;
 }
 const before=(await f.permissions.automation(f.admin)).items;
 assert.deepEqual(before.find(row=>row.id===legacyEmptyId).resourceScope,{kind:'unresolved'});
 assert.equal(before.find(row=>row.id===legacyEmptyId).executionAvailable,false);
 assert.equal(before.find(row=>row.id===legacyEmptyId).scopeCapability.canBindObjects,false);
 assert.deepEqual(before.find(row=>row.id===legacySelectedId).resourceScope,{kind:'selected',resourceIds:[legacyObject]});
 await assert.rejects(create(before.find(row=>row.id===legacyEmptyId),[randomUUID()]),{code:'operations_agentos_scope_unresolved'});
 await assert.rejects(create(before.find(row=>row.id===legacySelectedId),[randomUUID()]),{code:'operations_agentos_scope_denied'});
 await assert.rejects(save(grantInput(contentActions,{resourceScope:undefined})),{code:'operations_automation_scope_required'});
 const renameInput=grantInput(contentActions,{id:legacyEmptyId,expectedVersion:1,name:'仅改旧记录名称',resourceScope:undefined});
 const renamed=await save(renameInput);assert.deepEqual(renamed.automation.resourceScope,{kind:'unresolved'});
 assert.deepEqual(renamed.delta.scope,{before:{kind:'unresolved'},after:{kind:'unresolved'}});
 assert.equal((await f.db.query('SELECT resource_scope_kind FROM operations_automation_grants_v1 WHERE id=$1',[legacyEmptyId])).rows[0].resource_scope_kind,null);
 assert.throws(()=>automationScopeForSave({...renameInput,resourceScope:{kind:'eligible'},resourceIds:[legacyObject]}),{code:'operations_automation_scope_invalid'});
 const conversion=grantInput(contentActions,{id:legacyEmptyId,expectedVersion:renamed.automation.version,name:'人员明确改为持续符合条件范围'}),converted=await save(conversion);
 assert.deepEqual(converted.automation.resourceScope,{kind:'eligible'});
 assert.deepEqual(converted.delta.scope,{before:{kind:'unresolved'},after:{kind:'eligible'}});
 assert.equal((await save(conversion)).replayed,true);
 await assert.rejects(save({...conversion,operationId:randomUUID()}),{code:'operations_permissions_version_changed'});
 const receipt=await f.permissions.operation(f.admin,renameInput.operationId);
 assert.equal(Object.hasOwn(receipt.selection,'resourceScope'),false,'old wire receipts do not acquire a new default intention');

 // The grant already exists when this public object is first created.
 const future=await f.task(),eligible=converted.automation,prepared=commandFor(future.post),execution=(await create(eligible,[future.post.postId],{preparedCommand:prepared})).execution;
 const source=(await f.db.query('SELECT * FROM operations_agentos_source_refs_v1 WHERE execution_id=$1',[execution.id])).rows;
 assert.equal(source.length,1);assert.equal(source[0].source_version,1);assert.equal(source[0].target_id,future.post.postId);
 const call={executionId:execution.id,runId:randomUUID(),callId:'prepared',tool:'execute-prepared-command',arguments:{}};
 const read=await f.gateway.execute({...call,callId:'read',tool:'read-selected-content',arguments:{kind:'post',id:future.post.postId}});
 assert.equal(read.body,'SYNTHETIC_PUBLIC_SOURCE_ONLY');
 const effect=await f.gateway.execute(call);assert.equal(effect.visibility.hidden,true);
 assert.equal((await f.gateway.execute(call)).replayed,true,'the same grant keeps its original effect receipt');
 const audit=(await f.db.query('SELECT actor_kind,grant_id,execution_id FROM business_admin_audit_v1 WHERE operation_id=$1',[effect.operationId])).rows[0];
 assert.deepEqual(audit,{actor_kind:'operations-executor',grant_id:eligible.id,execution_id:execution.id});
 const restore={...prepared,input:{expectedVersion:1,expectedRevision:1,kind:'restore',reason:'解除本授权原先的合成处置'}};
 const restoration=(await create(eligible,[future.post.postId],{preparedCommand:restore})).execution;
 assert.equal((await f.gateway.execute({...call,executionId:restoration.id,runId:randomUUID()})).visibility.hidden,false);
 await f.content.visibility(f.admin,'post',future.post.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:2,kind:'hide',until:f.now()+200,reason:'人工明确保留的合成决定'});
 const humanBlocked=(await create(eligible,[future.post.postId],{preparedCommand:{...restore,input:{...restore.input,expectedRevision:3}}})).execution;
 await assert.rejects(f.gateway.execute({...call,executionId:humanBlocked.id,runId:randomUUID()}),{code:'operations_agentos_human_review_required'});
 const next=await post(f.people[1]);
 await assert.rejects(f.authority.actor(execution.id,{resourceIds:[next.postId]}),{code:'operations_agentos_scope_denied'},'eligible does not enlarge a task after creation');
 const nextExecution=(await create(eligible,[next.postId],{actions:['content.read']})).execution;
 assert.deepEqual(nextExecution.resourceIds,[next.postId],'a later task may freeze a newly created eligible object without resaving the grant');
 const revision=await bindForumIds('publish-version','account:'+f.people[1].accountId,{...next,operationId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:1,body:'NEW_PUBLIC_REVISION'});
 await f.forum.publish(f.people[1],{payloadJson:JSON.stringify(revision)});
 await assert.rejects(f.authority.actor(nextExecution.id),{code:'operations_agentos_source_changed'});
 const privatePost=await post(f.people[2],{audience:{read:{kind:'accounts'},participate:{kind:'accounts'}}});
 await assert.rejects(create(eligible,[privatePost.postId],{actions:['content.read']}),{code:'operations_agentos_object_ineligible'});
 await assert.rejects(create(eligible,[randomUUID()],{actions:['content.read']}),{code:'operations_agentos_object_ineligible'});
 const withdrawn=await post(f.people[2]),withdrawal=await bindForumIds('withdraw-post','account:'+f.people[2].accountId,{schemaVersion:1,operationId:randomUUID(),postId:withdrawn.postId,expectedHeadVersion:1});
 await f.forum.withdraw(f.people[2],'withdraw-post',{payloadJson:JSON.stringify(withdrawal)});
 await assert.rejects(create(eligible,[withdrawn.postId],{actions:['content.read']}),{code:'operations_agentos_object_ineligible'});
 await assert.rejects(create(eligible,[]),{code:'operations_agentos_scope_required'});
 await assert.rejects(create(eligible,[future.post.postId],{actions:['jobs.retry']}),{code:'operations_agentos_scope_denied'});
 await assert.rejects(f.permissions.executionIntersection({grantId:eligible.id,actions:['content.read'],resourceIds:[]}),{code:'operations_automation_scope_denied'});
 const intersection=await f.permissions.executionIntersection({grantId:eligible.id,actions:['content.read'],resourceIds:[future.post.postId]});
 assert.deepEqual(intersection.permissions,['content.read']);assert.equal(intersection.executionAvailable,false);assert.equal(intersection.state,'not-connected');
 const short=await post(f.people[1],{publishedUntil:f.now()+10}),shortExecution=(await create(eligible,[short.postId],{actions:['content.read']})).execution;
 f.advance(11);await assert.rejects(f.authority.actor(shortExecution.id),{code:'operations_agentos_object_ineligible'});

 // Only already connected bounded ordinary strategy commands qualify. The
 // active strategy is published after its eligible grant, with a real sample.
 const strategyGrant=(await save(grantInput(strategyActions))).automation,sid=randomUUID(),config=f.configuration({strategyId:sid}),sample=await f.task({owner:f.people[2]});
 config.strategies[0].ordinaryBounds={parameters:[],modes:['code-automatic'],canEnable:true,canDisable:true};
 await f.publish(config,[sample.execution.id]);
 const strategyExecution=(await create(strategyGrant,[sid],{actions:strategyActions})).execution;
 const strategyRead=await f.gateway.execute({executionId:strategyExecution.id,runId:randomUUID(),callId:'read',tool:'read-selected-strategy',arguments:{strategyId:sid}});
 const draft=await f.gateway.execute({executionId:strategyExecution.id,runId:randomUUID(),callId:'draft',tool:'save-selected-strategy-draft',arguments:{operationId:randomUUID(),expectedRevision:strategyRead.revision,strategyId:sid,enabled:false}});
 const published=await f.gateway.execute({executionId:strategyExecution.id,runId:randomUUID(),callId:'publish',tool:'publish-selected-strategy',arguments:{operationId:randomUUID(),expectedRevision:draft.revision,strategyId:sid,versionId:draft.versionId}});
 assert.equal(published.state,'active-for-new-matters');
 await f.authority.actor(strategyExecution.id);
 await assert.rejects(create(strategyGrant,[randomUUID()],{actions:strategyActions}),{code:'operations_agentos_object_ineligible'});
 const options=await f.authority.options(f.admin);assert.ok(Array.isArray(options.items));

 // Assisted grants still intersect the real person's current PG roles.
 const role=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'仅当前合成读取者',description:'',enabled:true,permissions:['workbench.read','content.read','ai.use.governance']},{authorize:async()=>f.admin})).role;
 const assignment=(await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),expectedVersion:0,operatorId:f.reader.operatorId,roleId:role.id,enabled:true},{authorize:async()=>f.admin})).assignment;
 const assisted=(await save(grantInput(['content.read'],{mode:'assisted',executorKind:'ai',aiAccountId:aiIds.governance}))).automation,assistedExecution=(await create(assisted,[sample.post.postId],{actions:['content.read'],who:f.reader})).execution;
 assert.deepEqual((await f.authority.options(f.reader)).items.find(row=>row.id===assisted.id).resourceScope,{kind:'eligible'});
 const assistedActor=await f.authority.actor(assistedExecution.id);
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:f.reader.operatorId,roleId:role.id,enabled:false},{authorize:async()=>f.admin});
 await assert.rejects(f.authority.requireAction(assistedActor,'content.read'),{code:'operations_permission_denied'});
 const actor=await f.authority.actor(execution.id);
 await save({...conversion,operationId:randomUUID(),expectedVersion:eligible.version,enabled:false});
 await assert.rejects(f.authority.requireAction(actor,'content.read'),{code:'operations_agentos_authority_changed'});
 const history=await f.permissions.history(f.admin,{resourceId:eligible.id});
 assert.deepEqual(history.items.find(row=>row.id===conversion.operationId).delta.scope,{before:{kind:'unresolved'},after:{kind:'eligible'}});
 assert.ok(history.items.find(row=>row.id===conversion.operationId).changedFields.includes('resourceScope'));
 const legacyDelta={kind:'automation',permissions:{added:[],removed:[]},enabled:{before:null,after:true},scope:{before:null,after:[]},mode:{before:null,after:'automatic'},executorKind:{before:null,after:'program'}};
 assert.deepEqual(safeDelta({kind:'automation-save',delta:legacyDelta}).scope,{before:null,after:{kind:'unresolved'}});
 assert.equal(safeDelta({kind:'automation-save',delta:{...legacyDelta,scope:{before:null,after:{kind:'eligible',url:'SECRET_SENTINEL'}}}}),null);
 assert.equal(JSON.stringify(history).includes('SYNTHETIC_PUBLIC_SOURCE_ONLY'),false);
 await assert.rejects(f.db.query('UPDATE operations_automation_grants_v1 SET created_by=$1 WHERE id=$2',[f.reader.operatorId,eligible.id]),{code:'42501'});
 await f.db.query('RESET ROLE');
});
