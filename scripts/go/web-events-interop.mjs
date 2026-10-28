// Original JS event reader against an isolated Go-owned test cluster only.
import pg from '../../packages/galaxy-official/node_modules/pg/lib/index.js';
import {migrate} from '../../packages/galaxy-official/src/infrastructure/database.mjs';
import {createWebEventService} from '../../packages/galaxy-official/src/web-events/service.mjs';
import * as topics from '../../packages/galaxy-official/src/web-events/topics.mjs';
const address=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL??'');
if(address.protocol!=='postgres:'||address.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(address.pathname))throw Error('isolated database required');
const pool=new pg.Pool({connectionString:address.href,max:4}),endpoint='https://events.invalid';
try{
 if(process.argv[2]==='setup') {await migrate(pool);console.log(JSON.stringify({sources:topics.webEventSources,aliases:topics.webEventSourceAliases,dependencies:topics.webEventAuthorizationDependencies,permissions:topics.operationsEventPermissions,web:topics.webModules,admin:topics.operationsModules,authority:[...topics.operationsAuthorityEventSources]}));}
 else if(process.argv[2]==='read') {
  const service=createWebEventService({pool,endpoint,authorizeOperator:async()=>({operatorId:'fixture',endpoint}),businessAdmin:{authorizeAction:async()=>{}}});
  try {const connection=await service.connect({request:{headers:{}},requestId:'fixture',surface:'admin',topics:process.argv[4].split(',')});console.log(JSON.stringify(await service.read(connection,process.argv[3])));}finally{service.stop();}
 }else throw Error('fixture command required');
}finally{await pool.end();}
