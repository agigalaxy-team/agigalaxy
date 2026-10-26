import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {withPermissionAuditLinks} from "../src/operations/audit/business-admin-permission-audit-links.mjs";
import {auditItem} from "../src/operations/agentos/query-view.mjs";
import {auditObjects,auditMetadata,auditObjectRecordsHref,normalizeAuditFilters} from '../../../apps/galaxy-admin/src/lib/audit-view-model.ts';

// One actual migrated PGlite/galaxy_api read-model leaf. Authorization is an
// explicit audit.read-only double. Immutable local SQL fixtures are not real
// role grants, OIDC accounts, browser/HTTP, provider or production operations.
test('audit person and role links require the exact immutable assignment event and optional SQL failures roll back before the original audit is read',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const endpoint='https://audit-links.example',foreign='https://other-audit-links.example',stamp='2030-01-01T00:00:00.000Z',now=()=>1893456000;
 const actorId='a'.repeat(64),otherActor='b'.repeat(64),targetId='c'.repeat(64),roleId=randomUUID(),assignmentId=randomUUID();
 for(const [id,ep]of [[actorId,endpoint],[otherActor,endpoint],[targetId,endpoint]])await db.query('INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[id,ep,'https://identity.example/realms/management',id,'本机历史身份夹具',stamp]);
 await db.query(`INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'本机已停用历史角色','',false,2,'{}',$3,$3,$4,$4)`,[roleId,endpoint,actorId,stamp]);
 await db.query(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,false,2,$5,$5,$6,$6)`,[assignmentId,endpoint,targetId,roleId,actorId,stamp]);
 await db.exec('CREATE TABLE audit_link_unreadable_fixture (id integer)');
 const fixtures=[];
 async function pair(label,change={}){
  const operationId=randomUUID(),auditId=randomUUID(),resourceId=label==='good'?assignmentId:randomUUID();
  const input={operationId,expectedVersion:0,operatorId:targetId,roleId,enabled:true,privateProse:'SOURCE_PROSE_MUST_NOT_LEAVE'};
  const result={operationId,assignment:{id:resourceId,operatorId:targetId,roleId,version:1,enabled:true},recordedAt:stamp,replayed:false};
  const event={id:operationId,endpoint,actor:actorId,kind:'assignment-save',resource:resourceId,input,result};
  const audit={id:auditId,endpoint,actor:actorId,operation:operationId,selection:{resourceId,expectedVersion:0,changedFields:['operatorId','roleId','enabled'],targetOperatorId:otherActor,roleId:randomUUID(),privateProse:'AUDIT_PROSE_MUST_NOT_LEAVE'},result:{version:1,enabled:true}};
  change.edit?.(event,audit);
  if(!change.missing)await db.query(`INSERT INTO operations_permission_events_v1(id,endpoint,operator_id,kind,resource_id,version,changed_fields,input,result,created_at) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9)`,[event.id,event.endpoint,event.actor,event.kind,event.resource,['operatorId','roleId','enabled'],JSON.stringify(event.input),JSON.stringify(event.result),stamp]);
  await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,selection,result,created_at) VALUES($1,$2,$3,'reader','permission-assignment-save',$4,$5,$6,$7)`,[audit.id,audit.endpoint,audit.actor,audit.operation,JSON.stringify(audit.selection),JSON.stringify(audit.result),stamp]);
  const fixture={label,operationId,auditId};fixtures.push(fixture);return fixture;
 }
 const good=await pair('good');
 await pair('wrong-actor',{edit:e=>{e.actor=otherActor;}});
 await pair('wrong-op',{edit:e=>{e.id=randomUUID();}});
 await pair('wrong-resource',{edit:e=>{e.resource=randomUUID();}});
 await pair('wrong-endpoint',{edit:e=>{e.endpoint=foreign;}});
 await pair('wrong-kind',{edit:e=>{e.kind='role-save';}});
 await pair('wrong-result-target',{edit:e=>{e.result.assignment.operatorId=otherActor;}});
 await pair('wrong-result-role',{edit:e=>{e.result.assignment.roleId=randomUUID();}});
 await pair('wrong-result-op',{edit:e=>{e.result.operationId=randomUUID();}});
 await pair('wrong-enabled',{edit:e=>{e.result.assignment.enabled=false;}});
 await pair('wrong-version',{edit:(_,a)=>{a.result.version=2;}});
 await pair('missing-source',{missing:true});
 await pair('invalid-target',{edit:e=>{e.input.operatorId='not-an-operator';e.result.assignment.operatorId='not-an-operator';}});
 await migrate(db,{roles:['api']});await db.exec('SET ROLE galaxy_api');
 assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'galaxy_api');
 assert.equal((await db.query("SELECT has_table_privilege(current_user,'operations_permission_events_v1','SELECT') AS can_read,has_table_privilege(current_user,'operations_permission_events_v1','UPDATE') AS can_update")).rows[0].can_read,true);
 assert.equal((await db.query("SELECT has_table_privilege(current_user,'operations_permission_events_v1','UPDATE') AS can_update")).rows[0].can_update,false);
 const actor={kind:'business-operator',operatorId:actorId,endpoint,role:'reader',businessAuthorization:{version:'fixture-audit-read',permissions:['audit.read']}},calls=[];
 const permissions={async requireAction(value,action){calls.push(action);assert.equal(action,'audit.read');if(value.endpoint!==endpoint)throw Error('Wrong endpoint in authority double');return value;}};
 const service=new BusinessAdminService({db,endpoint,permissions,now});t.after(()=>service.auditPages.close());
 const initial=(await db.query('SELECT selection,result,created_at,operation_id FROM business_admin_audit_v1 WHERE id=$1',[good.auditId])).rows[0];
 const cursor=await service.audit(actor,{action:'permission-assignment-save',limit:100}),original=cursor.items.find(item=>item.id===good.auditId);
 assert.equal(original.selection.targetOperatorId,targetId,'The real cursor read must recover the historical target from the exact immutable event');
 assert.equal(original.selection.roleId,roleId);assert.equal(original.selection.resourceId,assignmentId);assert.equal(original.result.enabled,true);assert.equal(original.result.version,1);assert.equal(original.createdAt,stamp);
 assert.equal((await db.query('SELECT enabled,version FROM operations_role_assignments_v1 WHERE id=$1',[assignmentId])).rows[0].enabled,false,'A revoked current assignment cannot rewrite the historical enabled result');
 for(const fixture of fixtures.filter(v=>v.label!=='good')){
  const item=cursor.items.find(v=>v.id===fixture.auditId);assert(item,fixture.label);assert.equal(Object.hasOwn(item.selection,'targetOperatorId'),false,fixture.label);assert.equal(Object.hasOwn(item.selection,'roleId'),false,fixture.label);
 }
 const page=await service.audit(actor,{action:'permission-assignment-save',page:1,pageSize:100}),paged=page.items.find(item=>item.id===good.auditId);assert.deepEqual(paged.selection,original.selection);assert.deepEqual(paged.result,original.result);
 const byRole=await service.audit(actor,{action:'permission-assignment-save',resourceId:roleId,page:1,pageSize:20});assert.equal(byRole.pagination.total,1);assert.equal(byRole.items[0].id,good.auditId);
 const byPerson=await service.audit(actor,{action:'permission-assignment-save',query:targetId,page:1,pageSize:20});assert.equal(byPerson.pagination.total,1);assert.equal(byPerson.items[0].id,good.auditId);
 const hidden=await service.audit(actor,{query:'SOURCE_PROSE_MUST_NOT_LEAVE',page:1,pageSize:20});assert.equal(hidden.pagination.total,0);
 const objects=auditObjects(original),person=objects.find(v=>v.kind==='permission-personnel'),role=objects.find(v=>v.kind==='business-role');
 assert.equal(person.id,targetId);assert.equal(person.href,'/admin/operations/permissions?tab=personnel&id='+targetId);assert.equal(role.id,roleId);assert.equal(role.href,'/admin/operations/permissions?tab=roles&id='+roleId);assert(objects.some(v=>v.id===assignmentId&&v.kind==='role-assignment'&&v.href===null));
 assert.equal(new URL(auditObjectRecordsHref(normalizeAuditFilters({}),person),'https://admin.example').searchParams.get('q'),targetId);
 assert.equal(new URL(auditObjectRecordsHref(normalizeAuditFilters({}),role),'https://admin.example').searchParams.get('resource'),roleId);
 assert.equal(auditMetadata(original.result,original.action).find(v=>v.key==='enabled').label,'记录时分配有效');assert(auditMetadata(original.selection,original.action).some(v=>v.key==='roleId'));
 const ai=auditItem(original);assert.equal(ai.selection.targetOperatorId,targetId);assert.equal(ai.selection.roleId,roleId);assert.equal(Object.hasOwn(ai,'operatorId'),false);assert.equal(Object.hasOwn(ai,'httpRequestId'),false);
 const raw=(await db.query('SELECT * FROM business_admin_audit_v1 WHERE endpoint=$1 AND id=$2',[endpoint,good.auditId])).rows;
 const failures=[];
 const unavailablePool={query:db.query.bind(db),transaction:fn=>db.transaction(tx=>fn({query:async(sql,args)=>{
  if(sql.includes('JOIN operations_permission_events_v1')){
   try{await tx.query('SELECT * FROM audit_link_unreadable_fixture');}catch(error){failures.push(error.code);try{await tx.query('SELECT 1');}catch(aborted){failures.push(aborted.code);}throw error;}
  }
  return tx.query(sql,args);
 }}))};
 const fallback=await withPermissionAuditLinks(unavailablePool,{endpoint,rows:raw});assert.deepEqual(failures,['42501','25P02'],'The optional source failure really aborts its PG transaction before the owning transaction rolls it back');assert.equal(Object.hasOwn(fallback[0].selection,'targetOperatorId'),false);assert.equal(Object.hasOwn(fallback[0].selection,'roleId'),false);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE id=$1',[good.auditId])).rows[0].n,1,'After rollback the same API-role database can still read the original audit');
 const failedService=new BusinessAdminService({db:unavailablePool,endpoint,permissions,now});t.after(()=>failedService.auditPages.close());
 const withoutLinks=await failedService.audit(actor,{action:'permission-assignment-save',page:1,pageSize:100});assert(withoutLinks.items.some(v=>v.id===good.auditId));assert(withoutLinks.items.every(v=>!Object.hasOwn(v.selection,'targetOperatorId')&&!Object.hasOwn(v.selection,'roleId')),'An unreadable optional source must not make the actual audit list fail');
 assert.deepEqual((await db.query('SELECT selection,result,created_at,operation_id FROM business_admin_audit_v1 WHERE id=$1',[good.auditId])).rows[0],initial,'No old generic audit is changed');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_permission_events_v1')).rows[0].n,fixtures.length-1,'Reads append no permission events');
 assert(!JSON.stringify({cursor,page,byRole,byPerson,ai,withoutLinks}).includes('PROSE_MUST_NOT_LEAVE'));assert(calls.length>=10);
});
