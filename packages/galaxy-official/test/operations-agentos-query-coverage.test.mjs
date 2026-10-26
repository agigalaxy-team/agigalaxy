import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationsAgentOsQueryTools} from "../src/operations/agentos/query-tools.mjs";
import {OperationsAgentOsAuthority} from "../src/operations/agentos/authority.mjs";
import {OperationsPermissionsAuthority} from '../src/operations/permissions/authority.mjs';
import {RegisteredUsersReadModel} from '../src/operations/accounts/registered-read-model.mjs';
import {OperationsSystemSettingsService} from '../src/operations/system-settings/service.mjs';
import {SystemGeneralPublications} from '../src/operations/system-settings/general-publications.mjs';
import {aiWorkQueryPermissions,aiWorkCapabilities} from '../src/shared/operations-ai-work-capabilities.mjs';
import {conversationReadRoute,conversationPriorReadReceipt} from "../src/operations/agentos/tool-evidence.mjs";

// Actual services, permission/AI-context intersection and projection. SQL rows,
// Native directory/control and public marker transport are explicit doubles.
// This leaf makes no claim that those doubles are a real PG/Native deployment.
test('new registration and system queries preserve exact populations, strict safe fields, and fresh human/AI intersection',async()=>{
 const endpoint='https://synthetic.invalid',owner='a'.repeat(64),now=()=>1792867200;
 const ids={ai:'11111111-1111-4111-8111-111111111111',generation:'22222222-2222-4222-8222-222222222222',first:'33333333-3333-4333-8333-333333333333',second:'44444444-4444-4444-8444-444444444444',account:'55555555-5555-4555-8555-555555555555',mail:'66666666-6666-4666-8666-666666666666',service:'77777777-7777-4777-8777-777777777777',mailVersion:'88888888-8888-4888-8888-888888888888',serviceVersion:'99999999-9999-4999-8999-999999999999',publication:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherPublication:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',credential:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
 const required=['accounts.registered.read','system.settings.read'];
 let humanPermissions=['workbench.read','ai.use.overview',...required],humanRole='reader',aiPermissions=[...required],aiVersion=1,ready=true,markerChanges=false,markerCalls=0,denyDuringNative=false;
 const rows=[
  {registration_id:ids.first,issuer:'https://identity.invalid/website',external_subject:'PRIVATE_IDENTITY_CANARY',present:true,email:'PRIVATE_EMAIL_CANARY',email_verified:true,enabled:true,registered_at:'2026-10-01T10:00:00Z',identity_display_name:'已有注册资料',observed_at:'2026-10-25T02:30:00Z',account_id:ids.account,uid:'GUFA12345678',display_name:'业务显示名',subject_type:'person',business_created_at:'2026-10-02T10:00:00Z',verified_at:null,profile_revision:2,profile_account_id:ids.account,restricted_until:null,restriction_reason:'PRIVATE_REASON_CANARY',restriction_revision:0},
  {registration_id:ids.second,issuer:'https://identity.invalid/website',external_subject:'PRIVATE_SECOND_SUBJECT_CANARY',present:true,email:'PRIVATE_SECOND_EMAIL_CANARY',email_verified:false,enabled:true,registered_at:'2026-10-03T10:00:00Z',identity_display_name:'只有注册身份',observed_at:'2026-10-25T02:30:00Z',account_id:null,uid:null,display_name:null,subject_type:null,profile_account_id:null,restricted_until:null}
 ];
 const mailConfiguration={connections:[{id:ids.mail,name:'三用途邮件连接',host:'smtp.synthetic.invalid',port:465,tls:'implicit',credentialRef:'system-key:'+ids.credential,connectionTimeoutMs:1200,greetingTimeoutMs:2400,socketTimeoutMs:3600,maxConnections:2,rateLimit:20,rateWindowSeconds:60,dkimSelector:'mail',password:'PRIVATE_PASSWORD_CANARY',credentialPath:'/protected/PRIVATE_PATH_CANARY'}],bindings:{operations:ids.mail,'account-authentication':ids.mail,'runtime-alerts':null},env:'PRIVATE_ENV_CANARY'};
 const serviceConfiguration={connections:[{id:ids.service,kind:'search',url:'https://search.synthetic.invalid',index:'public-content',credentialRef:'system-key:'+ids.credential,apiKey:'PRIVATE_SERVICE_KEY_CANARY'}]};
 const consumer=(target,id,version)=>({target,state:'configured',adoptedVersionId:version,connectionId:id,source:'consumer-ack',configured:true});
 const generalConfiguration={siteTitle:'网站已发布名称',description:'当前正式网站说明',footerLinks:[{label:'帮助',href:'/help/'}]};
 const counters={registeredList:0,directoryGet:0,native:0,marker:0};
 const connection={query:async(sql,args=[])=>{
  assert(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql),'No effect SQL in read tools');
  if(sql.startsWith('SET TRANSACTION')||sql.includes('pg_advisory_xact_lock_shared'))return{rows:[]};
  if(sql.includes('SELECT 1 FROM operations_operator_principals_v1'))return{rows:[{exists:1}]};
  if(sql.includes('SELECT version FROM operations_permission_authority_v1'))return{rows:[{version:1}]};
  if(sql.includes('SELECT DISTINCT unnest(r.permissions)'))return{rows:humanPermissions.map(permission=>({permission}))};
  if(sql.includes('SELECT a.id,a.version,a.enabled,r.id AS role_id'))return{rows:[{id:ids.first,version:1,enabled:true,role_id:ids.second,role_version:1,role_enabled:true}]};
  if(sql.includes('SELECT d.*,g.observed_count'))return{rows:ready?[{issuer:'https://identity.invalid/website',generation_id:ids.generation,observed_count:2,last_completed_at:'2026-10-25T02:30:00Z',last_started_at:'2026-10-25T02:29:00Z',last_error:null}]:[]};
  if(sql.startsWith('SELECT count(*)::text'))return{rows:[{n:sql.includes('a.id IS NULL')?'1':'2'}]};
  if(sql.includes('FROM operations_registered_subjects_v1 s')&&sql.includes('LEFT JOIN operations_registered_directory_v1'))return{rows:rows.filter(row=>row.registration_id===args[1])};
  if(sql.includes('FROM operations_registered_subjects_v1 s JOIN operations_registered_entries_v1'))return{rows:sql.includes('a.id IS NULL')?[rows[1]]:rows};
  if(sql.includes('FROM operations_registered_commands_v1'))return{rows:[{sequence:'1',operation_id:ids.first,operator_id:owner,kind:'profile-correct',state:'completed',input:{reason:'PRIVATE_HISTORY_REASON_CANARY',basis:'PRIVATE_HISTORY_BASIS_CANARY'},result:{effects:{profile:{state:'confirmed',code:null}}},created_at:'2026-10-25T02:30:00Z',updated_at:'2026-10-25T02:30:00Z'}]};
  if(sql.includes('FROM operations_system_settings_heads_v1'))return{rows:[{revision:2,version_id:args[1]==='mail'?ids.mailVersion:ids.serviceVersion,pending_operation:null}]};
  if(sql.includes('FROM operations_system_settings_versions_v1'))return{rows:[{id:args[1],revision:2,configuration:args[2]==='mail'?mailConfiguration:serviceConfiguration,created_at:'2026-10-25T02:30:00Z'}]};
  if(sql==='SELECT snapshot FROM site_publications_v1 WHERE id=$1 AND endpoint=$2'){assert.equal(args[1],endpoint);return{rows:[{snapshot:{settings:generalConfiguration,pages:[{private:'PRIVATE_PAGE_CANARY'}],media:[{private:'PRIVATE_MEDIA_CANARY'}]}}]};}
  throw Error('Unexpected read SQL fixture');
 }};
 const db={query:(...args)=>connection.query(...args),transaction:operation=>operation(connection)};
 const permissions=new OperationsPermissionsAuthority({db,endpoint,operatorAuthorization:async()=>humanRole,now});
 const aiState=domain=>({accountId:ids.ai,domain,enabled:true,authorizationVersion:aiVersion,permissions:[...aiPermissions],roleVersions:[{assignmentId:ids.first,assignmentVersion:aiVersion,roleId:ids.second,roleVersion:aiVersion}]});
 const aiWorkAccounts={assertEnabledWithin:async(_db,domain)=>aiState(domain),authorizationWithin:async(_db,domain,{accountId})=>{assert.equal(accountId,ids.ai);return aiState(domain);}};
 const authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts,now});
 const businessAdmin={db,endpoint,now,require:actor=>actor,authorizeAction:(actor,action,options={})=>permissions.requireAction(actor,action,options)};
 const directory={issuer:'https://identity.invalid/website',get:async principal=>{counters.directoryGet++;const row=rows.find(row=>row.external_subject===principal.externalSubject);return row?{issuer:directory.issuer,externalSubject:row.external_subject,email:row.email,emailVerified:row.email_verified,enabled:row.enabled,registeredAt:row.registered_at,displayName:row.identity_display_name,serviceAccount:false}:null;},management:async()=>({state:'not-configured'})};
 const registeredUsers=new RegisteredUsersReadModel({businessAdmin,directory,now});const realList=registeredUsers.list.bind(registeredUsers);registeredUsers.list=(...args)=>{counters.registeredList++;return realList(...args);};
 const native={call:async command=>{assert.equal(command.kind,'settings-overview');counters.native++;if(denyDuringNative){aiPermissions=[];aiVersion++;}const mail=command.section==='mail';return{availability:{state:'available'},current:[consumer(mail?'operations':'api',mail?ids.mail:ids.service,mail?ids.mailVersion:ids.serviceVersion)],credentials:[{reference:'system-key:'+ids.credential,connectionId:mail?ids.mail:ids.service,configured:true}],observedConfiguration:null,capabilities:{canTest:true,canApply:true,canWriteCredential:true}};}};
 const systemSettings=new OperationsSystemSettingsService({businessAdmin,native,now});
 const systemGeneral=new SystemGeneralPublications({businessAdmin,contentPublications:{},websiteOrigin:'https://public.synthetic.invalid',now,fetchImpl:async url=>{assert.equal(url,'https://public.synthetic.invalid/cms-publication.json');counters.marker++;markerCalls++;return new Response(JSON.stringify({version:1,publicationId:markerChanges&&markerCalls%2===0?ids.otherPublication:ids.publication}),{status:200});}});
 const tools=new OperationsAgentOsQueryTools({authority,services:{registeredUsers,systemSettings,systemGeneral},now});
 const actor={kind:'business-operator',operatorId:owner,role:'administrator',endpoint};
 const query=(module,view,filters={})=>tools.execute({actor,domain:'overview',tool:'query-operations',arguments:{module,view,filters}});
 const denied=async fn=>assert.rejects(fn,error=>error.status===403&&error.code==='operations_permission_denied');
 for(const code of required)assert(aiWorkQueryPermissions.includes(code));
 assert.deepEqual(aiWorkCapabilities('overview',[]).queryPermissions,[],'No new code creates a default role');
 const list=await query('registered-users','list');assert.equal(list.data.source.registeredCount,2);assert.equal(list.data.pagination.matchingTotal,2);assert.equal(list.data.items.length,2);assert.equal(list.data.items[1].business,null);assert.equal(list.data.items[1].identity.displayName,'只有注册身份');assert.equal(list.data.items[0].business.businessCreatedAt,'2026-10-02T10:00:00.000Z');assert.equal(list.data.items[0].identity.registeredAt,'2026-10-01T10:00:00.000Z');assert.equal(list.data.basis.businessCreatedAtIsRegistration,false);
 assert(list.evidenceRefs.some(row=>row.kind==='registered-user'&&row.id===ids.second&&new URL(row.href,'https://admin.invalid').searchParams.get('registration')===ids.second));
 const unformed=await query('registered-users','list',{business:'not-formed'});assert.equal(unformed.data.pagination.total,2);assert.equal(unformed.data.pagination.matchingTotal,1);assert.equal(unformed.data.items.length,1);
 const detail=await tools.execute({actor,domain:'overview',tool:'read-operation-object',arguments:{kind:'registered-user',id:ids.first}});assert.equal(detail.data.business.uid,'GUFA12345678');
 await denied(()=>query('registered-users','list',{query:'private@synthetic.invalid'}));
 ready=false;const unknown=await query('registered-users','list');assert.equal(unknown.availability,'unavailable');assert.equal(unknown.data.source.registeredCount,null);assert.equal(unknown.data.pagination.total,null);assert.equal(unknown.pagination.complete,false);assert.deepEqual(unknown.evidenceRefs,[]);ready=true;
 const overview=await query('system-settings','overview');assert.equal(overview.data.sections.general.configuration.siteTitle,'网站已发布名称');assert.equal(overview.data.sections.general.savedDraft.state,'not-read');assert.equal(overview.data.sections.mail.configuration.connections[0].credentialsConfigured,true);assert.equal(overview.data.sections['service-connections'].configuration.connections[0].origin,'https://search.synthetic.invalid');assert.equal(overview.data.sections.advanced.connections[0].connectionTimeoutMs,1200);assert.equal(overview.data.sections.advanced.revision,overview.data.sections.mail.revision);assert.equal(counters.native,2,'One overview reads each native section once; advanced uses the same mail source');
 assert.equal((await query('system-settings','mail')).data.section,'mail');assert.equal((await query('system-settings','service-connections')).data.section,'service-connections');assert.equal((await query('system-settings','advanced')).data.limitsScope,'per-worker-process');
 for(const value of [list,unformed,detail,unknown,overview])assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|credentialRef|system-key:|"issuer"|"subject"|"email"|"security"|"history"/,'Only explicit non-secret query output and source refs');
 markerChanges=true;markerCalls=0;const changed=await query('system-settings','general');assert.equal(changed.availability,'unavailable');assert.equal(changed.data.configuration,null);assert.deepEqual(changed.evidenceRefs,[]);markerChanges=false;
 const before=counters.registeredList;aiPermissions=[];aiVersion++;await denied(()=>query('registered-users','list'));assert.equal(counters.registeredList,before,'No role means no directory service dispatch');
 humanRole='administrator';await denied(()=>query('system-settings','mail'));assert.equal(counters.registeredList,before,'Root human authority never fills an empty AI role');humanRole='reader';
 aiPermissions=[...required];aiVersion++;humanPermissions=['workbench.read','ai.use.overview'];await denied(()=>query('registered-users','list'));humanPermissions=['workbench.read','ai.use.overview',...required];
 denyDuringNative=true;await denied(()=>query('system-settings','mail'));assert.equal(aiPermissions.length,0,'A late role withdrawal is re-read by the actual service before returning source data');denyDuringNative=false;
 await assert.rejects(()=>query('system-settings','mail',{credentialRef:'system-key:'+ids.credential}),error=>error.code==='invalid_operations_agentos_query');
 assert.deepEqual(required.filter(code=>code.endsWith('.read')),required);assert(!aiWorkQueryPermissions.includes('system.settings.apply'));
 const route=conversationReadRoute('read-operation-object',{kind:'registered-user',id:ids.first});assert.deepEqual(route,{module:'registered-users',view:'registered-user'});const prior=conversationPriorReadReceipt({tool:'read-operation-object',state:'completed',metadata:{...route,state:'available',raw:'PRIVATE_PRIOR_CANARY'},updated_at:new Date(now()*1000)});assert.equal(prior.module,'registered-users');assert.equal(prior.view,'registered-user');assert.doesNotMatch(JSON.stringify(prior),/PRIVATE_|33333333/);
});
