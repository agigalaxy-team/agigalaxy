import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AgentOsConversations} from '../src/operations-agentos-conversations.mjs';
import {AgentOsConversationTools} from '../src/operations-agentos-conversation-tools.mjs';
import {bindOperationsAiUse,withOperationsAiWork,operationsAiUseDomain} from '../src/shared/operations-ai-use.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsAgentOsConversationsMigrationSql} from '../src/infrastructure/operations-agentos-conversations-v1-schema.mjs';
import {operationsAgentOsConversationToolsMigrationSql} from '../src/infrastructure/operations-agentos-conversation-tools-v1-schema.mjs';

test('an effect changing its own public source retires prose history but preserves only the current-qualified original card receipt and safe new conversation',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(operationsAgentOsConversationsMigrationSql);await db.exec(operationsAgentOsConversationToolsMigrationSql);
 await db.exec('ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN ai_account_id uuid');
 await db.exec('CREATE TABLE business_admin_audit_v1(endpoint text,operator_id text,operation_id uuid,action text,selection jsonb,result jsonb)');
 const endpoint='https://official.synthetic.invalid',owner='card-source-owner',aiAccountId=randomUUID(),targetId=randomUUID(),now=()=>1988193660;
 let write=true,read=true,enabled=true,revision=1,effects=0,nativeReads=0,hidden=false,visibilityVersion=0,currentAiAccountId=aiAccountId;
 const actor=()=>withOperationsAiWork(bindOperationsAiUse({kind:'business-operator',operatorId:owner,endpoint,role:'reader',businessAuthorization:{version:String(revision),permissions:['workbench.read','ai.use.governance',...(read?['content.read']:[]),...(write?['content.hide','content.restore']:[])]}},'governance'),{accountId:currentAiAccountId,purpose:'query',resolve:async()=>({accountId:currentAiAccountId,domain:'governance',enabled,permissions:[],roleVersions:[]})});
 const authority={db,endpoint,now,async human(input,{action='workbench.read',domain=null,purpose=null}={}){
  if(input.operatorId!==owner||!enabled)throw new ServiceError('operations_permission_denied',403);
  if((domain??operationsAiUseDomain(input))!=='governance')throw new ServiceError('operations_agentos_domain_mismatch',403);
  const current=actor();if(!current.businessAuthorization.permissions.includes(action)||purpose==='prepare'&&!write)throw new ServiceError('operations_permission_denied',403);return current;
 }};
 const content=()=>({kind:'post',id:targetId,version:7,versionId:'8e407d19-1f3d-4d78-aa79-53d49b6e6c87',title:'PRIVATE_PREVIOUS_TITLE',body:'PRIVATE_PREVIOUS_BODY',sourceState:'available',publishedUntil:now()+3600,maxHideSeconds:1800,visibility:{hidden,version:visibilityVersion},curation:{revision:0},capabilities:{canHide:write&&!hidden,canRestore:write&&hidden}});
 const services={content:{async get(input,kind,id){assert.equal(kind,'post');assert.equal(id,targetId);await authority.human(input,{action:'content.read'});return{content:content(),checkedAt:now(),readExpiresAt:now()+30};},async visibility(input,kind,id,command){
  await authority.human(input,{action:'content.'+command.kind});assert.equal(id,targetId);
  const previous=(await db.query('SELECT result FROM business_admin_audit_v1 WHERE operation_id=$1',[command.operationId])).rows[0];if(previous)return previous.result;
  assert.equal(command.expectedVersion,7);assert.equal(command.expectedRevision,visibilityVersion);hidden=command.kind==='hide';visibilityVersion++;effects++;
  const result={operationId:command.operationId,content:content(),recordedAt:new Date(now()*1000).toISOString(),replayed:false};
  await db.query('INSERT INTO business_admin_audit_v1 VALUES($1,$2,$3,$4,$5,$6)',[endpoint,owner,command.operationId,'community-content-visibility',JSON.stringify({id,targetKind:kind}),JSON.stringify(result)]);
  return result;
 }}};
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['governance'],conversationVersion:2,conversationDomains:['governance']};},async readConversation(){nativeReads++;return{runs:[{content:'PRIVATE_PREVIOUS_NATIVE_HISTORY'}],readExpiresAt:now()+30};}};
 const conversations=new AgentOsConversations({authority,client}),tools=new AgentOsConversationTools({conversations,authority,services});
 conversations.tools=tools;
 const current=actor(),session=(await conversations.session(current,'governance',{create:true})).row,turnId=randomUUID(),runId='synthetic-owned-native-run';
 await db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,'not-a-message','accepted','{}',$5,$6)",[turnId,endpoint,session.id,owner,runId,new Date(now()*1000)]);
 const envelope=(tool,args)=>({conversationId:session.id,sessionId:session.session_id,turnId,runId,callId:randomUUID(),tool,arguments:args});
 await tools.execute(envelope('read-operation-object',{kind:'post',id:targetId,filters:{}}));
 const prepared=await tools.execute(envelope('prepare-operation',{kind:'content-visibility',targetKind:'post',targetId,action:'hide',until:now()+300,reason:'本地单对象源变化验证'}));
 assert.equal(prepared.card.state,'prepared');assert.equal(effects,0);
 const cardId=prepared.card.cardId,operationId=prepared.card.operationId;
 const done=await tools.confirm(current,'governance',cardId,{cardId,operationId},{authorize:async()=>actor()});
 assert.equal(done.state,'completed');assert.equal(effects,1);assert.equal(done.operationId,operationId);assert(!JSON.stringify(done).includes('PRIVATE_'));
 const next=await conversations.read(actor(),'governance');
 assert.equal(next.contextChanged,true);assert.equal(next.runs.length,0);assert.equal(next.toolCards.length,1);assert.equal(next.toolCards[0].state,'completed');assert.equal(nativeReads,0);assert(!JSON.stringify(next).includes('PRIVATE_'));
 await assert.rejects(conversations.current(session.id,{operator:actor()}),{code:'operations_agentos_source_changed'});
 const previousOperation=await conversations.operation(actor(),'governance',turnId);assert.equal(previousOperation.state,'context-changed');assert.equal(previousOperation.native,null);
 // A lost ACK must read the immutable business result, including after write authority is removed.
 await db.query("UPDATE operations_agentos_conversation_cards_v1 SET state='unknown' WHERE id=$1",[cardId]);
 write=false;revision++;
 const recovered=await tools.card(actor(),'governance',cardId);assert.equal(recovered.state,'completed');assert.equal(recovered.operationId,operationId);assert.equal(effects,1);assert(!JSON.stringify(recovered).includes('PRIVATE_'));
 await assert.rejects(tools.confirm(actor(),'governance',cardId,{cardId,operationId},{authorize:async()=>actor()}),{code:'operations_permission_denied'});
 const newSession=(await conversations.session(actor(),'governance',{create:true})).row;assert.notEqual(newSession.id,session.id);
 currentAiAccountId=randomUUID();await assert.rejects(tools.card(actor(),'governance',cardId),{code:'operations_ai_work_unassigned'});currentAiAccountId=aiAccountId;
 await assert.rejects(tools.card({kind:'business-operator',operatorId:'different-owner',endpoint},'governance',cardId),{code:'operations_permission_denied'});
 read=false;revision++;
 const withoutRead=await conversations.read(actor(),'governance');assert.equal(withoutRead.toolCards.length,0);assert.equal(withoutRead.capabilities.canSend,true);assert(!JSON.stringify(withoutRead).includes('PRIVATE_'));
 enabled=false;await assert.rejects(tools.card(current,'governance',cardId),{code:'operations_permission_denied'});
 assert.equal(effects,1);
});

