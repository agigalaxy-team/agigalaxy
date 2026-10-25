import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {p14Fixture} from './p14-rules-fixture.mjs';
import {joinAccountConversation} from './account-chat-fixture.mjs';
import {OperationsFileCleanupService} from '../src/operations/files/cleanup-service.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsQueryTools} from '../src/operations-agentos-query-tools.mjs';
import {agentOsQueryArgumentsSchema,agentOsReadArgumentsSchema} from '../src/shared/operations-agentos-query-schema.mjs';

// Real migrated PG, directory/role/plan services and actual upload/scan flows.
// Management directory, message transport, antivirus and byte storage are local
// fixture dependencies. This group never calls the cleanup worker or erase.
test('workbench file cleanup queries preserve real candidates, plans and own receipts without gaining deletion capabilities',{timeout:90000},async t=>{
 const f=await p14Fixture(t),objects=new Map();let erases=0;
 f.files.store={keyId:'local-only',put:async({key,bytes,sha256})=>objects.set(key,{bytes:Buffer.from(bytes),sha256}),get:async({key})=>objects.get(key)?.bytes,head:async({key})=>{const x=objects.get(key);return x?{size:x.bytes.length,sha256:x.sha256}:null;},erase:async()=>{erases++;throw Error('query must not delete');}};
 const cleanup=new OperationsFileCleanupService({businessAdmin:f.businessAdmin,chatAttachments:f.files,forumAttachments:f.forumFiles,now:f.now}),authority=new OperationsAgentOsAuthority({...f,permissions:f.permissions}),
  tools=new OperationsAgentOsQueryTools({authority,services:{fileCleanup:cleanup}}),query=(view,filters={},actor=f.admin)=>tools.execute({actor,domain:'maintenance',tool:'query-operations',arguments:{module:'files',view,filters}}),
  read=(kind,id,actor=f.admin)=>tools.execute({actor,domain:'maintenance',tool:'read-operation-object',arguments:{kind,id}});
 const roomId=await joinAccountConversation(f,f.people[0],f.people[1]);
 for(let n=0;n<2;n++){
  const id=randomUUID(),bytes=Buffer.from('PRIVATE_ATTACHMENT_BODY '+id);await f.files.prepare(f.people[0],{attachmentId:id,roomId,name:'当前文件 '+n+'.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes),purpose:'temporary-room-attachment',confirmed:true});
  await f.files.upload(f.people[0],id,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();
 }
 f.advance(30*86400+1);
 const first=await query('cleanup-candidates',{kind:'chat',limit:1});assert.equal(first.data.items.length,1);assert(first.pagination.next);assert.equal(first.pagination.complete,false);
 const next=await tools.execute({actor:f.admin,domain:'maintenance',tool:'query-operations',arguments:first.pagination.next}),items=[...first.data.items,...next.data.items];
 assert.equal(items.length,2);assert.notEqual(items[0].id,items[1].id);assert.equal(next.pagination.complete,true);assert(items.every(x=>x.eligible&&x.reason==='expired'));assert(items.every(x=>x.activeReferences===0));
 assert(first.evidenceRefs.every(x=>x.controlledSource===false));assert(first.evidenceRefs[0].href.includes('view=cleanup'));
 const raw=(await cleanup.candidates(f.admin,{limit:50})).items,createdId=randomUUID(),created=await cleanup.create(f.admin,{operationId:createdId,items:raw.map(({kind,id,expectedVersion})=>({kind,id,expectedVersion})),reason:'PRIVATE_MANUAL_PLAN_REASON'},{authorize:f.authorize}),planId=created.plan.id;
 const directory=await query('cleanup-plans',{limit:1}),plan=await read('file-cleanup-plan',planId),receipt=await read('file-cleanup-operation',createdId);
 assert.equal(directory.data.items.length,1);assert.equal(directory.data.items[0].state,'awaiting-approval');assert.equal(plan.data.itemCount,2);assert.equal(plan.data.createdBy.displayName,'合成规则维护者');assert.equal(plan.data.impact.physicalBlocksReleased,null);
 assert(plan.data.items.every(x=>x.state==='pending'&&x.objectRemoved===null));assert.equal(receipt.data.state,'recorded');assert.equal(receipt.data.kind,'create');assert.equal(receipt.data.planId,planId);
 assert.equal(plan.evidenceRefs.find(x=>x.kind==='file-cleanup-plan').href,'/admin/operations/files?kind=all&view=cleanup&plan='+planId);assert.equal(receipt.evidenceRefs.find(x=>x.kind==='file-cleanup-operation').href,plan.evidenceRefs.find(x=>x.kind==='file-cleanup-plan').href);
 const approved=await cleanup.approve(f.admin,planId,{operationId:randomUUID(),expectedRevision:created.plan.revision},{authorize:f.authorize});assert.equal((await read('file-cleanup-plan',planId)).data.state,'queued');
 await f.db.query("UPDATE operations_file_cleanup_plans_v1 SET state='attention' WHERE id=$1",[planId]);await f.db.query("UPDATE operations_file_cleanup_items_v1 SET state='result-unknown',result_code='operations_file_cleanup_result_unknown',attempt_count=3 WHERE plan_id=$1",[planId]);
 const attention=await read('file-cleanup-plan',planId);assert.equal(attention.data.state,'attention');assert.equal(attention.data.counts['result-unknown'],2);assert(attention.data.items.every(x=>x.objectRemoved===null));assert.equal(erases,0);
 const role=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'查询文件计划',description:'只读',enabled:true,permissions:['workbench.read','files.read']},{authorize:f.authorize})).role;
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),expectedVersion:0,operatorId:f.reader.operatorId,roleId:role.id,enabled:true},{authorize:f.authorize});
 assert.equal((await read('file-cleanup-plan',planId,f.reader)).data.id,planId);assert.equal((await read('file-cleanup-operation',createdId,f.reader)).data.state,'not-recorded');
 const empty=await read('file-cleanup-operation',randomUUID());assert.equal(empty.data.state,'not-recorded');assert.equal(empty.data.planId,null);
 const all=JSON.stringify([first,next,directory,plan,receipt,attention,empty]);for(const secret of ['PRIVATE_MANUAL_PLAN_REASON','PRIVATE_ATTACHMENT_BODY','expectedVersion','reference_state','storage_key','encryption_key','sha256','permissions','canApprove','canCreate'])assert(!all.includes(secret),secret);
 for(const value of [{module:'files',view:'cleanup-candidates',filters:{sql:'delete'}},{module:'files',view:'cleanup-plans',filters:{state:'queued'}},{module:'files',view:'cleanup-approve'},{module:'files',view:'cleanup-plans',filters:{operatorId:f.admin.operatorId}}])assert.equal(agentOsQueryArgumentsSchema.safeParse(value).success,false);
 assert.equal(agentOsReadArgumentsSchema.safeParse({kind:'file-cleanup-plan',id:planId,filters:{body:true}}).success,false);
 await assert.rejects(tools.execute({actor:f.admin,domain:'maintenance',tool:'query-operations',arguments:{module:'feedback',view:'list',filters:{after:'chat:'+items[0].id}}}),{code:'invalid_operations_agentos_query',status:400});
 f.roles.set(f.reader.operatorId,null);await assert.rejects(read('file-cleanup-plan',planId,f.reader),{code:'business_admin_denied',status:403});assert.equal(erases,0);assert.equal(approved.plan.itemCount,2);
});
