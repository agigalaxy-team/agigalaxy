process.stdin.setEncoding('utf8');
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {createHash} from 'node:crypto';
import {migrate,transaction} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {createKeycloakWebsiteDirectory} from '../../packages/galaxy-official/src/identity/authentication/keycloak-website-directory.mjs';
import {RegisteredDirectory} from '../../packages/galaxy-official/src/operations/accounts/registered-directory.mjs';
import {OperationsRegisteredUsersService} from '../../packages/galaxy-official/src/operations/accounts/registered-service.mjs';
import * as schema from '../../packages/galaxy-official/src/operations/accounts/registered-schema.mjs';
import {registeredTargetVersion} from '../../packages/galaxy-official/src/operations/accounts/registered-read-model.mjs';
import {OperationsPermissionsService} from '../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OfficialAccountSessionStore} from '../../packages/galaxy-official/src/accounts/session-store.mjs';
import {upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../../packages/galaxy-official/src/accounts/uid.mjs';
let text='';for await(const c of process.stdin)text+=c;const x=text?JSON.parse(text):{},mode=process.argv[2];
if(mode==='schema'){const out={};for(const[k,name]of Object.entries({list:'registeredUsersQuerySchema',command:'registeredUserCommandSchema',history:'registeredUsersHistorySchema'}))out[k]=(x[k]??[]).map(v=>{const p=schema[name].safeParse(v);return p.success?p.data:null});out.versions=(x.versions??[]).map(v=>registeredTargetVersion(v.row,v.identity));console.log(JSON.stringify(out));process.exit(0)}
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');
const db=new pg.Pool({connectionString:u.href,max:3}),endpoint='https://registered.example.invalid',issuer='https://website.example.invalid/realms/website',management='https://management.example.invalid/realms/management',now=()=>2000000000,id=createHash('sha256').update(management+'\0root').digest('hex');
try{
 if(mode==='setup'){
  await migrate(db,{roles:['api','worker']});await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,'root','Isolated current operator',$4,$4)`,[id,endpoint,management,new Date(now()*1000)]);
  await db.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,'root','Isolated current operator','administrator',$6,$7)`,[endpoint,'b'.repeat(64),createHash('sha256').update('R'.repeat(43)).digest('hex'),id,management,'C'.repeat(43),new Date((now()+3600)*1000)]);
  const accounts={};for(const subject of ['formed','legacy'])accounts[subject]=await transaction(db,async tx=>{const a=await upsertOfficialAccountWithin(tx,{endpoint,issuer,externalSubject:subject,verificationMethod:'external-account',verifiedAt:now()});await ensureOfficialAccountProfileWithin(tx,a.id,{subjectType:'person',now:now()});return a});
  await db.query(`INSERT INTO official_account_sessions_v1(scope_hash,token_hash,login_hash,account_id,issuer,external_subject,email,email_verified,csrf_token,created_at,expires_at) VALUES($1,$2,$2,$3,$4,'formed','formed@example.invalid',true,$5,2000000000,$6)`,['a'.repeat(64),'d'.repeat(64),accounts.formed.id,issuer,'E'.repeat(43),now()+3600]);
  console.log(JSON.stringify({endpoint,issuer,management,operatorId:id,accounts}));
 }else{
  const local=new URL(x.origin);if(local.hostname!=='127.0.0.1')throw Error('loopback native required');
  const directory=createKeycloakWebsiteDirectory({issuer,adminOrigin:local.origin,reader:{clientId:'reader',clientSecret:'isolated-reader'},writer:{clientId:'writer',clientSecret:'isolated-writer'},now,fetch:(address,init)=>{const u=new URL(address);if(!['website.example.invalid','127.0.0.1'].includes(u.hostname))throw Error('unexpected native host');return fetch(new URL(u.pathname+u.search,local),init)}});
  await db.query(mode==='sync'?'SET ROLE galaxy_evidence_worker':'SET ROLE galaxy_api');
  const index=new RegisteredDirectory({db,endpoint,directory,now});if(mode==='sync'){console.log(JSON.stringify({result:await index.sync(),source:await index.source()}));}
  else if(mode==='source')console.log(JSON.stringify(await index.source()));
  else{const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>(await db.query('SELECT 1 FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,a.operatorId])).rows.length&&a.operatorId===id?'administrator':null});const businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=permissions;const sessions=new OfficialAccountSessionStore({db,scope:'a'.repeat(64),now});const accountPortal={sessionSummary:p=>sessions.sessionSummary(p),revokeSessions:p=>sessions.revokePrincipal(p)};const service=new OperationsRegisteredUsersService({businessAdmin,directory,accountPortal,now}),actor={kind:'business-operator',endpoint,operatorId:id,role:'administrator',httpRequestId:null};let out;
   if(mode==='list')out=await service.list(actor,x.input??{});else if(mode==='detail')out=await service.detail(actor,x.id);else if(mode==='history')out=await service.history(actor,x.id,x.input??{});else if(mode==='operation')out=await service.operation(actor,x.id);else if(mode==='command')out=await service.command(actor,x.id,x.input,{authorize:async()=>actor});else throw Error('unknown fixture mode');console.log(JSON.stringify(out));
  }
 }
}finally{await db.end()}
