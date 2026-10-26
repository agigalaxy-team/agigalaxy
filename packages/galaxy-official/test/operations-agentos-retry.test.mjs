import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AgentOsConversations} from "../src/operations/agentos/conversations.mjs";
import {operationsAgentOsConversationsMigrationSql} from '../src/infrastructure/operations-agentos-conversations-v1-schema.mjs';

test('retry is owner-bound, keeps an original parent and dispatches one native regeneration',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(operationsAgentOsConversationsMigrationSql+'ALTER TABLE operations_agentos_conversation_commands_v1 ADD COLUMN native_run_id text;');
 const endpoint='https://isolated-retry.invalid',operator={endpoint,operatorId:'local-manager'},now=()=>2000000000;
 const row={id:randomUUID(),session_id:randomUUID(),operator_id:operator.operatorId,domain:'overview',permission_key:'local'};
 await db.query('INSERT INTO operations_agentos_conversations_v1(id,endpoint,operator_id,domain,permission_key,session_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,endpoint,operator.operatorId,row.domain,row.permission_key,row.session_id,new Date(now()*1000)]);
 const parent=randomUUID(),message='核对原来的问题。',nativeId=randomUUID(),digest=createHash('sha256').update(message).digest('hex');
 await db.query('INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[parent,endpoint,row.id,operator.operatorId,digest,'accepted',JSON.stringify({runId:nativeId}),nativeId,new Date(now()*1000)]);
 let dispatches=0,activity='not-started';const calls=[];
 const client={async status(){return {state:'connected',modelState:'configured',configuredDomains:['overview'],conversationVersion:2,conversationDomains:['overview']};},
  async runConversation(conversation,input){dispatches++;calls.push(input);return {run_id:randomUUID()};}};
 class FocusedConversations extends AgentOsConversations{
  async session(){return {row};}
  async current(){return {row};}
  async nativeOperation(){return {runId:nativeId,status:'ERROR',operationId:parent,userInput:message,errorCode:'operations_agentos_model_request_failed',failure:{stage:'model-request',category:'service-unavailable'}};}
  async failureActivities(_row,runs){return runs.map(run=>({...run,businessActivity:{state:activity,basis:'same-owner-turn-tool-and-card-ledger'}}));}
 }
 const authority={db,endpoint,now,async human(actor){assert.equal(actor.operatorId,operator.operatorId);}};
 const service=new FocusedConversations({authority,client}),authorize=async()=>operator;
 for(const input of [{operationId:randomUUID(),message:'别的问题',retryOfOperationId:parent},{operationId:randomUUID(),message,retryOfOperationId:randomUUID()}])
  await assert.rejects(service.run(operator,'overview',input,{authorize}),{code:'operations_agentos_retry_unavailable'});
 activity='check-records';
 await assert.rejects(service.run(operator,'overview',{operationId:randomUUID(),message,retryOfOperationId:parent},{authorize}),{code:'operations_agentos_retry_unavailable'});
 assert.equal(dispatches,0);activity='not-started';
 const results=await Promise.allSettled([1,2].map(()=>service.run(operator,'overview',{operationId:randomUUID(),message,retryOfOperationId:parent},{authorize})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='operations_agentos_retry_already_requested').length,1);
 assert.equal(dispatches,1);assert.equal(calls[0].retryOfRunId,nativeId);assert.equal(calls[0].retryOfOperationId,parent);
 const saved=(await db.query("SELECT result FROM operations_agentos_conversation_commands_v1 WHERE result->>'retryOfOperationId'=$1",[parent])).rows;
 assert.equal(saved.length,1);assert.equal(saved[0].result.priorFailure.status,'ERROR');
});
