import * as schema from '../../packages/galaxy-official/src/shared/operations-maintenance-schema.mjs';
import * as view from '../../packages/galaxy-official/src/operations/maintenance/view.mjs';
import {createHash} from 'node:crypto';
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {OperationsMaintenanceService} from '../../packages/galaxy-official/src/operations/maintenance/service.mjs';
import {BusinessAdminService} from '../../packages/galaxy-official/src/operations/audit/service.mjs';
import {OperationsPermissionsService} from '../../packages/galaxy-official/src/operations/permissions/service.mjs';
let raw='';for await(const c of process.stdin)raw+=c;const x=JSON.parse(raw||'{}');
if(!process.argv[2]){
 const names={logs:'maintenanceLogsQuerySchema',backups:'maintenanceBackupsQuerySchema',plans:'maintenancePlansQuerySchema',page:'maintenancePageSchema',backup:'maintenanceBackupCommandSchema',create:'maintenanceCreatePlanSchema',approve:'maintenanceApprovePlanSchema',execute:'maintenanceExecutePlanSchema',cancel:'maintenanceCancelPlanSchema',native:'maintenanceNativeCommandSchema'};
 const out={};for(const[k,name]of Object.entries(names))out[k]=(x[k]??[]).map(v=>{const p=schema[name].safeParse(v);return p.success?p.data:null});
 for(const[k,name]of Object.entries({overview:'maintenanceOverview',coverage:'maintenanceCoverage',point:'maintenancePoint',policy:'maintenancePolicy',log:'maintenanceLog',plan:'maintenancePlanProjection'}))out[k]=(x[k]??[]).map(v=>view[name](v));
 out.digests=(x.digests??[]).map(v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'));console.log(JSON.stringify(out));process.exit(0);
}
const u=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated DB required');
const db=new pg.Pool({connectionString:u.href,max:3}),endpoint='https://maintenance.example.invalid',issuer='https://management.example.invalid/realms/management',now=()=>2000000000,id=createHash('sha256').update(issuer+'\0root').digest('hex'),mode=process.argv[2];
try{if(mode==='setup'){
 await migrate(db,{roles:['api']});await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,'root','Isolated operator',$4,$4)`,[id,endpoint,issuer,new Date(now()*1000)]);
 await db.query(`INSERT INTO operations_operator_sessions_v1(endpoint,configuration_id,token_hash,operator_id,issuer,external_subject,display_name,role,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5,'root','Isolated operator','administrator',$6,$7)`,[endpoint,'b'.repeat(64),createHash('sha256').update('R'.repeat(43)).digest('hex'),id,issuer,'C'.repeat(43),new Date((now()+3600)*1000)]);console.log(JSON.stringify({endpoint,issuer,operatorId:id}));
}else{
 await db.query('SET ROLE galaxy_api');const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async a=>a.operatorId===id?'administrator':null}),businessAdmin=new BusinessAdminService({db,endpoint,now});businessAdmin.permissions=permissions;
 const native={call:async command=>{if(command.kind==='restore-preview')return x.preview;if(command.kind==='operation')return{...x.operation,id:command.operationId};return x.native??{}}};
 const service=new OperationsMaintenanceService({businessAdmin,native,now}),actor={kind:'business-operator',endpoint,operatorId:id,role:'administrator',httpRequestId:null};let out;
 if(mode==='createPlan')out=await service.createPlan(actor,x.input,{authorize:async()=>actor});else if(mode==='plan')out=await service.plan(actor,x.id,x.input??{});else if(mode==='plans')out=await service.plans(actor,x.input??{});else if(mode==='commandResult')out=await service.commandResult(actor,x.id);else throw Error('unknown mode');console.log(JSON.stringify(out));
}}finally{await db.end()}
