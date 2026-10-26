import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {OperationsRecommendationService} from '../src/operations/recommendations/service.mjs';
import {OperationsAgentOsActionTools} from "../src/operations/agentos/action-tools.mjs";
import {AgentOsConversationTools} from "../src/operations/agentos/conversation-tools.mjs";
import {AgentOsConversations} from "../src/operations/agentos/conversations.mjs";
import {queryProjection as view} from "../src/operations/agentos/query-view.mjs";
import {workbenchPrepareSchemas} from "../src/operations/agentos/action-catalog.mjs";
import {aiWorkCapabilities} from '../src/shared/operations-ai-work-capabilities.mjs';
import {bindOperationsAiUse,withOperationsAiWork,inheritOperationsAiUse,operationsAiUseDomain} from '../src/shared/operations-ai-use.mjs';
import {applyRecommendationControl} from '../src/discovery-runtime/recommendation-control.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real PGlite migrations/galaxy_api role, stored human and AI role grants,
// recommendation service/CAS/event/audit and central human-card dispatcher.
// Native admission/transport and an empty public-supply reader are explicit
// doubles; no provider, private content or production request is involved.
test('one recommendation direction preserves the complete policy and recovers only its original durable effect',{timeout:120000},async t=>{
 const engine=new PGlite(),connection=new AsyncLocalStorage();t.after(()=>engine.close());
 // PGlite has one serialized connection. Fresh authorization callbacks that
 // use the pool share this fixture's active transaction. Unlike a real pg
 // pool, this engine cannot serve a second connection while one is pinned.
 const db={query:(...args)=>(connection.getStore()??engine).query(...args),exec:(...args)=>(connection.getStore()??engine).exec(...args),
  transaction:operation=>connection.getStore()?operation(connection.getStore()):engine.transaction(tx=>connection.run(tx,()=>operation(tx)))};
 await migrate(db);
 const endpoint='https://recommendation-card.local.invalid',now=()=>2000000000,
  admin={kind:'business-operator',operatorId:'local-recommendation-root',endpoint,role:'administrator'},
  reader={kind:'business-operator',operatorId:'local-recommendation-manager',endpoint,role:'reader'},
  admissions=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of [admin,reader])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://native-admission.local.invalid',$1,'本地推荐操作者',$3,$3)`,[actor.operatorId,endpoint,new Date(now()*1000)]);
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async actor=>admissions.get(actor.operatorId)??null,now}),
  businessAdmin=new BusinessAdminService({db,endpoint,permissions,now}),
  aiAccounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,now}),aiId=randomUUID();
 await db.query(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at)
  VALUES($1,$2,'discovery','本地发现岗位','Explicit local fixture',true,1,1,$3,$3)`,[aiId,endpoint,new Date(now()*1000)]);
 const grant=async(name,codes)=> (await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name,description:'Only this local new leaf',enabled:true,permissions:codes},{authorize:async()=>admin})).role;
 let humanRole=await grant('本地推荐人员',['workbench.read','ai.use.discovery','recommendations.read','recommendations.configure']),aiRole=await grant('本地推荐岗位',['recommendations.read','recommendations.configure']);
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:humanRole.id,enabled:true},{authorize:async()=>admin});
 await migrate(db,{roles:['api']});await db.exec('SET ROLE galaxy_api');
 await aiAccounts.assignment(admin,'discovery',{operationId:randomUUID(),expectedVersion:0,roleId:aiRole.id,enabled:true},{authorize:async()=>admin});
 const setRole=async(which,codes)=>{
  const old=which==='ai'?aiRole:humanRole,next=(await permissions.saveRole(admin,{operationId:randomUUID(),id:old.id,expectedVersion:old.version,name:old.name,description:old.description,enabled:true,permissions:codes},{authorize:async()=>admin})).role;
  if(which==='ai')aiRole=next;else humanRole=next;
 };
 const resolveAi=(tx,domain,options)=>aiAccounts.authorizationWithin(tx,domain,options);
 const authority={db,endpoint,now,supported:new Set(),async human(input,{action='workbench.read',domain=operationsAiUseDomain(input)??'discovery',purpose='query',authorize,db:tx=db}={}){
  if(domain!=='discovery')throw new ServiceError('operations_agentos_domain_mismatch',403);
  if(authorize){const current=await authorize();if(current.operatorId!==input.operatorId||current.endpoint!==endpoint)throw new ServiceError('business_admin_denied',403);}
  const admitted=inheritOperationsAiUse(input,{...Object.fromEntries(Object.entries(input)),role:admissions.get(input.operatorId)}),
   scoped=withOperationsAiWork(bindOperationsAiUse(admitted,'discovery'),{accountId:aiId,purpose,resolve:resolveAi});
  return businessAdmin.authorizeAction(scoped,action,{db:tx});
 }};
 const source={async qualifiedSnapshot(){return{documents:[],complete:true,scanned:0,startedAt:now(),completedAt:now()};}},
  recommendation=new OperationsRecommendationService({db,endpoint,permissions,businessAdmin,source,now}),theme=(await recommendation.saveTheme(admin,{operationId:randomUUID(),expectedVersion:0,label:'观察与记录交流',enabled:false,mapping:{categories:['life','arts'],tagIds:[],queryTerms:['观察笔记']},reason:'明确本地自有主题'},{authorize:async()=>admin})).theme;
 const controls={avoidRepetition:false,avoidConcentration:false};
 await recommendation.savePolicy(admin,{operationId:randomUUID(),expectedVersion:0,enabled:false,themeKey:'category:technology',direction:'decrease',controls,reason:'保留另一项已有分类方向'},{authorize:async()=>admin});
 const base=(await recommendation.savePolicy(admin,{operationId:randomUUID(),expectedVersion:1,enabled:false,themeKey:theme.key,direction:'keep',controls,reason:'本地原中性方向'},{authorize:async()=>admin})).policy;
 let mode='normal',saveCalls=0;
 const services={recommendations:{overview:recommendation.overview.bind(recommendation),commandResult:recommendation.commandResult.bind(recommendation),async savePolicy(...args){
  saveCalls++;if(mode==='missing')throw new ServiceError('local_transport_lost',503);
  const value=await recommendation.savePolicy(...args);
  if(mode==='bad-ack')return{...value,operationId:randomUUID()};
  if(mode==='lost-write-permission')await setRole('ai',['recommendations.read']);
  return value;
 }}};
 const actions=new OperationsAgentOsActionTools({conversations:{},authority,gateway:{},services}),
  client={async status(){return{state:'connected',modelState:'configured',configuredDomains:['discovery'],conversationVersion:2,conversationDomains:['discovery']};},async readConversation(){return{runs:[],readExpiresAt:now()+30};}},
  conversations=new AgentOsConversations({authority,client,summaryForConversation:async()=>({checkedAt:now(),readExpiresAt:now()+30,availability:{}})}),
  tools=new AgentOsConversationTools({conversations,authority,services});conversations.tools=tools;
 const newCard=async(direction='increase')=>{
  const session=(await conversations.session(reader,'discovery',{create:true})).row,turnId=randomUUID(),runId=randomUUID();
  await db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,'local-no-prose','accepted','{}',$5,$6)",[turnId,endpoint,session.id,reader.operatorId,runId,new Date(now()*1000)]);
  return (await tools.execute({conversationId:session.id,sessionId:session.session_id,turnId,runId,callId:randomUUID(),tool:'prepare-operation',arguments:{kind:'recommendation-direction',themeKey:theme.key,direction,reason:'只调整本次主题方向'}})).card;
 };
 const confirm=card=>tools.confirm(reader,'discovery',card.cardId,{cardId:card.cardId,operationId:card.operationId},{authorize:async()=>reader});
 const policyNow=()=>recommendation.policyWithin(db),rawPolicy=policy=>({enabled:policy.enabled,controls:policy.controls,directions:policy.directions}),baseShape=rawPolicy(base);
 const restore=async()=>{const current=await policyNow();return recommendation.savePolicy(admin,{operationId:randomUUID(),expectedVersion:current.version,enabled:base.enabled,themeKey:theme.key,direction:'keep',controls:base.controls,reason:'恢复本地原方向'},{authorize:async()=>admin});};
 const originalEvents=(await db.query('SELECT count(*)::int AS n FROM operations_recommendation_events_v1')).rows[0].n;
 assert.deepEqual((await actions.listAuthorizedWork(reader,'discovery')).humanPreparation.availableKinds,['recommendation-direction']);
 assert.equal(workbenchPrepareSchemas['recommendation-direction'].safeParse({kind:'recommendation-direction',themeKey:theme.key,direction:'increase',reason:'正常请求',enabled:true}).success,false,'model cannot inject global policy switches');
 const card=await newCard();assert.equal(saveCalls,0);assert.equal(card.capability.canConfirm,true);assert(card.impact.some(line=>line.includes('不改变当前推荐排序')));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_recommendation_events_v1')).rows[0].n,originalEvents,'preparation has no business effect');
 const fixturePrepared=structuredClone(card),done=await confirm(card);assert.equal(done.state,'completed');assert.equal(saveCalls,1);assert.equal(done.result.receipt.version,base.version+1);
 assert.equal(done.result.receipt.direction,'increase');assert.equal(done.result.receipt.enabled,false);assert(done.result.summary.includes('仍未启用'));
 const after=await policyNow();assert.equal(after.enabled,false);assert.deepEqual(after.controls,controls);assert.deepEqual(after.directions,[{key:'category:technology',direction:'decrease'},{key:theme.key,direction:'increase'}]);
 const replay=await tools.card(reader,'discovery',card.cardId);assert.equal(replay.result.receipt.version,done.result.receipt.version);assert.equal(saveCalls,1);
 const stored=(await db.query('SELECT * FROM operations_agentos_conversation_cards_v1 WHERE id=$1',[card.cardId])).rows[0],receipt=await actions.recoverPrepared(reader,stored.proposal,card.operationId);
 assert.deepEqual({...receipt.receipt,replayed:false},done.result.receipt);
 await assert.rejects(actions.recoverPrepared(admin,stored.proposal,card.operationId),{code:'operations_command_receipt_not_found',status:404});
 const wrong=structuredClone(stored.proposal);wrong.command.reason=wrong.request.reason='另一个明确意图';await assert.rejects(actions.recoverPrepared(reader,wrong,card.operationId),{code:'operations_agentos_operation_conflict'});
 const audit=(await db.query("SELECT action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2",[endpoint,card.operationId])).rows;
 assert.equal(audit.length,1);assert.equal(audit[0].action,'recommendations.configure');assert.equal(audit[0].result.version,done.result.receipt.version);
 if(process.env.GALAXY_RECOMMENDATION_FIXTURE_OUTPUT)await writeFile(process.env.GALAXY_RECOMMENDATION_FIXTURE_OUTPUT,JSON.stringify({prepared:fixturePrepared,completed:done},null,2)+'\n');
 await restore();assert.deepEqual(rawPolicy(await policyNow()),baseShape);assert.deepEqual(await recommendation.catalogWithin(db).then(rows=>rows.find(item=>item.key===theme.key)),theme);
 const candidates=[{id:'first'},{id:'second'}];assert.equal(applyRecommendationControl(candidates,{policy:after,themes:[theme]}),candidates,'a disabled policy is not a ranking effect');
 for(const half of ['ai','human']){
  const full=half==='ai'?['recommendations.read','recommendations.configure']:['workbench.read','ai.use.discovery','recommendations.read','recommendations.configure'];
  await setRole(half,full.filter(code=>code!=='recommendations.configure'));await assert.rejects(newCard());await setRole(half,full);
  await setRole(half,full.filter(code=>code!=='recommendations.read'));await assert.rejects(newCard(),{code:'operations_permission_denied'});await setRole(half,full);
 }
 await assert.rejects(actions.prepareFor(reader,'governance',{kind:'recommendation-direction',themeKey:theme.key,direction:'increase',reason:'错误领域'}),{code:'operations_agentos_domain_mismatch'});
 assert.deepEqual(aiWorkCapabilities('governance',['recommendations.read','recommendations.configure']).preparableKinds,['recommendation-direction']);assert.deepEqual(aiWorkCapabilities('discovery',['recommendations.read','recommendations.configure']).autonomousPermissions,['recommendations.read','recommendations.configure']);
 mode='bad-ack';const broken=await newCard(),unknown=await confirm(broken),count=saveCalls;assert.equal(unknown.state,'unknown');assert.equal(unknown.result.receipt,null);
 const recovered=await tools.card(reader,'discovery',broken.cardId);assert.equal(recovered.state,'completed');assert.equal(recovered.result.receipt.direction,'increase');assert.equal(saveCalls,count,'bad ACK recovers by original GET, never POST');mode='normal';await restore();
 mode='lost-write-permission';const late=await newCard(),lateResult=await confirm(late);assert.equal(lateResult.state,'unknown');assert.equal((await tools.card(reader,'discovery',late.cardId)).state,'completed','the committed receipt remains readable after configure revocation');
 mode='normal';await restore();await setRole('ai',['recommendations.read','recommendations.configure']);
 mode='missing';const absent=await newCard(),absentResult=await confirm(absent),beforeReads=saveCalls;assert.equal(absentResult.state,'unknown');
 for(let index=0;index<3;index++)assert.equal((await tools.card(reader,'discovery',absent.cardId)).state,'unknown');assert.equal(saveCalls,beforeReads,'absent receipt cannot re-arm an attempted recommendation card');mode='normal';
 const stale=await actions.prepareFor(reader,'discovery',{kind:'recommendation-direction',themeKey:theme.key,direction:'increase',reason:'本地旧CAS'});await restore();
 const staleOp=randomUUID();await assert.rejects(actions.executePrepared(reader,stale,{operationId:staleOp,authorize:async()=>reader}),{code:'recommendation_policy_changed'});
 assert.equal((await recommendation.commandResult(reader,staleOp)).state,'not-recorded');assert.deepEqual(rawPolicy(await policyNow()),baseShape);
 const projected=view.recommendation({policy:base});assert.deepEqual(projected.directions,[{themeKey:'category:technology',direction:'decrease'},{themeKey:theme.key,direction:'keep'}]);assert.equal(projected.directionsComplete,true);
 assert.deepEqual(view.recommendation({policy:{directions:[]}}).directions,[]);assert.equal(view.recommendation({policy:{}}).directions,null);
 assert.equal(view.recommendation({policy:{directions:[...base.directions,{key:'arbitrary-secret-field',direction:'increase'}]}}).directionsComplete,false);
 const many=Array.from({length:101},()=>({key:'tag:'+randomUUID(),direction:'keep'})),limited=view.recommendation({policy:{directions:many}});assert.equal(limited.directions.length,100);assert.equal(limited.directionsComplete,false);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_automation_grants_v1')).rows[0].n,0);
 await db.exec('RESET ROLE');
});
