import test from 'node:test';
import {attachAiWorkFixture} from './fixtures/ai-work.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {createStoredOperatorAuthorization} from '../src/operations-config.mjs';
import {createOperationsManagementSessions} from '../src/operations-management-sessions.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsService} from '../src/operations-agentos.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {operationsAiUseDomain} from '../src/shared/operations-ai-use.mjs';

const endpoint='https://human-ai-use.example.invalid',issuer='https://identity.example.invalid/realms/management';
const hash=value=>createHash('sha256').update(value).digest('hex'),id=sub=>hash(issuer+'\0'+sub);
const hasCode=code=>error=>error?.code===code;
const domains=['overview','governance','messaging','discovery','maintenance'];

// One new authorization group, not a replay of the conversation/action suites.
// Real PostgreSQL schema/roles and business effects; native model/client and
// upstream native-role responses are explicit doubles. No provider I/O.
test('human domain AI permissions gate conversations, receipts, callbacks, cards and assisted executions without granting business rights or restricting automatic grants',
 {timeout:90000},async t=>{
  assert.deepEqual(migrations.map(x=>x.version),[...Array.from({length:119},(_,i)=>i+1),...Array.from({length:11},(_,i)=>i+121)]);
  const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE column_name='ai_domains'")).rows[0].n,0);
  const now=()=>Math.floor(Date.now()/1000),at=()=>new Date(now()*1000).toISOString();
  const root=Object.freeze({version:1,endpoint,issuer,externalSubject:'fixed-root',operatorId:id('fixed-root')});
  const person={kind:'business-operator',operatorId:id('member'),endpoint,role:'reader'},admin={...person,operatorId:root.operatorId,role:'administrator'};
  const nativeRoles={async getOperatorRoles(){return ['native-management-admin'];},invalidateOperatorRoles(){return true;}};
  const lifecycle=createOperationsManagementSessions({db,endpoint,issuer,roleDirectory:nativeRoles,now});
  const stored=createStoredOperatorAuthorization({db,endpoint,issuer,roles:{administrator:'native-management-admin',reader:'native-management-reader'},roleDirectory:nativeRoles,rootPrincipal:root,managementSessions:lifecycle});
  const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:stored,now});
  for(const sub of ['fixed-root','member'])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,$3,$4,$4,$5,$5)`,[id(sub),endpoint,issuer,sub,at()]);
  const roleId=randomUUID(),base=['workbench.read','accounts.read','accounts.restriction.apply'];
  const setPermissions=async codes=>db.query('UPDATE operations_business_roles_v1 SET permissions=$2 WHERE id=$1',[roleId,codes]);
  await db.query(`INSERT INTO operations_business_roles_v1(id,endpoint,name,enabled,version,permissions,created_by,updated_by,created_at,updated_at)
   VALUES($1,$2,'Synthetic domain use',true,1,$3,$4,$4,$5,$5)`,[roleId,endpoint,[...base,'ai.use.overview'],root.operatorId,at()]);
  await db.query(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at)
   VALUES($1,$2,$3,$4,true,1,$5,$5,$6,$6)`,[randomUUID(),endpoint,person.operatorId,roleId,root.operatorId,at()]);
  const target=randomUUID();await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
   VALUES($1,$2,'https://website.example.invalid/realms/galaxy','synthetic-target','email',$3,$3)`,[target,endpoint,at()]);
  const bootstrapBusiness=new BusinessAdminService({db,endpoint,permissions,now});
  const bootstrapAuthority=new OperationsAgentOsAuthority({db,endpoint,permissions,now});
  const {accounts:aiWorkAccounts,ids:aiIds}=await attachAiWorkFixture({db,endpoint,permissions,businessAdmin:bootstrapBusiness,authority:bootstrapAuthority,admin,domains,codes:base,now});
  await db.exec('SET ROLE galaxy_api');
  const authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts,now}),ledger=new Map();let dispatches=0;
  const client={
   async status(){return {state:'connected',modelState:'configured',configuredDomains:domains,conversationVersion:2,conversationDomains:domains};},
   async runConversation(execution,input){dispatches++;ledger.set(execution.id,[{runId:input.runId,operationId:input.runId,status:'COMPLETED',content:'Explicit native double',userInput:input.message,awaitingHuman:false}]);return {run_id:input.runId};},
   async readConversation(execution){return {runs:ledger.get(execution.id)??[],readExpiresAt:now()+30};},
  };
  const service=new OperationsAgentOsService({authority,client,summaryForConversation:async()=>({checkedAt:now(),readExpiresAt:now()+30,availability:{}})});
  const business=new BusinessAdminService({db,endpoint,permissions,now});
  let revokeInsideBusiness=false;
  service.connectConversationTools({gateway:{},services:{accounts:{
   get:(...args)=>business.get(...args),
   restrict:async(...args)=>{if(revokeInsideBusiness){revokeInsideBusiness=false;await setPermissions(base);}return business.restrict(...args);},
  }}});
  const authorize=async()=>person;
  for(const domain of domains)assert.equal((await service.conversation(admin,domain)).capabilities.canSend,true,'fixed root includes each human use code');
  assert.equal((await service.conversation(person,'overview')).capabilities.canSend,true);
  for(const domain of domains.slice(1)){
   await assert.rejects(service.conversation(person,domain),hasCode('operations_agentos_ai_use_denied'));
   await assert.rejects(service.conversationRun(person,domain,{operationId:randomUUID(),message:'No native dispatch'},{authorize}),hasCode('operations_agentos_ai_use_denied'));
  }
  assert.equal(dispatches,0);
  const bound=await authority.human(person,{domain:'overview'});
  assert.equal(operationsAiUseDomain(bound),'overview');
  await assert.rejects(permissions.requireAction(bound,'content.read'),hasCode('operations_permission_denied'),'AI use adds no business read');
  await assert.rejects(business.authorizeAction({...bound},'accounts.read'),hasCode('operations_agentos_ai_use_denied'),'unattested spread cannot downgrade to ordinary human');
  const revalidated=await business.revalidate(bound);assert.equal(operationsAiUseDomain(revalidated),'overview','explicit BusinessAdmin clone carries its restriction');

  const op=randomUUID(),sent=await service.conversationRun(person,'overview',{operationId:op,message:'Synthetic input'},{authorize});
  assert.equal(sent.state,'accepted');assert.equal(dispatches,1);
  assert.equal((await service.conversationOperation(person,'overview',op)).state,'COMPLETED');
  const conversation=(await db.query('SELECT * FROM operations_agentos_conversations_v1 WHERE operator_id=$1 AND domain=$2',[person.operatorId,'overview'])).rows[0];
  const nativeInput={conversationId:conversation.id,operation:'run',resourceType:'agents',resourceId:'galaxy-conversation-overview'};
  assert.equal((await service.conversations.authorizeNative(nativeInput)).allowed,true);
  await assert.rejects(service.conversations.authorizeNative({...nativeInput,resourceId:'galaxy-conversation-governance'}),hasCode('operations_agentos_domain_mismatch'));
  const envelope={conversationId:conversation.id,sessionId:conversation.session_id,turnId:op,runId:op,callId:'new-ai-use-summary',tool:'workbench-summary',arguments:{}};
  assert.equal((await service.conversations.executeTool(envelope)).domain,'overview');
  const prepared=await service.conversations.executeTool({...envelope,callId:'new-ai-use-card',tool:'prepare-operation',arguments:{kind:'account-restriction',action:'apply',targetId:target,until:new Date((now()+3600)*1000).toISOString(),reason:'Synthetic decision'}});
  const card=prepared.card;assert.equal(card.capability.canConfirm,true);
  await assert.rejects(service.conversationCard(person,'governance',card.cardId),hasCode('operations_agentos_ai_use_denied'));

  // The last business adapter boundary changes only ai.use, retaining the
  // actual write permission. Real BusinessAdmin.restrict must reject inside
  // its transaction, not depend on an earlier UI or card check.
  revokeInsideBusiness=true;
  await assert.rejects(service.conversationConfirm(person,'overview',card.cardId,{cardId:card.cardId,operationId:card.operationId},{authorize}),hasCode('operations_agentos_ai_use_denied'));
  assert.equal((await db.query('SELECT restriction_revision FROM community_accounts WHERE id=$1',[target])).rows[0].restriction_revision,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE action='restriction-set'")).rows[0].n,0);
  await assert.rejects(business.restrict(revalidated,target,{operationId:randomUUID(),expectedRevision:0,until:new Date((now()+3600)*1000).toISOString(),reason:'Original scoped AI actor'}),hasCode('operations_agentos_ai_use_denied'));
  await assert.rejects(service.conversationOperation(person,'overview',op),hasCode('operations_agentos_ai_use_denied'));
  await assert.rejects(service.conversationRun(person,'overview',{operationId:op,message:'Synthetic input'},{authorize}),hasCode('operations_agentos_ai_use_denied'));
  await assert.rejects(service.conversations.authorizeNative(nativeInput),hasCode('operations_agentos_ai_use_denied'));
  await assert.rejects(service.conversations.executeTool({...envelope,callId:'after-revoke'}),hasCode('operations_agentos_ai_use_denied'));
  await assert.rejects(service.conversationCard(person,'overview',card.cardId),hasCode('operations_agentos_ai_use_denied'));
  assert.equal(dispatches,1,'receipt/revocation cannot start another model call');
  const direct=await business.restrict(person,target,{operationId:randomUUID(),expectedRevision:0,until:new Date((now()+3600)*1000).toISOString(),reason:'Direct human operation'});
  assert.equal(direct.restriction.revision,1,'ordinary human page keeps its separate current business permission');
  t.diagnostic('conversation/read/send/original operation/native callback/tools/direct card and confirmation race exercised; no real model');

  await setPermissions([...base,'ai.use.overview']);
  const assisted=randomUUID(),automatic=randomUUID(),humanOnly=randomUUID(),legacyGrant=randomUUID();
  for(const [grantId,mode,codes] of [[assisted,'assisted',[]],[automatic,'automatic',[]],[humanOnly,'assisted',['ai.use.overview']],[legacyGrant,'assisted',[]]])await db.query(`INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,resource_scope_kind,ai_account_id,created_by,updated_by,created_at,updated_at)
   VALUES($1::uuid,$2,$1::uuid::text,'ai',$3,true,1,$4,$5,$6,$9,$7,$7,$8,$8)`,[grantId,endpoint,mode,codes,grantId===humanOnly?[target]:[],grantId===humanOnly?'selected':null,root.operatorId,at(),grantId===legacyGrant?aiIds.governance:mode==='automatic'?aiIds.maintenance:aiIds.overview]);
  const input={operationId:randomUUID(),grantId:assisted,expectedGrantVersion:1,domain:'overview',actions:[],resourceIds:[],preparedCommand:null};
  const created=await authority.create(person,input,{authorize});assert.equal(created.execution.domain,'overview');
  await assert.rejects(authority.create(person,{...input,operationId:randomUUID(),domain:'governance'},{authorize}),hasCode('operations_agentos_ai_use_denied'));
  const legacyId=randomUUID();await db.query(`INSERT INTO operations_agentos_executions_v1(id,endpoint,grant_id,grant_version,domain,executor_kind,mode,operator_id,created_by,actions,resource_ids,ai_account_id,state,revision,session_id,created_at,updated_at)
   VALUES($1,$2,$3,1,'governance','ai','assisted',$4,$4,'{}','{}',$7,'active',1,$5,$6,$6)`,[legacyId,endpoint,legacyGrant,person.operatorId,randomUUID(),at(),aiIds.governance]);
  assert.deepEqual((await authority.list(person)).items.map(x=>x.id),[created.execution.id]);
  await assert.rejects(authority.get(person,legacyId),hasCode('operations_agentos_ai_use_denied'));
  await assert.rejects(authority.nativeAuthorization({executionId:legacyId,operation:'run'}),hasCode('operations_agentos_ai_use_denied'));
  assert.deepEqual((await authority.options(person)).items,[],'an empty action grant is not advertised as an executable option');
  const auto=await authority.create(admin,{...input,operationId:randomUUID(),grantId:automatic,domain:'maintenance'},{authorize:async()=>admin});
  await assert.rejects(authority.create(admin,{...input,operationId:randomUUID(),grantId:humanOnly,actions:['ai.use.overview'],resourceIds:[target]},{authorize:async()=>admin}),hasCode('operations_ai_work_permission_denied'));
  await setPermissions(base);
  assert.deepEqual((await authority.list(person)).items,[]);
  assert.deepEqual((await authority.options(person)).items,[]);
  await assert.rejects(authority.get(person,created.execution.id),hasCode('operations_agentos_ai_use_denied'));
  await assert.rejects(authority.create(person,input,{authorize}),hasCode('operations_agentos_ai_use_denied'),'old create receipt is still domain protected');
  await assert.rejects(authority.nativeAuthorization({executionId:created.execution.id,operation:'run'}),hasCode('operations_agentos_ai_use_denied'));
  assert.equal((await authority.nativeAuthorization({executionId:auto.execution.id,operation:'run'})).allowed,true,'automatic native grant needs no human-only ai.use permission');
  await db.query('UPDATE operations_automation_grants_v1 SET enabled=false WHERE id=$1',[automatic]);
  await assert.rejects(authority.nativeAuthorization({executionId:auto.execution.id,operation:'run'}),hasCode('operations_agentos_authority_changed'),'automatic execution still needs its original live grant');
  t.diagnostic('special-task create/replay/owned/list/options/native and automatic-grant distinction exercised with real SQL');

  const helperUrl=new URL('../../../apps/galaxy-admin/src/lib/agentos-client.ts',import.meta.url),sharedUrl=new URL('../src/shared/operations-ai-use.mjs',import.meta.url);
  const raw=await readFile(helperUrl,'utf8'),code=stripTypeScriptTypes(raw,{mode:'strip'}).replace("'../../../../packages/galaxy-official/src/shared/operations-ai-use.mjs'",JSON.stringify(sharedUrl.href));
  const {agentOsCanUseDomain}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const session={state:'signed-in',operator:{id:person.operatorId,businessAuthorization:{permissions:[...base,'ai.use.overview']}},csrfToken:'synthetic',expiresAt:now()+300};
  assert.equal(agentOsCanUseDomain(session,'overview'),true);for(const domain of domains.slice(1))assert.equal(agentOsCanUseDomain(session,domain),false);
  assert.equal(agentOsCanUseDomain(null,'overview'),false);assert.equal(agentOsCanUseDomain({state:'signed-out'},'overview'),false);
  assert.equal(agentOsCanUseDomain({...session,operator:{...session.operator,businessAuthorization:{permissions:['ai.use.overview']}}},'overview'),false);
  t.diagnostic('actual frontend permission helper accepts only verified-session input supplied by Workbench; no role-name inference');
 });
