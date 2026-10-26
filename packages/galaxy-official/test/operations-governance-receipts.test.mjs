import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {OperationsBusinessDomain} from "../src/operations/public-content/content-visibility.mjs";
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {CommunityForumGovernanceV1} from "../src/community/community-forum-governance-v1.mjs";
import {OperationsCommunityService} from "../src/operations/community/service.mjs";
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {digest} from '../src/shared/digest.mjs';
import {governanceReceiptIntent} from '../src/shared/operations-governance-receipt-intent.mjs';
import {governanceCommandResult} from '../src/operations/governance-command-receipts.mjs';
import {dispatchOperationsBusiness} from '../src/adapters/http/operations-business-http.mjs';
import {dispatchOperationsForumContent} from '../src/adapters/http/operations-forum-content-http.mjs';
import {operationsReadPath,operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// Real migrated PGlite, API SQL role, current PG grants, original business
// commands and original result rows. Native management admission is a role
// double. The resource branch uses actual base visibility+audit transaction,
// not an end-to-end Project/Method source fixture. HTTP requests are adapter
// inputs and BFF policy inputs, not a production server. No model/network.
test('governance owner receipts bind original inputs and safe committed metadata without mutable detail or repeated effects',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'governance-receipt-admin',role:'administrator',endpoint:f.endpoint};
 const manager={...admin,operatorId:'governance-receipt-manager',role:'reader'},other={...manager,operatorId:'governance-receipt-other'};
 const upstream=new Map([[admin.operatorId,'administrator'],[manager.operatorId,'reader'],[other.operatorId,'reader']]);
 for(const actor of [admin,manager,other])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.invalid',$1,$1,$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>upstream.get(actor.operatorId),now:f.now});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now});
 const authorize=async(actor,action)=>businessAdmin.authorizeAction(actor,action);
 const makeRole=async(name,codes)=>(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name,description:'Only original result recovery SQL fixture',enabled:true,permissions:codes},{authorize:async()=>admin})).role;
 const reads=['cases.read','sections.read','content.read','content.tags.read','resources.read'],writes=['cases.resolve','sections.classify','sections.hide','sections.restore','content.curate','content.hide','content.restore','content.batch.hide','content.batch.restore','content.tags.manage','resources.hide','resources.restore'];
 const readRole=await makeRole('原结果读取',reads),writeRole=await makeRole('合成治理操作',writes);
 const assign=async(role,actor)=>(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:actor.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin})).assignment;
 const readAssignment=await assign(readRole,manager),writeAssignment=await assign(writeRole,manager);await assign(readRole,other);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now});
 const sourceBody='LOCAL_PUBLIC_BODY_NOT_IN_RECEIPT',reason='LOCAL_REASON_NOT_IN_RECEIPT',author=f.people[0],reporter=f.people[1],audience={read:{kind:'everyone'},participate:{kind:'accounts'}};
 async function post(){const value=await bindForumIds('create-post','account:'+author.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:author.accountId,title:'Original result fixture',body:sourceBody,links:[],topic:'technology',audience,publishedUntil:f.now()+7200});await forum.publish(author,{payloadJson:JSON.stringify(value)});return value;}
 const first=await post(),second=await post(),section=await bindForumIds('create-section','account:'+author.accountId,{schemaVersion:1,operationId:randomUUID(),sectionId:randomUUID(),expectedVersion:0,accountId:author.accountId,title:'Original section',theme:'A bounded local source',description:sourceBody,audience});
 await forum.sections.save(author,{payloadJson:JSON.stringify(section)});
 const report=await bindForumIds('create-report','account:'+reporter.accountId,{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),accountId:reporter.accountId,target:{kind:'post-version',postId:first.postId,versionId:first.versionId},category:'other',summary:reason});await governance.report(reporter,{payloadJson:JSON.stringify(report)});
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');t.after(async()=>{try{await f.db.exec('RESET ROLE');}catch{}});
 const cases=[];
 const record=async(path,input,invoke)=>{const body={operationId:randomUUID(),...input},ack=await invoke(body),intent=await governanceReceiptIntent(path,body,digest);cases.push({path,body,ack,intent});return ack;};
 await record('/v1/operations/community/reports/'+report.reportId+'/resolve',{expectedVersion:1,resolution:'needs-review',summary:reason},x=>community.resolve(manager,report.reportId,x));
 await record('/v1/operations/community/sections/'+section.sectionId+'/classification',{expectedVersion:1,category:'arts',reason},x=>community.classify(manager,section.sectionId,x));
 await record('/v1/operations/community/sections/'+section.sectionId+'/visibility',{expectedVersion:2,expectedVisibilityVersion:0,kind:'hide',until:f.now()+600,reason},x=>community.sectionVisibility(manager,section.sectionId,x));
 const tag=await record('/v1/operations/community/tags',{name:'Local original tag'},x=>community.content.tag(manager,null,x));
 await record('/v1/operations/community/tags/'+tag.tag.id,{expectedVersion:1,name:'Changed local tag',enabled:false},x=>community.content.tag(manager,tag.tag.id,x));
 await record('/v1/operations/community/content/post/'+first.postId+'/curation',{expectedVersion:1,expectedRevision:0,topic:'arts',pinned:true,reason},x=>community.content.curate(manager,'post',first.postId,x));
 await community.content.curate(manager,'post',first.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,topic:'learning',reason:'Current changed after original'});
 await record('/v1/operations/community/content/post/'+first.postId+'/visibility',{expectedVersion:1,expectedRevision:0,kind:'hide',until:f.now()+600,reason},x=>community.content.visibility(manager,'post',first.postId,x));
 await community.content.visibility(manager,'post',first.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,kind:'restore',reason:'Current restored after original'});
 await record('/v1/operations/community/content/visibility/batch',{kind:'hide',until:f.now()+300,reason,items:[{kind:'post',id:second.postId,expectedVersion:1,expectedRevision:0},{kind:'post',id:first.postId,expectedVersion:1,expectedRevision:2}]},x=>community.content.batch(manager,x));
 const resource=new OperationsBusinessDomain({businessAdmin,now:f.now});resource.maxHideSeconds=3600;
 const resourceId=randomUUID();
 await record('/v1/operations/resources/projects/'+resourceId+'/visibility',{kind:'hide',expectedVersion:1,expectedVisibilityVersion:0,until:f.now()+500,reason},x=>resource.command(manager,'resource-visibility',{kind:'projects',id:resourceId,command:x,operationId:x.operationId},db=>resource.changeVisibilityWithin(db,{kind:'project',id:resourceId,sourceVersion:1,expectedVersion:1,input:x})));
 const scopeFor=intent=>{const path=intent.receiptPath;if(path.includes('/reports/'))return{family:'case',id:report.reportId};if(path.includes('/sections/'))return{family:'section',id:section.sectionId};if(path.includes('/tags/'))return{family:'tag'};if(path.includes('/resources/'))return{family:'resource',kind:'projects',id:resourceId};return path.includes('/content/post/')?{family:'content',kind:'post',id:first.postId}:{family:'batch'};};
 const read=(row,actor=manager,scope=scopeFor(row.intent),customAuthorize=null)=>governanceCommandResult({db:f.db,endpoint:f.endpoint,operator:actor,now:f.now,authorize:customAuthorize??(a=>authorize(a,row.intent.readPermission))},row.body.operationId,scope);
 await permissions.saveAssignment(admin,{operationId:randomUUID(),id:writeAssignment.id,expectedVersion:1,operatorId:manager.operatorId,roleId:writeRole.id,enabled:false},{authorize:async()=>admin});
 const count=Number((await f.db.query('SELECT count(*) AS n FROM business_admin_audit_v1')).rows[0].n),receipts=[];
 for(const row of cases){
  const receipt=await read(row);receipts.push(receipt);
  assert.equal(receipt.state,'recorded',row.intent.action);assert.equal(receipt.kind,row.intent.action);assert.equal(receipt.operationId,row.body.operationId);assert.equal(receipt.result.intentHash,row.intent.intentHash);assert.equal(receipt.metadataOnly,true);assert.equal(receipt.readExpiresAt,receipt.checkedAt+30);
  assert.deepEqual(await read(row),receipt);await assert.rejects(read(row,other),{status:404,code:'operations_command_receipt_not_found'});
  const changed=await governanceReceiptIntent(row.path,{...row.body,...(row.body.reason?{reason:reason+' changed'}:row.body.summary?{summary:reason+' changed'}:{name:'Different original name'})},digest);assert.notEqual(changed.intentHash,receipt.result.intentHash);
 }
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM business_admin_audit_v1')).rows[0].n),count,'GET never adds an action or audit');
 assert(!JSON.stringify(receipts).includes(sourceBody));assert(!JSON.stringify(receipts).includes(reason));assert(!JSON.stringify(receipts).includes('Local original tag'));
 const originalCuration=receipts.find(x=>x.kind==='community-content-curation');assert.equal(originalCuration.result.revision,1);assert(!Object.hasOwn(originalCuration.result,'content'));assert.equal((await community.content.get(manager,'post',first.postId)).content.curation.revision,2);
 assert.equal((await read(cases[0],manager,{family:'case',id:randomUUID()})).state,'unknown');
 assert.equal((await read(cases.find(x=>x.intent.action==='community-content-curation'),manager,{family:'content',kind:'reply',id:first.postId})).state,'unknown');
 const missing={...cases[0],body:{...cases[0].body,operationId:randomUUID()}};assert.equal((await read(missing)).state,'not-recorded');
 await assert.rejects(read(cases[0],{...manager,endpoint:'https://foreign.invalid'}),{status:403});
 await assert.rejects(read(cases[0],{...manager,kind:'operations-executor'}),{status:403});
 // Queryless routes and BFF allow only the closed GET path, not arbitrary
 // action names, query bodies, POST reads, or foreign origins.
 for(const row of cases){
  let result;const headers={};
  const args={operationsCommunity:community,operationsResources:resource,authorizeOperator:async(_req,{action})=>authorize(manager,action),request:{method:'GET'},response:{setHeader:(k,v)=>{headers[k]=v;}},url:new URL(row.intent.receiptPath,f.endpoint),requestId:randomUUID(),send:(status,value)=>{assert.equal(status,200);result=value;}};
  const dispatcher=row.intent.receiptPath.includes('/content/')||row.intent.receiptPath.includes('/tags/')?dispatchOperationsForumContent:dispatchOperationsBusiness;
  assert.equal(await dispatcher(args),true);assert.equal(result.state,'recorded');assert.equal(headers['Cache-Control'],'no-store');
  await assert.rejects(dispatcher({...args,url:new URL(row.intent.receiptPath+'?body=not-allowed',f.endpoint)}),{status:404});
  await assert.rejects(dispatcher({...args,request:{method:'POST'}}),{status:404});
  assert.equal(operationsReadPath(row.intent.receiptPath),true);assert.equal(operationsReadPath(row.intent.receiptPath+'?x=1'),false);
  const policyArgs={url:'https://admin.example.org'+row.intent.receiptPath,method:'GET',headers:new Headers({origin:'https://admin.example.org'}),publicOrigin:'https://admin.example.org'};
  assert.equal(operationsProxyPolicy(policyArgs).allowed,true);assert.equal(operationsProxyPolicy({...policyArgs,url:policyArgs.url+'?x=1'}).allowed,false);assert.equal(operationsProxyPolicy({...policyArgs,method:'POST'}).allowed,false);
 }
 // Permission loss after the original row is read still prevents disclosure.
 let checks=0;
 await assert.rejects(read(cases[0],manager,scopeFor(cases[0].intent),async actor=>{
  if(++checks===2)await permissions.saveAssignment(admin,{operationId:randomUUID(),id:readAssignment.id,expectedVersion:1,operatorId:manager.operatorId,roleId:readRole.id,enabled:false},{authorize:async()=>admin});
  return authorize(actor,'cases.read');
 }),{status:403,code:'operations_permission_denied'});
 assert.equal(checks,2);
 console.log(JSON.stringify({families:6,originalCommands:cases.length,currentSQLPermissions:true,apiSQLRole:true,readAfterWriteRevocation:true,afterReadRevocationDenied:true,sourceAndReasonDisclosed:false,resourceSourceFixture:'base-command-only',networkRequests:0,modelCalls:0}));
});

