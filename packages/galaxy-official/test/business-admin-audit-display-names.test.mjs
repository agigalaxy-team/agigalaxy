import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';

test('business audit resolves current same-endpoint human names without attributing an executor or changing private metadata and paging',{timeout:60000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
 const endpoint='https://audit-name.example.invalid',foreignEndpoint='https://other-audit.example.invalid',now=()=>2000000000,
  at=new Date(now()*1000).toISOString(),known='a'.repeat(64),blank='b'.repeat(64),missing='c'.repeat(64),foreign='d'.repeat(64),
  actor={kind:'business-operator',operatorId:known,role:'administrator',endpoint},resourceId=randomUUID(),privateText='PRIVATE_AUDIT_NAME_CHECK';
 for(const [id,scope,name]of [[known,endpoint,' 合成运维负责人 '],[blank,endpoint,'  '],[foreign,foreignEndpoint,'外部端点不得借用的姓名']]){
  await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
   VALUES($1,$2,'https://management.example.invalid',$1,$3,$4,$4)`,[id,scope,name,at]);
 }
 const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async current=>current.operatorId===known?'administrator':null}),
  service=new BusinessAdminService({db,endpoint,permissions,now}),selection={resourceId,state:'processing',reason:privateText},result={feedbackId:resourceId,revision:1,note:privateText};
 for(const id of [known,blank,missing,foreign])await service.recordWithin(db,{...actor,operatorId:id},'feedback-update',{selection,result});
 const executionId=randomUUID(),grantId=randomUUID();
 await db.query(`INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at)
  VALUES($1,$2,'合成程序归因','program','automatic',true,1,'{}','{}',$3,$3,$4,$4)`,[grantId,endpoint,known,at]);
 await db.query(`INSERT INTO operations_agentos_executions_v1(id,endpoint,grant_id,grant_version,domain,executor_kind,mode,operator_id,created_by,actions,resource_ids,state,session_id,created_at,updated_at)
  VALUES($1,$2,$3,1,'overview','program','automatic',null,$4,'{}','{}','active',$5,$6,$6)`,[executionId,endpoint,grantId,known,randomUUID(),at]);
 await service.recordWithin(db,{...actor,kind:'operations-executor',role:null,executionId,grantId},'feedback-update',{selection,result});
 await new BusinessAdminService({db,endpoint:foreignEndpoint,now}).recordWithin(db,{...actor,endpoint:foreignEndpoint},'feedback-update',{selection,result});
 const persisted=(await db.query('SELECT id,selection,result,operator_id,actor_kind FROM business_admin_audit_v1 ORDER BY sequence')).rows;
 await db.exec('SET ROLE galaxy_api');
 const response=await service.audit(actor,{action:'feedback-update',limit:20});
 assert.equal(response.items.length,5);assert.equal(response.metadataOnly,true);
 const human=response.items.find(item=>item.operatorId===known&&item.actorKind==='business-operator'),executor=response.items.find(item=>item.actorKind==='operations-executor');
 assert.equal(human.operatorDisplayName,'合成运维负责人');assert.equal(human.operatorId,known);
 for(const id of [blank,missing,foreign])assert.equal(response.items.find(item=>item.operatorId===id).operatorDisplayName,null);
 assert.equal(executor.operatorDisplayName,null);assert.equal(executor.operatorRole,null);assert.equal(executor.executionId,executionId);assert.equal(executor.grantId,grantId);
 const wire=JSON.stringify(response);assert(!wire.includes(privateText));assert(!wire.includes('外部端点不得借用'));
 const named=await service.audit(actor,{action:'feedback-update',query:'合成运维负责人'});assert.deepEqual(named.items.map(item=>item.id),[human.id]);
 assert.equal((await service.audit(actor,{action:'feedback-update',query:privateText})).items.length,0);
 assert.equal((await service.audit(actor,{action:'feedback-update',query:'外部端点不得借用'})).items.length,0);
 const ids=[];let after;
 do{const page=await service.audit(actor,{action:'feedback-update',resourceId,limit:2,...(after?{after}:{})});ids.push(...page.items.map(item=>item.id));after=page.nextAfter;}while(after);
 assert.equal(new Set(ids).size,5);assert.equal(ids.length,5);
 await db.exec('RESET ROLE');await db.query('UPDATE operations_operator_principals_v1 SET display_name=$2 WHERE operator_id=$1',[known,'合成更新后的管理名称']);await db.exec('SET ROLE galaxy_api');
 const renamed=await service.audit(actor,{action:'feedback-update'});assert.equal(renamed.items.find(item=>item.id===human.id).operatorDisplayName,'合成更新后的管理名称');assert.equal(renamed.items.find(item=>item.id===executor.id).operatorDisplayName,null);
 const unchanged=(await db.query('SELECT id,selection,result,operator_id,actor_kind FROM business_admin_audit_v1 WHERE id=ANY($1::uuid[]) ORDER BY sequence',[persisted.map(item=>item.id)])).rows;
 assert.deepEqual(unchanged,persisted,'display names are resolved on read; old audit records are not rewritten');
 await assert.rejects(service.audit({...actor,endpoint:foreignEndpoint},{}),{code:'business_admin_denied'});
});
