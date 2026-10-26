import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {dispatchBusinessAdmin} from '../src/adapters/http/business-admin-http.mjs';

test('audit server filters use real SQL scope and only the closed metadata projection',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const endpoint='https://audit-query.example.org',otherEndpoint='https://another.example.org',account=randomUUID(),otherAccount=randomUUID(),resource=randomUUID(),hiddenResource=randomUUID(),operation=randomUUID(),requestId=randomUUID();
 const actor={kind:'business-operator',operatorId:'synthetic-audit-reader',role:'reader',endpoint,httpRequestId:randomUUID()},now=()=>Math.floor(Date.parse('2026-10-22T08:00:00Z')/1000),service=new BusinessAdminService({db,endpoint,now});
 const fixtureAdmin={...actor,operatorId:'audit-query-fixture-admin',role:'administrator'};
 for(const principal of [fixtureAdmin,actor])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://fixture.invalid',$1,'当前审计读取夹具',$3,$3)",[principal.operatorId,endpoint,new Date(now()*1000)]);
 await attachOperationsFixtureAuthority({businessAdmin:service,admin:fixtureAdmin,reader:actor,permissions:['audit.read']});
 async function append({action='feedback-update',operator='synthetic-operator',accountId=account,selection={},result={},at='2026-10-22T01:00:00Z',targetEndpoint=endpoint,operationId=null,httpRequestId=null}={}){
  const id=randomUUID();const row=(await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at)
   VALUES($1,$2,$3,'administrator',$4,$5,$6,$7,$8,$9,$10) RETURNING sequence`,[id,targetEndpoint,operator,action,accountId,operationId,httpRequestId,JSON.stringify(selection),JSON.stringify(result),at])).rows[0];return{id,sequence:String(row.sequence)};
 }
 const oldest=await append({operator:'OLD_METADATA_MATCH',selection:{resourceId:resource,state:'processing'},result:{feedbackId:resource,revision:1},operationId:operation,httpRequestId:requestId});
 const privateTerms=['PRIVATE_BODY_TERM','PRIVATE_REASON_TERM','PRIVATE_SUMMARY_TERM','PRIVATE_SEARCH_TERM','PRIVATE_NOTE_TERM','PRIVATE_FINGERPRINT_TERM','PRIVATE_UNKNOWN_STATE'];
 const hidden=await append({selection:{id:resource,resourceId:resource,state:privateTerms[6],body:privateTerms[0],reason:privateTerms[1],summary:privateTerms[2],query:privateTerms[3],note:privateTerms[4],noteHash:privateTerms[5]},
  result:{feedbackId:resource,revision:2,summary:privateTerms[2],password:privateTerms[0]}});
 await append({action:'audit-read',selection:{id:hiddenResource,resourceId:null},result:{count:0}});
 const boundary=[];
 for(const at of ['2026-10-21T15:59:59.999Z','2026-10-21T16:00:00Z','2026-10-22T15:59:59.999Z','2026-10-22T16:00:00Z']){
  boundary.push(await append({action:'restriction-set',at,selection:{expectedRevision:0},result:{accountId:account}}));
 }
 await append({action:'community-content-query',result:{count:0}});
 await append({accountId:otherAccount,operator:'OTHER_ACCOUNT_MATCH'});
 await append({targetEndpoint:otherEndpoint,operator:'OTHER_ENDPOINT_MATCH'});

 await t.test('Shanghai day boundaries, exact actions, category and account scope run before pagination',async()=>{
  const day=await service.audit(actor,{action:'restriction-set',day:'2026-10-22'});
  assert.deepEqual(day.items.map(item=>item.id),[boundary[2].id,boundary[1].id]);assert.equal(day.nextAfter,null);
  assert.equal((await service.audit(actor,{kind:'reads',action:'restriction-set'})).items.length,0);
  assert.equal((await service.audit(actor,{kind:'business',action:'community-content-query'})).items.length,0);
  assert.equal((await service.audit(actor,{kind:'reads',action:'community-content-query'})).items.length,1);
  assert.equal((await service.audit(actor,{accountId:account,query:'OTHER_ACCOUNT_MATCH'})).items.length,0);
  assert.equal((await service.audit(actor,{query:'OTHER_ENDPOINT_MATCH'})).items.length,0);
  await assert.rejects(service.audit({...actor,endpoint:otherEndpoint},{}),{code:'business_admin_denied'});
  const one=await service.audit(actor,{action:'restriction-set',day:'2026-10-22',limit:1});assert.equal(one.items[0].id,boundary[2].id);
  assert.equal((await service.audit(actor,{action:'restriction-set',day:'2026-10-22',limit:1,after:one.nextAfter})).items[0].id,boundary[1].id);
 });

 await t.test('hidden prose, fingerprints, unknown enum values and hidden object fields cannot affect matching',async()=>{
  for(const query of privateTerms){const result=await service.audit(actor,{query});assert.equal(result.items.length,0,query);assert.equal(result.scanLimited,false);}
  assert.equal((await service.audit(actor,{query:operation.toUpperCase()})).items.some(item=>item.id===oldest.id),true);
  assert.equal((await service.audit(actor,{query:requestId})).items.some(item=>item.id===oldest.id),true);
  assert.equal((await service.audit(actor,{query:'processing'})).items.some(item=>item.id===oldest.id),true);
  const found=await service.audit(actor,{resourceId:resource.toUpperCase()});assert.ok(found.items.some(item=>item.id===hidden.id));
  assert.equal((await service.audit(actor,{query:hiddenResource})).items.length,0);
  assert.equal((await service.audit(actor,{resourceId:hiddenResource})).items.length,0,'unknown selection.id is not searchable merely because it is stored');
  const logs=(await db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE action='audit-read' AND operator_id=$1",[actor.operatorId])).rows;
  const text=JSON.stringify(logs);for(const term of privateTerms)assert.equal(text.includes(term),false,'queries are not copied into persistent audit');
  assert.ok(logs.some(row=>row.selection.hasQuery===true));
  assert.equal((await db.query('SELECT selection FROM business_admin_audit_v1 WHERE id=$1',[hidden.id])).rows[0].selection.reason,privateTerms[1],'source audit is unchanged');
 });

 await t.test('more than 500 nonmatching candidates yield an honest continuation and eventually reach old matching metadata',async()=>{
  await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,selection,result,created_at)
   SELECT x.id,$1,'synthetic-filler','administrator','feedback-update',$2,'{}'::jsonb,'{}'::jsonb,'2026-10-22T02:00:00Z'::timestamptz
   FROM jsonb_to_recordset($3::jsonb) AS x(id uuid)`,[endpoint,account,JSON.stringify(Array.from({length:1005},()=>({id:randomUUID()})))]);
  const first=await service.audit(actor,{query:'OLD_METADATA_MATCH',limit:30});assert.deepEqual(first.items,[]);assert.equal(first.scanLimited,true);assert.ok(first.nextAfter);
  const second=await service.audit(actor,{query:'OLD_METADATA_MATCH',after:first.nextAfter,limit:30});assert.deepEqual(second.items,[]);assert.equal(second.scanLimited,true);assert.ok(BigInt(second.nextAfter)<BigInt(first.nextAfter));
  const third=await service.audit(actor,{query:'OLD_METADATA_MATCH',after:second.nextAfter,limit:30});assert.deepEqual(third.items.map(item=>item.id),[oldest.id]);assert.equal(third.scanLimited,false);assert.equal(third.nextAfter,null);
  const unfiltered=await service.audit(actor,{limit:1});assert.equal(unfiltered.scanLimited,false);assert.ok(unfiltered.nextAfter);assert.equal(unfiltered.items.length,1);
 });

 await t.test('registered nonunique indexes support action and date query plans against the synthetic audit population',async()=>{
  const indexes=(await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='business_admin_audit_v1' AND indexname=ANY($1::text[])",[['business_admin_action_audit_v1','business_admin_date_audit_v1']])).rows;
  assert.equal(indexes.length,2);for(const index of indexes)assert.equal(index.indexdef.includes('UNIQUE INDEX'),false);
  await db.query('ANALYZE business_admin_audit_v1');
  const query=`SELECT * FROM business_admin_audit_v1 WHERE endpoint=$1 AND ($2::uuid IS NULL OR account_id=$2)
   AND ($3::bigint IS NULL OR sequence<$3) AND ($5::text IS NULL OR action=$5) AND ($6::text[] IS NULL OR action=ANY($6))
   AND ($7::date IS NULL OR (created_at>=($7::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND created_at<(($7::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')))
   ORDER BY sequence DESC LIMIT $4`;
  for(const [name,action,day]of [['action','restriction-set',null],['day',null,'2026-10-21']]){
   const plan=(await db.query('EXPLAIN (ANALYZE,FORMAT JSON) '+query,[endpoint,null,null,31,action,null,day])).rows[0]['QUERY PLAN'][0];
   t.diagnostic(JSON.stringify({name,plan:plan.Plan}));
  }
 });

 await t.test('HTTP accepts only supported single-value metadata filters and keeps an account route fixed',async()=>{
  async function dispatch(path,authorize=async()=>actor){let response;const accepted=await dispatchBusinessAdmin({businessAdmin:service,authorizeOperator:authorize,
   request:Object.assign(Readable.from([]),{method:'GET',headers:{}}),requestId:randomUUID(),url:new URL(path,endpoint),send:(status,body)=>{response={status,body};}});return{accepted,response};}
  const filtered=await dispatch('/v1/operations/audit?kind=business&action=restriction-set&day=2026-10-22&limit=1');assert.equal(filtered.accepted,true);assert.equal(filtered.response.body.items[0].id,boundary[2].id);
  const scoped=await dispatch('/v1/operations/users/'+account+'/audit?query=OTHER_ACCOUNT_MATCH&kind=business');assert.deepEqual(scoped.response.body.items,[]);
  for(const query of ['day=2026-02-31','day=0000-01-01','kind=ai','outcome=active','action=not%20a%20code','action=unapproved-action','query='+encodeURIComponent('x'.repeat(161)),'day=2026-10-22&day=2026-10-23','role=administrator']){
   await assert.rejects(dispatch('/v1/operations/audit?'+query),{code:'invalid_business_admin_request'},query);
  }
  await assert.rejects(dispatch('/v1/operations/users/'+account+'/audit?accountId='+otherAccount),{code:'invalid_business_admin_request'});
  await assert.rejects(dispatch('/v1/operations/audit',async()=>({...actor,role:'ordinary-account'})),{code:'business_admin_denied'});
 });

 await t.test('action options stay endpoint-local and omit unknown persisted strings',async()=>{
  await db.query('ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check');
  await append({action:'UNAPPROVED_PRIVATE_ACTION'});
  const result=await service.audit(actor,{limit:1});assert.ok(result.actions.includes('feedback-update'));assert.ok(result.actions.includes('community-content-query'));
  assert.equal(result.actions.includes('UNAPPROVED_PRIVATE_ACTION'),false);
 });
});
