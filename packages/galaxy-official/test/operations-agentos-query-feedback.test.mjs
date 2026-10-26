import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AgentOsConversationTools} from "../src/operations/agentos/conversation-tools.mjs";
import {ServiceError} from '../src/shared/service-error.mjs';

// Actual bind/execute/query schema and adapter; transaction/ledger, current
// conversation and domain service I/O are explicit in-memory doubles.
test('conversation query schema failures return bounded correction feedback while preserving current authority and service errors',async()=>{
 const now=2000000000,endpoint='https://query-feedback.example.invalid',operatorId='synthetic-manager',
  actor={kind:'business-operator',operatorId,endpoint},conversationId=randomUUID(),sessionId=randomUUID(),turnId=randomUUID(),runId=randomUUID(),
  row={id:conversationId,domain:'overview',session_id:sessionId},ledger=new Map(),updates=[];
 let checks=0,denyOnCheck=null,serviceCalls=0,serviceError=null;
 const db={transaction:async operation=>operation(db),query:async(sql,args)=>{
  if(sql.startsWith('SELECT * FROM operations_agentos_conversation_commands_v1'))return{rows:[{id:turnId,conversation_id:conversationId,operator_id:operatorId,state:'accepted',native_run_id:runId}]};
  if(sql.startsWith('INSERT INTO operations_agentos_conversation_tool_calls_v1')){
   const [id,,conversation,turn,nativeRun,callId,tool,argumentsDigest]=args;
   if(!ledger.has(callId))ledger.set(callId,{id,conversation_id:conversation,turn_id:turn,native_run_id:nativeRun,call_id:callId,tool,arguments_digest:argumentsDigest,state:'started'});
   return{rows:[]};
  }
  if(sql.startsWith('SELECT * FROM operations_agentos_conversation_tool_calls_v1'))return{rows:[ledger.get(args[3])]};
  if(sql.startsWith('UPDATE operations_agentos_conversation_tool_calls_v1')){
   const saved=[...ledger.values()].find(value=>value.id===args[1]);
   saved.state=sql.includes("state='completed'")?'completed':'unavailable';saved.metadata=JSON.parse(args[2]);updates.push(saved.metadata);return{rows:[]};
  }
  assert.fail('Unexpected ledger operation');
 }},
  current=async id=>{assert.equal(id,conversationId);checks++;if(checks===denyOnCheck)throw new ServiceError('operations_permission_denied',403);return{row,actor};},
  authority={db,endpoint,now:()=>now,human:async(value,{action})=>{assert.equal(value,actor);assert(['workbench.read','accounts.read'].includes(action));return value;}},
  services={accounts:{list:async()=>{serviceCalls++;if(serviceError)throw serviceError;return{items:[],nextAfter:null,readExpiresAt:now+30};}}},
  tools=new AgentOsConversationTools({conversations:{current,async boundedTaskWithin(_db,value,command){assert.equal(value,row);assert.equal(command.id,turnId);}},authority,gateway:{},services}),
  execute=(tool,args)=>tools.execute({conversationId,sessionId,turnId,runId,callId:randomUUID(),tool,arguments:args});

 const invalid={module:'content',view:'list',filters:{days:30,query:'PRIVATE_SEARCH_WORD',unknownField:'PRIVATE_EMAIL_OR_BODY'}};
 const feedback=await execute('query-operations',invalid);
 assert.equal(feedback.state,'invalid-request');assert.equal(feedback.code,'invalid_operations_agentos_query');
 assert.equal(feedback.nextStep,'correct-arguments');assert.equal(feedback.effectExecuted,false);
 assert.equal(feedback.module,'content');assert.equal(feedback.view,'list');
 assert(feedback.allowedFilterKeys.includes('days'));assert(!feedback.allowedFilterKeys.includes('unknownField'));
 assert.deepEqual(feedback.filterEnums.days,[7,28,'all']);assert.deepEqual(feedback.filterEnums.kind,['post','reply']);
 assert.deepEqual(feedback.filterNumberRanges.limit,{minimum:1,maximum:100,integer:true});
 assert(feedback.issues.some(issue=>issue.path[0]==='filters'&&issue.path[1]==='days'));
 assert.equal(checks,2,'current conversation is rechecked before correction feedback leaves the wrapper');
 assert.equal(serviceCalls,0,'schema rejection precedes business-service I/O');
 assert.deepEqual(updates.at(-1),{tool:'query-operations',code:'invalid_operations_agentos_query',module:'content',view:'list',filterKeys:['days','query']});
 assert(!JSON.stringify([feedback,updates]).includes('PRIVATE_'));
 assert(!JSON.stringify([feedback,updates]).includes('unknownField'));
 await assert.rejects(tools.query.execute({actor,domain:'overview',tool:'query-operations',arguments:invalid}),{code:'invalid_operations_agentos_query'},'direct query adapter keeps strict parse/throw behavior');

 const missing=await execute('query-operations',{module:'messaging',view:'recipients',filters:{channel:'email'}});
 assert(missing.requiredFilterKeys.includes('runId'));assert.deepEqual(missing.filterEnums.channel,['inapp','email']);
 const badView=await execute('query-operations',{module:'rules',view:'list',filters:{}});
 assert.deepEqual(badView.allowedViews,['overview','versions']);assert.equal(badView.view,null);
 const badModule=await execute('query-operations',{module:'PRIVATE_MODULE_VALUE',view:'PRIVATE_VIEW_VALUE',filters:{sql:'PRIVATE_SQL_VALUE'}});
 assert.equal(badModule.module,null);assert.equal(badModule.view,null);assert(badModule.allowedModules.includes('accounts'));
 assert(!JSON.stringify([badModule,updates]).includes('PRIVATE_'));
 const nonStringModule=await execute('query-operations',{module:['accounts'],view:'list',filters:{}});
 assert.equal(nonStringModule.module,null,'only exact declared string module values may reach feedback metadata');
 const badRead=await execute('read-operation-object',{kind:'account-summary',id:randomUUID(),filters:{days:30}});
 assert.equal(badRead.kind,'account-summary');assert.deepEqual(badRead.allowedFilterKeys,['days']);assert.deepEqual(badRead.filterEnums.days,[7,28]);

 denyOnCheck=checks+2;
 await assert.rejects(execute('query-operations',invalid),{code:'operations_permission_denied'});
 assert.equal(updates.at(-1).code,'operations_permission_denied');denyOnCheck=null;
 const valid={module:'accounts',view:'list',filters:{}};
 for(const [code,status]of [['invalid_operations_agentos_query',400],['invalid_feedback_request',400],['operations_permission_denied',403],['operations_query_response_invalid',503],['operations_agentos_source_changed',409]]){
  serviceError=new ServiceError(code,status);
  await assert.rejects(execute('query-operations',valid),{code,status},'valid input service exceptions retain their original semantics');
 }
 serviceError=null;
 const normal=await execute('query-operations',valid);assert.equal(normal.availability,'available');assert.deepEqual(normal.data.items,[]);
 assert.equal(updates.at(-1).state,'available');assert(!JSON.stringify(updates).includes('PRIVATE_'));
});
