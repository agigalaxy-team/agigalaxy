process.stdin.setEncoding('utf8');
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {migrate,transaction} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {OperationsAutonomy} from '../../packages/galaxy-official/src/operations/autonomy/service.mjs';
import {OperationsAgentOsAuthority} from '../../packages/galaxy-official/src/operations/agentos/authority.mjs';
import {OperationsAiWorkAccountsService} from '../../packages/galaxy-official/src/operations/accounts/ai-work-service.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsPermissionsService} from '../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {p13EmptyConfiguration,p13ConfigurationSchema,p13Parse} from '../../packages/galaxy-official/src/shared/p13-strategies-schema.mjs';
import {workbenchRunFact,workbenchCardFact} from '../../packages/galaxy-official/src/operations/agentos/duty-workbench.mjs';
import {createOperationsAgentOsDutyTools} from '../../packages/galaxy-official/src/operations/agentos/duty-tools.mjs';
import {OperationsAgentOsClient} from '../../packages/galaxy-official/src/operations/agentos/client.mjs';
import {OperationsAutonomyNativeClient} from '../../packages/galaxy-official/src/operations/autonomy/native-client.mjs';
import {createOperationsAutonomyWorker} from '../../packages/galaxy-official/src/operations/autonomy/worker.mjs';
import {randomUUID,createHash} from 'node:crypto';
let text='';for await(const c of process.stdin)text+=c;const x=text?JSON.parse(text):{};
if(process.argv[2]==='facts'){console.log(JSON.stringify({runs:x.runs.map(workbenchRunFact),cards:x.cards.map(workbenchCardFact)}));process.exit(0)}
if(process.argv[2]==='authority-errors'){
 const a=new OperationsAgentOsAuthority({endpoint:'https://autonomy.example.invalid'}),out=[];for(const run of [()=>a.dutyActorWithin(null,{}),()=>a.requireDutyAction({},'feedback.read',{db:null}),()=>a.bindDutyOperation({},{}),()=>a.continuationActorWithin(null,{})])try{await run();out.push(null)}catch(e){out.push({code:e.code,status:e.status})};console.log(JSON.stringify({errors:out}));process.exit(0)
}
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');
const db=new pg.Pool({connectionString:u.href,max:2}),endpoint=x.endpoint??'https://autonomy.example.invalid',now=()=>2000000000;
const mode=process.argv[2];try{
 if(mode==='setup'){
  await migrate(db,{roles:['api']});const aiAccountId=randomUUID(),role=randomUUID(),assignment=randomUUID();
  const issuer='https://management.example.invalid/realms/management',operatorId=createHash('sha256').update(issuer+'\0fixture').digest('hex');await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,'fixture','Isolated fixture',$4,$4)`,[operatorId,endpoint,issuer,new Date(now()*1000)]);
  await db.query(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'overview','Isolated overview','Isolated test',true,1,1,$3,$3)`,[aiAccountId,endpoint,new Date(now()*1000)]);
  await db.query(`INSERT INTO operations_business_roles_v1(id,endpoint,name,description,permissions,enabled,version,created_by,updated_by,created_at,updated_at,subject_scope) VALUES($1,$2,'Isolated role','Isolated test',ARRAY['feedback.read','feedback.update'],true,1,$4,$4,$3,$3,'ai-only')`,[role,endpoint,new Date(now()*1000),operatorId]);
  await db.query(`INSERT INTO operations_ai_work_assignments_v1(id,endpoint,ai_account_id,role_id,enabled,version,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$5,$5)`,[assignment,endpoint,aiAccountId,role,new Date(now()*1000)]);
  console.log(JSON.stringify({endpoint,aiAccountId,role,assignment}));
 }else if(mode==='worker-provision'){await migrate(db,{roles:['worker']});console.log(JSON.stringify({role:'galaxy_evidence_worker'}));
 }else if(mode==='operation-setup'){
  const grantId=randomUUID(),strategyId=randomUUID(),versionId=randomUUID(),targetId=x.targetId??randomUUID(),permission=x.permission??'feedback.update',code=x.mode==='code',principal=(await db.query('SELECT operator_id FROM operations_operator_principals_v1 WHERE endpoint=$1 LIMIT 1',[endpoint])).rows[0].operator_id;
  await db.query(`INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind) VALUES($1,$2,'Isolated automatic grant',$7,'automatic',true,1,$8,$3,$4,$4,$5,$5,$6,'selected')`,[grantId,endpoint,[targetId],principal,new Date(now()*1000),code?null:x.aiAccountId,code?'program':'ai',[permission]]);
  const configuration=structuredClone(p13EmptyConfiguration);configuration.common.automationEnabled=true;configuration.domains.find(d=>d.key==='overview').executionEnabled=true;configuration.strategies=[{id:strategyId,name:'Isolated bounded strategy',domain:'overview',objective:null,enabled:true,mode:code?'code-automatic':'ai-autonomous',template:'business-action',execution:{aiDomain:'overview',trigger:{kind:'manual'},mode:code?'code':'ai',grantIds:[grantId],resourceScope:{kind:'selected',resourceIds:[targetId]},requiredRehearsal:false,actions:[permission]},judgment:'prepared-command',instructions:null,recovery:{versionId:null,conditions:[]}}];const parsed=p13Parse(p13ConfigurationSchema,configuration);
  await db.query(`INSERT INTO operations_p13_strategy_versions_v1(id,endpoint,version,configuration,created_by,created_at) VALUES($1,$2,1,$3,$4,$5)`,[versionId,endpoint,JSON.stringify(parsed),principal,new Date(now()*1000)]);await db.query(`INSERT INTO operations_p13_strategy_heads_v1(endpoint,revision,active_id,paused,updated_at) VALUES($1,1,$2,false,$3)`,[endpoint,versionId,new Date(now()*1000)]);
  await db.query(`UPDATE operations_autonomy_tasks_v1 SET mode=$6,state='running',human_decision=NULL,lease_until=$3,configuration=jsonb_set(jsonb_set(configuration,'{plan}',$4::jsonb),'{versionBindings}',$5::jsonb) WHERE endpoint=$1 AND id=$2`,[endpoint,x.taskId,new Date((now()+600)*1000),JSON.stringify({strategyIds:[strategyId],grantIds:[grantId],actions:[permission],resourceIds:[targetId],eventTypes:[]}),JSON.stringify({grants:[{id:grantId,version:1}],strategyVersionId:versionId}),code?'code':'ai']);await db.query('UPDATE operations_ai_work_assignments_v1 SET enabled=true WHERE endpoint=$1',[endpoint]);console.log(JSON.stringify({grantId,strategyId,versionId,targetId}));
 }else{
  await db.query('SET ROLE galaxy_api');const businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:mode==='human'?async a=>(await db.query('SELECT 1 FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,a.operatorId])).rows.length&&a.operatorId===x.operatorId?'administrator':null:null});const aiWorkAccounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,now});businessAdmin.permissions.aiWorkAccounts=aiWorkAccounts;const authority=new OperationsAgentOsAuthority({db,endpoint,permissions:businessAdmin.permissions,aiWorkAccounts,now});const service=new OperationsAutonomy({db,endpoint,businessAdmin,aiWorkAccounts,authority,now});
  if(mode==='human'){const actor={kind:'business-operator',endpoint,operatorId:x.operatorId,role:'administrator',httpRequestId:null};let result;if(x.method==='settings')result=await service.settings(actor);else if(x.method==='saveSettings')result=await service.saveSettings(actor,x.input,{authorize:async()=>actor});else if(x.method==='getConfig')result=await service.getConfig(actor,x.domain);else if(x.method==='saveConfig')result=await service.saveConfig(actor,x.domain,x.input,{authorize:async()=>actor});else if(x.method==='options')result=await service.options(actor);else if(x.method==='run')result=await service.run(actor,x.domain,x.input,{authorize:async()=>actor});else if(x.method==='getTask')result=await service.getTask(actor,x.input.id);else if(x.method==='tasks')result=await service.tasks(actor,x.input);else if(x.method==='overview')result=await service.overview(actor,x.input);else if(x.method==='control')result=await service.control(actor,x.input.id,x.input.command,{authorize:async()=>actor});else if(x.method==='operation')result=await service.operation(actor,x.input.id);else throw Error('unknown human method');console.log(JSON.stringify(result));}
  else if(mode==='duty-delegated'){
   const actor=await transaction(db,async tx=>service.authorizeTaskWithin(tx,await service.taskWithin(tx,x.taskId)));let result;
   if(x.method==='directory')result=await businessAdmin.permissions.delegatedDirectory(actor);
   else if(x.method==='role')result=await businessAdmin.permissions.delegatedRoleSave(actor,x.input);
   else if(x.method==='prompt')result=await businessAdmin.permissions.delegatedPrompt(actor,x.input);
   else if(x.method==='savePrompt')result=await businessAdmin.permissions.delegatedPromptSave(actor,x.input);
   else throw Error('unknown duty-delegated method');console.log(JSON.stringify(result));
  }else if(mode==='worker-execute'){
   const origin=new URL(x.origin);if(origin.hostname!=='127.0.0.1')throw Error('loopback native required');const client=new OperationsAgentOsClient({url:origin.origin,signingKey:'s'.repeat(32),serviceKey:'v'.repeat(32),now});service.native=new OperationsAutonomyNativeClient(client);const worker=createOperationsAutonomyWorker({autonomy:service,jobs:null});console.log(JSON.stringify(await worker.execute({taskId:x.taskId})));
  }else if(mode==='private'){
   service.dutyTools=createOperationsAgentOsDutyTools({authority,permissions:businessAdmin.permissions,authorizeOperation:(tx,input)=>service.authorizeOperationWithin(tx,input)});let result;if(x.method==='authorize')result=await service.authorize(x.input);else if(x.method==='report')result=await service.report(x.input);else if(x.method==='tool')result=await service.tool(x.input);else if(x.method==='code')result=await service.runCodeTask(x.input);else throw Error('unknown private source method');console.log(JSON.stringify(result));
  }else{
  let out;await transaction(db,async tx=>{
   if(mode==='link')out=await service.linkWorkbenchWithin(tx,x);
   else if(mode==='bind')out=await service.bindWorkbenchTaskWithin(tx,x);
   else if(mode==='update')out=await service.updateWorkbenchWithin(tx,x);
   else if(mode==='continuation')out=await service.continuationWithin(tx,await service.taskWithin(tx,x.taskId));
   else if(mode==='duty'){const row=await service.taskWithin(tx,x.taskId),actor=await service.authorizeTaskWithin(tx,row);out={metadata:authority.dutyMetadata(actor),id:actor.operatorId,role:actor.role,version:actor.businessAuthorization.version,permissions:actor.businessAuthorization.permissions};}
   else if(mode==='operation'){const row=await service.taskWithin(tx,x.taskId),actor=await service.authorizeTaskWithin(tx,row),bound=await authority.bindDutyOperation(actor,x.operation,{db:tx,authorizeOperation:(db,input)=>service.authorizeOperationWithin(db,input)});await authority.requireDutyOperation(bound,['feedback.update'],x.selection,{db:tx,action:'feedback-update'});out=authority.dutyMetadata(bound);}
   else if(mode==='delegation-availability'){const actor=await service.authorizeTaskWithin(tx,await service.taskWithin(tx,x.taskId));out=await businessAdmin.permissions.delegationAvailabilityWithin(tx,{actor});}
   else throw Error('unknown fixture mode');
  });console.log(JSON.stringify(out));}
 }
}finally{await db.end()}
