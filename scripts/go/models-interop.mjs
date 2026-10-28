import * as schema from '../../packages/galaxy-official/src/shared/operations-model-settings-schema.mjs';
import * as native from '../../packages/galaxy-official/src/operations/model-settings/native.mjs';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {createHash} from 'node:crypto';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {OperationsModelSettingsService} from '../../packages/galaxy-official/src/operations/model-settings/service.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsPermissionsService} from '../../packages/galaxy-official/src/operations/permissions/service.mjs';
let raw='';for await(const c of process.stdin)raw+=c;const x=JSON.parse(raw||'{}'),mode=process.argv[2];
if(mode==='schema'){
 const out={};for(const[k,name]of Object.entries({configuration:'modelSettingsConfigurationSchema',draft:'modelSettingsDraftSchema',apply:'modelSettingsApplySchema',credential:'modelSettingsCredentialSchema',history:'modelSettingsHistorySchema',usage:'modelSettingsUsageSchema',command:'modelSettingsNativeCommandSchema',authorization:'modelSettingsNativeAuthorizationSchema'}))out[k]=(x[k]??[]).map(v=>{const p=schema[name].safeParse(v);return p.success?p.data:null});
 for(const[k,name]of Object.entries({status:'modelSettingsNativeStatus',operation:'modelSettingsNativeOperation',nativeUsage:'modelSettingsNativeUsage',nativeCredential:'modelSettingsNativeCredential'}))out[k]=(x[k]??[]).map(v=>{try{return native[name](v)}catch{return null}});
 out.applicable=(x.applicable??[]).map(v=>{try{return schema.assertModelSettingsApplicable(v)}catch(e){return{error:e.code}}});console.log(JSON.stringify(out));process.exit(0);
}
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');
const db=new pg.Pool({connectionString:u.href,max:3}),endpoint='https://models.example.invalid',issuer='https://management.example.invalid/realms/management',now=()=>2000000000,id=createHash('sha256').update(issuer+'\0root').digest('hex');
try{if(mode==='setup'){
 await migrate(db,{roles:['api']});await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,'root','Isolated operator',$4,$4)`,[id,endpoint,issuer,new Date(now()*1000)]);
 await db.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,'root','Isolated operator','administrator',$6,$7)`,[endpoint,'b'.repeat(64),createHash('sha256').update('R'.repeat(43)).digest('hex'),id,issuer,'C'.repeat(43),new Date((now()+3600)*1000)]);console.log(JSON.stringify({endpoint,issuer,operatorId:id}));
 }else{await db.query('SET ROLE galaxy_api');const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>a.operatorId===id?'administrator':null}),businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=permissions;const service=new OperationsModelSettingsService({businessAdmin,now,native:x.native?{call:async v=>v.kind==='models-overview'?x.native:v.kind==='models-usage'?x.usage:x.operation}:null}),actor={kind:'business-operator',endpoint,operatorId:id,role:'administrator',httpRequestId:null};let out;
 if(mode==='draft')out=await service.saveDraft(actor,x.input,{authorize:async()=>actor});else if(mode==='overview')out=await service.overview(actor);else if(mode==='history')out=await service.history(actor,x.input??{});else if(mode==='operation')out=await service.operation(actor,x.id);else if(mode==='usage')out=await service.usage(actor,x.input??{});else throw Error('unknown mode');console.log(JSON.stringify(out));}
}finally{await db.end()}
