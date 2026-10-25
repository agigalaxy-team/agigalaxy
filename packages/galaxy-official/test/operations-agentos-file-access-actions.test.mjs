import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {migrate} from '../src/database.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {ForumAttachmentsV1Service} from '../src/forum-attachments-v1.mjs';
import {OperationsFileAccessService} from '../src/operations/files/access-service.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import {AgentOsConversations} from '../src/operations-agentos-conversations.mjs';
import {AgentOsConversationTools} from '../src/operations-agentos-conversation-tools.mjs';
import {workbenchActionCatalog,workbenchPrepareSchemas} from '../src/operations-agentos-action-catalog.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {workbenchActionCards,workbenchCardReason} from '../../../apps/galaxy-admin/src/lib/workbench-action-cards.ts';

// Real PG/API role, current grants, attachment preparation/upload/scan, access
// overlays and durable card/receipt stores. The management directory, scanner,
// chat transport and object bytes are explicit local contracts, not live OIDC,
// AV, HTTP or storage evidence. No provider, deletion or automation is invoked.
test('workbench file access cards preserve explicit human scope, actual attachment eligibility and exact GET recovery after an internal postcommit denial',{timeout:120000},async t=>{
 const f=await accountChatFixture();t.after(f.close);let erases=0;
 const store=f.files.store,erase=store.erase;store.erase=async()=>{erases++;throw Error('Access cards cannot erase objects.');};
 const forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),forumFiles=new ForumAttachmentsV1Service({forum,store,scanner:f.files.scanner});forum.attachments=forumFiles;
 const [owner,partner]=f.people,roomId=await joinAccountConversation(f,owner,partner),stamp=value=>new Date(value*1000).toISOString();
 const admin={kind:'business-operator',operatorId:'file-card-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'file-card-reader',role:'reader'},other={...admin,operatorId:'file-card-other'};
 for(const actor of [admin,reader,other])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://manager.example.invalid',$1,'文件管理者',$3,$3)",[actor.operatorId,f.endpoint,stamp(f.now())]);
 const accounts=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now}),current=await attachOperationsFixtureAuthority({businessAdmin:accounts,admin,reader,permissions:['workbench.read','files.read']});current.roles.set(other.operatorId,'administrator');
 const access=new OperationsFileAccessService({businessAdmin:accounts,chatAttachments:f.files,forumAttachments:forumFiles,now:f.now}),authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,now:f.now,permissions:current.permissions}),tools=new OperationsAgentOsActionTools({authority,services:{fileAccess:access}}),authorize=async()=>admin;
 let changeCalls=0;const realChange=access.change.bind(access);access.change=(...args)=>{changeCalls++;return realChange(...args);};
 async function upload(kind='chat',{scan=true,name='本次文件.txt'}={}){
  const id=randomUUID(),bytes=Buffer.from('LOCAL_FILE_CARD_BYTES '+id),files=kind==='chat'?f.files:forumFiles,input={attachmentId:id,name,mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes)};
  if(kind==='chat')Object.assign(input,{roomId,purpose:'temporary-room-attachment',confirmed:true});
  await files.prepare(owner,input);await files.upload(owner,id,Readable.from([bytes]),{contentLength:bytes.length});if(scan)await files.scanPending();return{kind,id,files,bytes};
 }
 const chat=await upload(),pub=await upload('forum'),withdrawn=await upload(),expired=await upload(),unknown=await upload(),blocked=await upload('chat',{scan:false,name:'待扫描文件.txt'});
 await f.chat.send(owner,roomId,{clientMessageId:randomUUID(),text:'PRIVATE_MESSAGE_NEVER_IN_CARD',attachments:[{id:chat.id,sha256:f.digest(chat.bytes)}]});
 await migrate(f.db,{roles:['api','worker']});await f.db.exec('SET ROLE galaxy_api');assert.equal((await f.db.query('SELECT current_user AS role')).rows[0].role,'galaxy_api');
 const request=(file,action='stop',extra={})=>({kind:'file-access',targetKind:file.kind,targetId:file.id,action,reason:'本次人工决定单个文件访问',...(action==='stop'?{until:f.now()+600}:{}),...extra}),
  prepare=(value,actor=admin,domain='maintenance')=>tools.prepareFor(actor,domain,value),effectCount=async operationId=>(await f.db.query('SELECT count(*)::int AS n FROM operations_file_access_events_v1 WHERE endpoint=$1 AND operation_id=$2',[f.endpoint,operationId])).rows[0].n,
  card=proposal=>({cardId:randomUUID(),operationId:randomUUID(),kind:proposal.kind,domain:proposal.domain,target:proposal.target,title:proposal.title,impact:proposal.impact,basis:proposal.basis,requiredAction:proposal.requiredAction,capability:{canConfirm:true},state:'prepared',checkedAt:f.now(),readExpiresAt:f.now()+30});
 assert.deepEqual(workbenchActionCatalog.map(item=>item.kind).sort(),['content-visibility','content-curation','section-classification','section-visibility','resource-visibility','account-restriction','feedback-update','file-scan-retry','file-access','file-cleanup-approve','case-resolve','messaging-state','strategy-control','strategy-continue','search-apply','search-restore','rule-publish','rule-restore'].sort());
 assert.deepEqual(workbenchActionCatalog.find(item=>item.kind==='file-access'),{kind:'file-access',domain:'maintenance',label:'停止或恢复单文件访问',read:'files.read'});
 const input=request(chat),{until,...withoutUntil}=input;
 assert.equal(workbenchPrepareSchemas['file-access'].safeParse(withoutUntil).success,false);assert.equal(workbenchPrepareSchemas['file-access'].safeParse({...input,action:'restore'}).success,false);
 for(const extra of [{expectedRevision:0},{expectedVersion:'forged'},{operationId:randomUUID()},{role:'administrator'},{durationSeconds:3600},{path:'/arbitrary'},{until:'2099-01-01'}])assert.equal(workbenchPrepareSchemas['file-access'].safeParse({...input,...extra}).success,false);
 await assert.rejects(prepare({...input,until:f.now()}),{code:'operations_file_access_until'});await assert.rejects(prepare(input,admin,'messaging'),{code:'operations_agentos_domain_mismatch'});
 await assert.rejects(prepare(input,{...admin,endpoint:'https://other.example.invalid'}),{code:'business_admin_denied'});
 await assert.rejects(prepare(input,{...reader,role:'administrator',businessAuthorization:{version:'forged',permissions:['files.access.stop']}}),{code:'operations_agentos_operation_unavailable'});
 await assert.rejects(prepare(input,owner),{code:'business_admin_denied'});await assert.rejects(prepare(input,{kind:'operations-executor',operatorId:'executor:'+randomUUID(),endpoint:f.endpoint}),{code:'business_admin_denied'});
 const prepared=await prepare(input),overview=await prepare(input,admin,'overview');assert.equal(overview.domain,'overview');assert.equal(prepared.requiredAction,'files.access.stop');assert.equal(prepared.decisionSource,'human-required');
 assert.deepEqual(prepared.command,{expectedVersion:(await access.get(admin,'chat',chat.id)).processingVersion,expectedRevision:0,action:'stop',reason:input.reason,until:input.until});assert.equal(changeCalls,0,'preparing does not write an overlay');
 assert.equal(prepared.target.href,'/admin/operations/files?fileKind=chat&id='+chat.id);assert.equal(prepared.target.label,'本次文件.txt');
 for(const text of ['不删除文件','原存储期限','作者撤回','清理计划','获准导出',input.reason])assert(prepared.impact.some(line=>line.includes(text)),text);
 assert(!JSON.stringify(prepared).includes('PRIVATE_MESSAGE_NEVER_IN_CARD'));assert(!JSON.stringify(prepared).includes('LOCAL_FILE_CARD_BYTES'));
 const projected=workbenchActionCards([card(prepared)],'maintenance');assert.equal(projected.length,1);assert.deepEqual(projected[0].impact,prepared.impact);assert(!JSON.stringify(projected).includes('expectedVersion'));assert.equal(workbenchCardReason('operations_file_access_changed'),'对象状态已有变化，请按当前内容重新准备。');
 const op=randomUUID();assert.equal((await tools.recoverPrepared(admin,prepared,op)).state,'not-recorded');assert.equal(changeCalls,0);
 await assert.rejects(tools.executePrepared(admin,prepared,{authorize:async()=>other,operationId:op}),{code:'business_admin_denied'});assert.equal(await effectCount(op),0);
 const original=(await f.db.query('SELECT state,expires_at,revoked_at,purge_pending,storage_key FROM chat_attachments WHERE id=$1',[chat.id])).rows[0],stopped=await tools.executePrepared(admin,prepared,{authorize,operationId:op});
 assert.equal(stopped.state,'completed');assert.equal(stopped.receipt.kind,'chat');assert.equal(stopped.receipt.id,chat.id);assert.equal(stopped.receipt.action,'stop');assert.equal(stopped.receipt.until,input.until);assert.equal(stopped.receipt.revision,1);assert.equal(stopped.receipt.stopped,true);assert(stopped.summary.includes('北京时间'));
 assert.deepEqual((await f.db.query('SELECT state,expires_at,revoked_at,purge_pending,storage_key FROM chat_attachments WHERE id=$1',[chat.id])).rows[0],original);await assert.rejects(f.files.content(owner,{attachmentId:chat.id}),{code:'attachment_content_unavailable'});
 const callsAfterStop=changeCalls;assert.equal((await tools.recoverPrepared(admin,prepared,op)).state,'completed');assert.equal(changeCalls,callsAfterStop,'original-result recovery only reads');assert.equal(await effectCount(op),1);
 for(const changed of [
  {...prepared,request:{...input,targetId:pub.id}},
  {...prepared,request:{...input,targetKind:'forum'}},
  {...prepared,request:{...input,reason:'替换已确认原因'},command:{...prepared.command,reason:'替换已确认原因'}},
  {...prepared,command:{...prepared.command,expectedVersion:prepared.command.expectedVersion+'changed'}},
  {...prepared,command:{...prepared.command,expectedRevision:1}},
  {...prepared,request:{...input,until:input.until+1},command:{...prepared.command,until:input.until+1}}
 ])await assert.rejects(tools.recoverPrepared(admin,changed,op),{code:'operations_agentos_operation_conflict'});
 await assert.rejects(tools.recoverPrepared(other,prepared,op),{code:'operations_agentos_operation_conflict'});await assert.rejects(tools.recoverPrepared({...admin,endpoint:'https://other.example.invalid'},prepared,op),{code:'business_admin_denied'});
 const restore=await prepare(request(chat,'restore'));assert.equal(restore.requiredAction,'files.access.restore');assert.equal(Object.hasOwn(restore.command,'until'),false);assert(restore.impact.some(line=>line.includes('扫描结果、来源状态与阅读权限')));
 await assert.rejects(tools.recoverPrepared(admin,restore,op),{code:'operations_agentos_operation_conflict'});
 const restoreOp=randomUUID(),restored=await tools.executePrepared(admin,restore,{authorize,operationId:restoreOp});assert.equal(restored.state,'completed');assert.equal(restored.receipt.stopped,false);assert.equal(restored.receipt.until,null);assert.equal(restored.receipt.revision,2);assert.deepEqual((await f.files.content(owner,{attachmentId:chat.id})).bytes,chat.bytes);
 await tools.recoverPrepared(admin,prepared,op);assert.equal((await access.get(admin,'chat',chat.id)).access.stopped,false,'reading an old stop cannot reinstate it');
 const forumStop=await prepare(request(pub)),forumOp=randomUUID();assert.equal((await tools.executePrepared(admin,forumStop,{authorize,operationId:forumOp})).receipt.kind,'forum');assert.equal((await tools.recoverPrepared(admin,forumStop,forumOp)).state,'completed');
 const stale=await prepare(request(pub,'restore')),directOp=randomUUID();await access.change(admin,'forum',pub.id,{...stale.command,operationId:directOp},{authorize});
 const staleOp=randomUUID();await assert.rejects(tools.executePrepared(admin,stale,{authorize,operationId:staleOp}),{code:'operations_file_access_changed'});assert.equal(await effectCount(staleOp),0,'a definite CAS rejection stays a known no-effect result');
 // A real service commits, then its OWN final authorize callback loses the PG
 // grant, before change() returns. Persist safe unknown and recover by GET.
 const role=(await current.permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'单文件人工访问处理',description:'',enabled:true,permissions:['files.access.stop','files.access.restore']},{authorize})).role;
 let assignment=(await current.permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize})).assignment;
 const readerProposal=await prepare(request(unknown),reader),conversations=new AgentOsConversations({authority,client:null}),session=(await conversations.session(reader,'maintenance',{create:true})).row,cards=new AgentOsConversationTools({conversations,authority,services:{fileAccess:access}}),turnId=randomUUID(),callId=randomUUID(),cardId=randomUUID(),originalOp=randomUUID();conversations.tools=cards;
 await f.db.query("INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,'local-file-fixture','accepted','{}',$5)",[turnId,f.endpoint,session.id,reader.operatorId,stamp(f.now())]);
 await f.db.query("INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'local-file-run','local-file-call','prepare-operation','local-file-fixture','completed',$5,$5)",[callId,f.endpoint,session.id,turnId,stamp(f.now())]);
 await f.db.query("INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'maintenance',$7,'local-file-fixture',$8,'prepared',$9,$9)",[cardId,f.endpoint,session.id,turnId,callId,reader.operatorId,originalOp,JSON.stringify(readerProposal),stamp(f.now())]);
 let authorizationCalls=0;const revokeInsidePostcommit=async()=>{
  authorizationCalls++;if(authorizationCalls===7){assert.equal(await effectCount(originalOp),1,'the file service has committed before its internal final freshness check');assignment=(await current.permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:role.id,enabled:false},{authorize})).assignment;}return reader;
 };
 await assert.rejects(cards.confirm(reader,'maintenance',cardId,{cardId,operationId:originalOp},{authorize:revokeInsidePostcommit}),{code:'operations_permission_denied'});assert.equal(authorizationCalls,8);
 const saved=(await f.db.query('SELECT state,result FROM operations_agentos_conversation_cards_v1 WHERE id=$1',[cardId])).rows[0];assert.equal(saved.state,'unknown');assert.deepEqual(Object.keys(saved.result).sort(),['operationId','receipt','state','summary']);assert.equal(saved.result.operationId,originalOp);assert.equal(saved.result.receipt,null);assert(!saved.result.summary.includes('未执行'));
 for(const text of [unknown.id,'本次文件.txt',readerProposal.request.reason])assert(!JSON.stringify(saved.result).includes(text));assert.equal((await access.operation(reader,originalOp)).state,'recorded','the original receipt remains available with files.read, without a write grant');
 await current.permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize});
 const beforeRecovery=changeCalls,realOperation=access.operation.bind(access);access.operation=async()=>{throw new ServiceError('operations_authorization_unavailable',503);};
 assert.equal((await cards.card(reader,'maintenance',cardId)).state,'unknown');assert.equal(changeCalls,beforeRecovery,'GET failure never resubmits');access.operation=realOperation;
 const recovered=await cards.card(reader,'maintenance',cardId);assert.equal(recovered.state,'completed');assert.equal(recovered.result.operationId,originalOp);assert.equal(changeCalls,beforeRecovery);assert.equal(await effectCount(originalOp),1);
 await cards.confirm(reader,'maintenance',cardId,{cardId,operationId:originalOp},{authorize:async()=>reader});assert.equal(changeCalls,beforeRecovery);assert.equal(await effectCount(originalOp),1);
 // A restore never substitutes for the original scan, author or expiry gates.
 await tools.executePrepared(admin,await prepare(request(blocked)),{authorize,operationId:randomUUID()});await f.db.exec('SET ROLE galaxy_evidence_worker');const scan=f.files.scanner.scan;f.files.scanner.scan=async()=>({state:'blocked',engine:'local-card-blocked'});await f.files.scanPending();f.files.scanner.scan=scan;await f.db.exec('SET ROLE galaxy_api');
 assert.equal((await access.get(admin,'chat',blocked.id)).access.canRestore,false);await assert.rejects(prepare(request(blocked,'restore')),{code:'operations_agentos_operation_unavailable'});
 await tools.executePrepared(admin,await prepare(request(withdrawn)),{authorize,operationId:randomUUID()});const beforeRevoke=await prepare(request(withdrawn,'restore'));await f.files.revoke(owner,{attachmentId:withdrawn.id});const revokeOp=randomUUID();await assert.rejects(tools.executePrepared(admin,beforeRevoke,{authorize,operationId:revokeOp}),{code:'operations_file_changed'});assert.equal(await effectCount(revokeOp),0);assert.equal((await access.get(admin,'chat',withdrawn.id)).access.canRestore,false);
 await tools.executePrepared(admin,await prepare(request(expired,'stop',{until:f.now()+40*86400})),{authorize,operationId:randomUUID()});f.advance(31*86400);assert.equal((await access.get(admin,'chat',expired.id)).access.canRestore,false);await assert.rejects(prepare(request(expired,'restore')),{code:'operations_agentos_operation_unavailable'});
 assert.equal(erases,0);store.erase=erase;assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_automation_grants_v1')).rows[0].n,0);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_agentos_executions_v1')).rows[0].n,0);
});
