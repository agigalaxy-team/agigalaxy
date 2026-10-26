import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsFeedbackService} from "../src/operations/feedback/service.mjs";
import {AccountFeedbackDataService} from '../src/operations/feedback/owner-data.mjs';
import {AgentOsConversations} from "../src/operations/agentos/conversations.mjs";
import {AgentOsConversationTools} from "../src/operations/agentos/conversation-tools.mjs";
import {conversationPriorActionTarget} from "../src/operations/agentos/tool-evidence.mjs";
import {bindOperationsAiUse,withOperationsAiWork,inheritOperationsAiUse,operationsAiUseDomain,operationsAiWorkScope} from '../src/shared/operations-ai-use.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real SQL/API role, stored human grants, feedback service and original audit,
// conversation source retirement, typed AI scope and central tool/card paths.
// Native admission, fixed-AI permissions and native transport are explicit
// local doubles. No model/network or production object is involved.
test('a completed feedback effect can locate the same current object after source retirement, never revive prose or a later human decision',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);let elapsed=0;
 const now=()=>f.now()+elapsed,businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now}),
  feedback=new OperationsFeedbackService({businessAdmin,accounts:f.accounts,now}),
  admin={kind:'business-operator',operatorId:'feedback-ref-local-admin',role:'administrator',endpoint:f.endpoint},
  reader={...admin,operatorId:'feedback-ref-local-reader',role:'reader'};
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.synthetic.invalid',$1,'本地反馈接续操作者',$3,$3)`,[actor.operatorId,f.endpoint,new Date(now()*1000)]);
 const humanCodes=['workbench.read','ai.use.governance','feedback.read','feedback.update'],
  {permissions}=await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:humanCodes});
 const ai=randomUUID();
 // The full released schema has a real fixed-position FK; DDL deliberately
 // does not seed identities. Seed this one synthetic identity before API role.
 await f.db.query(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at)
  VALUES($1,$2,'governance','本地反馈岗位','Explicit fixture only',true,1,1,$3,$3)`,[ai,f.endpoint,new Date(now()*1000)]);
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const roleId=(await f.db.query('SELECT role_id FROM operations_role_assignments_v1 WHERE endpoint=$1 AND operator_id=$2',[f.endpoint,reader.operatorId])).rows[0].role_id;
 const changeHumanRead=async enabled=>{const role=(await f.db.query('SELECT * FROM operations_business_roles_v1 WHERE id=$1',[roleId])).rows[0];
  await permissions.saveRole(admin,{operationId:randomUUID(),id:role.id,expectedVersion:role.version,name:role.name,description:role.description,enabled:true,permissions:enabled?humanCodes:humanCodes.filter(x=>x!=='feedback.read')},{authorize:async()=>admin});};
 let currentAi=ai,afterGet=null;
 const aiCodes=new Set(humanCodes),resolveAi=async(_db,domain,{accountId})=>{
  if(accountId!==currentAi)throw new ServiceError('operations_ai_work_unassigned',403);
  return{accountId,domain,enabled:true,permissions:[...aiCodes],roleVersions:[]};
 };
 const authority={db:f.db,endpoint:f.endpoint,now,async human(input,{action='workbench.read',domain=null,purpose='query',authorize,db=f.db}={}){
  if(input.operatorId!==reader.operatorId)throw new ServiceError('operations_permission_denied',403);
  if((domain??operationsAiUseDomain(input)??'governance')!=='governance')throw new ServiceError('operations_agentos_domain_mismatch',403);
  const work=operationsAiWorkScope(input);if(work&&work.accountId!==currentAi)throw new ServiceError('operations_ai_work_unassigned',403);
  if(authorize){const current=await authorize();assert.equal(current.operatorId,reader.operatorId);assert.equal(current.endpoint,f.endpoint);}
  // current() supplies only the immutable operator locator. The explicit
  // native-admission double supplies its real fixture reader admission; the
  // stored service still recomputes all business grants, never actor claims.
  const admitted=inheritOperationsAiUse(input,{...Object.fromEntries(Object.entries(input)),role:'reader'});
  const authorized=await businessAdmin.authorizeAction(admitted,action,{db});
  return withOperationsAiWork(bindOperationsAiUse(authorized,'governance'),{accountId:currentAi,purpose,resolve:resolveAi});
 }};
 const saved=await feedback.submit(f.people[0],{operationId:randomUUID(),title:'PRIVATE_FEEDBACK_TITLE',body:'PRIVATE_FEEDBACK_BODY',category:'suggestion',module:'other'});
 const services={feedback:{get:async(...args)=>{const value=await feedback.get(...args);if(afterGet)await afterGet(value);return value;},
  event:feedback.event.bind(feedback),operation:feedback.operation.bind(feedback)}};
 const client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['governance'],conversationVersion:2,conversationDomains:['governance']};},async readConversation(){return{runs:[],readExpiresAt:now()+30};}};
 const conversations=new AgentOsConversations({authority,client,summaryForConversation:async()=>({checkedAt:now(),readExpiresAt:now()+30,availability:{}})}),
  tools=new AgentOsConversationTools({conversations,authority,services});conversations.tools=tools;
 const newTurn=async()=>{
  const session=(await conversations.session(reader,'governance',{create:true})).row,turnId=randomUUID(),runId=randomUUID();
  await f.db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,'synthetic-no-prose','accepted','{}',$5,$6)",[turnId,f.endpoint,session.id,reader.operatorId,runId,new Date(now()*1000)]);
  return{session,turnId,context:{conversationId:session.id,turnId},envelope:(tool,args)=>({conversationId:session.id,sessionId:session.session_id,turnId,runId,callId:randomUUID(),tool,arguments:args})};
 };
 const original=await newTurn();await tools.execute(original.envelope('read-operation-object',{kind:'feedback',id:saved.feedbackId,filters:{}}));
 const first=await tools.execute(original.envelope('prepare-operation',{kind:'feedback-update',targetId:saved.feedbackId,module:'account',state:'processing',note:'PRIVATE_INTERNAL_NOTE'}));
 const done=await tools.confirm(reader,'governance',first.card.cardId,{cardId:first.card.cardId,operationId:first.card.operationId},{authorize:async()=>reader});
 assert.equal(done.state,'completed');assert.equal(done.result.receipt.revision,2);
 elapsed+=2;const followup=await newTurn();assert.notEqual(followup.session.id,original.session.id);
 const retired=(await f.db.query('SELECT retired_at,retirement_reason FROM operations_agentos_conversations_v1 WHERE id=$1',[original.session.id])).rows[0];assert(retired.retired_at);assert.equal(retired.retirement_reason,'source-changed');
 const summary=await tools.execute(followup.envelope('workbench-summary',{})),reference=summary.priorActionReceipts.items[0];
 assert.equal(summary.priorActionReceipts.items.length,1);assert.equal(summary.priorReadReceipts.items.length,0,'retired private material history is not restored');
 assert.deepEqual(reference,{cardId:first.card.cardId,operationId:first.card.operationId,kind:'feedback-update',action:'update',state:'completed',target:{kind:'feedback',id:saved.feedbackId},recordedEffect:{revision:2},observedAt:new Date((now()-2)*1000).toISOString(),current:{revision:2,checkedAt:now(),readExpiresAt:now()+30}});
 for(const secret of ['PRIVATE_',f.people[0].accountId,'title','body','note','category','module','accountId'])assert(!JSON.stringify(reference).includes(secret),'the locator cannot carry feedback prose, classification or user identity');
 const current=await tools.execute(followup.envelope('read-operation-object',{kind:reference.target.kind,id:reference.target.id,filters:{}}));
 assert.equal(current.data.revision,2);assert.equal(current.data.body,'PRIVATE_FEEDBACK_BODY');assert.equal(current.data.module,'account');
 aiCodes.delete('feedback.update');const readOnly=await newTurn();assert.equal((await tools.priorActionReferences(reader,'governance',readOnly.context)).items.length,1);
 await assert.rejects(tools.actions.prepareFor(await authority.human(reader,{}),'governance',{kind:'feedback-update',targetId:saved.feedbackId,state:'closed'}),{code:'operations_agentos_operation_unavailable',status:409});
 assert.equal((await feedback.get(admin,saved.feedbackId)).feedback.revision,2,'a locator grants no new write capability');aiCodes.add('feedback.update');
 const authorized=await newTurn();
 await assert.rejects(tools.priorActionReferences({...reader,operatorId:'other-owner'},'governance',authorized.context),{code:'operations_agentos_conversation_not_found'});
 await assert.rejects(tools.priorActionReferences(reader,'discovery',authorized.context),{code:'operations_agentos_domain_mismatch'});
 currentAi=randomUUID();await assert.rejects(tools.priorActionReferences(reader,'governance',authorized.context),{code:'operations_ai_work_unassigned'});currentAi=ai;
 aiCodes.delete('feedback.read');const noAiRead=await newTurn();assert.equal((await tools.priorActionReferences(reader,'governance',noAiRead.context)).items.length,0);aiCodes.add('feedback.read');
 await changeHumanRead(false);const noHumanRead=await newTurn();assert.equal((await tools.priorActionReferences(reader,'governance',noHumanRead.context)).items.length,0);await changeHumanRead(true);
 const late=await newTurn();afterGet=async()=>{afterGet=null;await changeHumanRead(false);};await assert.rejects(tools.priorActionReferences(reader,'governance',late.context),{code:'operations_agentos_authority_changed'},'a late real read revocation invalidates the old context before any locator leaves');await changeHumanRead(true);
 const latest=await newTurn(),row=(await f.db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE id=$1',[first.card.cardId])).rows[0];
 for(const state of ['prepared','processing','unknown','not-available'])assert.equal(conversationPriorActionTarget({...row,state}),null);
 assert.equal(conversationPriorActionTarget({...row,result:{...row.result,receipt:{...row.result.receipt,revision:3}}}),null);
 assert.equal(conversationPriorActionTarget({...row,result:{...row.result,receipt:{...row.result.receipt,feedbackId:randomUUID()}}}),null);
 await f.db.query("UPDATE operations_agentos_conversation_cards_v1 SET state='prepared' WHERE id=$1",[row.id]);assert.equal((await tools.priorActionReferences(reader,'governance',latest.context)).items.length,0);
 await f.db.query("UPDATE operations_agentos_conversation_cards_v1 SET state='completed',updated_at=$2 WHERE id=$1",[row.id,new Date((now()+10)*1000)]);assert.equal((await tools.priorActionReferences(reader,'governance',latest.context)).items.length,0,'future receipts cannot be earlier evidence');
 await f.db.query('UPDATE operations_agentos_conversation_cards_v1 SET updated_at=$2 WHERE id=$1',[row.id,row.updated_at]);
 // A completed-looking private card without a real business receipt cannot
 // supply a reference. Only the local card row is injected; audit stays real.
 const fakeOp=randomUUID();
 // operation_id is immutable to galaxy_api. Only the explicit corruption
 // fixture uses the owner role; the actual reader below stays galaxy_api.
 await f.db.exec('RESET ROLE');await f.db.query('UPDATE operations_agentos_conversation_cards_v1 SET operation_id=$2,result=$3 WHERE id=$1',[row.id,fakeOp,JSON.stringify({...row.result,operationId:fakeOp,receipt:{...row.result.receipt,operationId:fakeOp}})]);await f.db.exec('SET ROLE galaxy_api');
 assert.equal((await tools.priorActionReferences(reader,'governance',latest.context)).items.length,0,'the same-operation original audit is mandatory');
 await f.db.exec('RESET ROLE');await f.db.query('UPDATE operations_agentos_conversation_cards_v1 SET operation_id=$2,result=$3 WHERE id=$1',[row.id,row.operation_id,JSON.stringify(row.result)]);await f.db.exec('SET ROLE galaxy_api');
 assert.equal((await tools.priorActionReferences(reader,'governance',latest.context)).items.length,1);
 await feedback.event(admin,saved.feedbackId,{operationId:randomUUID(),expectedRevision:2,state:'closed'});
 assert.equal((await tools.actions.recoverPrepared(await authority.human(reader,{}),row.proposal,row.operation_id)).receipt.revision,2,'an old result remains the old result');
 assert.equal((await tools.priorActionReferences(reader,'governance',latest.context)).items.length,0,'a later human revision cannot be continued or undone using the old effect');
 const ownerData=new AccountFeedbackDataService({db:f.db,endpoint:f.endpoint,accounts:f.accounts,feedbackAttachments:feedback.feedbackAttachments,now});await ownerData.delete(f.people[0],{operationId:randomUUID()});
 assert.equal((await tools.priorActionReferences(reader,'governance',latest.context)).items.length,0,'deleted source never becomes old context again');
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_automation_grants_v1')).rows[0].n,0);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM discovery_usage_events_v1')).rows[0].n,0);
 await f.db.exec('RESET ROLE');
});
