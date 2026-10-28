import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {createServices} from '../../../../packages/galaxy-official/src/services.mjs';
import {OperationsCommunityService} from '../../../../packages/galaxy-official/src/operations/community/service.mjs';
import {OperationsPermissionsService} from '../../../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {OperationsAiWorkAccountsService} from '../../../../packages/galaxy-official/src/operations/accounts/ai-work-service.mjs';
import {BusinessAdminService} from '../../../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsAgentOsAuthority} from '../../../../packages/galaxy-official/src/operations/agentos/authority.mjs';
let raw='';for await(const part of process.stdin)raw+=part;const input=raw?JSON.parse(raw):{};
const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(url.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(url.pathname))throw Error('isolated database required');
const db=new pg.Pool({connectionString:url.href}),{endpoint,rootId}=input,now=()=>2000000000,actor={kind:'business-operator',operatorId:rootId,role:'administrator',endpoint,httpRequestId:null};
const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>a.operatorId===rootId?'administrator':null});
const businessAdmin=new BusinessAdminService({db,endpoint,permissions,now,operatorAuthorization:permissions.operatorAuthorization});
const aiWorkAccounts=new OperationsAiWorkAccountsService({db,endpoint,businessAdmin,automationEditorAvailable:true,now});permissions.aiWorkAccounts=aiWorkAccounts;
const forum=createServices({db,endpoint,kid:'isolated-execution',signingKey:generateKeyPairSync('ed25519').privateKey,trustedKeys:new Map(),now,operator:'isolated',region:'test'}).forum;
const content=new OperationsCommunityService({businessAdmin,forum,now}).content;
const authority=new OperationsAgentOsAuthority({db,endpoint,permissions,aiWorkAccounts,content,now});
try{
 if(['seed','seed-ai'].includes(process.argv[2])){
  const ai=process.argv[2]==='seed-ai';let role,account;
  if(ai){role=(await permissions.saveRole(actor,{operationId:randomUUID(),expectedVersion:0,name:'Original current executor AI',description:'Synthetic execution-only role',subjectScope:'ai-only',enabled:true,permissions:['content.read','content.hide','content.restore']},{authorize:async()=>actor})).role;await aiWorkAccounts.assignment(actor,'governance',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>actor});account=(await aiWorkAccounts.authorizationWithin(db,'governance')).accountId;}
  const grant=(await permissions.saveAutomation(actor,{operationId:randomUUID(),expectedVersion:0,name:'Original prepared execution',executorKind:ai?'ai':'program',mode:'assisted',enabled:true,permissions:['content.read','content.hide','content.restore'],resourceIds:ai?[]:[input.targetId],...(ai?{resourceScope:{kind:'eligible'},aiAccountId:account}:{})},{authorize:async()=>actor})).automation;
  const create={operationId:randomUUID(),grantId:grant.id,expectedGrantVersion:grant.version,domain:'governance',actions:['content.read','content.hide','content.restore'],resourceIds:[input.targetId],preparedCommand:{tool:'content-visibility',targetKind:'post',targetId:input.targetId,input:{expectedVersion:1,expectedRevision:0,kind:'hide',until:now()+600,reason:'Original prepared moderation'}}};
  const original=await authority.create(actor,create,{authorize:async()=>actor});console.log(JSON.stringify({grant,create,original,...(ai?{role,account}:{})}));
 }else if(process.argv[2]==='options')console.log(JSON.stringify(await authority.options(actor)));
 else if(process.argv[2]==='get')console.log(JSON.stringify(await authority.get(actor,input.id)));
 else if(process.argv[2]==='actor'){
  const a=await authority.actor(input.id);console.log(JSON.stringify({id:a.operatorId,version:a.businessAuthorization.version,permissions:a.businessAuthorization.permissions,scope:a.resourceIds}));
 }else if(process.argv[2]==='create')console.log(JSON.stringify(await authority.create(actor,input.create,{authorize:async()=>actor})));
 else throw Error('unknown mode');
}finally{await db.end()}
