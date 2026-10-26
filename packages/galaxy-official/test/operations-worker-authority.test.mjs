import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {createStoredOperatorAuthorization} from "../src/operations/configuration.mjs";
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';

test('queued authority uses the stored principal and current action grants, without accepting a payload subject',async t=>{
 const endpoint='https://official.example.invalid',issuer='https://admin.example.invalid/realms/management';
 const actor={kind:'business-operator',endpoint,operatorId:'operator-stable',role:'administrator',httpRequestId:'31338740-9a63-4283-b8ac-29b79c2696c9'};
 let roles=['admin'];const calls=[];
 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const admin={kind:'business-operator',endpoint,operatorId:'fixture-grant-admin',role:'administrator'};
 for(const principal of [actor,admin])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,$3,$4,'合成队列权限检查人员',now(),now())`,[principal.operatorId,endpoint,issuer,principal===actor?'stored-management-subject':'fixture-grant-admin']);
 const operatorAuthorization=createStoredOperatorAuthorization({db,endpoint,issuer,roles:{administrator:'admin',reader:'read'},roleDirectory:{async getOperatorRoles(input){calls.push(input);if(roles===null)throw Error('secret-upstream-response');return roles;}}});
 const service=new BusinessAdminService({db,endpoint,operatorAuthorization});
 const {permissions}=await attachOperationsFixtureAuthority({businessAdmin:service,admin,reader:actor,permissions:['cms.publish']});
 const fixtureAuthorization=permissions.operatorAuthorization;
 permissions.operatorAuthorization=(current,options)=>current.operatorId===admin.operatorId?fixtureAuthorization(current,options):operatorAuthorization(current,options);
 service.operatorAuthorization=operatorAuthorization;
 await assert.rejects(service.authorizeAction({...actor,externalSubject:'attacker-choice'},'cms.publish'),error=>error.code==='business_admin_denied');
 assert.equal(calls.length,0);
 const authorized=await service.authorizeAction(actor,'cms.publish');
 assert.deepEqual({kind:authorized.kind,endpoint:authorized.endpoint,operatorId:authorized.operatorId,httpRequestId:authorized.httpRequestId},
  {kind:actor.kind,endpoint:actor.endpoint,operatorId:actor.operatorId,httpRequestId:actor.httpRequestId},'authorization preserves the original operator and request receipt coordinates');
 assert.equal(authorized.role,'reader','native administrator admission does not create a root identity');
 assert.ok(authorized.businessAuthorization.permissions.includes('cms.publish'));
 assert.deepEqual(calls,[{issuer,externalSubject:'stored-management-subject'}]);
 roles=['read'];assert.ok((await service.revalidate(actor,{action:'cms.publish'})).businessAuthorization.permissions.includes('cms.publish'),'current PG grants remain authoritative after an admitted native role change');
 const assignment=(await db.query('SELECT id,role_id,version FROM operations_role_assignments_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,actor.operatorId])).rows[0];
 await permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:actor.operatorId,roleId:assignment.role_id,enabled:false},{authorize:async()=>admin});
 await assert.rejects(service.authorizeAction(authorized,'cms.publish'),error=>error.code==='operations_permission_denied'&&error.status===403,'a queued task cannot retain its earlier action grant after revocation');
 roles=[];await assert.rejects(service.authorizeAction(actor,'cms.publish'),error=>error.code==='business_admin_denied');
 roles=null;await assert.rejects(service.authorizeAction(actor,'cms.publish'),error=>error.code==='identity_directory_unavailable'&&!error.message.includes('secret'));
});
