import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {OperationsPermissionsService} from '../src/operations/permissions/service.mjs';
import {operationsPermissionCatalog,operationsPermissionCodes,operationActionPermissions} from '../src/operations-permission-catalog.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsBusinessDomain} from '../src/operations-content-visibility.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {ContentPublications,createContentPublicationWorker} from '../src/content-publications.mjs';
import {OperationsNotices,createOperationsNoticeWorker} from '../src/operations-notices.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';

// Real local PGlite, domain writes and official-account fixture. The management
// directory, message transport, scanner and file store are explicit doubles.
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'permission-fixture-admin',role:'administrator',endpoint:f.endpoint,httpRequestId:randomUUID()},reader={...admin,operatorId:'permission-fixture-reader',role:'reader'},other={...reader,operatorId:'permission-fixture-other'};
 const roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader'],[other.operatorId,'reader']]);
 for(const actor of [admin,reader,other])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.invalid',$1,'合成管理人员',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const operatorAuthorization=async actor=>roles.get(actor.operatorId),permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization,now:f.now});
 let identityReads=0;
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,operatorAuthorization,now:f.now,identityDirectory:{get:async()=>{identityReads++;return null;},findByEmail:async()=>{identityReads++;return[];}}});
 const makeRole=async(codes,name='合成角色 '+randomUUID())=>(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name,description:'本地功能动作授权夹具',enabled:true,permissions:codes},{authorize:async()=>admin})).role;
 const assign=async(role,person=reader)=>(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:person.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin})).assignment;
 return {...f,admin,reader,other,roles,permissions,businessAdmin,makeRole,assign,identityReads:()=>identityReads};
}

test('PG business grants authorize a real reader action without impersonating administrator and block forged snapshots or ungranted identity reads',async t=>{
 const f=await fixture(t),role=await f.makeRole(['accounts.read','accounts.restriction.apply','audit.read']);await f.assign(role);
 const actor={...f.reader,role:'administrator',businessAuthorization:{version:'999',permissions:[...operationsPermissionCodes]}};
 const list=await f.businessAdmin.list(actor);assert.equal(list.items.length,3);assert.equal(list.items[0].identity.email,null);assert.equal(list.items[0].identity.state,'not-authorized');assert.equal(f.identityReads(),0);
 await assert.rejects(f.businessAdmin.list(actor,{query:'private@example.invalid'}),{code:'operations_permission_denied'});assert.equal(f.identityReads(),0);
 const input={operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+60)*1000).toISOString(),reason:'获准功能动作限制'};
 const receipt=await f.businessAdmin.restrict(actor,f.people[0].accountId,input);assert.equal(receipt.restriction.active,true);
 assert.equal((await f.db.query("SELECT operator_role FROM business_admin_audit_v1 WHERE action='restriction-set' AND operation_id=$1",[input.operationId])).rows[0].operator_role,'reader');
 await assert.rejects(f.businessAdmin.releaseRestriction(actor,f.people[0].accountId,{operationId:randomUUID(),expectedRevision:1,reason:'未获准解除限制'}),{code:'operations_permission_denied'});
 const domain=new OperationsBusinessDomain({businessAdmin:f.businessAdmin});let called=false;
 await assert.rejects(domain.command(actor,'unknown-future-command',{operationId:randomUUID()},async()=>{called=true;return{};}),{code:'operations_permission_unknown'});assert.equal(called,false);
 assert.deepEqual(operationActionPermissions('resource-visibility',{kind:'projects',command:{kind:'restore'}}),['resources.restore']);
 await assert.rejects(f.permissions.effective({...actor,operatorId:f.people[0].accountId}),{code:'business_admin_denied'});
 await assert.rejects(f.permissions.effective({...actor,endpoint:'https://foreign.example.invalid'}),{code:'business_admin_denied'});
});

test('role and personnel commands enforce CAS, stable original intent, bounded grant authority and current revocation before replay',async t=>{
 const f=await fixture(t),manager=await f.makeRole(['permissions.read','permissions.roles.write','permissions.assignments.write','content.read']),assignment=await f.assign(manager);
 const input={operationId:randomUUID(),expectedVersion:0,name:'允许的下级业务动作集合',description:'不产生角色树或继承',enabled:true,permissions:['content.read']};
 const made=await f.permissions.saveRole(f.reader,input,{authorize:async()=>f.reader});assert.equal(made.role.version,1);
 assert.equal((await f.permissions.saveRole(f.reader,input,{authorize:async()=>f.reader})).replayed,true);
 await assert.rejects(f.permissions.saveRole(f.reader,{...input,name:'替换原意图'},{authorize:async()=>f.reader}),{code:'operations_permissions_operation_conflict'});
 await assert.rejects(f.permissions.saveRole(f.reader,{...input,operationId:randomUUID(),name:'不能自授敏感读取',permissions:['chat-reports.materials.read']},{authorize:async()=>f.reader}),{code:'operations_permission_grant_exceeds_authority'});
 await assert.rejects(f.permissions.saveRole(f.admin,{...input,id:made.role.id,operationId:randomUUID(),expectedVersion:0},{authorize:async()=>f.admin}),{code:'operations_permissions_version_changed'});
 await assert.rejects(f.permissions.saveRole(f.admin,{...input,operationId:randomUUID()},{}),{code:'operations_authorization_unavailable'});
 await assert.rejects(f.permissions.saveRole(f.admin,{...input,operationId:randomUUID()},{authorize:async()=>f.other}),{code:'business_admin_denied'});
 const before=(await f.permissions.effective(f.reader)).version;
 const revoked=await f.permissions.saveAssignment(f.reader,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:manager.id,enabled:false},{authorize:async()=>f.reader});assert.equal(revoked.assignment.enabled,false,'a deliberate self-revoke must commit');
 const after=await f.permissions.effective({...f.reader,role:'administrator',businessAuthorization:{version:before,permissions:[...operationsPermissionCodes]}});assert.deepEqual(after.permissions,[]);assert(BigInt(after.version)>BigInt(before));
 await assert.rejects(f.permissions.saveRole(f.reader,input,{authorize:async()=>f.reader}),{code:'operations_permission_denied'});
 const personnel=await f.permissions.personnel(f.admin);assert.deepEqual(personnel.items.find(p=>p.operatorId===f.reader.operatorId).effective.permissions,[]);
 const history=await f.permissions.history(f.admin,{resourceId:manager.id,limit:1});assert.equal(history.items.length,1);assert.equal(Object.hasOwn(history.items[0],'input'),false);assert.equal(Object.hasOwn(history.items[0],'name'),false);
 f.roles.delete(f.other.operatorId);assert.equal((await f.permissions.personnel(f.admin)).items.find(p=>p.operatorId===f.other.operatorId).authorizationState,'not-eligible');
 const audit=(await f.db.query("SELECT selection,result FROM business_admin_audit_v1 WHERE action LIKE 'permission-%'")).rows;assert.equal(JSON.stringify(audit).includes('允许的下级'),false);assert.equal(JSON.stringify(audit).includes('不产生角色树'),false);
});

test('private case metadata, selected body, attachment bytes and message actions require separate current grants while original disclosure limits remain',async t=>{
 const f=await fixture(t),g=new AccountChatGovernanceService({chat:f.chat,businessAdmin:f.businessAdmin}),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),attachmentId=randomUUID(),bytes=Buffer.from('synthetic selected bytes'),sha256=f.digest(bytes);
 await f.files.prepare(b,{attachmentId,roomId,name:'明确选入的合成附件.txt',mediaType:'text/plain',size:bytes.length,sha256,purpose:'temporary-room-attachment',confirmed:true});await f.files.upload(b,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();
 const message=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'不得由普通审计或案件目录取得的合成正文',attachments:[{id:attachmentId,sha256}]});
 const source=await g.source(a,{roomId,messageIds:[message.messageId]}),report=await g.report(a,{operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'只选这一条供必要独立处理',materials:[{messageId:message.messageId,revision:message.revision,attachmentIds:[attachmentId]}]});
 const role=await f.makeRole(['chat-reports.read','audit.read']);await f.assign(role);
 const metadata=await g.operatorGet(f.reader,{reportId:report.reportId});assert.deepEqual(metadata.materials,[]);assert.equal(metadata.events[0].summary,null);assert.equal(metadata.canModerate,false);
 await assert.rejects(g.operatorAttachment(f.reader,{reportId:report.reportId,attachmentId},{authorize:async()=>f.reader}),{code:'operations_permission_denied'});
 let updated=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),id:role.id,expectedVersion:1,name:role.name,description:role.description,enabled:true,permissions:['chat-reports.read','chat-reports.materials.read','chat-messages.hide']},{authorize:async()=>f.admin})).role;
 let detail=await g.operatorGet(f.reader,{reportId:report.reportId});assert.equal(detail.materials[0].text,message.text??'不得由普通审计或案件目录取得的合成正文');assert.equal(detail.materials[0].attachments[0].contentAvailable,false);assert.equal(detail.materials[0].moderation.canHide,true);assert.equal(detail.materials[0].moderation.canRestore,false);
 const hide={operationId:randomUUID(),expectedVersion:detail.version,expectedRevision:0,messageRevision:message.revision,action:'hide',summary:'仅执行已获准的本案单消息屏蔽'};
 detail=await g.operatorMessageVisibility(f.reader,{reportId:report.reportId,messageId:message.messageId},hide,{authorize:async()=>f.reader});assert.equal(detail.materials[0].moderation.ownHidden,true);
 await assert.rejects(g.operatorMessageVisibility(f.reader,{reportId:report.reportId,messageId:message.messageId},{...hide,operationId:randomUUID(),expectedVersion:detail.version,expectedRevision:1,action:'restore'},{authorize:async()=>f.reader}),{code:'operations_permission_denied'});
 updated=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),id:role.id,expectedVersion:updated.version,name:role.name,description:role.description,enabled:true,permissions:['chat-reports.read','chat-reports.materials.read','chat-reports.attachments.read']},{authorize:async()=>f.admin})).role;
 assert.deepEqual((await g.operatorAttachment(f.reader,{reportId:report.reportId,attachmentId},{authorize:async()=>f.reader})).bytes,bytes);
 await assert.rejects(g.operatorMessageVisibility(f.reader,{reportId:report.reportId,messageId:message.messageId},hide,{authorize:async()=>f.reader}),{code:'operations_permission_denied'},'stable replay also requires the current action');
 const grant=(await f.permissions.saveAutomation(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'未接通的助手许可',executorKind:'ai',mode:'assisted',enabled:true,permissions:['chat-reports.materials.read','content.read'],resourceIds:[report.reportId]},{authorize:async()=>f.admin})).automation;
 const intersection=await f.permissions.executionIntersection({grantId:grant.id,person:f.reader,actions:['chat-reports.materials.read','accounts.read'],resourceIds:[report.reportId]});assert.deepEqual(intersection.permissions,['chat-reports.materials.read']);assert.equal(intersection.executionAvailable,false);
 await assert.rejects(f.permissions.executionIntersection({grantId:grant.id,person:f.reader,actions:['chat-reports.materials.read'],resourceIds:[randomUUID()]}),{code:'operations_automation_scope_denied'});
});

test('delegated publishing rechecks PG grants after preparation and cannot activate with revoked authority or an unconnected automatic grant',async t=>{
 const f=await fixture(t),role=await f.makeRole(['cms.read','cms.publish']),assignment=await f.assign(role),jobs={onCancel(){},enqueue:async()=>randomUUID()},publications=new ContentPublications({db:f.db,endpoint:f.endpoint,businessAdmin:f.businessAdmin,jobs,now:f.now});
 const snapshot={version:1,settings:{siteTitle:'合成站点',description:'本地发布授权夹具',footerLinks:[]},pages:[],media:[]};
 const requested=await publications.request(f.reader,{operationId:randomUUID(),snapshot});let activated=0,prepared=0;
 const publisher={current:async()=>null,prepare:async()=>{prepared++;await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:role.id,enabled:false},{authorize:async()=>f.admin});return{siteVersion:'synthetic-version'};},activate:async()=>{activated++;}};
 const worker=createContentPublicationWorker({db:f.db,endpoint:f.endpoint,jobs,publisher,businessAdmin:f.businessAdmin,now:f.now});
 await assert.rejects(worker.execute({publicationId:requested.publication.id}),{code:'site_publication_failed'});assert.equal(prepared,1);assert.equal(activated,0);assert.equal((await f.db.query('SELECT state FROM site_publications_v1 WHERE id=$1',[requested.publication.id])).rows[0].state,'failed');
 const automatic=(await f.permissions.saveAutomation(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'程序授权记录',executorKind:'program',mode:'automatic',enabled:true,permissions:['content.read'],resourceIds:[]},{authorize:async()=>f.admin})).automation;assert.equal(automatic.executionAvailable,false);assert.equal(automatic.executionState,'not-connected');
 await assert.rejects(f.permissions.saveAutomation(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'不能自授管理权',executorKind:'ai',mode:'automatic',enabled:true,permissions:['permissions.roles.write'],resourceIds:[]},{authorize:async()=>f.admin}),{code:'operations_automation_human_boundary'});
});

test('revoked delegated notice delivery sends nothing and keeps the original reader attribution instead of inventing administrator authority',async t=>{
 const f=await fixture(t),role=await f.makeRole(['notices.read','notices.create','notices.publish']),assignment=await f.assign(role),jobs={onCancel(){},enqueue:async()=>randomUUID()},notices=new OperationsNotices({db:f.db,endpoint:f.endpoint,businessAdmin:f.businessAdmin,accounts:f.accounts,jobs,now:f.now});
 const {notice}=await notices.create(f.reader,{operationId:randomUUID(),content:{purpose:'maintenance',title:'合成普通服务通知',body:'本地授权回归材料，不作实际发送。',href:'/status/',audience:{kind:'all-accounts'},expiresAt:new Date((f.now()+3600)*1000).toISOString()}});
 await notices.publish(f.reader,notice.id,{operationId:randomUUID(),expectedVersion:notice.version});
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:role.id,enabled:false},{authorize:async()=>f.admin});
 await assert.rejects(createOperationsNoticeWorker({notices}).execute({noticeId:notice.id}),{code:'operations_permission_denied',status:403});
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM account_operations_notices_v1 WHERE notice_id=$1 AND delivered_at IS NOT NULL',[notice.id])).rows[0].n),0);
 const failure=(await f.db.query("SELECT operator_role,result FROM business_admin_audit_v1 WHERE action='notice-delivery' AND selection->>'noticeId'=$1 ORDER BY sequence DESC LIMIT 1",[notice.id])).rows[0];assert.equal(failure.operator_role,'reader');assert.equal(failure.result.deliveredCount,0);
});

test('permission history preserves actual closed deltas without inventing legacy facts or leaking stored prose and scoped intersections reject missing targets',async t=>{
 const {permissionHistoryDeltaLines:lines}=await import(new URL('../../../apps/galaxy-admin/src/lib/permissions-view-model.ts',import.meta.url));
 const f=await fixture(t),secret='PRIVATE_HISTORY_FREE_TEXT_SENTINEL',role=await f.makeRole(['content.read'],secret),assignment=await f.assign(role),auth={authorize:async()=>f.admin};
 const roleUpdate=await f.permissions.saveRole(f.admin,{operationId:randomUUID(),id:role.id,expectedVersion:1,name:role.name,description:secret,enabled:false,permissions:['files.read']},auth);
 let roleHistory=await f.permissions.history(f.admin,{resourceId:role.id});
 assert.deepEqual(roleHistory.items[0].delta,{kind:'role',permissions:{added:['files.read'],removed:['content.read']},enabled:{before:true,after:false}});
 assert.deepEqual(roleHistory.items[1].delta,{kind:'role',permissions:{added:['content.read'],removed:[]},enabled:{before:null,after:true}});
 const visibleRole=lines(roleHistory.items[0],operationsPermissionCatalog);
 assert(visibleRole.find(line=>line.label==='新增权限')?.text.includes(operationsPermissionCatalog.find(item=>item.code==='files.read').label));
 assert(visibleRole.find(line=>line.label==='移除权限')?.text.includes(operationsPermissionCatalog.find(item=>item.code==='content.read').label));
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:1,operatorId:f.reader.operatorId,roleId:role.id,enabled:false},auth);
 const assignmentHistory=await f.permissions.history(f.admin,{resourceId:assignment.id});
 assert.deepEqual(assignmentHistory.items[0].delta,{kind:'assignment',operatorId:f.reader.operatorId,roleId:role.id,enabled:{before:true,after:false}});
 assert.deepEqual(assignmentHistory.items[1].delta.enabled,{before:null,after:true});
 const visibleAssignment=lines(assignmentHistory.items[0],operationsPermissionCatalog,{people:(await f.permissions.personnel(f.admin)).items});
 assert.equal(visibleAssignment.find(line=>line.label==='管理人员').text,'合成管理人员');assert(visibleAssignment.find(line=>line.label==='业务角色').text.includes(role.id.slice(0,8)));assert.equal(visibleAssignment.find(line=>line.label==='角色分配').text,'由已分配改为已撤回');
 const firstTarget=randomUUID(),nextTarget=randomUUID(),grant=await f.permissions.saveAutomation(f.admin,{operationId:randomUUID(),expectedVersion:0,name:secret,executorKind:'program',mode:'automatic',enabled:true,permissions:['content.read'],resourceIds:[firstTarget]},auth);
 await assert.rejects(f.permissions.executionIntersection({grantId:grant.automation.id,actions:['content.read'],resourceIds:[]}),{code:'operations_automation_scope_denied'});
 await assert.rejects(f.permissions.executionIntersection({grantId:grant.automation.id,actions:['content.read']}),{code:'operations_automation_scope_denied'});
 const qualified=await f.permissions.executionIntersection({grantId:grant.automation.id,actions:['content.read'],resourceIds:[firstTarget]});assert.deepEqual(qualified.permissions,['content.read']);assert.equal(qualified.executionAvailable,false);assert.equal(qualified.state,'not-connected');
 await f.permissions.saveAutomation(f.admin,{operationId:randomUUID(),id:grant.automation.id,expectedVersion:1,name:secret,executorKind:'ai',mode:'assisted',enabled:false,permissions:['files.read'],resourceIds:[nextTarget]},auth);
 const automationHistory=await f.permissions.history(f.admin,{resourceId:grant.automation.id});
 assert.deepEqual(automationHistory.items[0].delta,{kind:'automation',permissions:{added:['files.read'],removed:['content.read']},enabled:{before:true,after:false},scope:{before:[firstTarget],after:[nextTarget]},mode:{before:'automatic',after:'assisted'},executorKind:{before:'program',after:'ai'}});
 const scopeLine=lines(automationHistory.items[0],operationsPermissionCatalog).find(line=>line.label==='对象范围');assert(scopeLine.text.includes(firstTarget));assert(scopeLine.text.includes(nextTarget));
 // Explicitly model an older event without a delta and dirty retained JSON;
 // none of this fixture mutation changes production records or invents a past.
 await f.db.query("UPDATE operations_permission_events_v1 SET result=result-'delta' WHERE id=$1",[roleHistory.items[1].id]);
 await f.db.query("UPDATE operations_permission_events_v1 SET result=jsonb_set(result,'{delta,extra}',to_jsonb($2::text)),input=input||jsonb_build_object('note',$2::text),changed_fields=changed_fields||$2::text WHERE id=$1",[roleUpdate.operationId,secret]);
 roleHistory=await f.permissions.history(f.admin,{resourceId:role.id});assert.equal(roleHistory.items[1].delta,null);assert.deepEqual(roleHistory.items[0].delta.permissions,{added:['files.read'],removed:['content.read']});assert.equal(JSON.stringify(roleHistory).includes(secret),false);
 assert.deepEqual(lines(roleHistory.items[1],operationsPermissionCatalog,{roles:[{...role,permissions:['files.read']}]}),[{label:'变更差异',text:'未记录'}]);
 assert.equal(JSON.stringify(lines(roleHistory.items[0],operationsPermissionCatalog)).includes(secret),false);
 await f.db.query("UPDATE operations_permission_events_v1 SET result=jsonb_set(result,'{delta,permissions,added}',jsonb_build_array('files.read',$2::text)) WHERE id=$1",[roleUpdate.operationId,secret]);
 const dirty=await f.permissions.history(f.admin,{resourceId:role.id});assert.equal(dirty.items[0].delta,null);assert.equal(JSON.stringify(dirty).includes(secret),false);
 assert.equal(Object.hasOwn(dirty.items[0],'input'),false);assert.equal(Object.hasOwn(dirty.items[0],'result'),false);
 await f.db.query("UPDATE operations_permission_events_v1 SET result=jsonb_set(result,'{delta,operatorId}',to_jsonb($2::text)) WHERE id=$1",[assignmentHistory.items[0].id,secret]);
 const invalidTarget=await f.permissions.history(f.admin,{resourceId:assignment.id});assert.equal(invalidTarget.items[0].delta,null);assert.equal(JSON.stringify(invalidTarget).includes(secret),false);
});

test('batch-only content grants preview and execute independently of single actions without bypassing current source, CAS or manual actor limits',async t=>{
 const f=await fixture(t),forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),service=new OperationsCommunityService({businessAdmin:f.businessAdmin,forum,governance,now:f.now}).content;
 const batchRole=await f.makeRole(['content.read','content.batch.hide','content.batch.restore']),singleRole=await f.makeRole(['content.read','content.hide','content.restore']);await f.assign(batchRole);await f.assign(singleRole,f.other);
 const audience={read:{kind:'everyone'},participate:{kind:'accounts'}};
 const post=async(extra={})=>{const p=await bindForumIds('create-post','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:f.people[0].accountId,title:'合成批量权限内容',body:'原作者内容保持不变',links:[],topic:'technology',audience,publishedUntil:f.now()+3600,...extra});await forum.publish(f.people[0],{payloadJson:JSON.stringify(p)});return p;};
 const publicPost=await post(),expiring=await post({publishedUntil:f.now()+30}),privatePost=await post({title:'PRIVATE_BATCH_SOURCE_SENTINEL',body:'PRIVATE_BATCH_SOURCE_SENTINEL',audience:{read:{kind:'accounts'},participate:{kind:'accounts'}}}),original=(await f.db.query('SELECT id,payload_text,payload_hash FROM forum_events_v1 ORDER BY id')).rows;
 const initial=await service.list(f.reader,{days:'all'}),item=initial.items.find(row=>row.id===publicPost.postId);
 assert.equal(initial.permissions.canManage,true);assert.equal(item.capabilities.canHide,false);assert.equal(item.capabilities.canBatchHide,true);assert.equal(item.capabilities.canBatchRestore,false);
 const single=(await service.get(f.other,'post',publicPost.postId)).content;assert.equal(single.capabilities.canHide,true);assert.equal(single.capabilities.canBatchHide,false);
 const items=[publicPost,expiring,privatePost].map(p=>({kind:'post',id:p.postId,expectedVersion:1,expectedRevision:0})),preview={kind:'hide',until:f.now()+60,items};
 await assert.rejects(service.preview(f.other,preview),{code:'operations_permission_denied'});
 await assert.rejects(service.batch(f.other,{...preview,operationId:randomUUID(),reason:'单条权限不能用作批量授权'}),{code:'operations_permission_denied'});
 await assert.rejects(service.visibility(f.reader,'post',publicPost.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:0,kind:'hide',until:f.now()+60,reason:'批量权限不能用作单条授权'}),{code:'operations_permission_denied'});
 const plan=await service.preview(f.reader,preview);assert.deepEqual(plan.items.map(row=>row.eligible),[true,true,false]);assert.equal(JSON.stringify(plan).includes('PRIVATE_BATCH_SOURCE_SENTINEL'),false);
 const stale=await service.preview(f.reader,{...preview,items:[{...items[0],expectedVersion:9}]});assert.equal(stale.items[0].eligible,false);assert.equal(stale.items[0].reason,'operations_source_changed');
 const beyond=await service.preview(f.reader,{...preview,until:f.now()+service.maxHideSeconds+1,items:[items[0]]});assert.equal(beyond.items[0].eligible,false);assert.equal(beyond.items[0].reason,'operations_hide_expiry');
 const command={...preview,operationId:randomUUID(),reason:'人工核对本次逐项候选后批量处理'},hidden=await service.batch(f.reader,command);assert.deepEqual(hidden.counts,{applied:2,rejected:1});assert.equal((await forum.getPost(publicPost.postId)).availability,'unavailable');
 const hiddenView=(await service.get(f.reader,'post',publicPost.postId)).content;assert.equal(hiddenView.capabilities.canRestore,false);assert.equal(hiddenView.capabilities.canBatchRestore,true);
 const restore={kind:'restore',items:[{...items[0],expectedRevision:1}]};assert.equal((await service.preview(f.reader,restore)).items[0].eligible,true);assert.equal((await service.batch(f.reader,{...restore,operationId:randomUUID(),reason:'人工复核后解除本批运营下架'})).counts.applied,1);assert.equal((await forum.getPost(publicPost.postId)).availability,'available');
 await service.visibility(f.other,'post',publicPost.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:2,kind:'hide',until:f.now()+60,reason:'已获准的单条下架独立生效'});
 await service.visibility(f.other,'post',publicPost.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:3,kind:'restore',reason:'已获准的单条恢复独立生效'});
 f.advance(31);const expiredRestore={kind:'restore',items:[{...items[1],expectedRevision:1}]};assert.equal((await service.preview(f.reader,expiredRestore)).items[0].eligible,false);const expiredResult=await service.batch(f.reader,{...expiredRestore,operationId:randomUUID(),reason:'来源已过期不能借批量恢复复活'});assert.equal(expiredResult.items[0].status,'rejected');assert.equal(expiredResult.items[0].code,'operations_source_unavailable');
 await assert.rejects(service.batch({...f.reader,kind:'ai-executor',businessAuthorization:{version:'999',permissions:operationsPermissionCodes}},command),{code:'business_admin_denied'});
 await f.permissions.saveRole(f.admin,{operationId:randomUUID(),id:batchRole.id,expectedVersion:1,name:batchRole.name,description:batchRole.description,enabled:false,permissions:batchRole.permissions},{authorize:async()=>f.admin});await assert.rejects(service.batch(f.reader,command),{code:'operations_permission_denied'});
 const after=(await f.db.query('SELECT id,payload_text,payload_hash FROM forum_events_v1 ORDER BY id')).rows;assert.deepEqual(after,original);
});
