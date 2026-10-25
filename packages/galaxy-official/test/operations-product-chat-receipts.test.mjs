import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {OperationsNotices} from '../src/operations-notices.mjs';
import {OperationsRetention} from '../src/operations-retention.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {productCommandResult} from '../src/operations/product-command-receipts.mjs';
import {chatCommandResult} from '../src/operations/chat-command-receipts.mjs';
import {productReceiptIntent} from '../src/shared/operations-product-receipt-intent.mjs';
import {chatReceiptIntent} from '../src/shared/operations-chat-receipt-intent.mjs';
import {digest} from '../src/shared/digest.mjs';
import {dispatchOperationsProduct} from '../src/adapters/http/operations-product-http.mjs';
import {dispatchAccountChatGovernance} from '../src/adapters/http/account-chat-governance-http.mjs';
import {operationsReadPath,operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// Actual migrated PGlite, API SQL role, stored roles, original product/chat
// services and their transactions. Native management admission, private chat
// transport/store/scanner and queue delivery are explicit doubles. No network,
// email, cleanup worker, production material or model call.
test('product and operator-chat original receipts preserve historical metadata and never borrow current detail',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const root={kind:'business-operator',operatorId:'receipt-root',role:'administrator',endpoint:f.endpoint},manager={...root,operatorId:'receipt-manager',role:'reader'},other={...manager,operatorId:'receipt-other'};
 const upstream=new Map([[root.operatorId,'administrator'],[manager.operatorId,'reader'],[other.operatorId,'reader']]);
 for(const actor of [root,manager,other])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operators.invalid',$1,$1,$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async a=>upstream.get(a.operatorId),now:f.now});
 const businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,now:f.now});
 const reads=['notices.read','retention.read','chat-reports.read'],writes=['notices.create','notices.update','notices.publish','notices.withdraw','retention.request','chat-reports.moderate','chat-messages.hide','chat-messages.restore','chat-messages.keep'];
 const role=async(name,codes)=>(await permissions.saveRole(root,{operationId:randomUUID(),expectedVersion:0,name,description:'Original receipt fixture only',enabled:true,permissions:codes},{authorize:async()=>root})).role;
 const reader=await role('读取原结果',reads),writer=await role('合成处理',writes);
 const assign=async(actor,role)=>(await permissions.saveAssignment(root,{operationId:randomUUID(),expectedVersion:0,operatorId:actor.operatorId,roleId:role.id,enabled:true},{authorize:async()=>root})).assignment;
 const readAssignment=await assign(manager,reader),writeAssignment=await assign(manager,writer);await assign(other,reader);
 const jobs={onCancel(){},async enqueue(){return randomUUID();}},notices=new OperationsNotices({db:f.db,endpoint:f.endpoint,businessAdmin,jobs,accounts:f.accounts,now:f.now}),retention=new OperationsRetention({db:f.db,endpoint:f.endpoint,businessAdmin,jobs,now:f.now});
 const governance=new AccountChatGovernanceService({chat:f.chat,businessAdmin}),[a,b]=f.people,roomId=await joinAccountConversation(f,a,b),message=await f.chat.send(b,roomId,{clientMessageId:randomUUID(),text:'PRIVATE_BODY_MUST_NOT_LEAVE_RECEIPT'});
 const source=await governance.source(a,{roomId,messageIds:[message.messageId]}),report=await governance.report(a,{operationId:randomUUID(),roomId,roomVersion:source.roomVersion,category:'other',summary:'PRIVATE_SUMMARY_MUST_NOT_LEAVE_RECEIPT',materials:[{messageId:message.messageId,revision:1,attachmentIds:[]}]});
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');t.after(async()=>{try{await f.db.exec('RESET ROLE');}catch{}});
 const products=[],chats=[];
 const product=async(path,input,write)=>{const body={operationId:randomUUID(),...input},ack=await write(body),intent=await productReceiptIntent(path,body,digest);products.push({path,body,ack,intent});return ack;};
 const content={purpose:'service-update',title:' Original title ',body:'NOTICE_BODY_NOT_IN_RECEIPT',expiresAt:new Date((f.now()+3600)*1000).toISOString(),audience:{kind:'all-accounts'}};
 const created=await product('/v1/operations/notices',{content},x=>notices.create(manager,x)),nid=created.notice.id;
 await product('/v1/operations/notices/'+nid+'/save',{expectedVersion:1,content:{...content,title:'Saved title'}},x=>notices.save(manager,nid,x));
 await product('/v1/operations/notices/'+nid+'/publish',{expectedVersion:2},x=>notices.publish(manager,nid,x));
 await product('/v1/operations/notices/'+nid+'/withdraw',{expectedVersion:3},x=>notices.withdraw(manager,nid,x));
 const queued=await product('/v1/operations/retention/runs',{target:'data-exports'},x=>retention.request(manager,x));
 // Worker completion is deliberately not the original queued ACK.
 await f.db.query("UPDATE operations_retention_runs_v1 SET state='completed',result='{}',finished_at=$2,updated_at=$2 WHERE id=$1",[queued.run.id,new Date(f.now()*1000)]);
 let current=report;
 const chat=async(kind,extra={})=>{const path='/v1/operations/chat-reports/'+report.reportId+'/event',body={operationId:randomUUID(),reportId:report.reportId,expectedVersion:current.version,kind,summary:'PRIVATE_REASON_NOT_IN_RECEIPT',...extra};current=await governance.operatorEvent(manager,body);const intent=await chatReceiptIntent(path,body,digest);chats.push({path,body,intent,ack:current});};
 await chat('review');
 const visibility=async(action,revision)=>{const path='/v1/operations/chat-reports/'+report.reportId+'/messages/'+message.messageId+'/visibility',body={operationId:randomUUID(),expectedVersion:current.version,expectedRevision:revision,messageRevision:1,action,summary:'PRIVATE_MESSAGE_REASON'};current=await governance.operatorMessageVisibility(manager,{reportId:report.reportId,messageId:message.messageId},body,{authorize:async()=>manager});const intent=await chatReceiptIntent(path,body,digest);chats.push({path,body,intent,ack:current});};
 await visibility('hide',0);await visibility('restore',1);await visibility('hide',2);await visibility('keep',3);
 await chat('pause',{targetVersion:source.roomVersion,rule:'PRIVATE_RULE_NOT_IN_RECEIPT',scopes:['sending-paused'],until:f.now()+300});await chat('resume');
 await chat('resolve',{targetVersion:source.roomVersion,rule:'PRIVATE_RULE_NOT_IN_RECEIPT',verdict:'dismissed',restriction:null});
 await permissions.saveAssignment(root,{operationId:randomUUID(),id:writeAssignment.id,expectedVersion:1,operatorId:manager.operatorId,roleId:writer.id,enabled:false},{authorize:async()=>root});
 const authorize=(actor,code)=>businessAdmin.authorizeAction(actor,code),originalCount=Number((await f.db.query('SELECT count(*) AS n FROM business_admin_audit_v1')).rows[0].n);
 const readProduct=(x,actor=manager,auth=null)=>productCommandResult({db:f.db,endpoint:f.endpoint,operator:actor,authorize:auth??(a=>authorize(a,x.intent.readPermission)),now:f.now},x.body.operationId,x.intent.action==='retention-request'?'retention':'notices');
 const readChat=(x,actor=manager,target=report.reportId,auth=null)=>chatCommandResult({db:f.db,endpoint:f.endpoint,operator:actor,authorize:auth??(a=>authorize(a,'chat-reports.read')),now:f.now},x.body.operationId,target);
 const receipts=[];
 for(const x of products){const r=await readProduct(x);assert.equal(r.state,'recorded',x.intent.action);assert.equal(r.result.intentHash,x.intent.intentHash);receipts.push(r);await assert.rejects(readProduct(x,other),{status:404});}
 for(const x of chats){const r=await readChat(x);assert.equal(r.state,'recorded',x.intent.kind);assert.equal(r.result.intentHash,x.intent.intentHash);assert.equal(r.result.version,x.body.expectedVersion+1);receipts.push(r);await assert.rejects(readChat(x,other),{status:404});}
 assert.equal(receipts[0].result.version,1);assert.equal(receipts[0].result.state,'draft');assert.equal((await notices.get(manager,nid)).notice.state,'withdrawn');
 assert.equal(receipts[4].result.state,'queued');assert.equal((await retention.get(manager,queued.run.id)).run.state,'completed');
 assert.equal(receipts[5].result.state,'reviewing');assert.equal((await governance.operatorGet(manager,{reportId:report.reportId})).state,'resolved');
 const restore=receipts.find(r=>r.kind==='message-restore');assert.equal(restore.result.dispositionRevision,2);assert.equal(restore.result.overallHiddenAtCommit,false);
 assert(!JSON.stringify(receipts).includes('PRIVATE_'));assert(!JSON.stringify(receipts).includes('NOTICE_BODY'));assert(!JSON.stringify(receipts).includes(roomId));
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM business_admin_audit_v1')).rows[0].n),originalCount+1,'only explicit fresh operatorGet is audited; receipt GETs do not write');
 const changed=await productReceiptIntent(products[1].path,{...products[1].body,content:{...products[1].body.content,body:'Changed body'}},digest);assert.notEqual(changed.intentHash,receipts[1].result.intentHash);
 assert.equal((await readChat(chats[0],manager,randomUUID())).state,'unknown');
 await assert.rejects(chatCommandResult({db:f.db,endpoint:f.endpoint,operator:manager,authorize:a=>authorize(a,'chat-reports.read'),now:f.now},report.reportId,report.reportId),{status:404},'ordinary account event cannot become an operator receipt');
 const missing={...products[0],body:{...products[0].body,operationId:randomUUID()}};assert.equal((await readProduct(missing)).state,'not-recorded');
 // Actual closed dispatchers and proxy gates, without an HTTP production server.
 for(const x of [...products,chats[0],chats[1]]){
  const headers={},request={method:'GET',headers:{}},response={setHeader:(k,v)=>headers[k]=v};let value;
  const args={notices,retention,operations:{authorizeOperator:async(_req,{action})=>authorize(manager,action)},accountChatGovernance:governance,authorizeOperator:async(_req,{action})=>authorize(manager,action),request,response,url:new URL(x.intent.receiptPath,f.endpoint),requestId:randomUUID(),send:(status,r)=>{assert.equal(status,200);value=r;}};
  const dispatcher=x.intent.receiptPath.includes('/chat-reports/')?dispatchAccountChatGovernance:dispatchOperationsProduct;
  assert.equal(await dispatcher(args),true);assert.equal(value.state,'recorded');assert.equal(headers['Cache-Control'],'no-store');
  await assert.rejects(dispatcher({...args,url:new URL(x.intent.receiptPath+'?input=x',f.endpoint)}),{status:404});
  // Use a currently write-authorized actor to reach the method gate. With the
  // read-only manager the existing product dispatcher rejects earlier with403.
  await assert.rejects(dispatcher({...args,operations:{authorizeOperator:async(_req,{action})=>authorize(root,action)},authorizeOperator:async(_req,{action})=>authorize(root,action),request:{method:'POST',headers:{}}}),{status:404});
  assert.equal(operationsReadPath(x.intent.receiptPath),true);assert.equal(operationsReadPath(x.intent.receiptPath+'?x=1'),false);
  const p={url:'https://admin.example.org'+x.intent.receiptPath,method:'GET',headers:new Headers({origin:'https://admin.example.org'}),publicOrigin:'https://admin.example.org'};
  assert.equal(operationsProxyPolicy(p).allowed,true);assert.equal(operationsProxyPolicy({...p,url:p.url+'?x=1'}).allowed,false);assert.equal(operationsProxyPolicy({...p,method:'POST'}).allowed,false);
 }
 // Retiring the original private input is unknown, never reconstructed from head.
 f.advance(181*86400);assert.equal((await governance.purgeExpired()).erasedCases,1);assert.equal((await readChat(chats[0])).state,'unknown');
 let checks=0;
 await assert.rejects(readProduct(products[0],manager,async actor=>{if(++checks===2)await permissions.saveAssignment(root,{operationId:randomUUID(),id:readAssignment.id,expectedVersion:1,operatorId:manager.operatorId,roleId:reader.id,enabled:false},{authorize:async()=>root});return authorize(actor,'notices.read');}),{status:403});
 await assert.rejects(readChat(chats[0]),{status:403});assert.equal(checks,2);
 console.log(JSON.stringify({productOriginalCommands:products.length,chatOriginalCommands:chats.length,currentSQLPermissions:true,apiSQLRole:true,originalQueuedNotCompletion:true,ordinaryActorExcluded:true,retiredInputUnknown:true,privateOrNoticeBodyReturned:false,networkRequests:0,modelCalls:0}));
});
