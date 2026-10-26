import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AgentOsConversations} from "../src/operations/agentos/conversations.mjs";
import {AgentOsConversationTools} from "../src/operations/agentos/conversation-tools.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';
import {bindOperationsAiUse,withOperationsAiWork} from '../src/shared/operations-ai-use.mjs';
import {operationsAgentOsConversationsMigrationSql} from '../src/infrastructure/operations-agentos-conversations-v1-schema.mjs';
import {operationsAgentOsConversationToolsMigrationSql} from '../src/infrastructure/operations-agentos-conversation-tools-v1-schema.mjs';
import {workbenchCardFact,workbenchRunFact} from "../src/operations/agentos/duty-workbench.mjs";

test('new workbench turns project original native facts without changing session authority or replaying after a projection failure',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(operationsAgentOsConversationsMigrationSql);await db.exec(operationsAgentOsConversationToolsMigrationSql);await db.exec('ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN ai_account_id uuid');
 const endpoint='https://local-workbench-projection.invalid',owner='local-workbench-owner',aiId=randomUUID(),at=1988193660,modelId=randomUUID();let dispatches=0,projectionUnavailable=true;
 const actor=()=>withOperationsAiWork(bindOperationsAiUse({kind:'business-operator',operatorId:owner,endpoint,businessAuthorization:{version:'1',permissions:['workbench.read','ai.use.overview']}},'overview'),{accountId:aiId,purpose:'query',resolve:async()=>({accountId:aiId,domain:'overview',enabled:true,permissions:[],roleVersions:[]})});
 const authority={db,endpoint,now:()=>at,async human(input){assert.equal(input.operatorId,owner);return actor();}};
 const source={runId:modelId,operationId:null,status:'RUNNING',content:'source reply retained by original conversation',createdAt:at,events:[],usage:{calls:3,inputTokens:41,outputTokens:19,totalTokens:60,durationMs:2200}};
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['overview'],conversationVersion:2,conversationDomains:['overview']};},async runConversation(){dispatches++;return{run_id:modelId,status:'PENDING'};},async readConversation(){return{runs:[{...source}],readExpiresAt:at+30};}};
 const service=new AgentOsConversations({authority,client}),tasks=new Map();
 service.autonomy={async linkWorkbenchWithin(tx,value){
  assert.equal((await tx.query('SELECT id FROM operations_agentos_conversation_commands_v1 WHERE id=$1',[value.operationId])).rows.length,1);
  tasks.set(value.operationId,structuredClone(value));
 },async updateWorkbenchWithin(tx,value){
  if(projectionUnavailable)throw Error('explicit projection outage');
  if(!tasks.has(value.operationId))return null;
  tasks.set(value.operationId,{...tasks.get(value.operationId),...structuredClone(value)});
 }};
 const id=randomUUID(),accepted=await service.run(actor(),'overview',{operationId:id,message:'查看实际待办'},{authorize:async()=>actor()});
 assert.equal(accepted.state,'accepted');assert.equal(accepted.runId,modelId);assert.equal(dispatches,1);
 const saved=(await db.query('SELECT result,native_run_id FROM operations_agentos_conversation_commands_v1 WHERE id=$1',[id])).rows[0];
 assert.equal(saved.result.state,'accepted');assert.equal(saved.native_run_id,modelId,'New projection failure never destroys the committed original ACK');
 assert.equal(tasks.get(id).modelState,'not-started');assert.equal(tasks.get(id).operatorId,owner);assert.ok(tasks.get(id).conversationId);assert.ok(tasks.get(id).sessionId);
 projectionUnavailable=false;source.status='COMPLETED';
 const read=await service.read(actor(),'overview');assert.equal(read.runs[0].content,source.content);
 assert.equal(tasks.get(id).modelState,'completed');assert.deepEqual(tasks.get(id).usage,source.usage);
 await service.operation(actor(),'overview',id);assert.equal(dispatches,1,'Original result reads never submit another model run');assert.deepEqual(tasks.get(id).usage,source.usage,'Usage is a complete snapshot, not added again on each read');
 assert.equal(tasks.get(id).businessReceipt,undefined,'Model completion is not a business receipt');
});

test('workbench card projection retains human waits and requires the original concrete receipt for business completion',()=>{
 const turn=randomUUID(),operationId=randomUUID(),targetId=randomUUID();
 const card={turn_id:turn,operation_id:operationId,state:'prepared',proposal:{kind:'content-curation',target:{kind:'post',id:targetId}},result:null};
 assert.deepEqual(workbenchCardFact(card),{status:'waiting-human'});
 assert.equal(workbenchCardFact({...card,state:'completed',result:{operationId,state:'completed'}}),null,'A completed flag without a domain receipt cannot prove success');
 const recorded=workbenchCardFact({...card,state:'completed',result:{operationId,state:'completed',receipt:{id:targetId,revision:2}}});
 assert.deepEqual(recorded.businessReceipt,{operationId,action:'content-curation',targetType:'content-post',targetId,state:'completed',basis:'workbench-original-domain-receipt'});
 assert.equal(workbenchCardFact({...card,state:'completed',result:{operationId:randomUUID(),state:'completed',receipt:{id:targetId}}}),null);
 assert.equal(workbenchCardFact({...card,state:'unknown',result:{operationId,state:'unknown'}}).businessReceipt.state,'unknown');
 assert.equal(workbenchRunFact({runId:'original',status:'COMPLETED'}).usage.totalTokens,null);
});

test('an explicit original task stays on the human conversation and its concrete card receipt without becoming a duty grant',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(operationsAgentOsConversationsMigrationSql);await db.exec(operationsAgentOsConversationToolsMigrationSql);await db.exec('ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN ai_account_id uuid');
 const endpoint='https://bounded-workbench.invalid',owner='bounded-owner',aiId=randomUUID(),taskId=randomUUID(),targetId=randomUUID(),at=1988193660;
 const actor=()=>withOperationsAiWork(bindOperationsAiUse({kind:'business-operator',operatorId:owner,endpoint,businessAuthorization:{version:'1',permissions:['workbench.read','ai.use.overview','content.read','content.curate']}},'overview'),{accountId:aiId,purpose:'query',resolve:async()=>({accountId:aiId,domain:'overview',enabled:true,permissions:['content.read','content.curate'],roleVersions:[]})});
 const authority={db,endpoint,now:()=>at,async human(input){assert.equal(input.operatorId,owner);return actor();}};
 const runs=[],bindings=[],updates=[],preparedIds=[];let dispatches=0,writes=0,active=true;
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['overview'],conversationVersion:2,conversationDomains:['overview']};},
  async runConversation(view,value){dispatches++;const run={runId:randomUUID(),operationId:value.runId,status:'COMPLETED',content:'本轮等待具体卡确认',createdAt:at,events:[],usage:{calls:2,inputTokens:22,outputTokens:8,totalTokens:30,durationMs:200}};runs.push(run);return{run_id:run.runId,status:'PENDING'};},async readConversation(){return{runs,readExpiresAt:at+30};}};
 const service=new AgentOsConversations({authority,client});
 const bound={taskId,goal:'按原策略核对这项公开内容',purpose:'operations-overview',planVersion:3,promptVersion:2,strategyIds:[randomUUID()],targetType:'strategy',targetId:randomUUID(),actions:['content.curate','content.hide'],resourceScope:{kind:'selected'},resourceIds:[targetId]};
 service.autonomy={async linkWorkbenchWithin(){assert.fail('A bounded turn must link the original task, not create another task');},async bindWorkbenchTaskWithin(tx,value){
  if(!active)throw new ServiceError('operations_autonomy_workbench_task_inactive',409);
  assert.equal(value.taskId,taskId);assert.equal(value.operatorId,owner);assert.equal(value.aiAccountId,aiId);assert.equal(value.domain,'overview');
  assert.equal((await tx.query('SELECT result FROM operations_agentos_conversation_commands_v1 WHERE id=$1',[value.turnOperationId])).rows[0].result.taskId,taskId);
  bindings.push(value);return bound;
 },async updateWorkbenchWithin(tx,value){assert.equal(value.operationId,taskId);updates.push(structuredClone(value));}};
 const tools=new AgentOsConversationTools({conversations:service,authority,services:{}});service.tools=tools;
 tools.actions={async prepareFor(operator,domain,request,options){assert.equal(operator.kind,'business-operator');assert.match(options.operationId,/^[0-9a-f-]{36}$/);preparedIds.push(options.operationId);return{schemaVersion:1,domain,kind:'content-curation',request,command:{expectedVersion:1,pinned:true},target:{kind:'post',id:targetId,label:'原对象',href:null},requiredAction:'content.curate',title:'本次具体处理',basis:[],impact:[],readExpiresAt:at+30};},
  async executePrepared(operator,proposal,{authorize,operationId}){assert.equal(operator.kind,'business-operator');await authorize();writes++;return{operationId,state:'completed',receipt:{id:targetId,revision:2}};}};
 tools.query={async execute(){return{data:{publiclyReadable:true,title:'原对象'},readExpiresAt:at+30};}};
 const turn=randomUUID(),accepted=await service.run(actor(),'overview',{operationId:turn,message:'接续这项任务，核对原对象后准备具体确认卡',taskId},{authorize:async()=>actor()});
 assert.equal(accepted.taskId,taskId);assert.equal(dispatches,1);
 const session=(await service.session(actor(),'overview')).row;
 assert.deepEqual(await service.boundedTaskFor(actor(),{conversationId:session.id,turnId:turn}),bound);
 await assert.rejects(service.run(actor(),'overview',{operationId:turn,message:'接续这项任务，核对原对象后准备具体确认卡',taskId:randomUUID()},{authorize:async()=>actor()}),{code:'operations_agentos_operation_conflict'});
 await assert.rejects(service.assertBoundedProposal(session.id,turn,{requiredAction:'content.curate',target:{id:randomUUID()}}),{code:'operations_autonomy_workbench_scope_denied'});
 await assert.rejects(service.assertBoundedProposal(session.id,turn,{kind:'public-content-batch',requiredAction:'content.hide',target:{id:targetId},request:{items:[{kind:'post',id:targetId},{kind:'reply',id:randomUUID()}]}}),{code:'operations_autonomy_workbench_scope_denied'});
 const prepared=await tools.execute({conversationId:session.id,sessionId:session.session_id,turnId:turn,runId:accepted.runId,callId:'bounded-prepare',tool:'prepare-operation',arguments:{kind:'content-curation',targetKind:'post',targetId,pinned:true,reason:'按本任务准备'}});
 assert.equal(prepared.state,'prepared');assert.equal(writes,0);assert.equal(prepared.card.capability.canConfirm,true);
 const confirm={cardId:prepared.card.cardId,operationId:prepared.card.operationId};
 const completed=await tools.confirm(actor(),'overview',confirm.cardId,confirm,{authorize:async()=>actor()});
 assert.equal(completed.state,'completed');assert.equal(writes,1);
 await tools.confirm(actor(),'overview',confirm.cardId,confirm,{authorize:async()=>actor()});assert.equal(writes,1);
 assert.ok(preparedIds.length>=2);assert.ok(preparedIds.every(id=>id===confirm.operationId),'Preparation and revalidation share the stored original operation, including draft-create target identity');
 const receipt=updates.find(value=>value.businessReceipt?.operationId===confirm.operationId);
 assert.equal(receipt.operationId,taskId);assert.equal(receipt.turnOperationId,turn);assert.equal(receipt.businessReceipt.basis,'workbench-original-domain-receipt');
 await service.operation(actor(),'overview',turn);assert.equal(updates.find(value=>value.usage?.calls===2).turnOperationId,turn);
 active=false;await assert.rejects(service.boundedTaskFor(actor(),{conversationId:session.id,turnId:turn}),{code:'operations_autonomy_workbench_task_inactive'});
 assert.equal(dispatches,1);assert.ok(bindings.length>1);
});
