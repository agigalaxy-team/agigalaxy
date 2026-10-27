import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/http.mjs';
import {createWebEventService} from '../src/web-events/service.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

const endpoint='https://official.example',modules=['agentos','management-accounts','permissions'];
// Exercise the actual authorization/filtering service. This fixture supplies
// source rows only; it does not stand in for a PostgreSQL integration check.
function fixture(sourceTable,module='management-accounts'){
 const event={cursor:'2',module,source_table:sourceTable,source_ref:{endpoint,_operation:'UPDATE',_version:'2'},endpoint,operation_id:null};
 const client={async query(sql){
  if(sql.startsWith('SELECT galaxy_web_events_promote'))return{rows:[{count:0}]};
  if(sql.startsWith('SELECT cursor::text AS high'))return{rows:[{high:'2',low:'1'}]};
  if(sql.includes('FROM web_event_log_v1 WHERE'))return{rows:[event]};
  if(sql.startsWith('SELECT to_jsonb(source)'))return{rows:[{endpoint}]};
  if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return{rows:[]};
  throw Error('Unexpected database operation: '+sql);
 },release(){}};
 const pool={query:client.query,async connect(){return client;}};
 return createWebEventService({pool,endpoint,authorizeOperator:async()=>({operatorId:'owner',endpoint}),businessAdmin:{async authorizeAction(){}}});
}

test('management directory observations and receipts update only their module without resetting chat',async()=>{
 for(const source of ['operations_management_directory_v1','operations_management_entries_v1','operations_management_commands_v1']){
  const service=fixture(source),connection=await service.connect({surface:'admin',request:{},topics:modules});
  const frames=await service.read(connection,'1');
  assert.equal(frames.some(frame=>frame.type==='reset'),false,source);
  assert.equal(frames.filter(frame=>frame.type==='change').length,1);
  assert.equal(frames.find(frame=>frame.type==='change').module,'management-accounts');
 }
});

test('actual role and management authority changes still reset dependent chat projections',async()=>{
 for(const [source,module]of [['operations_role_assignments_v1','permissions'],['operations_business_roles_v1','permissions'],['operations_management_accounts_v1','management-accounts'],['operations_management_login_fences_v1','management-accounts']]){
  const service=fixture(source,module),connection=await service.connect({surface:'admin',request:{},topics:modules});
  const frames=await service.read(connection,'1');
  assert.deepEqual(new Set(frames.find(frame=>frame.type==='reset').modules),new Set(modules),source);
 }
});

test('event HTTP transient failure reconnects without revocation; confirmed denial still clears',async()=>{
 for(const status of [503,500,401,403,409,410]){
  const server=createApi({bindings:{endpoint},webEvents:{async connect(){return{modules};},async subscribe(){return()=>{};},async read(){throw new ServiceError('fixture_failure',status);}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/operations/web-events');
   assert.equal(r.status,200);const text=await r.text();
   if([401,403,409,410].includes(status)){assert.match(text,/"type":"reset"/);assert.match(text,/"agentos"/);}
   else assert.equal(text,'');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 }
});
