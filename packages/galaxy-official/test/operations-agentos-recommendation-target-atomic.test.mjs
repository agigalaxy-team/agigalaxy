import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {OperationsRecommendationService} from '../src/operations/recommendations/service.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import '../src/operations-agentos-conversation-tools.mjs';
import '../src/operations-agentos-conversations.mjs';
import '../src/operations-agentos-query-view.mjs';
import '../src/operations-agentos-action-catalog.mjs';
import '../src/shared/operations-ai-work-capabilities.mjs';
import {bindOperationsAiUse,withOperationsAiWork,inheritOperationsAiUse,operationsAiUseDomain} from '../src/shared/operations-ai-use.mjs';
import '../src/discovery-runtime/recommendation-control.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real PGlite migrations/galaxy_api role, stored human and AI role grants,
// recommendation service/CAS/event/audit and central human-card dispatcher.
// Native admission/transport and an empty public-supply reader are explicit
// doubles; no provider, private content or production request is involved.
test('the frozen recommendation target is checked inside the original policy transaction',{timeout:120000},async t=>{
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
 const humanRole=await grant('本地推荐人员',['workbench.read','ai.use.discovery','recommendations.read','recommendations.configure']),aiRole=await grant('本地推荐岗位',['recommendations.read','recommendations.configure']);
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:humanRole.id,enabled:true},{authorize:async()=>admin});
 await migrate(db,{roles:['api']});await db.exec('SET ROLE galaxy_api');
 await aiAccounts.assignment(admin,'discovery',{operationId:randomUUID(),expectedVersion:0,roleId:aiRole.id,enabled:true},{authorize:async()=>admin});
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
 await recommendation.savePolicy(admin,{operationId:randomUUID(),expectedVersion:1,enabled:false,themeKey:theme.key,direction:'keep',controls,reason:'本地原中性方向'},{authorize:async()=>admin});

 let race=null,saveCalls=0;
 const services={recommendations:{overview:recommendation.overview.bind(recommendation),commandResult:recommendation.commandResult.bind(recommendation),async savePolicy(...args){
  saveCalls++;if(race){const current=race;race=null;await current();}return recommendation.savePolicy(...args);
 }}};
 const actions=new OperationsAgentOsActionTools({conversations:{},authority,gateway:{},services});
 const proposalFor=key=>actions.prepareFor(reader,'discovery',{kind:'recommendation-direction',themeKey:key,direction:'increase',reason:'只修改当前冻结目标的方向'});
 const execute=(proposal,operationId)=>actions.executePrepared(reader,proposal,{operationId,authorize:async()=>reader});
 const freshTheme=async()=> (await recommendation.catalogWithin(db)).find(item=>item.key===theme.key);
 const updateTheme=async patch=>{const current=await freshTheme();return recommendation.saveTheme(admin,{operationId:randomUUID(),themeId:theme.id,expectedVersion:current.version,label:current.label,enabled:current.enabled,mapping:current.mapping,reason:'本地并发编辑发生在卡重核后',...patch},{authorize:async()=>admin});};
 const initialPolicy=await recommendation.policyWithin(db),before=await proposalFor(theme.key),firstOp=randomUUID();
 race=()=>updateTheme({mapping:{categories:['life','arts'],tagIds:[],queryTerms:['新的当前主题映射']}});
 await assert.rejects(execute(before,firstOp),{code:'recommendation_theme_changed'},'theme commit after prepare but before save must reject without touching policy');
 assert.equal(saveCalls,1);assert.deepEqual(await recommendation.policyWithin(db),initialPolicy);
 assert.equal((await recommendation.commandResult(reader,firstOp)).state,'not-recorded');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[endpoint,firstOp])).rows[0].n,0);
 const enabledBefore=await proposalFor(theme.key),enabledOp=randomUUID();race=()=>updateTheme({enabled:true});
 await assert.rejects(execute(enabledBefore,enabledOp),{code:'recommendation_theme_changed'});
 assert.deepEqual(await recommendation.policyWithin(db),initialPolicy);
 const tagId=randomUUID(),tagKey='tag:'+tagId,at=new Date(now()*1000);
 await db.query("INSERT INTO operations_forum_tags_v1(id,endpoint,name,normalized_name,revision,enabled,created_at,updated_at) VALUES($1,$2,'本地独立标签','本地独立标签',1,true,$3,$3)",[tagId,endpoint,at]);
 const tagBefore=await proposalFor(tagKey),tagOp=randomUUID();
 race=()=>db.query('UPDATE operations_forum_tags_v1 SET revision=revision+1,enabled=false WHERE endpoint=$1 AND id=$2',[endpoint,tagId]);
 await assert.rejects(execute(tagBefore,tagOp),{code:'recommendation_theme_changed'},'tag changes under a different advisory lock must also reject');
 assert.deepEqual(await recommendation.policyWithin(db),initialPolicy);
 const current=await proposalFor(theme.key),successOp=randomUUID(),done=await execute(current,successOp);
 assert.equal(done.state,'completed');assert.equal(done.receipt.version,initialPolicy.version+1);
 await updateTheme({enabled:false,mapping:{categories:['life'],tagIds:[],queryTerms:['完成之后的新映射']}});
 const recovered=await actions.recoverPrepared(reader,current,successOp);
 assert.equal(recovered.state,'completed');assert.equal(recovered.receipt.version,done.receipt.version);
 assert.equal(recovered.receipt.direction,'increase','original committed receipt must survive a later target version');
 const body={operationId:successOp,expectedVersion:current.command.expectedVersion,enabled:current.command.enabled,themeKey:theme.key,direction:'increase',controls:current.command.controls,reason:current.command.reason};
 const originalAgain=await recommendation.savePolicy(reader,body,{authorize:async()=>reader,expectedTheme:{key:theme.key,expectedVersion:current.command.themeVersion,enabled:current.command.themeEnabled}});
 assert.equal(originalAgain.replayed,true);assert.equal(originalAgain.policy.version,done.receipt.version,'idempotent lookup precedes current-target checks');
 const plainCurrent=await recommendation.policyWithin(db),plainOp=randomUUID();
 const plain=await recommendation.savePolicy(admin,{operationId:plainOp,expectedVersion:plainCurrent.version,enabled:false,themeKey:'category:technology',direction:'keep',controls:plainCurrent.controls,reason:'原人工接口无新增输入'},{authorize:async()=>admin});
 assert.equal(plain.policy.version,plainCurrent.version+1);
 const categoryCurrent=await recommendation.policyWithin(db),categoryOp=randomUUID();
 const category=await recommendation.savePolicy(admin,{operationId:categoryOp,expectedVersion:categoryCurrent.version,enabled:false,themeKey:'category:technology',direction:'increase',controls:categoryCurrent.controls,reason:'不可变分类当前事实'},{authorize:async()=>admin,expectedTheme:{key:'category:technology',expectedVersion:0,enabled:true}});
 assert.equal(category.policy.version,categoryCurrent.version+1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=ANY($2::uuid[])',[endpoint,[firstOp,enabledOp,tagOp]])).rows[0].n,0);
 await db.exec('RESET ROLE');
 console.log(JSON.stringify({newUniqueLeaves:1,lateThemeMappingRejected:true,lateThemeEnabledRejected:true,lateTagChangeRejected:true,oldReceiptAfterTargetChange:true,existingPlainHumanContractUnchanged:true,actualDatabase:'PGlite schema125 with galaxy_api',concurrentPgSessions:false,providerCalls:0,productionWrites:0}));
});
