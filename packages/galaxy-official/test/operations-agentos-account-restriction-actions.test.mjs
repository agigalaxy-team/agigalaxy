import {attachAiWorkFixture} from './fixtures/ai-work.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {CommunityAccountRegistry} from "../src/accounts/community-accounts.mjs";
import {OperationsAgentOsAuthority} from "../src/operations/agentos/authority.mjs";
import {OperationsAgentOsActionTools} from "../src/operations/agentos/action-tools.mjs";
import {AgentOsConversations} from "../src/operations/agentos/conversations.mjs";
import {AgentOsConversationTools} from "../src/operations/agentos/conversation-tools.mjs";
import {workbenchActionCatalog,workbenchPrepareSchemas} from "../src/operations/agentos/action-catalog.mjs";
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {workbenchActionCards,workbenchCardReason} from "../../../apps/galaxy-admin/src/lib/workbench/workbench-action-cards.ts";

// Actual API-role PG, current grants, account restrictions, card persistence
// and original receipts. Only the upstream management-role lookup is a local
// contract. No model, provider, HTTP session or production account is used.
test('workbench account restriction cards preserve explicit deadlines, human decisions, current account CAS and the exact committed original result',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
 const clock=2000000000;const now=()=>clock,stamp=value=>new Date(value*1000).toISOString(),endpoint='https://account-card.example.invalid',foreign='https://other-account-card.example.invalid',
  ids=[randomUUID(),randomUUID(),randomUUID()],admin={kind:'business-operator',operatorId:'account-card-admin',role:'administrator',endpoint},reader={...admin,operatorId:'account-card-reader',role:'reader'},other={...admin,operatorId:'account-card-other'};
 for(const [index,id]of ids.entries()){
  await db.query("INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,'https://accounts.example.invalid',$4,'email',$5,$5)",[id,'G0000000000'+(index+1),index===2?foreign:endpoint,'PRIVATE_UPSTREAM_ACCOUNT_'+index,stamp(now())]);
  await db.query("INSERT INTO official_account_profiles_v1(account_id,display_name,subject_type,updated_at) VALUES($1,$2,'person',$3)",[id,['甲方账户','乙方账户','另站账户'][index],stamp(now())]);
 }
 for(const actor of [admin,reader,other])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.example.invalid',$1,'本地管理者',$3,$3)",[actor.operatorId,endpoint,stamp(now())]);
 const accounts=new BusinessAdminService({db,endpoint,now}),current=await attachOperationsFixtureAuthority({businessAdmin:accounts,admin,reader,permissions:['workbench.read','ai.use.governance','accounts.read']});current.roles.set(other.operatorId,'administrator');
 const authority=new OperationsAgentOsAuthority({db,endpoint,now,permissions:current.permissions}),tools=new OperationsAgentOsActionTools({authority,services:{accounts}}),authorize=async()=>admin,
  registry=new CommunityAccountRegistry({db,endpoint,now}),owner={kind:'official-account',accountId:ids[0],endpoint},
  request={kind:'account-restriction',targetId:ids[0],action:'apply',until:stamp(now()+3600),reason:'已核对本次具体参与限制'},prepare=(input=request,actor=admin,domain='governance')=>tools.prepareFor(actor,domain,input),
  card=proposal=>({cardId:randomUUID(),operationId:randomUUID(),kind:proposal.kind,domain:proposal.domain,target:proposal.target,title:proposal.title,impact:proposal.impact,basis:proposal.basis,requiredAction:proposal.requiredAction,capability:{canConfirm:true},state:'prepared',checkedAt:now(),readExpiresAt:now()+30});
 await attachAiWorkFixture({db:db,endpoint:endpoint,permissions:current.permissions,businessAdmin:accounts,authority,admin,domains:['governance','overview'],codes:["accounts.read","accounts.restriction.apply","accounts.restriction.release"],now:now});
 await attachAiWorkFixture({db:db,endpoint:endpoint,permissions:current.permissions,businessAdmin:accounts,authority,admin,domains:['messaging'],codes:[],now:now});
 await db.exec('SET ROLE galaxy_api');assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'galaxy_api');
 assert.deepEqual(workbenchActionCatalog.filter(item=>item.kind!=='file-access').map(item=>item.kind).sort((a,b)=>a<b?-1:a>b?1:0),['job-cancel','job-retry','search-retry','ai-role-command','ai-work-prompt-save','message-draft-create','message-draft-save','ordinary-strategy-draft','ordinary-strategy-publish','private-case-message','public-content-batch','recommendation-direction','content-visibility','content-curation','section-classification','section-visibility','resource-visibility','account-restriction','feedback-update','file-scan-retry','file-cleanup-approve','case-resolve','messaging-state','strategy-control','strategy-continue','search-apply','search-restore','rule-publish','rule-restore'].sort((a,b)=>a<b?-1:a>b?1:0));
 assert.deepEqual(workbenchActionCatalog.find(item=>item.kind===request.kind),{kind:'account-restriction',domain:'governance',label:'限制或解除单账户参与',read:'accounts.read',actions:['accounts.restriction.apply','accounts.restriction.release'],handler:{service:'accounts',methods:['get','restrict','releaseRestriction']},humanOnly:false,conditions:['ordinary','prior-automatic-decision']});
 for(const extra of [{expectedRevision:8},{operationId:randomUUID()},{role:'administrator'},{durationSeconds:3600},{path:'/arbitrary'},{scope:'all'}])assert.equal(workbenchPrepareSchemas[request.kind].safeParse({...request,...extra}).success,false);
 const {until:_until,...withoutUntil}=request;assert.equal(workbenchPrepareSchemas[request.kind].safeParse(withoutUntil).success,false);assert.equal(workbenchPrepareSchemas[request.kind].safeParse({...request,action:'release'}).success,false);
 assert.equal(workbenchPrepareSchemas[request.kind].safeParse({...request,until:'2099-01-01T00:00:00'}).success,false,'the deadline includes an explicit timezone');
 await assert.rejects(prepare({...request,until:stamp(now())}),{code:'operations_agentos_restriction_deadline'});
 await assert.rejects(prepare(request,admin,'messaging'),{code:'operations_permission_denied'});
 await assert.rejects(prepare({...request,targetId:ids[2]}),{code:'not_found'});
 await assert.rejects(prepare(request,{...reader,role:'administrator',businessAuthorization:{version:'forged',permissions:['accounts.restriction.apply']}}),{code:'operations_agentos_operation_unavailable'});
 await assert.rejects(prepare(request,owner),{code:'business_admin_denied'});
 await assert.rejects(prepare(request,{kind:'operations-executor',operatorId:'executor:'+randomUUID(),endpoint}),{code:'business_admin_denied'});
 const prepared=await prepare(),overview=await prepare(request,admin,'overview');assert.equal(overview.domain,'overview');assert.equal(prepared.requiredAction,'accounts.restriction.apply');assert.equal(prepared.decisionSource,'human-required');
 assert.deepEqual(prepared.command,{expectedRevision:0,reason:request.reason,until:request.until});assert.equal(prepared.target.href,'/admin/operations/users?account='+ids[0]+'&tab=restrictions');assert(prepared.target.label.includes('甲方账户'));assert(prepared.target.label.includes('G00000000001'));
 for(const text of ['帖子发布与修订','任务发布','评论','邀请','聊天发送与编辑','相关上传','不关闭登录','不删除已有内容',request.reason])assert(prepared.impact.some(line=>line.includes(text)),text);
 assert.equal(JSON.stringify(prepared).includes('PRIVATE_UPSTREAM_ACCOUNT'),false);assert.equal((await accounts.get(admin,ids[0])).account.restriction.revision,0,'prepare cannot restrict');
 const projected=workbenchActionCards([card(prepared)],'governance');assert.equal(projected.length,1);assert.deepEqual(projected[0].impact,prepared.impact);assert.equal(projected[0].target.href,prepared.target.href);assert(!JSON.stringify(projected).includes('expectedRevision'));
 assert.equal(workbenchCardReason('operations_agentos_restriction_changed'),'账户参与状态已有变化，请按当前内容重新准备。');
 const op=randomUUID();assert.equal((await tools.recoverPrepared(admin,prepared,op)).state,'not-recorded');
 await assert.rejects(tools.executePrepared(admin,prepared,{authorize:async()=>other,operationId:op}),{code:'business_admin_denied'});assert.equal((await accounts.get(admin,ids[0])).account.restriction.revision,0);
 const result=await tools.executePrepared(admin,prepared,{authorize,operationId:op});assert.equal(result.state,'completed');assert.equal(result.receipt.accountId,ids[0]);assert.equal(result.receipt.revision,1);assert.equal(result.receipt.restriction.until,request.until);assert(result.summary.includes('北京时间'));
 await assert.rejects(registry.runAuthorized(owner,'assistance',async()=>true,{resourceWrite:true}),{code:'community_restricted'});assert.equal(await registry.runAuthorized(owner,'assistance',async()=>true,{resourceWrite:true,control:true}),true);assert.equal(await registry.runAuthorized(owner,'binding',async()=>true),true);
 assert.equal((await tools.executePrepared(admin,prepared,{authorize,operationId:op})).receipt.replayed,true);assert.equal((await tools.recoverPrepared(admin,prepared,op)).state,'completed');
 const countEffects=async operationId=>(await db.query("SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND action IN ('restriction-set','restriction-release')",[endpoint,operationId])).rows[0].n;
 assert.equal(await countEffects(op),1);
 await assert.rejects(tools.recoverPrepared(other,prepared,op),{code:'operations_agentos_operation_conflict'});
 await assert.rejects(tools.recoverPrepared({...admin,endpoint:foreign},prepared,op),{code:'operations_agentos_ai_use_denied'});
 await assert.rejects(tools.recoverPrepared(admin,{...prepared,request:{...request,targetId:ids[1]}},op),{code:'operations_agentos_operation_conflict'});
 await assert.rejects(tools.recoverPrepared(admin,{...prepared,request:{...request,reason:'改变模型里的原处理原因'}},op),{code:'operations_agentos_operation_conflict'});
 await assert.rejects(tools.recoverPrepared(admin,{...prepared,command:{...prepared.command,expectedRevision:1}},op),{code:'operations_agentos_operation_conflict'});
 const altered={...prepared,request:{...request,reason:'不能用原ID改写处理原因'},command:{...prepared.command,reason:'不能用原ID改写处理原因'}};
 await assert.rejects(tools.recoverPrepared(admin,altered,op),{code:'operations_agentos_operation_conflict'});await assert.rejects(tools.executePrepared(admin,altered,{authorize,operationId:op}),{code:'business_admin_operation_conflict'});
 const releaseRequest={kind:'account-restriction',targetId:ids[0],action:'release',reason:'本次人工复核解除参与限制'},stale=await prepare(releaseRequest);assert.equal(stale.command.expectedRevision,1);assert.equal(Object.hasOwn(stale.command,'until'),false);
 await assert.rejects(tools.recoverPrepared(admin,stale,op),{code:'operations_agentos_operation_conflict'},'release cannot claim an apply receipt');
 await accounts.restrict(admin,ids[0],{operationId:randomUUID(),expectedRevision:1,until:stamp(now()+7200),reason:'另一项人工决定替换当前限制'});
 const staleOp=randomUUID();await assert.rejects(tools.executePrepared(admin,stale,{authorize,operationId:staleOp}),{code:'operations_agentos_restriction_changed'});assert.equal(await countEffects(staleOp),0);
 const release=await prepare(releaseRequest),releaseOp=randomUUID();assert.deepEqual(release.command,{expectedRevision:2,reason:releaseRequest.reason});assert.equal(workbenchActionCards([card(release)],'governance').length,1);
 const released=await tools.executePrepared(admin,release,{authorize,operationId:releaseOp});assert.equal(released.state,'completed');assert.equal(released.receipt.restriction.active,false);assert.equal(released.receipt.restriction.until,null);assert.equal(released.receipt.revision,3);
 assert.equal((await tools.executePrepared(admin,release,{authorize,operationId:releaseOp})).receipt.replayed,true);assert.equal((await tools.recoverPrepared(admin,release,releaseOp)).state,'completed');assert.equal(await countEffects(releaseOp),1);
 await assert.rejects(prepare(releaseRequest),{code:'operations_agentos_restriction_inactive'});await tools.recoverPrepared(admin,prepared,op);assert.equal((await accounts.get(admin,ids[0])).account.restriction.active,false,'reading an old apply receipt cannot restore a released restriction');
 // Current SQL grants are revoked before confirmation, outside any business transaction.
 const role=(await current.permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'本次账户参与处理',description:'',enabled:true,permissions:['accounts.restriction.apply','accounts.restriction.release']},{authorize})).role;
 let assignment=(await current.permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize})).assignment;
 const readerProposal=await prepare({...request,until:stamp(now()+1800)},reader),conversations=new AgentOsConversations({authority,client:null}),session=(await conversations.session(reader,'governance',{create:true})).row,
  cards=new AgentOsConversationTools({conversations,authority,services:{accounts}}),turnId=randomUUID(),callId=randomUUID(),cardId=randomUUID(),originalOp=randomUUID();
 conversations.tools=cards;
 await db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,'local-fixture','accepted','{}',$5)",[turnId,endpoint,session.id,reader.operatorId,stamp(now())]);
 await db.query("INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'local-run','local-call','prepare-operation','local-fixture','completed',$5,$5)",[callId,endpoint,session.id,turnId,stamp(now())]);
 await db.query("INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'governance',$7,'local-fixture',$8,'prepared',$9,$9)",[cardId,endpoint,session.id,turnId,callId,reader.operatorId,originalOp,JSON.stringify(readerProposal),stamp(now())]);
 assignment=(await current.permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:role.id,enabled:false},{authorize})).assignment;
 await assert.rejects(cards.confirm(reader,'governance',cardId,{cardId,operationId:originalOp},{authorize:async()=>reader}),{code:'operations_permission_denied'});
 assert.equal(await countEffects(originalOp),0,'a stale actor and original card cannot bypass a committed revocation');
 assert.equal((await db.query('SELECT state FROM operations_agentos_conversation_cards_v1 WHERE id=$1',[cardId])).rows[0].state,'prepared');
 assert.equal(session.ai_account_id!==null,true,'the persisted conversation retains its actual AI position');
 await current.permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize});
 const completed=await cards.confirm(reader,'governance',cardId,{cardId,operationId:originalOp},{authorize:async()=>reader});assert.equal(completed.state,'completed');assert.equal(completed.result.operationId,originalOp);assert.equal(await countEffects(originalOp),1);
 assert.equal((await cards.card(reader,'governance',cardId)).state,'completed');await cards.confirm(reader,'governance',cardId,{cardId,operationId:originalOp},{authorize:async()=>reader});assert.equal(await countEffects(originalOp),1,'same original GET and confirmation never reapply the business effect');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_automation_grants_v1')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_agentos_executions_v1')).rows[0].n,0);
});
