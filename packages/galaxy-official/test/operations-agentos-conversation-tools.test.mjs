import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {OperationsAgentOsService} from '../src/operations-agentos.mjs';
import {OperationsAgentOsGateway} from '../src/operations-agentos-gateway.mjs';
import {dispatchOperationsAgentOs} from '../src/adapters/http/operations-agentos-http.mjs';
import {bindOperationsAiUse,withOperationsAiWork} from '../src/shared/operations-ai-use.mjs';
import {operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

test('114 real SQL binds early native tool calls to their original turn, stores metadata, renews controlled context and recovers the exact human card',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const operator={kind:'business-operator',operatorId:'typed-tools-reader',endpoint:f.endpoint,businessAuthorization:{version:'1',permissions:['workbench.read','content.read','feedback.read','feedback.update']}},permissions=new Set(operator.businessAuthorization.permissions);
 const aiAccountId=randomUUID(),resolve=async()=>({accountId:aiAccountId,domain:'overview',enabled:true,
  permissions:[...permissions],roleVersions:[]});
 const authority={db:f.db,endpoint:f.endpoint,now:f.now,
  async human(actor,{action='workbench.read',purpose='conversation'}={}){
   if(actor.operatorId!==operator.operatorId||!permissions.has(action))throw Object.assign(new Error('explicit denied fixture'),{code:'operations_permission_denied',status:403});
   return withOperationsAiWork(bindOperationsAiUse({...operator},'overview'),{accountId:aiAccountId,purpose,resolve});
  }};

 await f.db.query("INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','SQL context fixture','',true,1,1,$3,$3)",[aiAccountId,f.endpoint,new Date(f.now()*1000)]);
 const runId=randomUUID(),turnId=randomUUID();let early=null;
 // Only the engine transport and individual domain adapters are doubles here.
 // All conversation/command/tool/card/source SQL and HTTP are actual product.
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['overview'],conversationVersion:2,conversationDomains:['overview']};},async readConversation(){return{runs:[],readExpiresAt:f.now()+30};},async runConversation(row,input){early=await gateway.execute({conversationId:row.id,sessionId:row.sessionId,turnId:input.runId,runId,callId:'early-query',tool:'query-operations',arguments:{module:'content',view:'list',filters:{}}});return{run_id:runId};}};
 const service=new OperationsAgentOsService({authority,client}),gateway=new OperationsAgentOsGateway({authority,serviceKey:'explicit-synthetic-private-test-key-not-production'});
 service.connectConversationTools({gateway,services:{}});const tools=service.conversations.tools;
 let sourceValid=true;const targetId=randomUUID();
 tools.query.execute=async()=>({availability:'available',data:{body:'CONTROLLED_BODY_NOT_A_TOOL_LEDGER'},evidenceRefs:[{kind:'post',id:targetId,version:1,purpose:'public-content',controlledSource:true,read:{tool:'read-operation-object',arguments:{kind:'post',id:targetId,filters:{}}}}]});
 tools.query.revalidate=async()=>({valid:sourceValid,refs:[],invalidRefs:[]});
 await service.conversationRun(operator,'overview',{operationId:turnId,message:'合成跨模块查询'},{authorize:async()=>operator});assert.equal(early.data.body,'CONTROLLED_BODY_NOT_A_TOOL_LEDGER');
 const context=(await service.conversations.session(operator,'overview')).row;
 const envelope={conversationId:context.id,sessionId:context.session_id,turnId,runId,callId:'second-query',tool:'query-operations',arguments:{module:'content',view:'list',filters:{}}};
 await assert.rejects(gateway.execute({...envelope,runId:randomUUID()}),{code:'operations_agentos_scope_denied'});
 await assert.rejects(gateway.execute({...envelope,sessionId:randomUUID()}),{code:'operations_agentos_scope_denied'});
 await assert.rejects(gateway.execute({...envelope,turnId:randomUUID()}),{code:'operations_agentos_scope_denied'});
 await assert.rejects(gateway.execute({...envelope,role:'administrator'}),{code:'invalid_operations_agentos_request'});
 const ledger=await f.db.query('SELECT * FROM operations_agentos_conversation_tool_calls_v1');assert.equal(ledger.rows.length,1);assert.equal(JSON.stringify(ledger.rows).includes('CONTROLLED_BODY_NOT_A_TOOL_LEDGER'),false);
 const proposal={schemaVersion:1,kind:'feedback-update',domain:'overview',request:{kind:'feedback-update',targetId,state:'processing'},command:{expectedRevision:1,state:'processing'},target:{kind:'feedback',id:targetId,label:'合成反馈',href:'/admin/operations/feedback?id='+targetId},title:'标记这条反馈',impact:['设为处理中'],basis:[{label:'当前状态',value:'待处理'}],requiredAction:'feedback.update',checkedAt:f.now(),readExpiresAt:f.now()+30};
 tools.actions.prepareFor=async()=>structuredClone(proposal);
 let effects=0,recorded=null;tools.actions.executePrepared=async(_actor,_proposal,{operationId})=>{effects++;recorded={operationId,state:'completed',summary:'合成效果已完成。'};throw Object.assign(new Error('explicit lost effect ACK'),{code:'operations_agentos_result_unknown',status:503});};
 tools.actions.recoverPrepared=async()=>recorded??{state:'not-recorded'};
 const prepared=await gateway.execute({...envelope,callId:'prepare-feedback',tool:'prepare-operation',arguments:proposal.request});assert.equal(prepared.card.state,'prepared');assert.equal(prepared.card.capability.canConfirm,true);assert.equal(JSON.stringify(prepared).includes('expectedRevision'),false);
 const duplicate=await gateway.execute({...envelope,callId:'prepare-feedback-again',tool:'prepare-operation',arguments:proposal.request});assert.equal(duplicate.card.cardId,prepared.card.cardId);
 const input={cardId:prepared.card.cardId,operationId:prepared.card.operationId};
 assert.equal((await tools.confirm(operator,'overview',input.cardId,input,{authorize:async()=>operator})).state,'unknown');assert.equal(effects,1);
 assert.equal((await tools.card(operator,'overview',input.cardId)).state,'completed');
 assert.equal((await tools.confirm(operator,'overview',input.cardId,input,{authorize:async()=>operator})).state,'completed');assert.equal(effects,1);
 await assert.rejects(tools.confirm(operator,'overview',input.cardId,{...input,operationId:randomUUID()},{authorize:async()=>operator}),{code:'operations_agentos_operation_conflict'});
 permissions.delete('feedback.update');assert.equal((await tools.card(operator,'overview',input.cardId)).state,'completed');await assert.rejects(tools.confirm(operator,'overview',input.cardId,input,{authorize:async()=>operator}),{code:'operations_permission_denied'});permissions.add('feedback.update');
 sourceValid=false;const fresh=await service.conversations.session(operator,'overview',{create:true});assert.notEqual(fresh.row.session_id,context.session_id);assert.equal(fresh.contextChanged,true);
 await assert.rejects(gateway.execute({...envelope,callId:'old-context'}),{code:'operations_agentos_source_changed'});
 assert.equal((await service.conversationOperation(operator,'overview',turnId)).state,'context-changed');
 assert.equal((await tools.cards(operator,'overview'))[0].state,'completed');
 assert.equal((await f.db.query('SELECT count(*)::int AS count FROM operations_automation_grants_v1')).rows[0].count,0);
});

test('human card HTTP and BFF close paths and bodies while retaining current-session CSRF',async()=>{
 const id=randomUUID(),op=randomUUID(),prefix='/v1/operations/agentos/conversations/overview/cards/'+id,calls=[];
 const actor={operatorId:'explicit-reader',endpoint:'https://official.invalid'},service={async conversationCard(){return{cardId:id,operationId:op,state:'prepared'};},async conversationConfirm(operator,domain,cardId,input,{authorize}){assert.equal((await authorize()).operatorId,actor.operatorId);calls.push(input);return{cardId,operationId:op,state:'completed'};}};
 const route=async(method,path,input)=>{let result;const request=Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]);request.method=method;request.headers={'content-type':'application/json'};
  await dispatchOperationsAgentOs({operationsAgentOs:service,request,url:new URL(path,'https://admin.invalid'),authorizeOperator:async(_request,options)=>{assert.equal(options.action,'workbench.read');assert.equal(options.write,false);assert.equal(options.csrf,method==='POST');return actor;},send:(_status,value)=>result=value});return result;};
 assert.equal((await route('GET',prefix)).state,'prepared');assert.equal((await route('POST',prefix+'/confirm',{cardId:id,operationId:op})).state,'completed');assert.equal(calls.length,1);
 await assert.rejects(route('POST',prefix,{}),{code:'not_found'});await assert.rejects(route('GET',prefix+'?action=hide'),{code:'not_found'});
 const proxy=(method,path)=>operationsProxyPolicy({method,url:'https://admin.invalid'+path,publicOrigin:'https://admin.invalid',headers:new Headers({origin:'https://admin.invalid'})}).allowed;
 assert.equal(proxy('GET',prefix),true);assert.equal(proxy('POST',prefix+'/confirm'),true);assert.equal(proxy('POST',prefix),false);assert.equal(proxy('GET',prefix+'?action=hide'),false);assert.equal(proxy('POST','/v1/internal/agentos/tools/execute'),false);
});
