import pg from '../../../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {OperationsPermissionsService} from '../../../../packages/galaxy-official/src/operations/permissions/service.mjs';
import {BusinessAdminService} from '../../../../packages/galaxy-official/src/operations/audit/service.mjs';
let raw='';for await(const b of process.stdin)raw+=b;const input=JSON.parse(raw),url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(url.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(url.pathname))throw Error('isolated database required');
const db=new pg.Pool({connectionString:url.href}),permissions=new OperationsPermissionsService({db,endpoint:input.endpoint,now:()=>2000000000,operatorAuthorization:async a=>a.operatorId===input.rootId?'administrator':null}),service=new BusinessAdminService({db,endpoint:input.endpoint,now:()=>2000000000});service.permissions=permissions;
try{const result=await service.audit({kind:'business-operator',endpoint:input.endpoint,operatorId:input.rootId,role:'administrator',httpRequestId:null},input.query);process.stdout.write(JSON.stringify(result))}finally{service.auditPages.close();await db.end()}
