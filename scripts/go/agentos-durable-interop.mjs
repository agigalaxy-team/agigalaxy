// The original service is used only against the isolated Go test cluster.
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {randomUUID} from 'node:crypto';
import {OperationsPermissionsService} from '../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {OperationsAiWorkAccountsService} from '../../packages/galaxy-official/src/operations/accounts/ai-work-service.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsAgentOsAuthority} from '../../packages/galaxy-official/src/operations/agentos/authority.mjs';
import {OperationsAgentOsQueryTools} from '../../packages/galaxy-official/src/operations/agentos/query-tools.mjs';
import {AgentOsConversations} from '../../packages/galaxy-official/src/operations/agentos/conversations.mjs';
import {digest} from '../../packages/galaxy-official/src/shared/digest.mjs';
process.stdin.setEncoding('utf8');
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const input=raw?JSON.parse(raw):{},url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(url.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(url.pathname))throw Error('isolated DB required');
const db=new pg.Pool({connectionString:url.href,max:2}),endpoint='https://permissions.example.invalid',issuer='https://management.example.invalid/realms/management',now=()=>2000000000;
const actor={kind:'business-operator',operatorId:digest(issuer+'\0root'),endpoint,role:'administrator',httpRequestId:null};
const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async()=> 'administrator'});
const businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=permissions;businessAdmin.operatorAuthorization=permissions.operatorAuthorization;
const aiWorkAccounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,automationEditorAvailable:true,now});permissions.aiWorkAccounts=aiWorkAccounts;
const authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts,now});
const conversations=new AgentOsConversations({authority,client:{}});
try{
 if(process.argv[2]==='prepare'){
  const role=(await permissions.saveRole(actor,{operationId:randomUUID(),expectedVersion:0,name:'Conversation service role',description:'Isolated current AI permission fixture',subjectScope:'ai-only',enabled:true,permissions:input.management?['workbench.read','ai.roles.read','ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke','ai.prompts.read','ai.prompts.update']:['workbench.read']},{authorize:async()=>actor})).role;
  await aiWorkAccounts.assignment(actor,'overview',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>actor});
  const configuration={prompt:'请依据当前授权处理，禁止借用其他岗位权限。'};
  await db.query(`INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,delegation_version,updated_by,created_at,updated_at) VALUES($1,$2,'overview',1,false,$3,1,1,1,$4,$5,$5)`,[randomUUID(),endpoint,JSON.stringify(configuration),actor.operatorId,new Date(now()*1000)]);
  if(input.management){
   const targetConfiguration={prompt:'原岗位工作要求',model:{retained:'unchanged'}};
   await db.query(`INSERT INTO operations_autonomy_configs_v1(id,endpoint,domain,revision,enabled,configuration,prompt_version,plan_version,delegation_version,updated_by,created_at,updated_at) VALUES($1,$2,'governance',1,false,$3,1,1,1,$4,$5,$5)`,[randomUUID(),endpoint,JSON.stringify(targetConfiguration),actor.operatorId,new Date(now()*1000)]);
  }
  console.log(JSON.stringify(await conversations.session(actor,'overview',{create:true})));
 }else if(process.argv[2]==='current'){
  const value=await conversations.current(input.id,{operator:actor});console.log(JSON.stringify({view:conversations.view(value.row),permissionKey:value.row.permission_key}));
 }else if(process.argv[2]==='management-tool'){
 const tools=new OperationsAgentOsQueryTools({authority,services:{permissions},now});
 console.log(JSON.stringify(await tools.execute({actor,domain:'overview',tool:'read-ai-delegation',arguments:input})));
 }else if(process.argv[2]==='authorize')console.log(JSON.stringify(await conversations.authorizeNative(input)));
 else throw Error('unsupported fixture mode');
}finally{await db.end();}
