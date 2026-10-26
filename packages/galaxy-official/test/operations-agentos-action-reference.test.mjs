import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AgentOsConversations} from "../src/operations/agentos/conversations.mjs";
import {AgentOsConversationTools} from "../src/operations/agentos/conversation-tools.mjs";
import {bindOperationsAiUse,withOperationsAiWork,operationsAiUseDomain} from '../src/shared/operations-ai-use.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {operationsAgentOsConversationsMigrationSql} from '../src/infrastructure/operations-agentos-conversations-v1-schema.mjs';
import {operationsAgentOsConversationToolsMigrationSql} from '../src/infrastructure/operations-agentos-conversation-tools-v1-schema.mjs';

test('a retired-source follow-up gets only its owned fixed-AI completed target reference, then must freshly read and prepare a separate human restore',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(operationsAgentOsConversationsMigrationSql);await db.exec(operationsAgentOsConversationToolsMigrationSql);
 await db.exec('ALTER TABLE operations_agentos_conversations_v1 ADD COLUMN ai_account_id uuid');
 await db.exec('CREATE TABLE business_admin_audit_v1(endpoint text,operator_id text,operation_id uuid,action text,selection jsonb,result jsonb)');
 const endpoint='https://official.synthetic.invalid',owner='action-reference-owner',aiAccountId=randomUUID(),targetId=randomUUID(),versionId=randomUUID();
 let seconds=1988193660;let revision=1;let write=true;let read=true;const enabled=true;let hidden=false;let sourceAvailable=true;let sourceFailure=false;let visibilityVersion=0;let effects=0;let currentAiAccountId=aiAccountId;let reads=0;
 const now=()=>seconds,sourceExpiry=now()+3600;
 const actor=()=>withOperationsAiWork(bindOperationsAiUse({kind:'business-operator',operatorId:owner,endpoint,role:'reader',businessAuthorization:{version:String(revision),permissions:['workbench.read','ai.use.governance',...(read?['content.read']:[]),...(write?['content.hide','content.restore']:[])]}},'governance'),{accountId:currentAiAccountId,purpose:'query',resolve:async()=>({accountId:currentAiAccountId,domain:'governance',enabled,permissions:[],roleVersions:[]})});
 const authority={db,endpoint,now,async human(input,{action='workbench.read',domain=null,purpose=null}={}){
  if(input.operatorId!==owner||!enabled)throw new ServiceError('operations_permission_denied',403);
  if((domain??operationsAiUseDomain(input))!=='governance')throw new ServiceError('operations_agentos_domain_mismatch',403);
  const current=actor();if(!current.businessAuthorization.permissions.includes(action)||purpose==='prepare'&&!write)throw new ServiceError('operations_permission_denied',403);return current;
 }};
 const content=()=>({kind:'post',id:targetId,version:7,versionId,title:'PRIVATE_OLD_TITLE',body:'PRIVATE_OLD_BODY',sourceState:sourceAvailable?'available':'unavailable',publishedUntil:sourceExpiry,maxHideSeconds:1800,visibility:{hidden,version:visibilityVersion},curation:{revision:0},capabilities:{canHide:write&&!hidden&&sourceAvailable,canRestore:write&&hidden&&sourceAvailable}});
 const services={content:{async get(input,kind,id){
  await authority.human(input,{action:'content.read'});assert.equal(kind,'post');assert.equal(id,targetId);reads++;
  if(sourceFailure)throw new ServiceError('operations_source_unavailable',503);return{content:content(),checkedAt:now(),readExpiresAt:now()+30};
 },async visibility(input,kind,id,command){
  await authority.human(input,{action:'content.'+command.kind});assert.equal(id,targetId);assert.equal(kind,'post');
  const saved=(await db.query('SELECT result FROM business_admin_audit_v1 WHERE operation_id=$1',[command.operationId])).rows[0];if(saved)return saved.result;
  assert.equal(command.expectedVersion,7);assert.equal(command.expectedRevision,visibilityVersion);assert.equal(sourceAvailable,true);
  hidden=command.kind==='hide';visibilityVersion++;effects++;
  const result={operationId:command.operationId,content:content(),recordedAt:new Date(now()*1000).toISOString(),replayed:false};
  await db.query('INSERT INTO business_admin_audit_v1 VALUES($1,$2,$3,$4,$5,$6)',[endpoint,owner,command.operationId,'community-content-visibility',JSON.stringify({id,targetKind:kind}),JSON.stringify(result)]);return result;
 }}};
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['governance'],conversationVersion:2,conversationDomains:['governance']};},async readConversation(){return{runs:[],readExpiresAt:now()+30};}};
 const conversations=new AgentOsConversations({authority,client,summaryForConversation:async()=>({checkedAt:now(),readExpiresAt:now()+30,availability:{}})}),tools=new AgentOsConversationTools({conversations,authority,services});conversations.tools=tools;
 const newTurn=async()=>{
  const session=(await conversations.session(actor(),'governance',{create:true})).row,turnId=randomUUID(),runId=randomUUID();
  await db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,'not-message-prose','accepted','{}',$5,$6)",[turnId,endpoint,session.id,owner,runId,new Date(now()*1000)]);
  return{session,turnId,envelope:(tool,args)=>({conversationId:session.id,sessionId:session.session_id,turnId,runId,callId:randomUUID(),tool,arguments:args})};
 };
 const original=await newTurn();await tools.execute(original.envelope('read-operation-object',{kind:'post',id:targetId,filters:{}}));
 const prepared=await tools.execute(original.envelope('prepare-operation',{kind:'content-visibility',targetKind:'post',targetId,action:'hide',until:now()+300,reason:'固定单对象合成处置'}));
 const done=await tools.confirm(actor(),'governance',prepared.card.cardId,{cardId:prepared.card.cardId,operationId:prepared.card.operationId},{authorize:async()=>actor()});assert.equal(done.state,'completed');assert.equal(effects,1);
 await conversations.read(actor(),'governance');seconds+=5;
 const followup=await newTurn();assert.notEqual(followup.session.id,original.session.id);
 const summary=await tools.execute(followup.envelope('workbench-summary',{}));
 assert.equal(summary.priorReadReceipts.items.length,0,'old source prose/read context remains retired');
 assert.equal(summary.priorActionReceipts.availability,'available');assert.equal(summary.priorActionReceipts.items.length,1);
 const reference=summary.priorActionReceipts.items[0];
 assert.deepEqual(reference.target,{kind:'post',id:targetId});assert.equal(reference.operationId,prepared.card.operationId);assert.equal(reference.action,'hide');
 assert.equal(reference.recordedEffect.hidden,true);assert.equal(reference.current.hidden,true);assert.equal(reference.current.readExpiresAt,now()+30);
 assert.equal(summary.priorActionReceipts.valuesCurrent,false);assert(!JSON.stringify(summary).includes('PRIVATE_'));assert.equal(effects,1,'summary never executes an effect');
 assert.deepEqual(Object.keys(reference).sort(),['action','cardId','current','kind','observedAt','operationId','recordedEffect','state','target']);
 assert(!Object.hasOwn(reference.target,'label'));assert(!Object.hasOwn(reference,'request'));assert(!Object.hasOwn(reference,'reason'));
 const current=await tools.execute(followup.envelope('read-operation-object',{kind:reference.target.kind,id:reference.target.id,filters:{}}));assert.equal(current.data.publiclyReadable,false);assert.equal(current.data.title,null);assert.equal(current.data.body,null);
 const restoreArgs={kind:'content-visibility',targetKind:reference.target.kind,targetId:reference.target.id,action:'restore',reason:'解除刚才单对象处置'};
 write=false;revision++;await assert.rejects(tools.actions.prepareFor(actor(),'governance',restoreArgs),{code:'operations_permission_denied'});write=true;revision++;
 // A new authority key must acquire its own current conversation before tools.
 seconds++;const authorized=await newTurn();const restore=await tools.execute(authorized.envelope('prepare-operation',restoreArgs));
 assert.equal(restore.card.capability.canConfirm,true);assert.notEqual(restore.card.operationId,prepared.card.operationId);assert.equal(effects,1,'new restore remains a separate human decision');
 const result=await tools.confirm(actor(),'governance',restore.card.cardId,{cardId:restore.card.cardId,operationId:restore.card.operationId},{authorize:async()=>actor()});assert.equal(result.state,'completed');assert.equal(effects,2);assert.equal(hidden,false);assert.equal(content().versionId,versionId);assert.equal(content().publishedUntil,sourceExpiry);
 // New valid context can inspect a historical effect without reusing its prose.
 seconds++;const later=await newTurn();const context={conversationId:later.session.id,turnId:later.turnId};
 const references=await tools.priorActionReferences(actor(),'governance',context);assert.equal(references.items.length,2);assert.equal(effects,2);
 // Owner/domain/fixed-AI boundaries are not supplied by model arguments.
 await assert.rejects(tools.priorActionReferences({...actor(),operatorId:'other-owner'},'governance',context),{code:'operations_agentos_conversation_not_found'});
 await assert.rejects(tools.priorActionReferences(actor(),'discovery',context),{code:'operations_agentos_domain_mismatch'});
 currentAiAccountId=randomUUID();await assert.rejects(tools.priorActionReferences(actor(),'governance',context),{code:'operations_ai_work_unassigned'});currentAiAccountId=aiAccountId;
 sourceFailure=true;const unavailable=await tools.priorActionReferences(actor(),'governance',context);assert.equal(unavailable.availability,'partial');assert.equal(unavailable.items.length,0);sourceFailure=false;
 sourceAvailable=false;const lost=await tools.priorActionReferences(actor(),'governance',context);assert.equal(lost.items.length,0);sourceAvailable=true;
 // A forged/unknown stored shape and future result cannot become a model locator.
 const originalRow=(await db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE id=$1',[prepared.card.cardId])).rows[0];
 const mutated={...originalRow.proposal,request:{...originalRow.proposal.request,targetId:randomUUID()},extra:'PRIVATE_UNKNOWN_PROPOSAL'};
 await db.query('UPDATE operations_agentos_conversation_cards_v1 SET proposal=$2 WHERE id=$1',[prepared.card.cardId,JSON.stringify(mutated)]);
 const malformed=await tools.priorActionReferences(actor(),'governance',context);assert.equal(malformed.items.length,1);assert(!JSON.stringify(malformed).includes('PRIVATE_'));
 await db.query('UPDATE operations_agentos_conversation_cards_v1 SET proposal=$2,updated_at=$3 WHERE id=$1',[prepared.card.cardId,JSON.stringify(originalRow.proposal),new Date((now()+10)*1000)]);
 assert.equal((await tools.priorActionReferences(actor(),'governance',context)).items.length,1);
 read=false;revision++;seconds++;const noRead=await newTurn();const hiddenReferences=await tools.priorActionReferences(actor(),'governance',{conversationId:noRead.session.id,turnId:noRead.turnId});assert.equal(hiddenReferences.items.length,0);assert.equal(effects,2);
 assert(reads>0);assert.equal(services.accounts,undefined,'no audit route exists or is needed');
});
