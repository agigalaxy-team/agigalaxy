import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';

// One real migrated PGlite/galaxy_api leaf. Current audit.read authorization is
// an explicit double, not an OIDC/Keycloak or live business-grant claim.
test('both audit read contracts find only exact closed selection version IDs without searching hidden material',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const endpoint='https://audit-versions.example',foreign='https://other-audit-versions.example',operatorId='a'.repeat(64),versionId=randomUUID(),otherVersion=randomUUID(),wrongVersion=randomUUID(),stamp='2030-01-01T00:00:00.000Z',now=()=>1893456000;
 const ids=[];
 async function add({section='service-connections',kind='save',version=versionId,resultVersion=version,ep=endpoint,selection={},action='system-settings-'+kind}={}){
  const id=randomUUID();await db.query(`INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,selection,result,created_at) VALUES($1,$2,$3,'reader',$4,$5,$6,$7,$8)`,
   [id,ep,operatorId,action,randomUUID(),JSON.stringify({section,kind,versionId:version,revision:1,...selection}),JSON.stringify({state:'completed',versionId:resultVersion,revision:1}),stamp]);return id;
 }
 ids.push(await add());ids.push(await add({kind:'test'}));ids.push(await add({kind:'apply'}));
 const other=await add({version:otherVersion,resultVersion:versionId});
 await add({version:null,selection:{freeText:versionId,body:versionId,privateProse:'PRIVATE_VERSION_PROSE_MUST_NOT_LEAVE'}});
 await add({version:versionId,action:'restriction-release',selection:{hiddenVersionId:versionId}});
 await add({ep:foreign});
 const original=(await db.query('SELECT id,selection,result,created_at,operation_id FROM business_admin_audit_v1 ORDER BY id')).rows;
 await migrate(db,{roles:['api']});await db.exec('SET ROLE galaxy_api');
 assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'galaxy_api');
 let checks=0;
 const actor={kind:'business-operator',operatorId,endpoint,role:'reader',businessAuthorization:{version:'fixture-audit-read',permissions:['audit.read']}};
 const permissions={async requireAction(value,action){checks++;assert.equal(action,'audit.read');assert.equal(value.endpoint,endpoint);return value;}};
 const service=new BusinessAdminService({db,endpoint,permissions,now});t.after(()=>service.auditPages.close());
 const cursor=await service.audit(actor,{resourceId:versionId,kind:'business',limit:100});
 assert.deepEqual(new Set(cursor.items.map(item=>item.id)),new Set(ids),'Cursor resource filtering must include the exact immutable System-version operations');
 assert(cursor.items.every(item=>item.selection.versionId===versionId));
 const page=await service.audit(actor,{resourceId:versionId,kind:'business',page:1,pageSize:20});
 assert.equal(page.search.state,'ready');assert.equal(page.pagination.total,3);assert.deepEqual(new Set(page.items.map(item=>item.id)),new Set(ids));
 const repeated=await service.audit(actor,{resourceId:versionId,kind:'business',page:1,pageSize:20,snapshot:page.pagination.snapshot});
 assert.equal(repeated.pagination.snapshot,page.pagination.snapshot);assert.equal(repeated.pagination.total,3);assert.deepEqual(repeated.items,page.items,'The existing snapshot freezes the same projected records');
 for(const query of[{resourceId:wrongVersion,kind:'business',limit:100},{resourceId:wrongVersion,kind:'business',page:1,pageSize:20}]){
  const result=await service.audit(actor,query);assert.equal(result.items.length,0);if(result.pagination)assert.equal(result.pagination.total,0);
 }
 const byOther=await service.audit(actor,{resourceId:otherVersion,kind:'business',limit:100});assert.deepEqual(byOther.items.map(item=>item.id),[other],'Result.versionId or hidden/free/raw fields cannot turn into selection resource matches');
 const hidden=await service.audit(actor,{query:'PRIVATE_VERSION_PROSE_MUST_NOT_LEAVE',kind:'business',page:1,pageSize:20});assert.equal(hidden.pagination.total,0);
 assert(!JSON.stringify({cursor,page,repeated,byOther,hidden}).includes('PRIVATE_VERSION_PROSE_MUST_NOT_LEAVE'));
 assert.deepEqual((await db.query("SELECT id,selection,result,created_at,operation_id FROM business_admin_audit_v1 WHERE action<>'audit-read' ORDER BY id")).rows,original,'Read projection does not rewrite old audits');
 assert(checks>=14);assert.equal((await db.query('SELECT max(version) AS n FROM schema_migrations')).rows[0].n,124);
});
