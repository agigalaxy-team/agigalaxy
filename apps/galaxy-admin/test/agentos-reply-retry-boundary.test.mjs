import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeConversationFailure,nativeConversationRetryMessage} from "../src/lib/workbench/agentos-client.ts";

test('a new explicit question requires a current bound terminal model failure and positive unstarted ledger evidence',()=>{
 const run={runId:'11111111-1111-4111-8111-111111111111',operationId:'22222222-2222-4222-8222-222222222222',status:'ERROR',content:null,userInput:'  查询当前公开汇总，不作修改。\n',createdAt:1,events:[],awaitingHuman:false,errorCode:'operations_agentos_model_request_failed',failure:{stage:'model-request',category:'timeout',reportedStatus:408,body:'PRIVATE_PROVIDER_CANARY'},businessActivity:{state:'not-started',basis:'same-owner-turn-tool-and-card-ledger'}};
 const conversation={domain:'governance',runs:[run],runtimeState:'connected',modelState:'configured',blockedReason:null,capabilities:{canSend:true},checkedAt:1,readExpiresAt:31};
 assert.equal(nativeConversationFailure(run).canRetry,true);
 assert.equal(nativeConversationRetryMessage(conversation,run.runId),run.userInput,'preserve the exact original question, not a reconstructed command');
 const denied=[{status:'RUNNING'},{status:'COMPLETED'},{status:'CANCELLED'},{operationId:null},{operationId:'not-an-original-operation'},{runId:''},{userInput:''},{userInput:'x'.repeat(12001)},{businessActivity:undefined},{businessActivity:{state:'unknown',basis:'same-owner-turn-tool-and-card-ledger'}},{businessActivity:{state:'check-records',basis:'same-owner-turn-tool-and-card-ledger'}},{businessActivity:{state:'not-started',basis:'untrusted'}},{errorCode:'operations_agentos_run_failed',failure:null},{errorCode:'operations_agentos_authority_changed'},{errorCode:'operations_authorization_unavailable'},{failure:{stage:'model-request',category:'context-limit',reportedStatus:422}},{failure:{stage:'model-request',category:'request-rejected',reportedStatus:401}}];
 for(const patch of denied){const current={...run,...patch};assert.equal(nativeConversationFailure(current).canRetry,false,JSON.stringify(patch));assert.equal(nativeConversationRetryMessage({...conversation,runs:[current]},current.runId),null);}
 for(const current of [null,{...conversation,capabilities:{canSend:false}},{...conversation,contextChanged:true},{...conversation,runs:[]},{...conversation,runs:[{...run,status:'RUNNING'}]}])assert.equal(nativeConversationRetryMessage(current,run.runId),null,'stale rendered error cannot grant a new request');
 const legacy=nativeConversationFailure({...run,errorCode:'operations_agentos_run_failed',failure:null,businessActivity:undefined});assert.equal(legacy.title,'回复失败');assert.equal(legacy.canRetry,false);assert.match(legacy.processingNotice,/待确认/);
 const business=nativeConversationFailure({...run,businessActivity:{state:'check-records',basis:'same-owner-turn-tool-and-card-ledger'}});assert.match(business.processingNotice,/已有处理记录/);assert.equal(business.canRetry,false);
 assert.doesNotMatch(JSON.stringify(nativeConversationFailure(run)),/PRIVATE_PROVIDER_CANARY|408/,'never expose provider prose or technical status as user-facing diagnosis');
});
