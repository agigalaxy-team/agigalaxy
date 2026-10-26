import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {operationsOperatorV1MigrationSql} from '../src/infrastructure/operations-operator-schema-v1.mjs';
import {operationsPermissionsV1MigrationSql} from '../src/infrastructure/operations-permissions-v1-schema.mjs';
import {operationsMessagingV1MigrationSql} from '../src/infrastructure/operations-messaging-v1-schema.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsMessagingService} from '../src/operations-messaging.mjs';
import {messageHistoryOperator} from '../../../apps/galaxy-admin/src/lib/messaging-view-model.ts';
import {permissionHistoryOperator,permissionHistoryDeltaLines} from '../../../apps/galaxy-admin/src/lib/permissions-view-model.ts';

test('messaging and permissions history resolve only current same-endpoint management names and never render opaque IDs as identity',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 // Use the exact three existing table migrations this read-only change needs;
 // unrelated migration113 / AgentOS work is deliberately not executed here.
 await db.exec(operationsOperatorV1MigrationSql);await db.exec(operationsPermissionsV1MigrationSql);await db.exec(operationsMessagingV1MigrationSql);
 const endpoint='https://history.example.invalid',foreignEndpoint='https://other.example.invalid',now=()=>2000000000,at=new Date(now()*1000).toISOString();
 const actorId='a'.repeat(64),targetId='b'.repeat(64),missingId='c'.repeat(64),foreignId='d'.repeat(64),blankId='e'.repeat(64);
 for(const [id,scope,name]of [[actorId,endpoint,'合成运营负责人'],[targetId,endpoint,'合成复核维护者'],[foreignId,foreignEndpoint,'不得从其他端点借来的名称'],[blankId,endpoint,'  ']])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.example.invalid',$1,$3,$4,$4)`,[id,scope,name,at]);
 const actor={kind:'business-operator',operatorId:actorId,role:'administrator',endpoint},permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async value=>value.operatorId===actorId?'administrator':null}),businessAdmin=new BusinessAdminService({db,endpoint,permissions,now});
 const roleId=randomUUID(),assignmentId=randomUUID();
 await db.query(`INSERT INTO operations_business_roles_v1(id,endpoint,name,description,enabled,version,permissions,created_by,updated_by,created_at,updated_at) VALUES($1,$2,'合成只读角色','',true,1,ARRAY['content.read'],$3,$3,$4,$4)`,[roleId,endpoint,actorId,at]);
 await db.query(`INSERT INTO operations_role_assignments_v1(id,endpoint,operator_id,role_id,enabled,version,created_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,true,1,$5,$5,$6,$6)`,[assignmentId,endpoint,targetId,roleId,actorId,at]);
 const assignmentDelta={kind:'assignment',operatorId:targetId,roleId,enabled:{before:null,after:true}},assignmentEvent=randomUUID();
 for(const [id,scope,who,kind,resourceId,delta]of [[assignmentEvent,endpoint,actorId,'assignment-save',assignmentId,assignmentDelta],[randomUUID(),endpoint,blankId,'role-save',roleId,null],[randomUUID(),endpoint,foreignId,'role-save',roleId,null],[randomUUID(),foreignEndpoint,foreignId,'role-save',roleId,null]])await db.query(`INSERT INTO operations_permission_events_v1(id,endpoint,operator_id,kind,resource_id,version,changed_fields,input,result,created_at) VALUES($1,$2,$3,$4,$5,1,ARRAY['enabled'],'{}',$6,$7)`,[id,scope,who,kind,resourceId,JSON.stringify({delta}),at]);
 const history=await permissions.history(actor),assigned=history.items.find(item=>item.id===assignmentEvent);
 assert.equal(history.items.length,3);assert.equal(assigned.operatorId,actorId);assert.equal(assigned.operatorDisplayName,'合成运营负责人');assert.equal(assigned.assignmentOperatorDisplayName,'合成复核维护者');assert.equal(permissionHistoryOperator(assigned),'合成运营负责人');
 assert.equal(permissionHistoryDeltaLines(assigned,[],{roles:[],people:[]})[0].text,'合成复核维护者','target name must not depend on a loaded personnel directory');
 assert.equal(history.items.find(item=>item.operatorId===blankId).operatorDisplayName,null);assert.equal(history.items.find(item=>item.operatorId===foreignId).operatorDisplayName,null);
 for(const event of history.items.filter(item=>item.operatorId!==actorId))assert.equal(permissionHistoryOperator(event),'管理账户');
 assert.equal(permissionHistoryDeltaLines({delta:assignmentDelta},[],{roles:[],people:[]})[0].text,'管理账户');
 const one=await permissions.history(actor,{limit:1});assert(one.nextAfter);assert((await permissions.history(actor,{after:one.nextAfter,limit:1})).items[0].id!==one.items[0].id);

 const planId=randomUUID(),foreignPlanId=randomUUID(),config={channels:['inapp'],content:{purpose:'service-update',title:'合成可辨认历史',body:'只供组件展示，不发送。',href:null,expiresAt:new Date((now()+86400)*1000).toISOString()},audience:{kind:'all-accounts'},senderKey:'notice',schedule:{kind:'immediate'}};
 for(const [id,scope]of [[planId,endpoint],[foreignPlanId,foreignEndpoint]]){await db.query(`INSERT INTO operations_messaging_plans_v1(id,endpoint,version,revision,state,created_by,updated_by,created_at,updated_at) VALUES($1,$2,1,1,'draft',$3,$3,$4,$4)`,[id,scope,actorId,at]);await db.query(`INSERT INTO operations_messaging_versions_v1(plan_id,version,config,created_by,created_at) VALUES($1,1,$2,$3,$4)`,[id,JSON.stringify(config),actorId,at]);}
 for(const [plan,who,kind]of [[planId,actorId,'create'],[planId,blankId,'save'],[planId,missingId,'save'],[planId,foreignId,'pause'],[foreignPlanId,foreignId,'create']])await db.query(`INSERT INTO operations_messaging_events_v1(id,plan_id,operator_id,operator_role,kind,version,revision,created_at) VALUES($1,$2,$3,'reader',$4,1,1,$5)`,[randomUUID(),plan,who,kind,at]);
 const messaging=new OperationsMessagingService({db,endpoint,businessAdmin,now}),messages=await messaging.history(actor,planId),detail=await messaging.get(actor,planId);
 assert.equal(messages.items.length,4);assert.equal(messages.items.find(item=>item.operatorId===actorId).operatorDisplayName,'合成运营负责人');assert.deepEqual(detail.history.items,messages.items);
 for(const item of messages.items.filter(item=>item.operatorId!==actorId)){assert.equal(item.operatorDisplayName,null);assert.equal(messageHistoryOperator(item),'管理账户');assert(item.operatorId.length===64,'internal association remains intact');}
 assert.equal((await messaging.historyWithin(db,foreignPlanId)).items.length,0);await assert.rejects(messaging.history(actor,foreignPlanId),{code:'operations_messaging_plan_not_found'});
 assert.equal(messageHistoryOperator({operatorDisplayName:' '}),'管理账户');assert.equal(permissionHistoryOperator({operatorDisplayName:null}),'管理账户');
 const rendered=messages.items.map(messageHistoryOperator).join(' ')+history.items.map(permissionHistoryOperator).join(' ')+permissionHistoryDeltaLines(assigned,[]).map(line=>line.text).join(' ');
 for(const id of [actorId,targetId,missingId,foreignId,blankId])assert(!rendered.includes(id)&&!rendered.includes(id.slice(0,8)),'opaque identity leaked into user labels');assert(!rendered.includes('不得从其他端点'));
 await db.query('UPDATE operations_operator_principals_v1 SET display_name=$2 WHERE operator_id=$1',[actorId,'合成更新后的管理名称']);assert.equal((await messaging.history(actor,planId)).items.find(item=>item.operatorId===actorId).operatorDisplayName,'合成更新后的管理名称');assert.equal((await permissions.history(actor)).items.find(item=>item.id===assignmentEvent).operatorDisplayName,'合成更新后的管理名称');
 await db.query('UPDATE operations_operator_principals_v1 SET display_name=$2 WHERE operator_id=$1',[targetId,' ']);const blankTarget=(await permissions.history(actor)).items.find(item=>item.id===assignmentEvent);assert.equal(blankTarget.assignmentOperatorDisplayName,null);assert.equal(permissionHistoryDeltaLines(blankTarget,[],{roles:[],people:[]})[0].text,'管理账户');assert.equal(permissionHistoryDeltaLines(blankTarget,[],{people:[{operatorId:targetId,displayName:'目录中过时的管理名称'}]})[0].text,'管理账户','explicit unavailable history name must not borrow an older directory snapshot');
 // Optional safe fixture export feeds the actual-component observation below.
 if(process.env.GALAXY_HISTORY_DISPLAY_EVIDENCE){const out=path.resolve(process.env.GALAXY_HISTORY_DISPLAY_EVIDENCE);await mkdir(out,{recursive:true});await writeFile(path.join(out,'sql-history-fixtures.json'),JSON.stringify({scope:'Synthetic principals and recorded events read by real PGlite services; not production',messaging:messages,messagingDetail:detail,permissions:history},null,2));}
});
