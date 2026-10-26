import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsFeedbackService} from '../src/operations-feedback.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';

test('chat review audit preserves only controlled message operations and room scope metadata',()=>{
 const reportId=randomUUID(),roomId=randomUUID(),messageId=randomUUID(),createdAt=new Date('2026-10-23T00:00:00Z'),secret='PRIVATE_CASE_PROSE',
  base={id:randomUUID(),sequence:1,operator_id:'recorded-operator',operator_role:'administrator',action:'chat-report-event',created_at:createdAt};
 for(const kind of ['review','pause','resume','resolve','message-hide','message-restore','message-keep']){
  const projected=businessAuditMetadata({...base,selection:{reportId,roomId,messageId,sourceRevision:3,kind,summary:secret,query:secret,reason:secret,noteHash:secret,source:'ai'},
   result:{version:2,revision:1,hidden:true,replayed:false,state:'reviewing',text:secret,decisionSource:'ai',credentials:secret}});
  assert.deepEqual(projected.selection,{reportId,roomId,messageId,sourceRevision:3,kind});
  assert.deepEqual(projected.result,{version:2,state:'reviewing',revision:1,hidden:true,replayed:false});
  assert.equal(JSON.stringify(projected).includes(secret),false);
  assert.equal(Object.hasOwn(projected.result,'decisionSource'),false);
 }
 const unknown=businessAuditMetadata({...base,selection:{kind:secret,messageId:secret,sourceRevision:secret},result:{hidden:secret,revision:secret}});
 assert.deepEqual(unknown.selection,{});assert.deepEqual(unknown.result,{});
 const scoped=businessAuditMetadata({...base,action:'chat-reports-query',selection:{roomId,state:'reviewing',after:null,limit:20,query:secret},result:{reportIds:[reportId]}});
 assert.deepEqual(scoped.selection,{after:null,limit:20,roomId,state:'reviewing'});
 assert.deepEqual(scoped.result,{reportIds:[reportId]});
 const unrelated=businessAuditMetadata({...base,action:'feedback-read',selection:{roomId,messageId,sourceRevision:3,kind:'message-hide'},result:{hidden:true,revision:1}});
 assert.deepEqual(unrelated.selection,{});assert.deepEqual(unrelated.result,{});
});

test('audit projects actual business reads and commands without copying prose, credentials, fingerprints or unknown fields',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const service=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),admin={kind:'business-operator',operatorId:'audit-synthetic-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,role:'reader'},
  feedback=new OperationsFeedbackService({businessAdmin:service,accounts:f.accounts}),privateText='PRIVATE_AUDIT_PROSE',fingerprint='a'.repeat(64),account=f.people[0],
  restriction={operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+3600)*1000).toISOString(),reason:privateText};
 await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.org','audit-synthetic','合成运营人员',$3,$3)`,[admin.operatorId,f.endpoint,new Date(f.now()*1000)]);
 await service.restrict(admin,account.accountId,restriction);
 await service.changeType(admin,account.accountId,{operationId:randomUUID(),expectedRevision:0,subjectType:'organization',reason:privateText,basis:privateText,preserveHistory:true});
 const submitted=await feedback.submit(account,{operationId:randomUUID(),body:privateText,category:'problem'});
 await feedback.event(admin,submitted.feedbackId,{operationId:randomUUID(),expectedRevision:1,state:'processing',note:privateText});
 await service.recordWithin(f.db,admin,'user-read',{accountId:account.accountId,selection:{view:'usage-summary',days:7,query:privateText,body:privateText,
  noteHash:fingerprint,unknown:{password:privateText}},result:{count:1,publicActivityState:'available',summary:privateText,accessToken:privateText,unknown:privateText}});
 const before=(await f.db.query('SELECT id,selection,result FROM business_admin_audit_v1 ORDER BY sequence')).rows,
  audit=await service.audit(reader,{limit:100}),wire=JSON.stringify(audit);
 assert.equal(audit.metadataOnly,true);assert.equal(wire.includes(privateText),false);assert.equal(wire.includes(fingerprint),false);
 assert.equal(wire.includes('noteHash'),false);assert.equal(wire.includes('accessToken'),false);assert.equal(wire.includes('unknown'),false);
 const limited=audit.items.find(item=>item.action==='restriction-set');
 assert.equal(limited.operationId,restriction.operationId);assert.equal(limited.selection.expectedRevision,0);assert.equal(limited.selection.until,restriction.until);
 assert.deepEqual(limited.result.restriction,{scope:'community-participation',active:true,until:restriction.until,revision:1});
 assert.equal(limited.result.before.active,false);assert.equal(Object.hasOwn(limited.result.before,'reason'),false);
 const typed=audit.items.find(item=>item.action==='type-change');assert.equal(typed.result.subjectType,'organization');assert.equal(typed.result.revision,1);assert.equal(typed.selection.preserveHistory,true);
 const note=audit.items.find(item=>item.action==='feedback-update');assert.equal(note.selection.resourceId,submitted.feedbackId);assert.equal(note.selection.state,'processing');assert.equal(note.result.feedbackId,submitted.feedbackId);
 const read=audit.items.find(item=>item.action==='user-read'&&item.selection.view==='usage-summary');assert.equal(read.selection.days,7);assert.equal(read.result.publicActivityState,'available');
 const filtered=await service.audit(reader,{resourceId:submitted.feedbackId});assert.ok(filtered.items.some(item=>item.id===note.id));
 const after=(await f.db.query('SELECT id,selection,result FROM business_admin_audit_v1 WHERE id=ANY($1::uuid[]) ORDER BY sequence',[before.map(item=>item.id)])).rows;
 assert.deepEqual(after,before,'a metadata read leaves all existing persistent records unchanged');
 const replay=await service.restrict(admin,account.accountId,restriction);assert.equal(replay.replayed,true);assert.equal(replay.restriction.reason,privateText,'read projection never changes original command result or intent');
 const unknown=businessAuditMetadata({...before[0],sequence:1,action:'future-action',operator_id:admin.operatorId,operator_role:admin.role,created_at:new Date(f.now()*1000),
  selection:{body:privateText,id:randomUUID()},result:{body:privateText,state:'active'}});
 assert.deepEqual(unknown.selection,{});assert.deepEqual(unknown.result,{});
});
