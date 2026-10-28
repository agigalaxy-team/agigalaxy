process.stdin.setEncoding('utf8');
import {delegatedAiPromptSaveSchema} from '../../packages/galaxy-official/src/operations/permissions/ai-delegation-schema.mjs';
import {aiWorkHistorySchema} from '../../packages/galaxy-official/src/operations/accounts/ai-work-schema.mjs';
import {OperationsAgentOsActionTools} from '../../packages/galaxy-official/src/operations/agentos/action-tools.mjs';
import {OperationsAgentOsQueryTools} from '../../packages/galaxy-official/src/operations/agentos/query-tools.mjs';
import {OperationsAgentOsAuthority} from '../../packages/galaxy-official/src/operations/agentos/authority.mjs';
import {transaction} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {aiWorkCapabilities} from '../../packages/galaxy-official/src/shared/operations-ai-work-capabilities.mjs';
import {OperationsAiWorkAccountsService} from '../../packages/galaxy-official/src/operations/accounts/ai-work-service.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {OperationsPermissionsService} from '../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {operationsPermissionCodes,operationsPermissionCatalog} from '../../packages/galaxy-official/src/operations-permission-catalog.mjs';
import {operationsRoleSaveSchema,operationsAssignmentSaveSchema,operationsPermissionsHistorySchema} from '../../packages/galaxy-official/src/shared/operations-permissions-schema.mjs';
import {safeDelta} from '../../packages/galaxy-official/src/operations/permissions/history-delta.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
const endpoint='https://permissions.example.invalid',issuer='https://management.example.invalid/realms/management',now=()=>2000000000;
const ids=Object.fromEntries(['root','writer','empty'].map(s=>[s,digest(issuer+'\0'+s)]));
const actors=Object.fromEntries(Object.entries(ids).map(([s,operatorId])=>[s,{kind:'business-operator',endpoint,operatorId,role:s==='root'?'administrator':'reader',httpRequestId:null}]));
let stdin='';for await(const c of process.stdin)stdin+=c;const input=stdin?JSON.parse(stdin):{};
if(process.argv[2]==='oracle'){console.log(JSON.stringify({catalog:operationsPermissionCatalog,codes:operationsPermissionCodes,role:(input.roles??[]).map(x=>{const r=operationsRoleSaveSchema.safeParse(x);return r.success?r.data:null}),assignments:(input.assignments??[]).map(x=>{const r=operationsAssignmentSaveSchema.safeParse(x);return r.success?r.data:null}),deltas:(input.deltas??[]).map(safeDelta),promptIssues:(input.promptWrites??[]).map(x=>{const r=delegatedAiPromptSaveSchema.safeParse(x);return r.success?[]:r.error.issues.map(i=>({code:i.code,path:i.path,maximum:i.maximum,minimum:i.minimum}))}),promptWrites:(input.promptWrites??[]).map(x=>{const r=delegatedAiPromptSaveSchema.safeParse(x);return r.success?r.data:null}),aiHistories:(input.aiHistories??[]).map(x=>{const r=aiWorkHistorySchema.safeParse(x);return r.success?r.data:null}),capabilities:(input.capabilities??[]).map(p=>aiWorkCapabilities('overview',p)),histories:(input.histories??[]).map(x=>{const r=operationsPermissionsHistorySchema.safeParse(x);return r.success?r.data:null})}));process.exit(0)}
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');
const db=new pg.Pool({connectionString:u.href,max:2}),service=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>a.operatorId===ids.root?'administrator':Object.values(ids).includes(a.operatorId)?'reader':null,managementMaintainerAuthorization:async a=>a.operatorId===ids.root||a.operatorId===ids.writer});
const businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=service;businessAdmin.operatorAuthorization=service.operatorAuthorization;const aiWork=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,automationEditorAvailable:true,now});service.aiWorkAccounts=aiWork;
try{
 if(process.argv[2]==='setup'){
  await migrate(db,{roles:['api']});
  for(const [name,id]of Object.entries(ids)){
   await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)`,[id,endpoint,issuer,name,'Synthetic '+name,new Date(now()*1000)]);
   const token={root:'R',writer:'W',empty:'E'}[name].repeat(43);await db.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[endpoint,'b'.repeat(64),digest(token),id,issuer,name,'Synthetic '+name,name==='root'?'administrator':'reader','C'.repeat(43),new Date((now()+3600)*1000)]);
  }
  const writerInput={operationId:randomUUID(),expectedVersion:0,name:'Writer',description:'Synthetic delegated human role',enabled:true,permissions:['permissions.read','permissions.roles.write','permissions.assignments.write','feedback.read']};
  const writerRole=(await service.saveRole(actors.root,writerInput,{authorize:async()=>actors.root})).role;
  const assignment=(await service.saveAssignment(actors.root,{operationId:randomUUID(),expectedVersion:0,operatorId:ids.writer,roleId:writerRole.id,enabled:true},{authorize:async()=>actors.root})).assignment;
  const originalInput={operationId:randomUUID(),expectedVersion:0,name:' Original role ',description:' Original JS role ',enabled:true,permissions:['feedback.read']};const original=await service.saveRole(actors.root,originalInput,{authorize:async()=>actors.root});
  console.log(JSON.stringify({endpoint,issuer,ids,writerRole,assignment,originalInput,original}));
  }else if(process.argv[2]==='automation-setup'){
  const accounts={};for(const domain of ['overview','governance','messaging','discovery','maintenance']){const id=randomUUID();accounts[domain]=id;await db.query(`INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,$3,$4,'Synthetic isolated test',true,1,1,$5,$5)`,[id,endpoint,domain,'Synthetic '+domain,new Date(now()*1000)]);}
  const role=(await service.saveRole(actors.root,{operationId:randomUUID(),expectedVersion:0,name:'Synthetic AI business role',description:'No inherited human rights',subjectScope:'ai-only',enabled:true,permissions:['feedback.read','feedback.update']},{authorize:async()=>actors.root})).role;
  await aiWork.assignment(actors.root,'governance',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>actors.root});
  const resource=randomUUID(),originalInput={operationId:randomUUID(),expectedVersion:0,name:'Original program',executorKind:'program',mode:'assisted',enabled:true,permissions:['feedback.read'],resourceIds:[resource]};const original=await service.saveAutomation(actors.root,originalInput,{authorize:async()=>actors.root});
  const delegationInput={operationId:randomUUID(),expectedVersion:0,enabled:true,targetAiAccountIds:[accounts.governance],grantablePermissions:['feedback.read','feedback.update'],allowedManagementActions:['read','create','update','assign','revoke','prompt-read','prompt-update']};const delegation=await service.saveDelegation(actors.root,delegationInput,{authorize:async()=>actors.root});
  console.log(JSON.stringify({accounts,resource,role,originalInput,original,delegationInput,delegation}));
  }else if(process.argv[2]==='delegated-setup'){
  const permissions=['ai.roles.read','ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke','ai.prompts.read','ai.prompts.update'];const role=(await service.saveRole(actors.root,{operationId:randomUUID(),expectedVersion:0,name:'Synthetic overview current role',description:'Explicit AI management actions',subjectScope:'ai-only',enabled:true,permissions},{authorize:async()=>actors.root})).role;await aiWork.assignment(actors.root,'overview',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>actors.root});
  const accounts=(await db.query('SELECT id,domain FROM operations_ai_work_accounts_v1 WHERE endpoint=$1',[endpoint])).rows,governance=accounts.find(a=>a.domain==='governance'),overview=accounts.find(a=>a.domain==='overview');
  const configId=randomUUID(),configuration={prompt:'Original synthetic prompt',model:{retained:'unchanged'},plan:{retained:['same']}};await db.query(`INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,delegation_version,updated_by,created_at,updated_at) VALUES($1,$2,'governance',1,false,$3,1,1,1,$4,$5,$5)`,[configId,endpoint,JSON.stringify(configuration),ids.root,new Date(now()*1000)]);await db.query(`INSERT INTO operations_autonomy_versions_v1(config_id,revision,configuration,prompt_version,plan_version,delegation_version,operator_id,created_at) VALUES($1,1,$2,1,1,1,$3,$4)`,[configId,JSON.stringify(configuration),ids.root,new Date(now()*1000)]);
  const authority=new OperationsAgentOsAuthority({db,endpoint,permissions:service,aiWorkAccounts:aiWork,now}),actor=await authority.human(actors.root,{domain:'overview',purpose:'prepare',action:'ai.roles.create'}),originalInput={kind:'role-create',operationId:randomUUID(),expectedVersion:0,name:'Original delegated role',description:'Original narrow role',enabled:true,permissions:['feedback.read'],targetAiAccountIds:[governance.id]},original=await service.delegatedRoleSave(actor,originalInput,{expectedDelegationVersion:1});console.log(JSON.stringify({overview,governance,role,configId,configuration,originalInput,original}));
   }else if(process.argv[2]==='ai-command'){
  const result=await aiWork.command(actors.root,input.domain,input.command,{authorize:async()=>actors.root});console.log(JSON.stringify(result));
 }else if(process.argv[2]==='ai-read'){
  const result={list:await aiWork.list(actors.root),detail:await aiWork.detail(actors.root,input.domain??'governance'),history:await aiWork.history(actors.root,input.domain??'governance'),runtime:await aiWork.runtimeStatus(actors.root,input.domain??'governance')};if(input.operationId)result.operation=await aiWork.operation(actors.root,input.operationId);console.log(JSON.stringify(result));
 }else if(process.argv[2]?.startsWith('consumer-')){
  const authority=new OperationsAgentOsAuthority({db,endpoint,permissions:service,aiWorkAccounts:aiWork,now}),actions=new OperationsAgentOsActionTools({authority,services:{permissions:service},now}),queries=new OperationsAgentOsQueryTools({authority,services:{permissions:service},now});let result;
  if(process.argv[2]==='consumer-prepare')result=await actions.prepareFor(actors.root,'overview',input.request,{operationId:input.operationId});
  else if(process.argv[2]==='consumer-execute')result=await actions.executePrepared(actors.root,input.proposal,{operationId:input.operationId,authorize:async()=>actors.root});
  else if(process.argv[2]==='consumer-recover')result=await actions.recoverPrepared(actors.root,input.proposal,input.operationId);
  else if(process.argv[2]==='consumer-read')result=await queries.readAiManagement({actor:actors.root,domain:'overview',input:input.arguments??{}});else throw Error('unknown consumer');console.log(JSON.stringify(result));
 }else if(process.argv[2]==='delegated-read'){
  const authority=new OperationsAgentOsAuthority({db,endpoint,permissions:service,aiWorkAccounts:aiWork,now}),actor=await authority.human(actors.root,{domain:'overview',purpose:'query'});const result={actor:{version:actor.businessAuthorization.version,permissions:actor.businessAuthorization.permissions},directory:await service.delegatedDirectory(actor),capabilities:await transaction(db,tx=>service.managementCapabilitiesWithin(tx,{actor}))};if(input.operationId)result.operation=await service.delegatedManagementOperation(actor,input.operationId);if(input.aiAccountId)result.prompt=await service.delegatedPrompt(actor,{aiAccountId:input.aiAccountId});if(input.prepare)result.preparation=await service.delegatedRolePreparation(actor,input.prepare);console.log(JSON.stringify(result));
 }else if(process.argv[2]==='automation-read'){
  const result={automation:await service.automation(actors.root),delegation:await service.delegation(actors.root),authorization:await aiWork.authorizationWithin(db,'governance'),history:await service.history(actors.root,{limit:100})};if(input.operationId)result.operation=await service.operation(actors.root,input.operationId);if(input.delegationOperationId)result.delegationOperation=await service.delegationOperation(actors.root,input.delegationOperationId);console.log(JSON.stringify(result));
 }else if(process.argv[2]==='read'){
  const result={catalog:await service.catalog(actors.root),roles:await service.roles(actors.root),personnel:await service.personnel(actors.root),history:await service.history(actors.root,{limit:100})};if(input.operationId)result.operation=await service.operation(actors.root,input.operationId);console.log(JSON.stringify(result));
 }else throw Error('mode required');
}finally{await db.end()}
