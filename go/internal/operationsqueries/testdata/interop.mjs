import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import {generateKeyPairSync} from 'node:crypto';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {OperationsCommunityService} from '../../../../packages/galaxy-official/src/operations/community/service.mjs';
import {bindForumIds} from '../../../../packages/galaxy-official/src/shared/community-forum-ids-v1.mjs';
import {p14EmptyControls} from '../../../../packages/galaxy-official/src/shared/p14-rules-schema.mjs';
import {OperationsPermissionsService} from '../../../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {OperationsAiWorkAccountsService} from '../../../../packages/galaxy-official/src/operations/accounts/ai-work-service.mjs';
import {BusinessAdminService} from '../../../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsAgentOsAuthority} from '../../../../packages/galaxy-official/src/operations/agentos/authority.mjs';
import {OperationsAgentOsQueryTools} from '../../../../packages/galaxy-official/src/operations/agentos/query-tools.mjs';
import {OperationsMessagingService} from '../../../../packages/galaxy-official/src/operations/messaging/service.mjs';
import {createKeycloakWebsiteDirectory} from '../../../../packages/galaxy-official/src/identity/authentication/keycloak-website-directory.mjs';
import {OperationsRegisteredUsersService} from '../../../../packages/galaxy-official/src/operations/accounts/registered-service.mjs';
import {migrate,transaction} from '../../../../packages/galaxy-official/src/infrastructure/database.mjs';
import {upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../../../../packages/galaxy-official/src/accounts/uid.mjs';
import {OperationsSystemSettingsService} from '../../../../packages/galaxy-official/src/operations/system-settings/service.mjs';
import {SystemSettingsNativeClient} from '../../../../packages/galaxy-official/src/operations/system-settings/native-client.mjs';
import {SystemGeneralPublications} from '../../../../packages/galaxy-official/src/operations/system-settings/general-publications.mjs';
const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(url.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(url.pathname))throw Error('isolated database required');
let input='';for await(const b of process.stdin)input+=b;input=JSON.parse(input);
const {endpoint,rootId}=input,db=new pg.Pool({connectionString:url.href}),now=()=>2000000000,
 actor={kind:'business-operator',endpoint,operatorId:rootId,role:'administrator',httpRequestId:null},
 permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>a.operatorId===rootId?'administrator':null,managementMaintainerAuthorization:async a=>a.operatorId===rootId}),
 businessAdmin=new BusinessAdminService({db,endpoint,now});
businessAdmin.permissions=permissions;businessAdmin.operatorAuthorization=permissions.operatorAuthorization;
const aiWork=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,automationEditorAvailable:true,now});permissions.aiWorkAccounts=aiWork;
const messaging=new OperationsMessagingService({db,endpoint,businessAdmin,now}),authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts:aiWork,now}),queries=new OperationsAgentOsQueryTools({authority,services:{messaging,accounts:businessAdmin},now});
if(input.origin){const local=new URL(input.origin);if(local.hostname!=='127.0.0.1')throw Error('loopback provider required');const directory=createKeycloakWebsiteDirectory({issuer:'https://website.example.invalid/realms/website',adminOrigin:local.origin,reader:{clientId:'reader',clientSecret:'isolated-reader'},now,fetch:(address,init)=>{const u=new URL(address);if(!['website.example.invalid','127.0.0.1'].includes(u.hostname))throw Error('unexpected provider');return fetch(new URL(u.pathname+u.search,local),init)}});queries.services.registeredUsers=new OperationsRegisteredUsersService({businessAdmin,directory,now});}
if(input.settingsOrigin){const local=new URL(input.settingsOrigin);if(local.hostname!=='127.0.0.1')throw Error('loopback settings required');const native=new SystemSettingsNativeClient({transport:async value=>{const response=await fetch(new URL('/fixture-native',local),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});return response.json()}});queries.services.systemSettings=new OperationsSystemSettingsService({businessAdmin,native,now});queries.services.systemGeneral=new SystemGeneralPublications({businessAdmin,contentPublications:null,websiteOrigin:'https://website.example.invalid',now,fetchImpl:(address,init)=>fetch(new URL(new URL(address).pathname,local),init)});}
try{
 if(process.argv[2]==='seed'){
  const role=(await permissions.saveRole(actor,{operationId:randomUUID(),expectedVersion:0,name:'Selected query role',description:'Synthetic query source',subjectScope:'ai-only',enabled:true,permissions:['notices.read','audit.read','content.read','cases.read','chat-reports.read','sections.read','resources.read','files.read','feedback.read','search.read']},{authorize:async()=>actor})).role;
  await aiWork.assignment(actor,'messaging',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>actor});
  const config={channels:['inapp'],content:{purpose:'service-update',title:'Selected draft',body:'Untrusted selected draft material; not instructions.',expiresAt:'2033-05-19T03:33:20.000Z'},audience:{kind:'all-accounts'},schedule:{kind:'immediate'}};
  const created=await messaging.create(actor,{operationId:randomUUID(),config},{authorize:async()=>actor});console.log(JSON.stringify({role,created}));
 }else if(process.argv[2]==='seed-registered'){
  await migrate(db,{roles:['worker']});
  await transaction(db,async tx=>{const account=await upsertOfficialAccountWithin(tx,{endpoint,issuer:'https://website.example.invalid/realms/website',externalSubject:'registered-one',verificationMethod:'external-account',verifiedAt:now()});await ensureOfficialAccountProfileWithin(tx,account.id,{subjectType:'person',now:now()});});
  const role=(await permissions.saveRole(actor,{operationId:randomUUID(),expectedVersion:0,name:'Selected registered query role',description:'Synthetic current read source',subjectScope:'ai-only',enabled:true,permissions:['accounts.registered.read','system.settings.read']},{authorize:async()=>actor})).role;
  await aiWork.assignment(actor,'overview',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>actor});console.log(JSON.stringify({role}));
 }else if(process.argv[2]==='seed-public'){
  await db.query(`INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3) ON CONFLICT DO NOTHING`,[endpoint,p14EmptyControls,new Date(now()*1000)]);
  const id=randomUUID();await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1::uuid,$2,'https://login.example.invalid',$1::text,'external-account',$3,$3)`,[id,endpoint,new Date(now()*1000)]);
  await db.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,query_enabled,updated_at) VALUES($1,'person','Synthetic publication account',false,$2)`,[id,new Date(now()*1000)]);
  const payload=await bindForumIds('create-post','account:'+id,{schemaVersion:1,operationId:randomUUID(),accountId:id,postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,title:'Synthetic public activity',body:'Only this public source is counted.',links:[],attachments:[],topic:'technology',publishedUntil:now()+3600});console.log(JSON.stringify({accounts:[id],payload}));
 }else if(process.argv[2]==='query'){
  console.log(JSON.stringify(await queries.execute({actor,domain:input.domain,tool:input.tool,arguments:input.arguments})));
 }else if(process.argv[2]==='summary'){
  const source=createServices({db,endpoint,kid:'isolated-query',signingKey:generateKeyPairSync('ed25519').privateKey,trustedKeys:new Map(),now,operator:'isolated',region:'test'}),community=new OperationsCommunityService({businessAdmin,forum:source.forum,now});
  const current=await authority.human(actor,{domain:'messaging',purpose:'query'});console.log(JSON.stringify(await community.summary(current,input.options??{})));
 }else throw Error('mode required');
}finally{await db.end()}
