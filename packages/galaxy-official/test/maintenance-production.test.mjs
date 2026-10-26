import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readlink,symlink,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {reconcileOpenPanelSecurity,openPanelSecurityCaptureSql,openPanelSecurityTables} from '../deploy/maintenance-agent/engine-security.mjs';
import {MaintenancePublicGate,containedPublicConfiguration} from '../deploy/maintenance-agent/public-gate.mjs';
import {createProductionRestoreAdapters} from '../deploy/maintenance-agent/production-restore.mjs';
import {MaintenanceRestoreExecutor} from '../deploy/maintenance-agent/restore-executor.mjs';
import {MaintenanceControlJournal} from '../deploy/maintenance-agent/journal.mjs';
import {maintenanceOpeningConditions} from '../src/operations-maintenance-catalog.mjs';
import {isolatedPostgresArguments} from '../deploy/operations-stack/backup.mjs';
import {restoredDatabaseNames,MaintenanceHostDatabase} from '../deploy/maintenance-agent/host-database.mjs';
import {maintenanceFileTransfers} from '../deploy/maintenance-agent/host-files.mjs';
import {MaintenanceNativeRuntime} from '../deploy/maintenance-agent/runtime.mjs';
import {verifyCurrentModelConfiguration,modelAuthorityCaptureSql} from '../deploy/maintenance-agent/model-preservation.mjs';
import {ModelConfigurationRuntime} from '../deploy/maintenance-agent/model-configuration.mjs';
import {compileModelConfiguration,credentialVariable} from '../deploy/maintenance-agent/model-configuration-codec.mjs';
import {MaintenanceCaddyControl} from '../deploy/maintenance-agent/caddy-control.mjs';
import {reconcileDiscoveryItems} from '../deploy/maintenance-agent/discovery-reconciliation.mjs';
import {createDiscoveryReadOnlySource} from '../src/discovery-runtime/public-content-source.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {MaintenanceWebsitePointer} from '../deploy/maintenance-agent/website-pointer.mjs';
import {pauseRestoredStrategyRuns} from '../src/operations/maintenance-recovery-facts.mjs';

const fail=code=>Object.assign(Error(code),{code});
const linux={skip:process.platform!=='linux'?'Private native artifacts require Linux filesystem permissions.':false};
// A deliberately small SQL fixture using the fixed public2 @@map names and
// real relevant FK/unique relations. This tests the merge against a PG engine;
// it is not an OpenPanel native HTTP/deployment test or a production restore.
test('maintenance keeps current OpenPanel credential/access rows and invalidates sessions without resurrecting older native passwords or client keys',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`
 CREATE TABLE organizations(id text PRIMARY KEY,name text NOT NULL);
 CREATE TABLE projects(id text PRIMARY KEY,"organizationId" text NOT NULL REFERENCES organizations(id),name text NOT NULL);
 CREATE TABLE users(id text PRIMARY KEY,email text NOT NULL UNIQUE,"deletedAt" timestamptz);
 CREATE TABLE accounts(id text PRIMARY KEY,"userId" text NOT NULL REFERENCES users(id),password text,"accessToken" text);
 CREATE TABLE user_totp("userId" text PRIMARY KEY REFERENCES users(id),secret text NOT NULL);
 CREATE TABLE members(id text PRIMARY KEY,"organizationId" text NOT NULL REFERENCES organizations(id),"userId" text REFERENCES users(id),role text NOT NULL);
 CREATE TABLE invites(id text PRIMARY KEY,"organizationId" text NOT NULL REFERENCES organizations(id),"createdByUserId" text NOT NULL REFERENCES users(id));
 CREATE TABLE project_access("projectId" text REFERENCES projects(id),"userId" text REFERENCES users(id),level text NOT NULL,PRIMARY KEY("projectId","userId"));
 CREATE TABLE clients(id text PRIMARY KEY,"projectId" text REFERENCES projects(id),"organizationId" text NOT NULL REFERENCES organizations(id),secret text NOT NULL,type text NOT NULL);
 CREATE TABLE salts(salt text PRIMARY KEY);
 CREATE TABLE sessions(id text PRIMARY KEY,"userId" text NOT NULL REFERENCES users(id));
 CREATE TABLE two_factor_challenges(id text PRIMARY KEY,"userId" text NOT NULL REFERENCES users(id));
 CREATE TABLE reset_password(id text PRIMARY KEY,"accountId" text NOT NULL REFERENCES accounts(id));
 INSERT INTO organizations VALUES('org','Point organization');INSERT INTO projects VALUES('project','org','Point project');
 INSERT INTO users VALUES('old-user','person@example.invalid',NULL);INSERT INTO accounts VALUES('old-account','old-user','old-password-hash','old-oauth-token');
 INSERT INTO user_totp VALUES('old-user','old-totp');INSERT INTO members VALUES('old-admin','org','old-user','org:admin');
 INSERT INTO clients VALUES('old-client','project','org','revoked-secret','root');INSERT INTO salts VALUES('old-salt');
 INSERT INTO sessions VALUES('old-session','old-user');INSERT INTO reset_password VALUES('old-reset','old-account');`);
 const facts={organizations:[{id:'org',name:'Current identity parent'}],projects:[{id:'project',organizationId:'org',name:'Current project'},{id:'new-project',organizationId:'org',name:'Required current access parent'}],
  users:[{id:'current-user',email:'person@example.invalid',deletedAt:null}],accounts:[{id:'current-account',userId:'current-user',password:'current-password-hash',accessToken:'current-oauth-token'}],
  user_totp:[{userId:'current-user',secret:'current-totp'}],members:[{id:'service-owner',organizationId:'org',userId:null,role:'org:admin'},{id:'current-member',organizationId:'org',userId:'current-user',role:'org:member'}],
  invites:[],project_access:[{projectId:'new-project',userId:'current-user',level:'read'}],clients:[{id:'current-client',projectId:'project',organizationId:'org',secret:'current-secret',type:'read'}],salts:[{salt:'current-salt'}]};
 await assert.rejects(reconcileOpenPanelSecurity(db,facts),{code:'maintenance_native_security_candidate_required'});
 const recoveryId=randomUUID();await db.exec('CREATE TEMP TABLE galaxy_maintenance_recovery_guard(operation_id uuid NOT NULL,private_candidate boolean NOT NULL)');await db.query('INSERT INTO galaxy_maintenance_recovery_guard VALUES($1,true)',[recoveryId]);
 const result=await reconcileOpenPanelSecurity(db,facts,{at:new Date('2026-10-23T09:00:00Z'),recoveryId});assert.equal(result.currentPasswordsPreserved,true);assert.equal(result.currentClientsPreserved,true);
 assert.deepEqual((await db.query('SELECT id,secret FROM clients')).rows,[{id:'current-client',secret:'current-secret'}]);
 assert.deepEqual((await db.query('SELECT password FROM accounts')).rows,[{password:'current-password-hash'}]);
 assert((await db.query("SELECT \"deletedAt\" FROM users WHERE id='old-user'")).rows[0].deletedAt);assert.equal((await db.query("SELECT email FROM users WHERE id='current-user'")).rows[0].email,'person@example.invalid');
 assert.equal((await db.query('SELECT id FROM sessions')).rows.length,0);assert.equal((await db.query('SELECT id FROM reset_password')).rows.length,0);
 assert.equal((await db.query("SELECT \"userId\" FROM members WHERE id='service-owner'")).rows[0].userId,null,'service org owner remains a non-login member, not an invented User');
 assert.equal((await db.query("SELECT name FROM projects WHERE id='project'")).rows[0].name,'Point project','existing business metadata stays at point; missing current security parents are supplied');
 const native=await db.exec(openPanelSecurityCaptureSql);assert.equal(Object.keys(native.find(x=>x.rows?.[0]?.jsonb_build_object).rows[0].jsonb_build_object).length,openPanelSecurityTables.length);
 await assert.rejects(reconcileOpenPanelSecurity(db,{...facts,unexpected:'must-not-be-treated-as-SQL'}),{code:'maintenance_native_security_facts_invalid'});
});

test('maintenance fixed host protocol keeps IAM/control available, distinguishes staged artifacts from final native readiness and opens only once',linux,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-maintenance-production-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const original={apps:{http:{servers:{s0:{listen:[':443'],routes:[{match:[{host:['admin.example.invalid']}],handle:[{handler:'headers',response:{set:{'X-Security':['preserved']}}},{handler:'subroute',routes:[{match:[{path:['/realms/*']}],handle:[{handler:'reverse_proxy',upstreams:[{dial:'127.0.0.1:18080'}]}]},{handle:[{handler:'reverse_proxy',upstreams:[{dial:'127.0.0.1:3400'}]}]}]}]},{handle:[{handler:'reverse_proxy',upstreams:[{dial:'127.0.0.1:3201'}]}]}]}}}},privateMarker:'synthetic-private-current-configuration'};
 let current=structuredClone(original),loads=0;
 const fetchImpl=async(url,options={})=>{assert(url.startsWith('http://127.0.0.1:2019/'));if(options.method==='POST'){current=JSON.parse(options.body);loads++;return{ok:true,text:async()=>''};}return{ok:true,text:async()=>JSON.stringify(current)};};
 const gate=new MaintenancePublicGate({controlDirectory:directory,fetchImpl}),writers=new Map([['galaxy-api@pilot.service',true],['galaxy-worker@pilot.service',true]]),effects=[];
 const config={tools:{docker:'synthetic-docker',systemctl:'synthetic-systemctl'},postgres:[{id:'business',database:'galaxy_pilot',container:'synthetic-business',socketPath:'/tmp',administrator:'postgres'}]};
 const run=async(command,args)=>{
  if(command==='synthetic-systemctl'){if(args[0]==='show')return{code:0,stdout:writers.get(args.at(-1))?'active':'inactive'};effects.push(args[0]+':'+args[1]);writers.set(args[1],args[0]==='start');return{code:0,stdout:''};}
  assert(args.includes('psql'));assert(args.at(-1).includes('operations_model_settings_operations_v1'));return{code:0,stdout:'0'};
 };
 let healthy=true;
 const adapters=createProductionRestoreAdapters({config,run,controlDirectory:directory,gate,readinessTimeoutMs:0,
  engines:{capture:async()=>({privateArtifact:'synthetic'}),prepareOpenPanel:async()=>({required:false})},
  databases:{prepare:async context=>{effects.push('prepare-database');context.artifacts.security={authorityPreserved:true,sourceGatesReconciled:true,outbound:{submittedNotRetried:true}};context.artifacts.deletion={quarantined:true};return[];},activate:async()=>{effects.push('activate-database');},validate:async()=>{effects.push('native-database-validation');}},
  files:{stage:async()=>[],activate:async()=>{effects.push('activate-files');}},
  health:{check:async context=>{effects.push('native-health');assert(current.apps.http.servers.s0.routes.at(-1).handle[0].status_code===503);assert(context.containment.probeToken);if(!healthy)throw fail('maintenance_required_modules_not_ready');return{currentIdentityReady:true};}},
  prepare:async context=>{assert(context.currentFacts.complete);return{directory,files:directory+'/prepared',databases:[]};},
  captureCurrent:async()=>({current:true}),captureDeletion:async()=>({signatureValidated:true}),fingerprint:async()=>({sha256:'synthetic-current-security-version',fileCount:3}),
  readModelState:async()=>({endpoint:'https://official.example.invalid',pending:0,tables:{operations_model_settings_state_v1:{rows:[]},operations_model_settings_versions_v1:{rows:[]}}}),
  loadCurrent:async()=>({endpoint:'https://official.example.invalid',tables:{operations_model_settings_state_v1:{rows:[]},operations_model_settings_versions_v1:{rows:[]}}}),verifyModels:async()=>({state:'verified',versionId:null,configurationVersion:'unconfigured-v1'})});
 const journal=new MaintenanceControlJournal({directory:directory+'/journal'}),executor=new MaintenanceRestoreExecutor({journal,adapters}),moduleIds=['business'];
 const intent=()=>({kind:'restore-execute',operationId:randomUUID(),operatorId:'synthetic-current-operator',planId:randomUUID(),revision:2,planDigest:'a'.repeat(64),footprintDigest:'b'.repeat(64),pointId:'c'.repeat(64),moduleIds,openingConditions:[...maintenanceOpeningConditions],approvedAt:new Date().toISOString()});
 const footprint={digest:'b'.repeat(64),writers:[...writers.keys()].map(name=>({kind:'systemd',name})),containers:[],services:[]},authorize=async()=>({endpoint:'https://official.example.invalid'});
 const approved=intent(),result=await executor.execute(approved,{point:{},footprint,authorize});assert.equal(result.state,'succeeded');assert.equal(result.publicActivation,true);assert.equal(loads,2);assert.deepEqual(current,original);assert.equal(effects.filter(x=>x==='activate-database').length,1);assert.equal(effects.filter(x=>x==='native-health').length,1);
 assert.equal(JSON.stringify(result).includes('synthetic-private-current-configuration'),false);assert.equal(JSON.stringify(result).includes('probeToken'),false);
 const saved=JSON.parse(await readFile(directory+'/host-intents/'+approved.operationId+'.json','utf8'));assert.equal(saved.intent.planDigest,approved.planDigest);assert.equal(saved.activated,true);
 const calls=effects.length;await executor.execute(approved,{point:{},footprint,authorize});assert.equal(effects.length,calls);assert.equal(loads,2,'same operation never repeats native effects or public opening');
 healthy=false;const refused=await executor.execute(intent(),{point:{},footprint,authorize});assert.equal(refused.state,'failed');assert.equal(refused.publicActivation,false);assert.equal(loads,3,'failed final native readiness leaves the site contained');
 const contained=containedPublicConfiguration(original,'synthetic-probe');const serialized=JSON.stringify(contained.apps.http.servers.s0.routes.slice(1,-1));assert(serialized.includes('127.0.0.1:18080'));assert(serialized.includes('authentication')===false);assert(serialized.includes('X-Security'));
 const noIdentity={apps:{http:{servers:{x:{routes:[]}}}}};
 assert.throws(()=>containedPublicConfiguration(noIdentity),{code:'maintenance_current_identity_route_unknown'});
 let callsToAuthority=0,deny=false;const ids=[];
 const native=new MaintenanceNativeRuntime({configuration:{operations:config,controlDirectory:directory+'/auth',serviceKey:'synthetic-only-service-key-longer-than-thirty-two',authorizationUrl:'http://127.0.0.1:3201/v1/internal/maintenance/authorize'},authorizationWait:async()=>{},authorizationRetryWindowMs:1000,
  fetchImpl:async(_url,options)=>{assert.equal(options.headers['x-forwarded-for'],'127.0.0.1');callsToAuthority++;ids.push(options.headers['x-galaxy-request-id']);if(deny)return{ok:false,status:403};if(callsToAuthority===1)return{ok:false,status:503};const x=JSON.parse(options.body);return{ok:true,status:200,text:async()=>JSON.stringify({authorized:true,operationId:x.operationId,operatorId:x.operatorId,kind:x.kind,endpoint:'https://official.example.invalid'})};}});
 assert.equal((await native.authorize(approved)).authorized,true);assert.equal(callsToAuthority,2);assert.notEqual(ids[0],ids[1]);deny=true;await assert.rejects(native.authorize(approved),{code:'maintenance_current_authorization_denied'});assert.equal(callsToAuthority,3,'definite denied authority never uses an earlier successful result or retries');
});

test('maintenance native preparation keeps TCP isolated, restores database data without old role passwords and excludes current protected configuration from point file activation',async()=>{
 const pg={id:'business',uid:999,gid:999,cipherFile:'/etc/galaxy/business/cipher'},args=isolatedPostgresArguments({images:{postgresBackup:'synthetic-fixed-image'}},pg,{root:'/var/lib/galaxy/restores/op/postgres/business',repository:'/var/lib/galaxy/restores/op/repository',configurationFile:'/var/lib/galaxy/restores/op/config',name:'synthetic-clone',entrypoint:'postgres',args:['-c','listen_addresses='],socketDirectory:'/var/lib/galaxy/restores/op/sockets/business'});
 assert(args.includes('none'));assert(!args.some(x=>/^--publish/.test(x)));assert(args.includes('type=bind,src=/var/lib/galaxy/restores/op/sockets/business,dst=/galaxy-recovery-socket'));assert(args.includes('no-new-privileges:true'));
 const context={intent:{operationId:randomUUID(),moduleIds:['business','analytics','configuration','agentos']},point:{manifest:{maintenance:{moduleDatabaseBindings:{agentos:{state:'available',stanza:'business',database:'galaxy_agentos',schema:'galaxy_agentos'}},coverage:[],sourceBindings:[
  {id:'configuration',path:'/etc/galaxy',kind:'tree',modules:['configuration']},{id:'api-release',path:'/opt/galaxy/releases/point',kind:'tree',modules:['business','configuration']},{id:'analytics-db-mount-0',path:'/var/lib/docker/volumes/galaxy-discovery-op-db-data/_data',kind:'tree',modules:['analytics'],owner:'galaxy-discovery-op-db-1',captureMode:'bounded-quiesced-volume'}]},files:[
  {id:'configuration',path:'/etc/galaxy',resolvedPath:'/etc/galaxy',kind:'tree'},{id:'api-release',path:'/opt/galaxy/releases/point',resolvedPath:'/opt/galaxy/releases/point',kind:'tree'},{id:'analytics-db-mount-0',path:'/var/lib/docker/volumes/galaxy-discovery-op-db-data/_data',kind:'tree'}]}},
  footprint:{sources:[{id:'analytics-db-mount-0',path:'/var/lib/docker/volumes/galaxy-discovery-op-db-data/_data',owner:'galaxy-discovery-op-db-1'}],moduleDatabaseBindings:{agentos:{state:'available',stanza:'business',database:'galaxy_agentos',schema:'galaxy_agentos'}}},artifacts:{files:'/var/lib/galaxy/restores/synthetic/files'}};
 assert.deepEqual(restoredDatabaseNames(context,{postgres:[{id:'business',database:'galaxy_pilot'},{id:'accounts',database:'galaxy_accounts'}]}),['galaxy_pilot','galaxy_agentos']);
 assert.deepEqual(maintenanceFileTransfers(context).map(x=>x.sourceId),['analytics-db-mount-0']);
 const nativeQueries=[],live={id:'business',database:'galaxy_pilot',container:'synthetic-current-cluster',socketPath:'/tmp',administrator:'synthetic-owner'};
 await new MaintenanceHostDatabase({config:{postgres:[live],tools:{docker:'synthetic-docker'}},run:async(_command,args)=>{nativeQueries.push(args.at(-1));return{stdout:''};}}).activate({...context,artifacts:{transfers:[{name:'galaxy_agentos',candidate:'synthetic_next',previous:'synthetic_before',acl:[{role:'current_role',privilege:'CONNECT',grantable:false}]}]}});
 assert(nativeQueries[0].includes('GRANT CONNECT ON DATABASE "galaxy_agentos" TO "current_role"'));assert(!nativeQueries[0].includes('TO PUBLIC'));assert(!nativeQueries[0].includes('PASSWORD'));assert(!nativeQueries[0].includes('CREATE ROLE'));
 context.footprint.moduleDatabaseBindings.agentos.database='another_database';assert.throws(()=>restoredDatabaseNames(context,{postgres:[{id:'business',database:'galaxy_pilot'}]}),{code:'maintenance_agentos_database_binding_changed'});
});

test('maintenance binds current PG model state to the current protected versions and credential references without calling a provider',linux,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-maintenance-model-current-'));t.after(()=>rm(directory,{recursive:true,force:true}));const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE operations_model_settings_state_v1(endpoint text PRIMARY KEY,active_id uuid);CREATE TABLE operations_model_settings_versions_v1(id uuid PRIMARY KEY,endpoint text,configuration jsonb);CREATE TABLE operations_model_settings_operations_v1(endpoint text,phase text);');
 const endpoint='https://official.example.invalid',versionId=randomUUID(),modelId=randomUUID(),reference='model-key:'+randomUUID();let keyValue='synthetic-current-model-credential-never-sent';
 const credentials=[{reference,modelRecordId:modelId,configured:true}],empty={configurationVersion:'unconfigured-v1',modelCount:0,configuredScenarios:[],gateway:{model_list:[],galaxy_profiles:{}},agentos:{version:'unconfigured-v1',scenarios:{overview:null,governance:null,messaging:null,discovery:null,maintenance:null}}};
 let expected=empty;
 const status=()=>({configurationVersion:expected.configurationVersion,appliedVersionId:expected===empty?null:versionId,credentials,
  engines:{gateway:{state:'running',configurationVersion:expected.configurationVersion,modelCount:expected.modelCount},agentos:{state:'running',configurationVersion:expected.configurationVersion,configuredScenarios:expected.configuredScenarios}}});
 const runtime={overview:async()=>status(),matches:(engines,compiled)=>ModelConfigurationRuntime.prototype.matches(engines,compiled),key:async ref=>{assert.equal(ref,reference);return{reference,modelRecordId:modelId,apiKey:keyValue};}};
 const write=async(provider='')=>{for(const[name,value]of[['models.yaml',JSON.stringify(expected.gateway)],['bindings.json',JSON.stringify(expected.agentos)],['active.env','GALAXY_MODEL_GATEWAY_CONFIG_VERSION='+expected.configurationVersion+'\n'],['provider.env',provider]])await writeFile(directory+'/'+name,value,{mode:0o600});};
 const readFacts=async()=>(await db.query(modelAuthorityCaptureSql(endpoint))).rows[0].jsonb_build_object;
 await write();assert.equal((await verifyCurrentModelConfiguration({facts:await readFacts(),root:directory,runtime})).configurationVersion,'unconfigured-v1');
 const configuration={models:[{id:modelId,displayName:'Synthetic only; never called',modelId:'synthetic-model',apiFormat:'openai-chat',baseUrl:'https://provider.example.invalid/v1',credentialRef:reference,contextWindow:1000,maxOutputTokens:100,timeoutSeconds:60,
  reasoning:{mode:'default',effort:null,supportedEfforts:[],supportSource:'manual'},toolCalling:true,structuredOutput:false,enabled:true}],scenarios:{overview:{modelId,dataPolicyApproved:true},governance:null,messaging:null,discovery:null,maintenance:null}};
 await db.query('INSERT INTO operations_model_settings_state_v1 VALUES($1,$2)',[endpoint,versionId]);await db.query('INSERT INTO operations_model_settings_versions_v1 VALUES($1,$2,$3)',[versionId,endpoint,JSON.stringify(configuration)]);
 expected=compileModelConfiguration(configuration,versionId,credentials);const provider=()=>credentialVariable(reference)+'='+keyValue+'\n';await write(provider());
 const facts=await readFacts(),accepted=await verifyCurrentModelConfiguration({facts,root:directory,runtime});assert.equal(accepted.versionId,versionId);assert.equal(accepted.credentialReferences,1);assert(!JSON.stringify(accepted).includes(keyValue));
 keyValue='synthetic-rotated-current-value';await assert.rejects(verifyCurrentModelConfiguration({facts,root:directory,runtime}),{code:'maintenance_current_model_binding_unconfirmed'});await write(provider());assert.equal((await verifyCurrentModelConfiguration({facts,root:directory,runtime})).state,'verified');
 const wrong=structuredClone(facts);wrong.tables.operations_model_settings_versions_v1.rows[0].configuration.models[0].enabled=false;await assert.rejects(verifyCurrentModelConfiguration({facts:wrong,root:directory,runtime}),{code:'maintenance_current_model_binding_unconfirmed'});
 const old=structuredClone(facts);old.tables.operations_model_settings_state_v1.rows[0].active_id=randomUUID();await assert.rejects(verifyCurrentModelConfiguration({facts:old,root:directory,runtime}),{code:'maintenance_current_model_binding_unconfirmed'});
});

test('maintenance Caddy control uses the current disabled-admin service with exact runtime files and refuses source changes instead of opening a new management port',linux,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-maintenance-caddy-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const configuration=directory+'/Caddyfile',runtime=directory+'/run',units=directory+'/units',executable='/opt/galaxy/runtime/caddy-v2.11.4-linux-amd64/caddy';
 const source='{ admin off }\n# Synthetic fixed source; native/systemd effects below are explicit doubles.\n';await writeFile(configuration,source,{mode:0o600});
 const original={admin:{disabled:true},apps:{http:{servers:{s0:{routes:[{match:[{host:['auth.example.invalid']}],handle:[{handler:'reverse_proxy',upstreams:[{dial:'127.0.0.1:18080'}]}]}]}}}}};
 let command=[executable,'run','--config',configuration,'--adapter','caddyfile'];const effects=[];
 const run=async(file,args)=>{effects.push([file,args]);if(args[0]==='show')return{stdout:'MainPID=123\nActiveState=active\nUser=caddy\nGroup=caddy\nExecStart=synthetic\n'};if(args[0]==='adapt')return{stdout:JSON.stringify(original)};
  if(args[0]==='restart'){try{const override=await readFile(units+'/90-galaxy-maintenance.conf','utf8');command=[executable,'run','--config',override.split(' run --config ')[1].trim()];}catch(error){if(error.code!=='ENOENT')throw error;command=[executable,'run','--config',configuration,'--adapter','caddyfile'];}}return{stdout:''};};
 const control=new MaintenanceCaddyControl({config:{tools:{systemctl:'synthetic-systemctl'}},run,paths:{configuration,runtime,units},processMetadata:async()=>({executable,command,uid:999,gid:999})});
 const gate=new MaintenancePublicGate({controlDirectory:directory,control}),intent=randomUUID(),receipt=await gate.contain(intent);
 assert.equal(await readFile(configuration,'utf8'),source);assert.equal((await control.current(JSON.parse(await readFile(receipt.artifactPath,'utf8')))).admin.disabled,true);
 assert.equal(effects.filter(x=>x[1][0]==='restart').length,1);assert.equal(effects.some(x=>x[1].some(v=>String(v).includes('2019'))),false);
 await writeFile(configuration,source+'# Concurrent operator source edit.\n');await assert.rejects(gate.open(receipt),{code:'maintenance_public_routes_changed'});assert.equal(effects.filter(x=>x[1][0]==='restart').length,1);
 await writeFile(configuration,source);assert.deepEqual(await gate.open(receipt),{publicActivation:true});assert.equal(effects.filter(x=>x[1][0]==='restart').length,2);assert.equal(await readFile(configuration,'utf8'),source);
 await assert.rejects(readFile(units+'/90-galaxy-maintenance.conf'),{code:'ENOENT'});assert(!JSON.stringify(receipt).includes(source));
});

test('maintenance restored native item inventory removes ghost and no-longer-public sources through original PG readers while preserving independent usage history',async t=>{
 const f=await accountChatFixture();t.after(f.close);const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites});
 const payload=await bindForumIds('create-post','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:f.people[0].accountId,title:'Current source fixture',body:'Public content only',links:[],topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});
 await forum.publish(f.people[0],{payloadJson:JSON.stringify(payload)});
 const source=createDiscoveryReadOnlySource({db:f.db,endpoint:f.endpoint,now:f.now,readGrant:()=>{throw Error('anonymous source does not issue new grants');},forumPolicy:forum.policy,moderatorIds:[],identityProviders:[{issuer:'https://login.example.org',clientId:'synthetic-chat'}]});
 const current='post_'+payload.postId,ghost='post_'+randomUUID(),meiliKeys=new Set([current,ghost]),gorseKeys=new Set([current,ghost]),removed=[];
 let pendingNativeTask=true;
 const meili={index:'galaxy_public_community',call:async(path,options)=>{if(path.startsWith('/tasks/cancel?')){assert.equal(options.method,'POST');pendingNativeTask=false;return{taskUid:7};}if(path.startsWith('/tasks?'))return{results:pendingNativeTask?[{uid:1}]:[]};return{results:[...meiliKeys].map(id=>({id})),total:meiliKeys.size};},task:async value=>{assert.equal(value.taskUid,7);},upsert:async doc=>{assert.equal(pendingNativeTask,false);meiliKeys.add(doc.id);},remove:async key=>{assert.equal(pendingNativeTask,false);removed.push(['meili',key]);meiliKeys.delete(key);}};
 const gorse={call:async()=>({Items:[...gorseKeys].map(ItemId=>({ItemId})),Cursor:''}),upsert:async doc=>{gorseKeys.add(doc.id);},remove:async key=>{removed.push(['gorse',key]);gorseKeys.delete(key);}};
 const accepted=await reconcileDiscoveryItems({source,meili,gorse});assert.equal(accepted.inspected,2);assert.equal(accepted.removed,1);assert.deepEqual([...meiliKeys],[current]);assert.deepEqual([...gorseKeys],[current]);assert.equal(accepted.independentAccountVisitorUsage,'preserved-at-point');
 await f.db.query('UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE object_id=$1',[payload.versionId,new Date(f.now()*1000).toISOString()]);
 const revoked=await reconcileDiscoveryItems({source,meili,gorse});assert.equal(revoked.removed,1);assert.equal(meiliKeys.size,0);assert.equal(gorseKeys.size,0);
 assert.equal((await f.db.query('SELECT id FROM forum_posts_v1 WHERE id=$1',[payload.postId])).rows.length,1,'index removal is not a new source or account deletion');
 await assert.rejects(reconcileDiscoveryItems({source,meili:{...meili,call:async(path,options)=>path.startsWith('/tasks')?meili.call(path,options):({results:[{id:'unrelated-native-data'}],total:1})},gorse}),{code:'maintenance_discovery_inventory_unconfirmed'});
});

test('maintenance website restore activates the selected registered release pointer and retains the former current link without altering protected configuration',linux,async t=>{
 const root=await mkdtemp(join(tmpdir(),'galaxy-maintenance-website-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(root+'/releases');
 const before=root+'/releases/current-release',target=root+'/releases/selected-point';await mkdir(before);await mkdir(target);await writeFile(before+'/index.html','current-business');await writeFile(target+'/index.html','point-business');await symlink(before,root+'/current');
 const pointers=new MaintenanceWebsitePointer({root}),context={intent:{operationId:randomUUID(),moduleIds:['website']},point:{manifest:{files:[{id:'website-release',path:root+'/current',resolvedPath:target}]}},footprint:{sources:[{id:'website-release',path:root+'/current'}]},artifacts:{fileTransfers:[{path:target}]}};
 const record=await pointers.stage(context);assert.equal(await realpath(root+'/current'),before);assert.equal(await readFile(root+'/current/index.html','utf8'),'current-business');
 await pointers.activate(record);assert.deepEqual(await pointers.verify(record),{ready:true});assert.equal(await realpath(root+'/current'),target);assert.equal(await readFile(root+'/current/index.html','utf8'),'point-business');assert.equal(await readlink(record.previous),before);assert.equal(await readFile(record.previous+'/index.html','utf8'),'current-business');
 const unknown=structuredClone(context);unknown.point.manifest.files[0].resolvedPath='/etc/galaxy';await assert.rejects(pointers.stage(unknown),{code:'maintenance_website_point_binding_invalid'});
});

test('maintenance recovery pauses restored P13 configuration and nonterminal native tickets without replaying completed effects or enabling current grants',async t=>{
 const db=new PGlite();t.after(()=>db.close());const at=new Date('2026-10-23T10:00:00Z');assert.deepEqual(await pauseRestoredStrategyRuns(db,at),{applied:false});
 // Relevant closed columns/states from schema112, not a simulated runtime.
 await db.exec("CREATE TABLE operations_p13_strategy_heads_v1(endpoint text PRIMARY KEY,paused boolean NOT NULL,updated_at timestamptz);CREATE TABLE operations_p13_strategy_runs_v1(id uuid PRIMARY KEY,state text NOT NULL CHECK(state IN ('prepared','dispatching','running','awaiting-human','completed','blocked','unknown','no-action')),code text,updated_at timestamptz);CREATE TABLE operations_business_roles_v1(enabled boolean NOT NULL);INSERT INTO operations_business_roles_v1 VALUES(false);INSERT INTO operations_p13_strategy_heads_v1 VALUES('https://official.example.invalid',false,now());");
 for(const state of['prepared','dispatching','running','awaiting-human','completed','blocked','unknown','no-action'])await db.query('INSERT INTO operations_p13_strategy_runs_v1 VALUES($1,$2,NULL,now())',[randomUUID(),state]);
 const result=await db.transaction(tx=>pauseRestoredStrategyRuns(tx,at));assert.equal(result.blocked,6);assert.equal((await db.query('SELECT paused FROM operations_p13_strategy_heads_v1')).rows[0].paused,true);
 const rows=(await db.query('SELECT state,code FROM operations_p13_strategy_runs_v1')).rows;assert.equal(rows.filter(x=>x.state==='blocked'&&x.code==='restore-current-authorization-required').length,6);assert.equal(rows.filter(x=>['completed','no-action'].includes(x.state)&&x.code===null).length,2);assert.equal((await db.query('SELECT enabled FROM operations_business_roles_v1')).rows[0].enabled,false);
});

test('maintenance refuses chat restore scopes whose readiness or deletion contributions are still unproven before any containment or data effect',async()=>{
 let calls=0;const config={tools:{docker:'synthetic-docker'},postgres:[{id:'business',container:'synthetic',database:'synthetic',administrator:'synthetic',socketPath:'/tmp'}]};
 const adapters=createProductionRestoreAdapters({config,controlDirectory:'/synthetic-unused',run:async()=>({stdout:'1'}),gate:{contain:async()=>{calls++;throw Error('must not contain');}}});
 await assert.rejects(adapters.contain({intent:{moduleIds:['chat']}}),{code:'maintenance_current_chat_native_readiness_not_proven'});
 assert.equal(calls,0,'not even public containment starts when a known native authority/lifecycle contribution is missing');
});
