import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AgentOsConversations} from '../src/operations-agentos-conversations.mjs';
import {bindOperationsAiUse,withOperationsAiWork} from '../src/shared/operations-ai-use.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsAgentOsConversationsMigrationSql} from '../src/infrastructure/operations-agentos-conversations-v1-schema.mjs';
import {operationsAgentOsConversationToolsMigrationSql} from '../src/infrastructure/operations-agentos-conversation-tools-v1-schema.mjs';

test('one durable turn and one stop intent survive lost ACK/read recovery without a second effect, while streams recheck current owner and lease',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(operationsAgentOsConversationsMigrationSql);await db.exec(operationsAgentOsConversationToolsMigrationSql);await db.exec('ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN ai_account_id uuid');
 const endpoint='https://stream.synthetic.invalid',owner='stream-check-owner',aiId=randomUUID();let at=1988193660,enabled=true,streamMode='normal',dispatches=0,cancels=0,native=null;
 const actor=()=>withOperationsAiWork(bindOperationsAiUse({kind:'business-operator',operatorId:owner,endpoint,businessAuthorization:{version:'1',permissions:['workbench.read','ai.use.governance']}},'governance'),{accountId:aiId,purpose:'query',resolve:async()=>({accountId:aiId,domain:'governance',enabled,permissions:[],roleVersions:[]})});
 const authority={db,endpoint,now:()=>at,async human(input,{domain='governance'}={}){if(!enabled||input.operatorId!==owner||domain!=='governance')throw new ServiceError('operations_permission_denied',403);return actor();}};
 let historyOmitted=false,transport=true,lookups=0,revokeDuringLookup=false;
 const client={
  async status(){return{state:'connected',modelState:'configured',configuredDomains:['governance'],conversationVersion:2,conversationDomains:['governance'],conversationTransport:{events:transport,cancel:transport,originalRunLookup:transport}};},
  async runConversation(row,input){dispatches++;assert.equal(input.stream,true);native={runId:randomUUID(),operationId:input.runId,status:'RUNNING',content:null,userInput:'synthetic question',createdAt:at,events:[],awaitingHuman:false};throw new ServiceError('operations_agentos_result_unknown',503);},
  async readConversation(){if(revokeDuringLookup)enabled=false;return{runs:native&&!historyOmitted?[native]:[],readExpiresAt:at+30};},
  async readConversationOperation(row,id){lookups++;assert.equal(id,native.operationId);return{operationId:id,runId:native.runId,state:native.status,native,readExpiresAt:at+30};},
  async cancelConversation(row,runId){assert.equal(runId,native.runId);cancels++;throw new ServiceError('operations_agentos_result_unknown',503);},
  async *conversationEvents(){
   yield{kind:'text',eventIndex:1,text:'当前可读的第一段。'};
   if(streamMode==='revoke')enabled=false;
   if(streamMode==='expire')at+=31;
   yield{kind:'text',eventIndex:2,text:'不得跨越资格期限显示的第二段。'};
   yield{kind:'terminal',eventIndex:3,status:'COMPLETED'};
  },
 };
 let expireOnAuthorize=false;
 const service=new AgentOsConversations({authority,client}),authorize=async()=>{if(expireOnAuthorize){at+=31;expireOnAuthorize=false;}return actor();},operationId=randomUUID();
 const first=await service.run(actor(),'governance',{operationId,message:'synthetic question'},{authorize});assert.equal(first.state,'unknown');assert.equal(dispatches,1);
 historyOmitted=true;
 transport=false;const legacy=await service.operation(actor(),'governance',operationId);assert.equal(legacy.state,'unknown');assert.equal(legacy.native,null);assert.equal(lookups,0,'old runtimes without the transport ACK are not queried at an unsupported private route');transport=true;
 const original=await service.operation(actor(),'governance',operationId);assert.equal(original.native.runId,native.runId,'lost native ACK is found by original queue operation even outside the 50-run history');assert.equal(original.state,'RUNNING');
 await service.run(actor(),'governance',{operationId,message:'synthetic question'},{authorize});assert.equal(dispatches,1,'explicit same original POST only reads its receipt');
 const stopId=randomUUID();const stop=await service.cancel(actor(),'governance',operationId,{operationId:stopId},{authorize});assert.equal(stop.state,'unknown');assert.equal(cancels,1);
 for(let i=0;i<3;i++){const read=await service.operation(actor(),'governance',stopId);assert.equal(read.operationId,stopId);assert.equal(read.cancelledOperationId,operationId);assert.equal(read.native.runId,native.runId);}
 await service.cancel(actor(),'governance',operationId,{operationId:stopId},{authorize});assert.equal(cancels,1,'unknown cancellation never dispatches twice');
 await assert.rejects(service.cancel(actor(),'governance',operationId,{operationId:randomUUID()},{authorize}),{code:'operations_agentos_cancel_already_requested'});assert.equal(cancels,1,'new IDs cannot replace an unresolved stop for the same turn');
 historyOmitted=false;
 const restored=await service.read(actor(),'governance');assert.deepEqual(restored.runs[0].cancellation,{operationId:stopId,state:'unknown',recordedAt:new Date(at*1000).toISOString()},'refresh retrieves the original stop intent without its private body');
 const events=[];for await(const event of service.events(actor(),'governance',operationId,{authorize}))events.push(event);
 assert.deepEqual(events.map(event=>event.kind),['lease','text','terminal']);assert.equal(events[1].eventIndex,2);assert.equal(events[1].text,'当前可读的第一段。不得跨越资格期限显示的第二段。');assert.equal(events[0].readExpiresAt,at+30);assert.equal(events[0].stopAvailable,true);assert(events.slice(1).every(event=>event.operationId===operationId));
 streamMode='expire';const expired=[];for await(const event of service.events(actor(),'governance',operationId,{authorize}))expired.push(event);
 assert.deepEqual(expired.map(event=>event.kind),['lease','resync']);assert(!JSON.stringify(expired).includes('第二段'),'lease expiry never emits an unqualified text batch');
 streamMode='revoke';const iterator=service.events(actor(),'governance',operationId,{authorize});await iterator.next();await assert.rejects(iterator.next(),{code:'operations_permission_denied'});enabled=true;
 revokeDuringLookup=true;await assert.rejects(service.events(actor(),'governance',operationId,{authorize}).next(),{code:'operations_permission_denied'});enabled=true;revokeDuringLookup=false;
 streamMode='normal';const slowCheck=service.events(actor(),'governance',operationId,{authorize});assert.equal((await slowCheck.next()).value.kind,'lease');expireOnAuthorize=true;
 assert.equal((await slowCheck.next()).value.kind,'resync','a batch whose fresh authorization completed after its original lease is withheld');assert.equal((await slowCheck.next()).done,true);
 await assert.rejects(service.operation({...actor(),operatorId:'other-owner'},'governance',operationId),{code:'operations_permission_denied'});
 native={...native,status:'CANCELLED',content:'已收到的合成文字。'};
 const stopped=await service.operation(actor(),'governance',stopId);assert.equal(stopped.state,'CANCELLED');assert.equal(cancels,1);
 const saved=(await db.query('SELECT state,result FROM operations_agentos_conversation_commands_v1 WHERE id=$1',[stopId])).rows[0];assert.equal(saved.state,'unknown','read recovery does not rewrite the original unknown dispatch as an accepted call');assert.equal(saved.result.cancelledOperationId,operationId);
 const counts=(await db.query('SELECT count(*)::int AS count FROM operations_agentos_conversation_commands_v1')).rows[0];assert.equal(counts.count,2,'only original message and original stop are recorded');
});
