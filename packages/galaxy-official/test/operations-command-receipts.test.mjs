import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from '../src/database.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsSmtpService} from '../src/operations-smtp.mjs';
import {emptySmtpConfiguration} from '../src/shared/operations-smtp-schema.mjs';
import {OperationsMessagingService} from '../src/operations/messaging/service.mjs';
import {OperationsRecommendationService} from '../src/operations/recommendations/service.mjs';
import {OperationsMaintenanceService} from '../src/operations-maintenance.mjs';
import {maintenanceModuleIds} from '../src/operations-maintenance-catalog.mjs';

// Real PGlite migrations/current PG grants/galaxy_api and real domain commands.
// Upstream management eligibility, queue and native maintenance transport are
// explicit local doubles. SMTP is deliberately unconfigured: no mail, backup,
// restore, external identity, provider, model or production request is performed.
test('four original command ledgers recover only same-manager safe metadata with current read grants, without replay or inferred success',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'receipt-admin',role:'administrator',endpoint:f.endpoint};
 const manager={...admin,operatorId:'receipt-manager',role:'reader'},other={...manager,operatorId:'receipt-other'};
 const upstream=new Map([[admin.operatorId,'administrator'],[manager.operatorId,'reader'],[other.operatorId,'reader']]);
 for(const actor of [admin,manager,other])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.invalid',$1,$1,$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>upstream.get(actor.operatorId),now:f.now});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),auth={authorize:async()=>manager},adminAuth={authorize:async()=>admin};
 const readCodes=['smtp.read','notices.read','recommendations.read','maintenance.read'];
 const writeCodes=['smtp.configure','smtp.test.connection','smtp.test.delivery','notices.create','notices.update','notices.publish','notices.withdraw','recommendations.configure','maintenance.backups.create','maintenance.backups.verify','maintenance.restore.plan','maintenance.restore.approve','maintenance.restore.execute'];
 const makeRole=async(name,codes)=>(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name,description:'本地原回执验证',enabled:true,permissions:codes},adminAuth)).role;
 const assign=async(role,operator)=>(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:operator.operatorId,roleId:role.id,enabled:true},adminAuth)).assignment;
 const readRole=await makeRole('原回执读取',readCodes),writeRole=await makeRole('原回执合成写入',writeCodes);
 const readerAssignment=await assign(readRole,manager),writerAssignment=await assign(writeRole,manager);await assign(readRole,other);
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');t.after(async()=>{try{await f.db.exec('RESET ROLE');}catch{}});

 const sentinel='private-body-and-credential-sentinel',cases=[];let smtpCalls=0,nativeCalls=0,queueCalls=0;
 const smtp=new OperationsSmtpService({db:f.db,endpoint:f.endpoint,businessAdmin,now:f.now,credentialResolver:{list:()=>[],resolve:()=>{throw Error('unconfigured credentials must not resolve');}},transport:{verify:async()=>{smtpCalls++;throw Error('must not send');},submit:async()=>{smtpCalls++;throw Error('must not send');}}});
 const savedId=randomUUID(),config=emptySmtpConfiguration();
 await smtp.save(manager,{operationId:savedId,expectedVersion:0,configuration:config},auth);
 cases.push([smtp,savedId,'settings',{version:1}]);
 for(const kind of ['connection','delivery']){
  const operationId=randomUUID(),input={operationId,expectedVersion:1,...(kind==='delivery'?{accountId:f.people[0].accountId,senderKey:'notice'}:{})};
  const tested=await smtp.test(manager,input,{kind,...auth});assert.equal(tested.test.state,'not-configured');
  cases.push([smtp,operationId,'test.'+kind,{version:1,testId:operationId,state:'not-configured',code:'smtp_not_configured'}]);
 }
 await smtp.save(manager,{operationId:randomUUID(),expectedVersion:1,configuration:config},auth);

 const jobs={enqueue:async()=>{queueCalls++;return randomUUID();}};
 const messaging=new OperationsMessagingService({db:f.db,endpoint:f.endpoint,businessAdmin,accounts:f.accounts,jobs,now:f.now,mailProvider:{submit:async()=>{smtpCalls++;throw Error('must not send');}}});
 const messageConfig={channels:['inapp'],content:{purpose:'service-update',title:'原回执合成消息',body:sentinel,href:'/guide/',expiresAt:new Date((f.now()+86400)*1000).toISOString()},audience:{kind:'accounts',accountIds:[f.people[0].accountId]},senderKey:'notice',schedule:{kind:'immediate'}};
 let operationId=randomUUID(),plan=(await messaging.create(manager,{operationId,config:messageConfig},auth)).plan;
 const planMetadata=p=>({planId:p.id,version:p.version,revision:p.revision,state:p.state});
 cases.push([messaging,operationId,'create',planMetadata(plan)]);
 operationId=randomUUID();plan=(await messaging.save(manager,plan.id,{operationId,expectedVersion:plan.version,expectedRevision:plan.revision,config:messageConfig},auth)).plan;
 cases.push([messaging,operationId,'save',planMetadata(plan)]);
 for(const kind of ['activate','pause','resume']){
  operationId=randomUUID();const result=await messaging.action(manager,plan.id,kind,{operationId,expectedVersion:plan.version,expectedRevision:plan.revision},auth);plan=result.plan;
  cases.push([messaging,operationId,kind,{...planMetadata(plan),effects:result.effects}]);
 }
 // Seed the run through the real execution domain under the local DB owner;
 // galaxy_api does not receive worker INSERT rights for this read-only feature.
 await f.db.exec('RESET ROLE');
 const run=(await messaging.execute({planId:plan.id,planVersion:plan.version},{jobId:randomUUID()})).run;
 await f.db.exec('SET ROLE galaxy_api');
 await f.db.query("UPDATE operations_messaging_recipients_v1 SET state='blocked' WHERE run_id=$1",[run.id]);
 operationId=randomUUID();const retried=await messaging.retry(manager,run.id,{operationId,expectedRevision:run.revision},auth);
 cases.push([messaging,operationId,'retry',{planId:plan.id,runId:run.id,version:retried.run.planVersion,revision:retried.run.revision,state:retried.run.state}]);
 for(const kind of ['stop','withdraw']){
  operationId=randomUUID();const result=await messaging.action(manager,plan.id,kind,{operationId,expectedVersion:plan.version,expectedRevision:plan.revision},auth);plan=result.plan;
  cases.push([messaging,operationId,kind,{...planMetadata(plan),effects:result.effects}]);
 }

 const recommendation=new OperationsRecommendationService({db:f.db,endpoint:f.endpoint,permissions,businessAdmin,now:f.now});
 const policy={operationId:randomUUID(),expectedVersion:0,enabled:true,themeKey:'category:life',direction:'increase',controls:{avoidRepetition:false,avoidConcentration:false},reason:sentinel};
 await recommendation.savePolicy(manager,policy,auth);cases.push([recommendation,policy.operationId,'policy',{version:1,themeKey:'category:life'}]);
 await recommendation.savePolicy(manager,{...policy,operationId:randomUUID(),expectedVersion:1,direction:'decrease'},auth);
 const themeInput={operationId:randomUUID(),expectedVersion:0,label:sentinel,enabled:true,mapping:{categories:['life'],tagIds:[],queryTerms:[sentinel]},reason:sentinel};
 const theme=(await recommendation.saveTheme(manager,themeInput,auth)).theme;
 cases.push([recommendation,themeInput.operationId,'theme',{version:1,themeKey:theme.key,themeId:theme.id}]);
 await recommendation.saveTheme(manager,{...themeInput,operationId:randomUUID(),themeId:theme.id,expectedVersion:1,enabled:false},auth);

 const pointId='a'.repeat(64),footprintDigest='b'.repeat(64),nowIso=new Date(f.now()*1000).toISOString();
 const point={id:pointId,createdAt:nowIso,logicalBytes:10,logicalFileCount:1,integrity:{state:'verified',checkedAt:nowIso},coverage:maintenanceModuleIds.map(id=>({id,state:'covered',sourceIds:[],postgresStanzas:['business'],method:'pgbackrest-cluster',reasonCodes:[]})),capture:{state:'available',startedAt:nowIso,finishedAt:nowIso,consistency:'named-pg-points-and-bounded-quiesced-files'}};
 const native={call:async input=>{nativeCalls++;return input.kind==='restore-preview'?{point,moduleIds:input.moduleIds,productionExecutable:true,footprintDigest,adapterVersion:'receipt-test-double',blockers:[]}:{id:input.operationId,kind:input.kind,state:'pending',publicActivation:false,steps:[]};}};
 const maintenance=new OperationsMaintenanceService({businessAdmin,native,now:f.now});
 for(const kind of ['create','verify']){
  operationId=randomUUID();await maintenance.runBackup(manager,{operationId,kind,...(kind==='verify'?{pointId}:{})},auth);
  cases.push([maintenance,operationId,kind,{state:'accepted'}]);
 }
 operationId=randomUUID();const made=await maintenance.createPlan(manager,{operationId,pointId,scope:'whole-site'},auth);
 cases.push([maintenance,operationId,'plan',{planId:made.planId,revision:1,state:'awaiting-approval'}]);
 operationId=randomUUID();const approved=await maintenance.approvePlan(manager,made.planId,{operationId,expectedRevision:1,expectedPlanDigest:made.planDigest,acknowledgement:{point:true,scope:true,possibleLoss:true,openingConditions:true}},auth);
 cases.push([maintenance,operationId,'approve',{planId:made.planId,revision:approved.revision,state:'approved'}]);
 operationId=randomUUID();const executing=await maintenance.executePlan(manager,made.planId,{operationId,expectedRevision:approved.revision},auth);
 cases.push([maintenance,operationId,'execute',{planId:made.planId,revision:executing.revision,state:'preparing'}]);
 const cancellable=await maintenance.createPlan(manager,{operationId:randomUUID(),pointId,scope:'whole-site'},auth);
 operationId=randomUUID();const cancelled=await maintenance.cancelPlan(manager,cancellable.planId,{operationId,expectedRevision:1},auth);
 cases.push([maintenance,operationId,'cancel',{planId:cancellable.planId,revision:cancelled.revision,state:'cancelled'}]);

 // The original committed result remains readable after loss of every write
 // grant. Its version is neither the new settings version nor the current head.
 await permissions.saveAssignment(admin,{operationId:randomUUID(),id:writerAssignment.id,expectedVersion:1,operatorId:manager.operatorId,roleId:writeRole.id,enabled:false},adminAuth);
 const auditCount=Number((await f.db.query('SELECT count(*) AS count FROM business_admin_audit_v1')).rows[0].count),counts={smtpCalls,nativeCalls,queueCalls};
 const all=[];
 for(const [service,id,kind,result]of cases){
  const receipt=await service.commandResult(manager,id);all.push(receipt);
  assert.equal(receipt.state,'recorded',kind);assert.equal(receipt.kind,kind);assert.deepEqual(receipt.result,result,kind);assert.equal(receipt.operationId,id);assert.equal(receipt.metadataOnly,true);assert.equal(receipt.readExpiresAt,receipt.checkedAt+30);
  assert.deepEqual(await service.commandResult(manager,id),receipt,'GET does not replay the original command');
  await assert.rejects(service.commandResult(other,id),{code:'operations_command_receipt_not_found',status:404});
 }
 for(const service of [smtp,messaging,recommendation,maintenance]){
  const absent=await service.commandResult(manager,randomUUID());assert.equal(absent.state,'not-recorded');assert.equal(absent.kind,null);assert.equal(absent.result,null);
  await assert.rejects(service.commandResult(manager,'not-an-id'),{code:'invalid_operations_command_receipt',status:400});
  await assert.rejects(service.commandResult({...manager,endpoint:'https://foreign.invalid'},randomUUID()),{code:'business_admin_denied'});
  await assert.rejects(service.commandResult({kind:'operations-executor',operatorId:manager.operatorId,endpoint:f.endpoint},randomUUID()),{code:'business_admin_denied'});
 }
 assert.deepEqual({smtpCalls,nativeCalls,queueCalls},counts);assert.equal(smtpCalls,0);
 assert.equal(Number((await f.db.query('SELECT count(*) AS count FROM business_admin_audit_v1')).rows[0].count),auditCount,'receipt reads do not write generic audit/input');
 assert(!JSON.stringify(all).includes(sentinel));assert(!JSON.stringify(all).includes('"configuration":'));assert(!JSON.stringify(all).includes('"config":'));

 const testingId=randomUUID();await f.db.query("INSERT INTO operations_smtp_tests_v1(id,endpoint,operator_id,kind,configuration_version,input,state,code,started_at) VALUES($1,$2,$3,'connection',2,$4,'testing',$5,$6)",[testingId,f.endpoint,manager.operatorId,JSON.stringify({secret:sentinel}),sentinel,new Date(f.now()*1000)]);
 let testing=await smtp.commandResult(manager,testingId);assert.equal(testing.result.state,'testing');assert.equal(testing.result.code,null);
 f.advance(901);testing=await smtp.commandResult(manager,testingId);assert.equal(testing.result.state,'unknown');assert.equal(testing.result.code,'smtp_submission_unknown');
 // Separate SMTP tables have no cross-table uniqueness: ambiguity is unknown.
 await f.db.query("INSERT INTO operations_smtp_tests_v1(id,endpoint,operator_id,kind,configuration_version,input,state,started_at) VALUES($1,$2,$3,'connection',2,'{}','testing',$4)",[savedId,f.endpoint,manager.operatorId,new Date(f.now()*1000)]);
 assert.equal((await smtp.commandResult(manager,savedId)).state,'unknown');
 await f.db.exec('RESET ROLE');
 await f.db.query("UPDATE operations_messaging_commands_v1 SET result=$2 WHERE endpoint=$3 AND operation_id=$1",[cases.find(([s,,kind])=>s===messaging&&kind==='create')[1],JSON.stringify({state:sentinel,config:{secret:sentinel}}),f.endpoint]);
 await f.db.exec('SET ROLE galaxy_api');
 assert.equal((await messaging.commandResult(manager,cases.find(([s,,kind])=>s===messaging&&kind==='create')[1])).state,'unknown');
 // A genuinely missing ledger is not proof that an operation did not happen.
 await f.db.exec('RESET ROLE; ALTER TABLE operations_smtp_commands_v1 RENAME TO receipt_test_smtp_commands; SET ROLE galaxy_api');
 try{assert.equal((await smtp.commandResult(manager,randomUUID())).state,'unknown');}
 finally{await f.db.exec('RESET ROLE; ALTER TABLE receipt_test_smtp_commands RENAME TO operations_smtp_commands_v1; SET ROLE galaxy_api');}

 // Recheck current upstream eligibility after reading the immutable row.
 const heldDb={query:async(sql,values)=>{const result=await f.db.query(sql,values);if(sql.includes('UNION ALL'))upstream.delete(manager.operatorId);return result;}};
 const lateRevoke=new OperationsSmtpService({db:heldDb,endpoint:f.endpoint,businessAdmin,now:f.now});
 await assert.rejects(lateRevoke.commandResult(manager,cases.find(([s,,kind])=>s===smtp&&kind==='test.connection')[1]),{code:'business_admin_denied'});upstream.set(manager.operatorId,'reader');
 await permissions.saveAssignment(admin,{operationId:randomUUID(),id:readerAssignment.id,expectedVersion:1,operatorId:manager.operatorId,roleId:readRole.id,enabled:false},adminAuth);
 for(const service of [smtp,messaging,recommendation,maintenance])await assert.rejects(service.commandResult({...manager,businessAuthorization:{version:'fake',permissions:readCodes}},randomUUID()),{code:'operations_permission_denied'});
 assert.equal(smtpCalls,0);assert.equal(nativeCalls,counts.nativeCalls);assert.equal(queueCalls,counts.queueCalls);
});
