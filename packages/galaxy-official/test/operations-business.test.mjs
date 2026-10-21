import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {ForumAttachmentsV1Service} from '../src/forum-attachments-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {OperationsResourcesService} from '../src/operations-resources.mjs';
import {OperationsFilesService} from '../src/operations-files.mjs';
import {dispatchOperationsBusiness} from '../src/adapters/http/operations-business-http.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {serviceFixture} from './service-fixture.mjs';

// SQL, account authority, source permission and domain commands are real. The
// underlying chat fixture explicitly uses RAM transport/store/scanner, and the
// HTTP authorizer below is a contract double, not a Keycloak login assertion.
async function actors(db,endpoint,now){
 const admin={kind:'business-operator',operatorId:'operations-admin',role:'administrator',endpoint,httpRequestId:randomUUID()},reader={...admin,operatorId:'operations-reader',role:'reader'};
 for(const actor of [admin,reader])await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.org',$1,'合成管理人员',$3,$3)`,[actor.operatorId,endpoint,new Date(now()*1000)]);
 return {admin,reader};
}
async function fixture(t){
 const f=await accountChatFixture();t.after(f.close);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),operator=await actors(f.db,f.endpoint,f.now),
  community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),forumFiles=new ForumAttachmentsV1Service({forum,store:f.files.store,scanner:f.files.scanner});
 forum.attachments=forumFiles;
 const files=new OperationsFilesService({businessAdmin,chatAttachments:f.files,forumAttachments:forumFiles,now:f.now});
 return {...f,...operator,forum,governance,community,files,forumFiles,businessAdmin};
}
const audience={read:{kind:'everyone'},participate:{kind:'accounts'}};
async function section(f,owner=f.people[0],extra={}){
 const payload=await bindForumIds('create-section','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),sectionId:randomUUID(),accountId:owner.accountId,expectedVersion:0,title:'成员独立版块',theme:'明确的长期讨论主题',description:'由成员维护的原始说明',audience,...extra});
 await f.forum.sections.save(owner,{payloadJson:JSON.stringify(payload)});return payload;
}
async function post(f,owner=f.people[1],extra={}){
 const payload=await bindForumIds('create-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),accountId:owner.accountId,expectedHeadVersion:0,title:'原作者的帖子',body:'可公开读取的原始内容',links:[],publishedUntil:f.now()+3600,audience,...extra});
 await f.forum.publish(owner,{payloadJson:JSON.stringify(payload)});return payload;
}
async function report(f,p,owner=f.people[0],summary='仅供处理人员读取的具体举报说明'){
 const payload=await bindForumIds('create-report','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),accountId:owner.accountId,target:{kind:'post-version',postId:p.postId,versionId:p.versionId},category:'other',summary});
 await f.governance.report(owner,{payloadJson:JSON.stringify(payload)});return payload;
}

test('operators classify and temporarily hide member sections without rewriting member content or undoing an author archive',async t=>{
 const f=await fixture(t),p=await section(f),input={operationId:randomUUID(),expectedVersion:1,category:'arts',reason:'按实际主题整理全站分类'};
 await assert.rejects(async()=>f.community.classify(f.reader,p.sectionId,input),{code:'business_admin_denied'});
 const classified=await f.community.classify(f.admin,p.sectionId,input);assert.equal(classified.version,2);
 assert.equal((await f.community.classify(f.admin,p.sectionId,input)).replayed,true);
 const stored=(await f.db.query('SELECT * FROM forum_sections_v2 WHERE id=$1',[p.sectionId])).rows[0];assert.equal(stored.title,p.title);assert.equal(stored.description,p.description);
 const event=(await f.db.query('SELECT * FROM forum_section_events_v2 WHERE id=$1',[input.operationId])).rows[0];assert.equal(event.actor_kind,'business-operator');assert.equal(event.subject_id,null);assert.equal(event.account_id,null);assert.equal(event.consent_id,null);
 const hide=await f.community.sectionVisibility(f.admin,p.sectionId,{operationId:randomUUID(),expectedVersion:2,expectedVisibilityVersion:0,kind:'hide',until:f.now()+60,reason:'按具体内容规则暂时限制展示'});
 assert.equal(hide.visibility.hidden,true);await assert.rejects(f.forum.sections.get(null,p.sectionId),{code:'not_found'});
 assert.equal((await f.forum.sections.get(f.people[0],p.sectionId)).canParticipate,false);
 await assert.rejects(post(f,f.people[0],{sectionId:p.sectionId}),{code:'forum_section_participation_denied'});
 const archive=await bindForumIds('update-section','account:'+f.people[0].accountId,{...p,operationId:randomUUID(),expectedVersion:2,state:'archived'});
 await f.forum.sections.save(f.people[0],{payloadJson:JSON.stringify(archive)});
 await assert.rejects(f.community.sectionVisibility(f.admin,p.sectionId,{operationId:randomUUID(),expectedVersion:2,expectedVisibilityVersion:1,kind:'restore',reason:'需要先取得当前对象版本'}),{code:'operations_source_changed'});
 await f.community.sectionVisibility(f.admin,p.sectionId,{operationId:randomUUID(),expectedVersion:3,expectedVisibilityVersion:1,kind:'restore',reason:'复核后解除这一层运营限制'});
 const restored=await f.forum.sections.get(null,p.sectionId);assert.equal(restored.state,'archived');assert.equal(restored.canParticipate,false);
 const audit=await f.businessAdmin.audit(f.reader);assert.equal(audit.items.some(row=>row.selection.resourceId===p.sectionId&&row.action==='community-section-classify'),true);
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM subjects')).rows[0].n),0);
});

test('new Cookie reports disclose only current case narrative; old private permits remain private and operator decisions return to original appeals',async t=>{
 const f=await fixture(t),p=await post(f),r=await report(f,p),legacy=await report(f,await post(f),f.people[0],'旧Private许可的说明不能扩给新管理角色');
 await f.db.query('UPDATE forum_reports_v1 SET operations_disclosed=false WHERE id=$1',[legacy.reportId]);
 const view=await f.community.report(f.reader,r.reportId);assert.equal(view.operationsDisclosed,true);assert.equal(view.events[0].summary,r.summary);assert.equal(view.source.availability,'available');
 const own=await f.governance.get(f.people[0],r.reportId);assert.equal(own.operationsHandling,true);assert.equal(own.operationsDisclosure,'仅发送给运营处理人员');
 const old=await f.community.report(f.admin,legacy.reportId);assert.equal(old.events.length,0);assert.equal(JSON.stringify(old).includes('旧Private许可'),false);
 const oldOwn=await f.governance.get(f.people[0],legacy.reportId);assert.equal(oldOwn.operationsHandling,false);assert.equal(Object.hasOwn(oldOwn,'operationsDisclosure'),false);
 const input={operationId:randomUUID(),expectedVersion:1,resolution:'accepted',summary:'按具体内容规则接受本案并暂时隐藏',hideUntil:f.now()+60};
 await assert.rejects(async()=>f.community.resolve(f.reader,r.reportId,input),{code:'business_admin_denied'});
 const decided=await f.community.resolve(f.admin,r.reportId,input);assert.equal(decided.version,2);
 assert.equal((await f.community.resolve(f.admin,r.reportId,input)).replayed,true);
 assert.equal((await f.forum.getPost(p.postId)).availability,'unavailable');
 const party=await f.governance.get(f.people[0],r.reportId);assert.equal(party.canAppeal,true);assert.equal(party.decisionLocator.operationId,input.operationId);
 assert.equal(party.events.at(-1).author.kind,'business-operator');assert.equal(party.events.at(-1).payload.reason,input.summary);
 const appeal=await bindForumIds('appeal','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),accountId:f.people[0].accountId,governanceEventId:randomUUID(),reportId:r.reportId,expectedReportVersion:2,kind:'appeal',summary:'本人补充说明并请求重新处理'});
 await f.governance.event(f.people[0],r.reportId,{payloadJson:JSON.stringify(appeal)});
 await assert.rejects(f.community.resolve(f.admin,r.reportId,{...input,operationId:randomUUID()}),{code:'forum_report_version_conflict'});
 await f.community.resolve(f.admin,r.reportId,{operationId:randomUUID(),expectedVersion:3,resolution:'dismissed',summary:'复核当前材料后解除原隐藏'});
 assert.equal((await f.forum.getPost(p.postId)).availability,'available');
 assert.equal((await f.db.query('SELECT subject_id FROM forum_events_v1 WHERE id=$1',[p.operationId])).rows[0].subject_id,null);
});

test('case conflicts follow known issuer and subject relationships, not an equal subject string from the separate management realm',async t=>{
 const f=await fixture(t),r=await report(f,await post(f));
 await f.db.query("UPDATE operations_operator_principals_v1 SET external_subject='synthetic-0' WHERE operator_id=$1",[f.admin.operatorId]);
 assert.equal((await f.community.report(f.admin,r.reportId)).canModerate,true);
 await f.db.query("UPDATE operations_operator_principals_v1 SET issuer='https://login.example.org' WHERE operator_id=$1",[f.admin.operatorId]);
 const view=await f.community.report(f.admin,r.reportId);assert.equal(view.canModerate,false);assert.equal(view.knownPartyConflict,true);assert.equal(view.events.length,0);
 await assert.rejects(f.community.resolve(f.admin,r.reportId,{operationId:randomUUID(),expectedVersion:1,resolution:'dismissed',summary:'已知当事者不能自行处理本案'}),{code:'forum_independent_handler_required'});
 await assert.rejects(f.community.report({...f.admin,operatorId:'missing-principal'},r.reportId),{code:'business_admin_denied'});
});

test('file operations reschedule bounded processing, never read private bytes or revive available, revoked or erased files; mixed-source paging is stable',async t=>{
 const f=await fixture(t),owner=f.people[0],roomId=await joinAccountConversation(f,owner,f.people[1]),bytes=Buffer.from('本地选中的真实附件'),id=randomUUID();
 await f.files.chatAttachments.prepare(owner,{attachmentId:id,roomId,name:'私密文件名称.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes),purpose:'temporary-room-attachment',confirmed:true});
 await f.files.chatAttachments.upload(owner,id,Readable.from([bytes]),{contentLength:bytes.length});
 const scan=f.files.chatAttachments.scanner.scan;f.files.chatAttachments.scanner.scan=async()=>{throw new ServiceError('attachment_scan_unavailable',503);};
 await f.files.chatAttachments.scanPending();f.files.chatAttachments.scanner.scan=scan;
 const current=await f.files.get(f.admin,'chat',id);assert.equal(current.canRetryScan,true);assert.equal(current.contentAvailable,false);assert.equal(JSON.stringify(current).includes('私密文件名称'),false);assert.equal(Object.hasOwn(current,'storage_key'),false);
 const input={operationId:randomUUID(),kind:'scan',expectedVersion:current.version,reason:'扫描服务恢复后重试这一个文件'};
 await assert.rejects(async()=>f.files.retry(f.reader,'chat',id,input),{code:'business_admin_denied'});
 const accepted=await f.files.retry(f.admin,'chat',id,input);assert.equal(accepted.state,'scheduled');assert.equal(accepted.processingComplete,false);assert.equal(accepted.file.retriesRemaining,2);
 assert.equal((await f.files.retry(f.admin,'chat',id,input)).replayed,true);
 await assert.rejects(f.files.retry(f.admin,'chat',id,{...input,reason:'同操作不能替换原意图'}),{code:'business_admin_operation_conflict'});
 await f.files.chatAttachments.scanPending();const available=await f.files.get(f.admin,'chat',id);assert.equal(available.state,'available');assert.equal(available.canRetryScan,false);
 await assert.rejects(f.files.retry(f.admin,'chat',id,{...input,operationId:randomUUID(),expectedVersion:available.version}),{code:'operations_file_retry_unavailable'});
 await f.files.chatAttachments.revoke(owner,{attachmentId:id});
 const erase=f.files.chatAttachments.store.erase;f.files.chatAttachments.store.erase=async()=>{throw Error('private-object-key-must-not-be-returned');};
 await assert.rejects(f.files.chatAttachments.purgeExpired());f.files.chatAttachments.store.erase=erase;
 const cleanup=await f.files.get(f.admin,'chat',id);assert.equal(cleanup.lastError,'attachment_cleanup_failed');assert.equal(cleanup.canRetryCleanup,true);assert.equal(JSON.stringify(cleanup).includes('private-object-key'),false);
 await f.files.retry(f.admin,'chat',id,{operationId:randomUUID(),kind:'cleanup',expectedVersion:cleanup.version,reason:'存储服务恢复后继续原清理'});
 await f.files.chatAttachments.purgeExpired();assert.equal((await f.files.get(f.admin,'chat',id)).state,'erased');
 await f.forumFiles.prepare(owner,{attachmentId:id,name:'另一个论坛草稿文件.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)});
 const page=await f.files.list(f.reader,{limit:1});assert.equal(page.items[0].kind,'chat');assert.ok(page.nextAfter);
 const next=await f.files.list(f.reader,{limit:1,after:page.nextAfter});assert.equal(next.items[0].kind,'forum');assert.equal(next.nextAfter,null);
 assert.equal((await f.community.summary(f.reader)).files.cleanupFailed,0);
});

test('projects use current public source reads; operator visibility preserves author history and cannot restore a revoked source',async t=>{
 const f=await communityForumFixture();t.after(f.close);await f.login(f.owner,'project-source-author');
 const now=()=>f.clock.now,{admin,reader}=await actors(f.db,f.owner.access.endpoint,now),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.owner.access.endpoint,now}),
  resources=new OperationsResourcesService({businessAdmin,projects:f.owner.projects,capsules:f.owner.capsules.v2,maxHideSeconds:f.forum.policy.maxGovernanceHideSeconds,now});
 const id=randomUUID(),event={operationId:randomUUID(),projectId:id,expectedRevision:0,kind:'create',document:{kind:'module',title:'原作者的项目',summary:'本人发布的项目说明',functions:['research'],technologies:[],discoverable:true}},
  grant=await f.owner.authorize(event,'project.write',{objectId:event.operationId,visibility:'Public',purpose:'public-profile'});
 await f.owner.projects.submit(f.owner.actor,grant);
 const before=(await f.db.query('SELECT payload_text FROM project_events_v2 WHERE operation_id=$1',[event.operationId])).rows[0].payload_text;
 const detail=await resources.get(reader,'projects',id);assert.equal(detail.title,event.document.title);assert.equal(detail.privateMaterialsGranted,false);
 const input={operationId:randomUUID(),kind:'hide',expectedVersion:1,expectedVisibilityVersion:0,until:now()+60,reason:'按当前内容规则暂时隐藏公开展示'};
 await assert.rejects(async()=>resources.visibility(reader,'projects',id,input),{code:'business_admin_denied'});
 await resources.visibility(admin,'projects',id,input);
 await assert.rejects(f.owner.projects.get(null,id),{code:'project_not_found'});assert.equal((await f.owner.projects.get(f.owner.actor,id)).operationsVisibility.hidden,true);
 assert.equal((await f.owner.projects.publicPortfolio(null,{ownerId:f.owner.actor.subjectId})).items.length,0);
 await f.owner.consents.revoke(f.owner.actor,grant.consentId);
 await resources.visibility(admin,'projects',id,{operationId:randomUUID(),kind:'restore',expectedVersion:1,expectedVisibilityVersion:1,reason:'只解除运营限制并重核原许可'});
 await assert.rejects(f.owner.projects.get(null,id));assert.equal((await resources.get(reader,'projects',id)).sourceState,'unavailable');
 assert.equal((await f.db.query('SELECT payload_text FROM project_events_v2 WHERE operation_id=$1',[event.operationId])).rows[0].payload_text,before);
});

test('method moderation affects both reading protocols and search, while restoring never removes the author deprecation',async t=>{
 const f=await serviceFixture(['binding','consent','case-teaser','capsules','history']);t.after(()=>f.db.close());
 const now=()=>f.now,{admin,reader}=await actors(f.db,f.access.endpoint,now),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.access.endpoint,now}),
  resources=new OperationsResourcesService({businessAdmin,projects:f.projects,capsules:f.capsules.v2,maxHideSeconds:86400,now});
 const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,localRef:randomUUID(),title:'合成来源',summary:'实际签名的合成流程',source:{kind:'local',reference:randomUUID()},synthetic:true};
 const put=async value=>f.cases.submitV2(f.actor,await f.authorize(value,'case.teaser.publish',{objectId:value.eventId}));await put(root);
 const attempt={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId:id,expectedVersion:1,actorId:f.actor.subjectId,role:'implementation',strategy:'按明确范围执行',inputScopeSummary:'合成测试资料',permissionScope:['selected-context'],environment:{name:'Node',version:'24'}};await put(attempt);
 const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId:id,expectedVersion:2,actorId:f.actor.subjectId,origin:{kind:'attempt',id:attempt.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'succeeded',summary:'有来源的合成结果',limitations:'仅验证业务实现'};await put(result);
 const version={schemaVersion:2,id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,publicationClass:'formal-source-success',synthetic:true,
  title:'已发布的具体方法',problemPattern:'明确的问题模式',environment:{name:'Node',version:'24'},solutionStrategy:'具体可复用方法',tools:[],skills:[],mcpRefs:[],verificationMethod:'引用本人的具体结果',limitations:['合成流程'],capabilityId:'software-debugging',applicableScope:'此合成测试范围',license:'MIT',contributors:[],
  sourceResolution:{caseId:id,resultId:result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},sourceRefs:[],permissionRefs:[],attributionRefs:[],externalReferences:[],redactionConfirmed:true};
 await f.capsules.publishV2(f.actor,await f.authorize(version,'capsule.publish',{visibility:'Public',purpose:'public-profile'}));
 assert.equal((await resources.get(reader,'methods',version.capsuleId)).title,version.title);
 await resources.visibility(admin,'methods',version.capsuleId,{operationId:randomUUID(),kind:'hide',expectedVersion:1,expectedVisibilityVersion:0,until:now()+60,reason:'对当前公开方法暂时隐藏展示'});
 await assert.rejects(f.capsules.getV2(null,{capsuleId:version.capsuleId}),{code:'capsule_unavailable'});
 await assert.rejects(f.capsules.get(null,{capsuleId:version.capsuleId}),{code:'capsule_unavailable'});
 assert.equal((await f.search.v2.query(null,{type:'capsule',query:{query:version.title}})).items.length,0);
 assert.equal((await f.capsules.getV2(f.actor,{capsuleId:version.capsuleId})).version.title,version.title);
 const notice={schemaVersion:2,id:randomUUID(),kind:'deprecate',capsuleId:version.capsuleId,versionId:version.id,expectedRevision:1,summary:'作者自己停止推荐此方法'};
 await f.capsules.publishV2(f.actor,await f.authorize(notice,'capsule.publish',{visibility:'Public',purpose:'public-profile'}));
 await resources.visibility(admin,'methods',version.capsuleId,{operationId:randomUUID(),kind:'restore',expectedVersion:2,expectedVisibilityVersion:1,reason:'只解除运营展示限制'});
 assert.equal((await f.capsules.getV2(null,{capsuleId:version.capsuleId})).deprecated,true);
});

test('operations HTTP obtains fresh server authority, rejects forged JSON roles and exposes real summary counts',async t=>{
 const f=await fixture(t);await report(f,await post(f));const calls=[];
 async function dispatch(method,path,input,authorizeOperator){const request=Object.assign(Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]),{method,headers:{'content-type':'application/json'}});let response;
  const handled=await dispatchOperationsBusiness({operationsCommunity:f.community,operationsFiles:f.files,authorizeOperator,request,requestId:randomUUID(),url:new URL(path,f.endpoint),send:(status,body)=>{response={status,body};}});return{handled,response};}
 const authorize=async(_request,context)=>{calls.push(context);return f.reader;};
 const summary=await dispatch('GET','/v1/operations/summary',null,authorize);assert.equal(summary.handled,true);assert.equal(summary.response.body.communityReports.pending,1);
 const p=await section(f);await assert.rejects(dispatch('POST','/v1/operations/community/sections/'+p.sectionId+'/classification',{role:'administrator',operationId:randomUUID(),expectedVersion:1,category:'arts',reason:'客户端伪造角色没有效力'},authorize),{code:'business_admin_denied'});
 assert.equal(calls.at(-1).write,true);assert.equal((await f.community.section(f.reader,p.sectionId)).category,'unclassified');
 await assert.rejects(dispatch('GET','/v1/operations/summary',null,async()=>{throw new ServiceError('operator_login_required',401);}),{code:'operator_login_required'});
 await assert.rejects(dispatch('GET','/v1/operations/files?storageKey=private',null,authorize),{code:'invalid_operations_request'});
 assert.equal((await dispatch('GET','/v1/operations/files/chat/'+randomUUID()+'/content',null,authorize)).handled,false,'no arbitrary private-content admin endpoint exists');
});
