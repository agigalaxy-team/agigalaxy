import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {CommunityForumGovernanceV1} from "../src/community/community-forum-governance-v1.mjs";
import {OperationsCommunityService} from "../src/operations/community/service.mjs";
import {OperationsForumContentService} from '../src/operations/public-content/service.mjs';
import {ForumAttachmentsV1Service} from "../src/community/forum-attachments-v1.mjs";
import {ReadingBookmarksV1} from "../src/accounts/reading-bookmarks-v1.mjs";
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {createApi} from '../src/http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

async function operator(db,endpoint,now,role='administrator'){const actor={kind:'business-operator',operatorId:'content-synthetic-'+role,role,endpoint};
 await db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.example.org',$1,'合成运营人员',$3,$3)`,[actor.operatorId,endpoint,new Date(now()*1000)]);return actor;
}
async function contentOperators(db,endpoint,now){
 const admin=await operator(db,endpoint,now),reader=await operator(db,endpoint,now,'reader'),roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 const permissions=new OperationsPermissionsService({db,endpoint,now,operatorAuthorization:async actor=>roles.get(actor.operatorId)??null});
 const options={authorize:async()=>admin},role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'合成公开内容只读',description:'仅当前公开内容及审计读取',enabled:true,permissions:['content.read','content.tags.read','audit.read']},options)).role;
 await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},options);
 return {admin,reader,businessAdmin:new BusinessAdminService({db,endpoint,now,permissions})};
}
const everyone={read:{kind:'everyone'},participate:{kind:'accounts'}};

test('public content curation, finite visibility and batches act on real reads, replies, attachments and references without editing signed content',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),
  {businessAdmin,admin,reader}=await contentOperators(f.db,f.endpoint,f.now),
  community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),service=community.content,
  files=new ForumAttachmentsV1Service({forum,store:f.files.store,scanner:f.files.scanner});forum.attachments=files;
 const owner=f.people[0],responder=f.people[1],bytes=Buffer.from('A small clean synthetic forum attachment.');
 async function attachment(who){const attachmentId=randomUUID();await files.prepare(who,{attachmentId,name:'合成附件.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)});
  await files.upload(who,attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await files.scanPending();return {id:attachmentId,sha256:f.digest(bytes)};}
 const parentFile=await attachment(owner),replyFile=await attachment(responder);
 async function post(who=owner,extra={}){const x=await bindForumIds(extra.expectedHeadVersion?'publish-version':'create-post','account:'+who.accountId,
  {schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:who.accountId,title:'真实公开内容',body:'PUBLIC_BODY_FOR_CONTENT_READING',links:[],topic:'technology',audience:everyone,publishedUntil:f.now()+3600,...extra});
  await forum.publish(who,{payloadJson:JSON.stringify(x)});return x;}
 const parent=await post(owner,{attachments:[parentFile]}),expiring=await post(responder,{publishedUntil:f.now()+30}),
  privatePost=await post(owner,{audience:{read:{kind:'accounts'},participate:{kind:'accounts'}},title:'PRIVATE_NOT_IN_PUBLIC_OPERATIONS',body:'PRIVATE_NOT_IN_PUBLIC_OPERATIONS'}),
  reply=await bindForumIds('create-reply','account:'+responder.accountId,{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),expectedRevision:0,accountId:responder.accountId,
   postId:parent.postId,postVersionId:parent.versionId,replyTo:null,body:'公开回复正文',publishedUntil:f.now()+3600,audience:everyone,attachments:[replyFile]});
 await forum.createReply(responder,{payloadJson:JSON.stringify(reply)});
 const original=(await f.db.query('SELECT id,payload_text,payload_hash FROM forum_events_v1 ORDER BY id')).rows;
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const initial=await service.list(reader,{days:'all'});assert.equal(initial.summary.total,3);assert.equal(initial.summary.pendingReview,null);
 assert.equal(initial.items.some(item=>item.kind==='reply'&&item.id===reply.replyId),true);assert.equal(JSON.stringify(initial).includes('PRIVATE_NOT_IN_PUBLIC_OPERATIONS'),false);
 await assert.rejects(service.get(reader,'post',privatePost.postId),{code:'not_found'});
 const tagInput={operationId:randomUUID(),name:'操作记录'},tag=await service.tag(admin,null,tagInput);
 assert.equal((await service.tag(admin,null,tagInput)).replayed,true);await assert.rejects(service.tag(admin,null,{operationId:randomUUID(),name:'操作记录'}),{code:'operations_tag_exists'});
 await assert.rejects(service.tag(reader,null,{operationId:randomUUID(),name:'reader cannot add'}),{code:'operations_permission_denied'});
 const curate={operationId:randomUUID(),expectedVersion:1,expectedRevision:0,topic:'arts',pinned:true,featured:true,tagIds:[tag.tag.id],reason:'按公开主题进行人工编排'};
 const edited=await service.curate(admin,'post',parent.postId,curate);assert.equal(edited.content.curation.revision,1);assert.equal(edited.content.originalTopic,'technology');
 assert.equal(edited.content.topic,'arts');assert.equal(edited.content.curation.publicPlacement,'not-connected');assert.equal((await service.curate(admin,'post',parent.postId,curate)).replayed,true);
 const current=await forum.getPost(parent.postId);assert.equal(current.payload.topic,'technology');assert.equal(current.topic,'arts');assert.equal(current.operatorCuration.tags[0].name,'操作记录');
 assert.equal((await forum.query({topic:'arts'})).items.some(item=>item.locator.postId===parent.postId),true);
 assert.equal((await forum.query({topic:'technology'})).items.some(item=>item.locator.postId===parent.postId),false);
 const parentSource={attachmentId:parentFile.id,source:{postId:parent.postId,versionId:parent.versionId}},replySource={attachmentId:replyFile.id,source:{replyId:reply.replyId}};
 assert.deepEqual((await files.content(null,parentSource)).bytes,bytes);assert.deepEqual((await files.content(null,replySource)).bytes,bytes);
 const attachmentDetail=(await service.get(reader,'reply',reply.replyId)).content.attachments[0];assert.equal(attachmentDetail.id,replyFile.id);assert.equal(attachmentDetail.availability,'available');assert.ok(attachmentDetail.contentPath.endsWith('/attachments/'+replyFile.id+'/content'));
 const readAuthorization={authorize:async()=>reader};
 assert.deepEqual((await service.attachmentContent(reader,'reply',reply.replyId,replyFile.id,readAuthorization)).bytes,bytes);
 await assert.rejects(service.attachmentContent(reader,'reply',reply.replyId,parentFile.id,readAuthorization),{code:'attachment_source_unavailable'});
 const bookmarkReader=new ReadingBookmarksV1(f.access,{forum}),reference={kind:'forum-post',postId:parent.postId};
 assert.equal((await bookmarkReader.sourceWithin(f.db,null,reference)).state,'available');
 const hide={operationId:randomUUID(),expectedVersion:1,expectedRevision:0,kind:'hide',until:f.now()+60,reason:'人工核对后临时下架'};
 await service.visibility(admin,'post',parent.postId,hide);assert.equal((await service.visibility(admin,'post',parent.postId,hide)).replayed,true);
 assert.equal((await forum.getPost(parent.postId)).availability,'unavailable');assert.equal((await forum.getReply(reply.replyId)).availability,'unavailable');
 assert.equal((await forum.replies({postId:parent.postId,postVersionId:parent.versionId})).items.length,0);
 assert.equal((await forum.query()).items.some(item=>item.locator.postId===parent.postId),false);
 assert.equal((await forum.publicForAccount(owner.accountId)).items.some(item=>item.locator.postId===parent.postId),false);
 assert.equal((await bookmarkReader.sourceWithin(f.db,null,reference)).state,'unavailable');
 await assert.rejects(files.content(null,parentSource),{code:'attachment_source_unavailable'});await assert.rejects(files.content(null,replySource),{code:'attachment_source_unavailable'});
 assert.equal((await service.get(reader,'reply',reply.replyId)).content.visibility.inheritedHidden,true);
 const hiddenSummary=(await service.list(reader,{days:'all'})).summary;assert.equal(hiddenSummary.hidden,2);assert.equal(hiddenSummary.daily.reduce((sum,day)=>sum+day.posts+day.replies,0),1,'the public trend excludes both a hidden parent and its reply');
 assert.equal((await service.get(reader,'reply',reply.replyId)).content.attachments[0].contentPath,null);
 await assert.rejects(service.attachmentContent(reader,'reply',reply.replyId,replyFile.id,readAuthorization),{code:'attachment_source_unavailable'});
 const restore={operationId:randomUUID(),expectedVersion:1,expectedRevision:1,kind:'restore',reason:'人工复核后移除本次下架'};
 await service.visibility(admin,'post',parent.postId,restore);assert.equal((await forum.getReply(reply.replyId)).availability,'available');assert.deepEqual((await files.content(null,replySource)).bytes,bytes);
 const preview={kind:'hide',until:f.now()+50,items:[{kind:'post',id:expiring.postId,expectedVersion:1,expectedRevision:0},{kind:'post',id:privatePost.postId,expectedVersion:1,expectedRevision:0}]};
 const plan=await service.preview(admin,preview);assert.equal(plan.items[0].eligible,true);assert.equal(plan.items[1].eligible,false);
 const batch={...preview,operationId:randomUUID(),reason:'人工核对这一组具体对象'},result=await service.batch(admin,batch);
 assert.deepEqual(result.counts,{applied:1,rejected:1});assert.equal((await service.batch(admin,batch)).replayed,true);
 f.advance(31);await assert.rejects(service.visibility(admin,'post',expiring.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,kind:'restore',reason:'已到期的来源不能被恢复'}),{code:'operations_source_unavailable'});
 const next=await post(owner,{postId:parent.postId,expectedHeadVersion:1});
 assert.equal((await service.get(reader,'post',parent.postId)).content.curation.appliesToCurrent,false);assert.equal((await forum.getPost(parent.postId)).topic,'technology');
 assert.equal((await forum.getPost(parent.postId)).payload.body,next.body);
 const after=(await f.db.query('SELECT id,payload_text,payload_hash FROM forum_events_v1 WHERE id=ANY($1::uuid[]) ORDER BY id',[original.map(row=>row.id)])).rows;
 assert.deepEqual(after,original);await assert.rejects(f.db.query('UPDATE forum_events_v1 SET payload_text=$1',["rewritten"]),/permission denied/);
 const audit=JSON.stringify(await businessAdmin.audit(reader,{limit:100}));assert.equal(audit.includes('人工核对'),false);assert.equal(audit.includes('reasonDigest'),false);
 const origin='https://admin.example.org',server=createApi({bindings:{endpoint:f.endpoint},operations:{portal:{authorizeOperator:async(request,{write,csrf})=>{
  if(request.headers.origin!==origin||(write||csrf)&&request.headers['x-synthetic-csrf']!=='yes')throw new ServiceError('business_admin_denied',403);return request.headers['x-synthetic-reader']==='true'?reader:admin;
 }}},operationsCommunity:community,browserOrigins:[origin],rateLimit:250});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,headers={Origin:origin,'Content-Type':'application/json','X-Synthetic-CSRF':'yes'};
 const list=await fetch(base+'/v1/operations/community/content?days=all&kind=post&topic=technology&pinned=false&featured=false',{headers});assert.equal(list.status,200);assert.ok((await list.json()).items.length);
 const detail=await fetch(base+'/v1/operations/community/content/reply/'+reply.replyId+'?historyAfter=999999',{headers});assert.equal(detail.status,200);await detail.arrayBuffer();
 const filePath=base+'/v1/operations/community/content/reply/'+reply.replyId+'/attachments/'+replyFile.id+'/content';
 const binary=await fetch(filePath,{method:'POST',headers:{...headers,'X-Synthetic-Reader':'true'},body:'{}'});assert.equal(binary.status,200);assert.deepEqual(Buffer.from(await binary.arrayBuffer()),bytes);assert.equal(binary.headers.get('content-type'),'application/octet-stream');
 const noCsrf=await fetch(filePath,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Synthetic-Reader':'true'},body:'{}'});assert.equal(noCsrf.status,403);await noCsrf.arrayBuffer();
 const nonEmpty=await fetch(filePath,{method:'POST',headers,body:'{"body":"not allowed"}'});assert.equal(nonEmpty.status,400);await nonEmpty.arrayBuffer();
 const denied=await fetch(base+'/v1/operations/community/tags',{method:'POST',headers:{...headers,'X-Synthetic-Reader':'true'},body:JSON.stringify({operationId:randomUUID(),name:'No'})});assert.equal(denied.status,403);await denied.arrayBuffer();
 const duplicate=await fetch(base+'/v1/operations/community/content?days=7&days=28',{headers});assert.equal(duplicate.status,400);await duplicate.arrayBuffer();
 const withdrawOld=await bindForumIds('withdraw-version','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:parent.postId,versionId:parent.versionId,expectedHeadVersion:2});
 await forum.withdraw(owner,'withdraw-version',{payloadJson:JSON.stringify(withdrawOld)});
 await service.curate(admin,'post',parent.postId,{operationId:randomUUID(),expectedVersion:3,expectedRevision:1,topic:'arts',reason:'在当前头版本重新核对编排'});
 assert.equal((await forum.getPost(parent.postId)).topic,'arts');assert.equal((await forum.getVersion(parent.postId,next.versionId)).topic,'arts');
 assert.equal((await forum.query({topic:'arts'})).items.some(item=>item.locator.postId===parent.postId),true,'topic candidates and current source reads use the same head revision after an old-version withdrawal');
 await f.db.exec('RESET ROLE');
});

test('valid subject-only signed forum sources remain manageable under their exact service endpoint without invented accounts',{timeout:60000},async t=>{
 const f=await communityForumFixture();t.after(f.close);await f.login(f.owner,'legacy-signed-owner');await f.login(f.responder,'legacy-signed-responder');
 const post=await f.post({topic:'technology'});assert.equal((await f.write(f.owner,'create-post',post)).status,200);
 const reply=await f.reply(post);assert.equal((await f.write(f.responder,'create-reply',reply)).status,200);
 const withdrawn=await f.post({topic:'life',title:'RETAINED_LEGACY_WITHDRAWN_TITLE'});assert.equal((await f.write(f.owner,'create-post',withdrawn)).status,200);
 const withdrawal={schemaVersion:1,operationId:randomUUID(),postId:withdrawn.postId,expectedHeadVersion:1},withdrawalResult=await f.write(f.owner,'withdraw-post',withdrawal);
 assert.equal(withdrawalResult.status,200,JSON.stringify(withdrawalResult.body));
 // Reproduce the schema's supported historical shape while retaining real
 // signed payloads, Consents, endpoint/recipient and current control evidence.
 // The current writer's account-selection/owner check does not support a
 // NULL-account historical row; that separate control-path gap must not be
 // bypassed by changing identity authority in this directory regression.
 await f.db.query('UPDATE forum_posts_v1 SET account_id=NULL WHERE id=ANY($1::uuid[])',[[post.postId,withdrawn.postId]]);
 await f.db.query('UPDATE forum_versions_v1 SET account_id=NULL WHERE id=ANY($1::uuid[])',[[post.versionId,withdrawn.versionId]]);
 await f.db.query('UPDATE forum_replies_v1 SET account_id=NULL WHERE id=$1',[reply.replyId]);
 await f.db.query('UPDATE forum_events_v1 SET account_id=NULL WHERE id=ANY($1::uuid[])',[[post.operationId,reply.operationId,withdrawn.operationId,withdrawal.operationId]]);
 await f.db.query('UPDATE forum_permissions_v1 SET account_id=NULL WHERE event_id=ANY($1::uuid[])',[[post.operationId,reply.operationId,withdrawn.operationId,withdrawal.operationId]]);
 const now=()=>f.clock.now,endpoint=f.owner.access.endpoint,{admin,businessAdmin}=await contentOperators(f.db,endpoint,now),service=new OperationsForumContentService({businessAdmin,forum:f.forum,now});
 assert.equal((await f.forum.getPost(post.postId)).availability,'available');assert.equal((await f.forum.getReply(reply.replyId)).availability,'available');
 const page=await service.list(admin,{days:'all'});assert.equal(page.summary.total,3);assert.equal(page.summary.unavailable,1);
 const legacy=page.items.find(item=>item.id===post.postId);assert.equal(legacy.author.accountId,null);assert.equal(legacy.author.uid,null);assert.equal(legacy.author.subjectId,f.owner.actor.subjectId);
 await service.visibility(admin,'post',post.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:0,kind:'hide',until:now()+60,reason:'按原生来源临时下架'});
 assert.equal((await f.forum.getReply(reply.replyId)).availability,'unavailable');
 await service.visibility(admin,'post',post.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,kind:'restore',reason:'原来源许可仍然有效'});
 assert.equal((await f.forum.getPost(post.postId)).availability,'available');
 const retained=(await service.list(admin,{days:'all',visibility:'unavailable'})).items;
 assert.equal(retained.length,1);assert.equal(retained[0].id,withdrawn.postId);assert.equal(retained[0].versionId,null);
 assert.equal(retained[0].title,null);assert.deepEqual(retained[0].author,{accountId:null,uid:null,displayName:null,subjectId:null});
 assert.equal((await service.get(admin,'post',withdrawn.postId)).content.body,null);
 assert.equal((await service.list(admin,{days:'all',query:withdrawn.title})).items.length,0);
 const foreign=new OperationsForumContentService({businessAdmin:new BusinessAdminService({db:f.db,endpoint:'https://foreign.example.org',now,permissions:businessAdmin.permissions}),forum:f.forum,now}),foreignActor={...admin,endpoint:'https://foreign.example.org'};
 await assert.rejects(foreign.get(foreignActor,'post',post.postId),{code:'business_admin_denied'});
 await assert.rejects(foreign.rawWithin(f.db,'post',post.postId),{code:'not_found'});
});

test('reply operations never project retained parent titles or categories after parent withdrawal, expiry or audience loss',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),{businessAdmin,admin,reader}=await contentOperators(f.db,f.endpoint,f.now),
  service=new OperationsForumContentService({businessAdmin,forum,now:f.now}),owner=f.people[0],responder=f.people[1];
 async function pair(title,extra={}){
  const parent=await bindForumIds('create-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,
   accountId:owner.accountId,title,body:'父来源仍由原许可控制的正文',links:[],topic:'technology',audience:everyone,publishedUntil:f.now()+3600,...extra});
  await forum.publish(owner,{payloadJson:JSON.stringify(parent)});
  const reply=await bindForumIds('create-reply','account:'+responder.accountId,{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),expectedRevision:0,accountId:responder.accountId,
   postId:parent.postId,postVersionId:parent.versionId,replyTo:null,body:'本回复自己的有效正文',publishedUntil:f.now()+3600,audience:everyone});
  await forum.createReply(responder,{payloadJson:JSON.stringify(reply)});return {parent,reply};
 }
 const withdrawn=await pair('WITHDRAWN_PARENT_TITLE_MUST_STOP'),expiring=await pair('EXPIRED_PARENT_TITLE_MUST_STOP',{topic:'life',publishedUntil:f.now()+30}),
  section=await bindForumIds('create-section','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),sectionId:randomUUID(),accountId:owner.accountId,expectedVersion:0,
   title:'原本公开的长期版块',theme:'真实受众变化',description:'用于验证受众权限的合成来源',audience:everyone});
 await forum.sections.save(owner,{payloadJson:JSON.stringify(section)});
 const restricted=await pair('RESTRICTED_PARENT_TITLE_MUST_STOP',{sectionId:section.sectionId,topic:'galaxy'});
 for(const value of [withdrawn,expiring,restricted]){const view=(await service.get(reader,'reply',value.reply.replyId)).content;assert.equal(view.title,value.parent.title);assert.equal(view.originalTopic,value.parent.topic);}
 await service.curate(admin,'reply',withdrawn.reply.replyId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:0,topic:'arts',reason:'本回复自身的人工分类保留'});
 const withdrawal=await bindForumIds('withdraw-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:withdrawn.parent.postId,expectedHeadVersion:1});
 await forum.withdraw(owner,'withdraw-post',{payloadJson:JSON.stringify(withdrawal)});
 const afterWithdrawal=(await service.get(reader,'reply',withdrawn.reply.replyId)).content;
 assert.equal((await forum.getReply(withdrawn.reply.replyId)).availability,'available','parent withdrawal does not revoke the independent reply');
 assert.equal(afterWithdrawal.sourceState,'available');assert.equal(afterWithdrawal.body,withdrawn.reply.body);assert.equal(afterWithdrawal.title,null);
 assert.equal(afterWithdrawal.originalTopic,null);assert.equal(afterWithdrawal.topic,'arts','the reply own operator classification remains effective');
 assert.equal((await service.list(reader,{days:'all',kind:'reply',query:withdrawn.parent.title})).items.length,0);
 f.advance(31);
 const afterExpiry=(await service.get(reader,'reply',expiring.reply.replyId)).content;
 assert.equal((await forum.getReply(expiring.reply.replyId)).availability,'available','the reply retains its own later accepted deadline');
 assert.equal(afterExpiry.body,expiring.reply.body);assert.equal(afterExpiry.title,null);assert.equal(afterExpiry.originalTopic,null);assert.equal(afterExpiry.topic,null);
 assert.equal((await service.list(reader,{days:'all',kind:'reply',query:expiring.parent.title})).items.length,0);
 assert.equal((await service.list(reader,{days:'all',kind:'reply',topic:'life'})).items.some(value=>value.id===expiring.reply.replyId),false);
 const changedAudience=await bindForumIds('update-section','account:'+owner.accountId,{...section,operationId:randomUUID(),expectedVersion:1,audience:{read:{kind:'accounts'},participate:{kind:'accounts'}}});
 await forum.sections.save(owner,{payloadJson:JSON.stringify(changedAudience)});
 assert.equal((await forum.getVersion(restricted.parent.postId,restricted.parent.versionId)).availability,'unavailable');
 await assert.rejects(service.get(reader,'reply',restricted.reply.replyId),{code:'not_found'});
 assert.equal((await service.list(reader,{days:'all',kind:'reply',query:restricted.parent.title})).items.length,0);
 const retained=(await f.db.query('SELECT payload_text FROM forum_events_v1 WHERE id=ANY($1::uuid[])',[[withdrawn.parent.operationId,expiring.parent.operationId,restricted.parent.operationId]])).rows;
 assert.equal(retained.length,3);for(const value of retained)assert.ok(value.payload_text.includes('PARENT_TITLE_MUST_STOP'),'the privacy result comes from current read qualification rather than premature payload deletion');
});

test('public content directory retains authorized unavailable metadata without old prose, identities, search text or false public totals',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),{businessAdmin,admin,reader}=await contentOperators(f.db,f.endpoint,f.now),
  service=new OperationsForumContentService({businessAdmin,forum,now:f.now}),owner=f.people[0],responder=f.people[1];
 async function post(who,title,extra={}){
  const x=await bindForumIds('create-post','account:'+who.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,
   accountId:who.accountId,title,body:title+'_RETAINED_BODY',links:[],topic:'technology',audience:everyone,publishedUntil:f.now()+3600,...extra});
  await forum.publish(who,{payloadJson:JSON.stringify(x)});return x;
 }
 async function reply(title,extra={}){
  const x=await bindForumIds('create-reply','account:'+responder.accountId,{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),expectedRevision:0,accountId:responder.accountId,
   postId:visible.postId,postVersionId:visible.versionId,replyTo:null,body:title+'_RETAINED_BODY',publishedUntil:f.now()+3600,audience:everyone,...extra});
  await forum.createReply(responder,{payloadJson:JSON.stringify(x)});return x;
 }
 const visible=await post(owner,'VISIBLE_DIRECTORY_SOURCE'),hidden=await post(owner,'HIDDEN_VALID_DIRECTORY_SOURCE'),
  expired=await post(responder,'EXPIRED_DIRECTORY_OLD_TITLE',{publishedUntil:f.now()+30}),withdrawn=await post(owner,'WITHDRAWN_DIRECTORY_OLD_TITLE'),
  privateSource=await post(f.people[2],'PRIVATE_DIRECTORY_SOURCE',{audience:{read:{kind:'accounts'},participate:{kind:'accounts'}}}),
  expiredReply=await reply('EXPIRED_DIRECTORY_REPLY',{publishedUntil:f.now()+30}),withdrawnReply=await reply('WITHDRAWN_DIRECTORY_REPLY');
 await service.curate(admin,'post',expired.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:0,topic:'arts',pinned:true,reason:'HISTORY_REASON_MUST_NOT_BE_SEARCHABLE'});
 for(const p of [hidden,expired])await service.visibility(admin,'post',p.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:0,kind:'hide',until:f.now()+300,reason:'有限期限的人工治理记录'});
 const withdrawal=await bindForumIds('withdraw-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:withdrawn.postId,expectedHeadVersion:1});
 await forum.withdraw(owner,'withdraw-post',{payloadJson:JSON.stringify(withdrawal)});
 const replyWithdrawal=await bindForumIds('withdraw-reply','account:'+responder.accountId,{schemaVersion:1,operationId:randomUUID(),replyId:withdrawnReply.replyId,expectedRevision:1});
 await forum.withdraw(responder,'withdraw-reply',{payloadJson:JSON.stringify(replyWithdrawal)});f.advance(31);
 const retainedBytes=(await f.db.query('SELECT id,payload_text FROM forum_events_v1 WHERE id=ANY($1::uuid[])',[[expired.operationId,withdrawn.operationId,expiredReply.operationId,withdrawnReply.operationId]])).rows;
 assert.equal(retainedBytes.length,4);assert.ok(retainedBytes.every(row=>row.payload_text?.includes('RETAINED_BODY')));
 // Exercise the actual API database role. No new body permission or write
 // grant is needed to list the retained governance metadata.
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const page=await service.list(reader,{days:'all',limit:1});
 assert.equal(page.items.length,1);assert.ok(page.nextAfter);assert.equal(page.scanTruncated,false);
 assert.deepEqual({total:page.summary.total,visible:page.summary.visible,hidden:page.summary.hidden,unavailable:page.summary.unavailable,posts:page.summary.posts,replies:page.summary.replies},
  {total:6,visible:1,hidden:1,unavailable:4,posts:4,replies:2});
 assert.equal(page.summary.total,page.summary.visible+page.summary.hidden+page.summary.unavailable);
 assert.equal(page.summary.daily.reduce((sum,day)=>sum+day.posts+day.replies,0),1,'only a currently readable and unhidden first publication enters the public trend');
 const unavailable=await service.list(reader,{days:'all',visibility:'unavailable'});
 assert.deepEqual(new Set(unavailable.items.map(item=>item.id)),new Set([expired.postId,withdrawn.postId,expiredReply.replyId,withdrawnReply.replyId]));
 assert.equal(unavailable.summary.total,4);assert.equal(unavailable.summary.visible,0);assert.equal(unavailable.summary.hidden,0);assert.equal(unavailable.summary.unavailable,4);
 assert.equal((await service.list(reader,{days:'all',visibility:'visible'})).summary.total,1);
 assert.equal((await service.list(reader,{days:'all',visibility:'hidden'})).summary.total,1);
 const proseReads=[],metadataDb={query:(sql,params)=>{if(/\bpayload_text\b/i.test(sql))proseReads.push(sql);return f.db.query(sql,params);}};
 for(const item of unavailable.items){
  assert.equal(item.sourceState,'unavailable');assert.equal(item.title,null);assert.equal(item.excerpt,null);assert.equal(item.originalTopic,null);
  assert.deepEqual(item.author,{accountId:null,uid:null,displayName:null,subjectId:null});
  assert.deepEqual(item.capabilities,{canHide:false,canRestore:false,canBatchHide:false,canBatchRestore:false,canCurate:false});
  const detail=await service.viewWithin(metadataDb,reader,item.kind,item.id,{detail:true});
  assert.equal(detail.body,null);assert.equal(detail.publishedUntil,null);assert.deepEqual(detail.links,[]);assert.deepEqual(detail.attachments,[]);
 }
 assert.deepEqual(proseReads,[],'metadata-only source reads execute real SQL without selecting retained prose');
 const expiredView=await service.get(reader,'post',expired.postId),withdrawnView=(await service.get(reader,'post',withdrawn.postId)).content;
 assert.equal(expiredView.content.visibility.ownHidden,true);assert.equal(expiredView.content.topic,'arts');assert.equal(expiredView.content.curation.pinned,true);
 assert.equal(expiredView.history.items.length,2);assert.ok(expiredView.history.items.some(event=>event.reason==='HISTORY_REASON_MUST_NOT_BE_SEARCHABLE'));
 assert.equal(withdrawnView.versionId,null);assert.equal(withdrawnView.version,2);assert.equal(withdrawnView.state,'withdrawn');
 assert.equal((await service.list(reader,{days:'all',query:expired.postId})).items[0].id,expired.postId);
 assert.equal((await service.list(reader,{days:'all',query:'withdrawn'})).summary.total,2);
 for(const query of [expired.title,withdrawn.title,expired.body,withdrawn.body,expiredReply.body,withdrawnReply.body,'HISTORY_REASON_MUST_NOT_BE_SEARCHABLE','乙'])
  assert.equal((await service.list(reader,{days:'all',query})).items.length,0,'unavailable source prose, profile and history reasons never become query material');
 assert.equal((await service.list(reader,{days:'all',topic:'arts',pinned:true})).items[0].id,expired.postId,'an explicit retained operator classification remains a separate query fact');
 await assert.rejects(service.get(reader,'post',privateSource.postId),{code:'not_found'});
 for(const p of [expired,withdrawn]){
  const view=(await service.get(admin,'post',p.postId)).content;
  await assert.rejects(service.visibility(admin,'post',p.postId,{operationId:randomUUID(),expectedVersion:view.version,expectedRevision:view.visibility.version,kind:'restore',reason:'不可读来源不得通过目录恢复'}),{code:'operations_source_unavailable'});
  await assert.rejects(service.curate(admin,'post',p.postId,{operationId:randomUUID(),expectedVersion:view.version,expectedRevision:view.curation.revision,featured:true,reason:'不可读来源不得新增人工编排'}),{code:'operations_source_unavailable'});
 }
 const origin='https://admin.example.org',server=createApi({bindings:{endpoint:f.endpoint},operations:{portal:{authorizeOperator:async request=>{
  if(request.headers.origin!==origin)throw new ServiceError('business_admin_denied',403);return reader;
 }}},operationsCommunity:{content:service},browserOrigins:[origin],rateLimit:100});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port,headers={Origin:origin};
 const response=await fetch(base+'/v1/operations/community/content?days=all&visibility=unavailable',{headers});assert.equal(response.status,200);
 const json=await response.json();assert.equal(json.summary.unavailable,4);assert.equal(json.items.every(item=>item.title===null),true);
 for(const suffix of ['visibility=missing','visibility=unavailable&visibility=visible','sourceState=unavailable']){
  const rejected=await fetch(base+'/v1/operations/community/content?'+suffix,{headers});assert.equal(rejected.status,400);await rejected.arrayBuffer();
 }
 await f.db.exec('RESET ROLE');
 // This is a synthetic retained/minimized shape, not an attempt to recover
 // erased attribution from older versions, Consents or account profiles.
 await f.db.query('UPDATE forum_posts_v1 SET account_id=NULL,subject_id=NULL WHERE id=$1',[withdrawn.postId]);
 await assert.rejects(service.get(reader,'post',withdrawn.postId),{code:'not_found'});
 assert.equal((await service.list(reader,{days:'all',query:withdrawn.postId})).items.length,0);
});

test('a missing current forum version uses only the latest retained public metadata and keeps oversized directory totals unknown',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),{businessAdmin,admin}=await contentOperators(f.db,f.endpoint,f.now),
  service=new OperationsForumContentService({businessAdmin,forum,now:f.now}),owner=f.people[0];
 async function publish(title,extra={}){
  const kind=extra.expectedHeadVersion?'publish-version':'create-post',x=await bindForumIds(kind,'account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),
   expectedHeadVersion:0,accountId:owner.accountId,title,body:title+'_PROSE',links:[],topic:'technology',audience:everyone,publishedUntil:f.now()+3600,...extra});
  await forum.publish(owner,{payloadJson:JSON.stringify(x)});return x;
 }
 const oldPublic=await publish('OLDER_PUBLIC_IS_NOT_A_FALLBACK'),latestPrivate=await publish('LATEST_PRIVATE_METADATA',{postId:oldPublic.postId,expectedHeadVersion:1,audience:{read:{kind:'accounts'},participate:{kind:'accounts'}}}),
  older=await publish('OLDER_PUBLIC_VERSION'),latestPublic=await publish('LATEST_PUBLIC_RETAINED',{postId:older.postId,expectedHeadVersion:1});
 for(const p of [latestPrivate,latestPublic]){
  const x=await bindForumIds('withdraw-version','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:p.postId,versionId:p.versionId,expectedHeadVersion:2});
  await forum.withdraw(owner,'withdraw-version',{payloadJson:JSON.stringify(x)});
 }
 assert.equal((await forum.getVersion(oldPublic.postId,oldPublic.versionId)).availability,'available','the older signed public version remains retained and readable on its own existing route');
 await assert.rejects(service.get(admin,'post',oldPublic.postId),{code:'not_found'});
 const raw=await service.rawWithin(f.db,'post',latestPublic.postId);assert.equal(raw.head.current_version_id,null);assert.equal(raw.source.id,latestPublic.versionId);
 assert.equal(raw.source.version_number,2);assert.equal(Object.hasOwn(raw.source,'payload_text'),false);
 const view=(await service.get(admin,'post',latestPublic.postId)).content;
 assert.equal(view.state,'published');assert.equal(view.sourceState,'unavailable');assert.equal(view.version,3);assert.equal(view.versionId,null);assert.equal(view.title,null);assert.equal(view.body,null);
 const page=await service.list(admin,{days:'all'});assert.equal(page.summary.total,1);assert.equal(page.summary.unavailable,1);assert.equal(page.items[0].id,latestPublic.postId);
 assert.equal((await service.list(admin,{days:'all',query:oldPublic.title})).items.length,0);
 assert.equal((await service.list(admin,{days:'all',query:latestPublic.title})).items.length,0);
 // Real retained metadata rows exercise the existing bounded SQL scan. They
 // contain no source body and do not stand in for collected traffic metrics.
 await f.db.query(`INSERT INTO forum_posts_v1(id,account_id,head_version,state,created_at,updated_at)
  SELECT gen_random_uuid(),$1,1,'withdrawn',$2,$2 FROM generate_series(1,2001)`,[owner.accountId,new Date(f.now()*1000)]);
 const bounded=await service.list(admin,{days:'all',limit:1});assert.equal(bounded.summary.available,false);assert.equal(bounded.summary.reason,'public-content-window-too-large');
 for(const field of ['total','visible','hidden','unavailable','posts','replies'])assert.equal(bounded.summary[field],null);
 assert.deepEqual(bounded.summary.daily,[]);assert.equal(bounded.scanTruncated,true);
});
