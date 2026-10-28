process.stdin.setEncoding('utf8');
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {ManagementDirectory} from '../../packages/galaxy-official/src/operations/accounts/management-directory.mjs';
import {createKeycloakManagementAccounts} from '../../packages/galaxy-official/src/identity/authentication/keycloak-management-accounts.mjs';
import * as schemas from '../../packages/galaxy-official/src/operations/accounts/management-schema.mjs';
import {OperationsManagementAccountsService} from '../../packages/galaxy-official/src/operations/accounts/management-service.mjs';
import {createOperationsManagementSessions} from '../../packages/galaxy-official/src/operations/accounts/management-sessions.mjs';
import {OperationsPermissionsService} from '../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {createManagementEmailChanges} from '../../packages/galaxy-official/src/identity/authentication/management-email-changes.mjs';
let text='';for await(const c of process.stdin)text+=c;const x=text?JSON.parse(text):{};
const mode=process.argv[2];
if(mode==='schema'){
 const names={create:'managementCreateSchema',command:'managementCommandSchema',list:'managementListSchema',history:'managementHistorySchema',assignment:'managementAssignmentSchema'};
 const out={};for(const[k,s]of Object.entries(names))out[k]=(x[k]??[]).map(v=>{const p=schemas[s].safeParse(v);return p.success?p.data:null});
 out.versions=(x.versions??[]).map(v=>schemas.managementTargetVersion(v.user,v.meta));console.log(JSON.stringify(out));
}
const local=new URL(x.origin??'http://127.0.0.1');if(local.hostname!=='127.0.0.1')throw Error('loopback fixture required');
const issuer='https://management.example.invalid/realms/management',endpoint='https://management-api.example.invalid';
const fetchLocal=(address,init)=>{const u=new URL(address);if(!['management.example.invalid','127.0.0.1'].includes(u.hostname))throw Error('unexpected native host');return fetch(new URL(u.pathname+u.search,local),init)};
if(mode==='email'){
 const results=[];for(const c of x.cases){const adapter=createManagementEmailChanges({issuer:'https://management.example.invalid/realms/galaxy-operations',privateOrigin:local.origin,writer:{clientId:'galaxy-management-account-maintenance',clientSecret:'isolated-writer'},now:()=>2000000000,fetch:(u,init)=>fetchLocal(u,{...init,headers:{...init.headers,'x-fixture-case':c,'x-fixture-original':'true'}})});
 const available=await adapter.available();let result;try{result=await adapter.request({issuer:'https://management.example.invalid/realms/galaxy-operations',externalSubject:'human'},'new@example.invalid',{operationId:x.operationId,authorize:async()=>{}})}catch(e){result={error:e.code}};results.push({available,result});}console.log(JSON.stringify({results}));
}
const native=createKeycloakManagementAccounts({issuer,adminOrigin:local.origin,reader:{clientId:'reader',clientSecret:'isolated-reader'},writer:{clientId:'writer',clientSecret:'isolated-writer'},fetch:fetchLocal,now:()=>2000000000});
if(mode==='native'){
 const principal={issuer,externalSubject:'human'};const options={authorize:async()=>{}};
 const out={count:await native.count(),page:await native.page({first:0,max:20}),get:await native.get(principal),sessions:await native.sessions(principal)};
 out.created=await native.create({username:'new-user',firstName:'新',lastName:'人',temporaryPassword:'isolated-password'},options);
 out.profile=await native.profile(principal,{firstName:'更新',note:'must not be sent'},options);
 out.enabled=await native.setEnabled(principal,false,options);out.password=await native.resetPassword(principal,'isolated-password',options);
 out.logout=await native.logout(principal,options);out.admission=await native.admission(principal,'reader',options);out.remove=await native.remove(principal,options);
 console.log(JSON.stringify(out));
}
if(mode!=='native'&&mode!=='schema'&&mode!=='email'){
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');
const db=new pg.Pool({connectionString:u.href,max:2});try{
 if(mode==='setup'||mode==='service-setup'){await migrate(db,{roles:['api']});
  if(mode==='service-setup')for(const sub of ['root','human']){const id=schemas.managementId(issuer,sub);await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$4,$5,$5)`,[id,endpoint,issuer,sub,new Date(2000000000000)]);const token=(sub==='root'?'R':'T').repeat(43);await db.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,[endpoint,'b'.repeat(64),createHash('sha256').update(token).digest('hex'),id,issuer,sub,sub==='root'?'administrator':'reader','C'.repeat(43),new Date(2000003600000)]);}
  console.log(JSON.stringify({issuer,endpoint,rootId:schemas.managementId(issuer,'root'),humanId:schemas.managementId(issuer,'human')}));}
 else if(mode.startsWith('service-')){
  await db.query('SET ROLE galaxy_api');const now=()=>2000000000,rootId=schemas.managementId(issuer,'root'),rootPrincipal={version:1,endpoint,issuer,externalSubject:'root',operatorId:rootId},actor={kind:'business-operator',endpoint,operatorId:rootId,role:'administrator',httpRequestId:null};
  const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>{const p=(await db.query('SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2',[a.operatorId,endpoint])).rows[0];if(!p)return null;const u=await native.get({issuer:p.issuer,externalSubject:p.external_subject});return u?.enabled&&u.admission!=='none'?(a.operatorId===rootId?'administrator':'reader'):null},managementMaintainerAuthorization:async()=>true});
  const businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=permissions;
  const managementSessions=createOperationsManagementSessions({db,endpoint,issuer,now,roleDirectory:{invalidateOperatorRoles:p=>p.issuer===issuer}});
  const service=new OperationsManagementAccountsService({db,endpoint,now,businessAdmin,directory:native,rootPrincipal,managementSessions});
  let out;if(x.method==='list')out=await service.list(actor,x.input??{});else if(x.method==='detail')out=await service.detail(actor,x.id);else if(x.method==='history')out=await service.history(actor,x.id,x.input??{});else if(x.method==='operation')out=await service.operation(actor,x.id);else if(x.method==='assignmentOperation')out=await service.assignmentOperation(actor,x.id,x.operationId);else if(x.method==='create')out=await service.create(actor,x.input,{authorize:async()=>actor});else if(x.method==='command')out=await service.command(actor,x.id,x.input,{authorize:async()=>actor});else throw Error('unknown service method');console.log(JSON.stringify(out));
 }
 else{await db.query('SET ROLE galaxy_api');const index=new ManagementDirectory({db,endpoint,directory:native,now:()=>2000000000});
  if(mode==='sync')console.log(JSON.stringify({result:await index.sync(),source:await index.source()}));
  else if(mode==='source')console.log(JSON.stringify(await index.source()));
  else throw Error('unknown fixture mode');
 }
}finally{await db.end()}

}
