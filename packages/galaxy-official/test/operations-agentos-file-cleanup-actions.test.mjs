import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {accountChatFixture,joinAccountConversation} from './account-chat-fixture.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsFileCleanupService} from '../src/operations/files/cleanup-service.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import {workbenchActionCatalog,workbenchPrepareSchemas} from '../src/operations-agentos-action-catalog.mjs';
import {workbenchActionCards} from '../../../apps/galaxy-admin/src/lib/workbench-action-cards.ts';

// Real PG plans, current business grants, exact API role, approval CAS and
// original receipts. File metadata is an explicit SQL fixture; no upload,
// worker deletion, native model, provider or production operation is run.
test('workbench cleanup approval cards preserve one complete existing plan and only the human-confirmed current approval',{timeout:90000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'cleanup-card-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'cleanup-card-reader',role:'reader'},other={...reader,operatorId:'cleanup-card-other'},
  businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,now:f.now});
 for(const actor of [admin,reader,other])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://fixture.invalid',$1,'文件管理者',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const current=await attachOperationsFixtureAuthority({businessAdmin,admin,reader,permissions:['workbench.read','files.read']});current.roles.set(other.operatorId,'reader');
 let storageCalls=0;f.files.store={head:async()=>{storageCalls++;throw Error('Approval must not read storage bytes');},erase:async()=>{storageCalls++;throw Error('Only the existing worker may delete bytes');}};
 const cleanup=new OperationsFileCleanupService({businessAdmin,chatAttachments:f.files,now:f.now}),authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,permissions:current.permissions,now:f.now}),
  tools=new OperationsAgentOsActionTools({authority,services:{fileCleanup:cleanup}}),authorize=async()=>admin,
  roomId=await joinAccountConversation(f,f.people[0],f.people[1]),ids=Array.from({length:50},()=>randomUUID()),stamp=seconds=>new Date(seconds*1000);
 for(const [index,id]of ids.entries())await f.db.query(`INSERT INTO chat_attachments(id,room_id,subject_id,request_hash,name,media_type,byte_size,sha256,storage_key,encryption_key_id,state,created_at,prepare_expires_at,uploaded_at,expires_at,scan_result)
  VALUES($1,$2,$3,$4,$5,'text/plain',8,$4,$6,'local-contract-only','available',$7,$8,$7,$8,$9)`,
  [id,roomId,'account:'+f.people[0].accountId,'a'.repeat(64),'计划文件 '+(index+1)+'.txt','attachments/'+id,stamp(f.now()-60),stamp(f.now()-1),JSON.stringify({state:'clean',checkedAt:f.now()-59})]);
 await migrate(f.db,{roles:['api','worker']});await f.db.exec('SET ROLE galaxy_api');
 const candidates=(await cleanup.candidates(admin,{limit:50})).items;assert.equal(candidates.length,50);assert(candidates.every(item=>item.eligible));
 const created=await cleanup.create(admin,{operationId:randomUUID(),items:candidates.map(({kind,id,expectedVersion})=>({kind,id,expectedVersion})),reason:'PRIVATE_PLAN_DESCRIPTION_NOT_FOR_MODEL_CARD'},{authorize}),plan=created.plan,
  request={kind:'file-cleanup-approve',planId:plan.id},prepare=(actor=admin,domain='maintenance')=>tools.prepareFor(actor,domain,request),
  card=proposal=>({cardId:randomUUID(),operationId:randomUUID(),kind:proposal.kind,domain:proposal.domain,target:proposal.target,title:proposal.title,impact:proposal.impact,basis:proposal.basis,requiredAction:proposal.requiredAction,capability:{canConfirm:true},state:'prepared',checkedAt:f.now(),readExpiresAt:f.now()+30});
 assert.deepEqual(workbenchActionCatalog.filter(item=>item.kind==='file-cleanup-approve'),[{kind:'file-cleanup-approve',domain:'maintenance',label:'人工批准具体文件清理计划',read:'files.read'}]);
 for(const extra of [{expectedRevision:999},{items:[]},{reason:'模型不能改范围或说明'},{confirmed:true},{path:'/arbitrary'}])assert.equal(workbenchPrepareSchemas['file-cleanup-approve'].safeParse({...request,...extra}).success,false);
 await assert.rejects(prepare(reader),{code:'operations_agentos_operation_unavailable'});
 await assert.rejects(prepare(admin,'messaging'),{code:'operations_agentos_domain_mismatch'});
 await assert.rejects(tools.prepareFor(admin,'overview',{...request,planId:randomUUID()}),{code:'operations_file_cleanup_plan_not_found'});
 const prepared=await prepare(),overview=await prepare(admin,'overview');
 assert.equal(prepared.requiredAction,'files.cleanup.approve');assert.equal(prepared.decisionSource,'human-required');assert.deepEqual(prepared.command,{expectedRevision:plan.revision});assert.equal(overview.domain,'overview');
 assert.equal(prepared.impact.length,53);for(let index=1;index<=50;index++)assert(prepared.impact.some(line=>line.includes('计划文件 '+index+'.txt')));
 assert(prepared.impact.some(line=>line.includes('无法从此处恢复')));assert(prepared.impact.some(line=>line.includes('有变化的文件不会继续清理')));assert(prepared.impact.some(line=>line.includes('磁盘释放空间目前无法确认')));
 for(const forbidden of ['PRIVATE_PLAN_DESCRIPTION','storage_key','encryption_key_id','reference_state','expectedVersion','account:'+f.people[0].accountId])assert(!JSON.stringify(prepared).includes(forbidden));
 assert.equal((await cleanup.plan(admin,plan.id)).state,'awaiting-approval');assert.equal(storageCalls,0);
 const publicCard=card(prepared),parsed=workbenchActionCards([publicCard],'maintenance');assert.equal(parsed.length,1);assert.deepEqual(parsed[0].impact,prepared.impact);
 assert.deepEqual(workbenchActionCards([{...publicCard,impact:Array(55).fill('范围不可截断')}],'maintenance'),[]);
 assert.deepEqual(workbenchActionCards([{...publicCard,impact:['x'.repeat(5001)]}],'maintenance'),[]);
 assert.deepEqual(workbenchActionCards([{...publicCard,impact:Array(5).fill('x'.repeat(4500))}],'maintenance'),[]);
 assert.equal(workbenchActionCards([{...publicCard,kind:'file-scan-retry'}],'maintenance')[0].impact.length,12,'existing scan cards keep their old bound');
 if(process.env.GALAXY_TEST_CLEANUP_CARD_PATH)await writeFile(process.env.GALAXY_TEST_CLEANUP_CARD_PATH,JSON.stringify({scope:'local-PG-prepared-card-no-production-approval',card:parsed[0]},null,2)+'\n');
 // A real source-state change makes the previously prepared plan stale.
 await f.db.exec('RESET ROLE');await f.db.query('UPDATE chat_attachments SET expires_at=$2 WHERE id=$1',[ids[0],stamp(f.now()+60)]);await f.db.exec('SET ROLE galaxy_api');
 await assert.rejects(tools.executePrepared(admin,prepared,{authorize,operationId:randomUUID()}),{code:'operations_file_cleanup_plan_changed'});
 assert.equal((await cleanup.plan(admin,plan.id)).state,'awaiting-approval');
 await f.db.exec('RESET ROLE');await f.db.query('UPDATE chat_attachments SET expires_at=$2 WHERE id=$1',[ids[0],stamp(f.now()-1)]);await f.db.exec('SET ROLE galaxy_api');
 // A plan revision change cannot be silently substituted behind the card.
 await f.db.query('UPDATE operations_file_cleanup_plans_v1 SET revision=revision+1 WHERE id=$1',[plan.id]);
 await assert.rejects(tools.executePrepared(admin,prepared,{authorize,operationId:randomUUID()}),{code:'operations_file_cleanup_plan_changed'});
 const fresh=await prepare(),operationId=randomUUID(),result=await tools.executePrepared(admin,fresh,{authorize,operationId});
 assert.equal(result.state,'completed');assert.equal(result.receipt.state,'queued');assert.equal(result.receipt.planId,plan.id);assert(result.summary.includes('已批准'));assert(!result.summary.includes('已删除'));assert.equal(storageCalls,0);
 for(let n=0;n<2;n++){const recovered=await tools.recoverPrepared(admin,fresh,operationId);assert.equal(recovered.state,'completed');assert.equal(recovered.receipt.state,'queued');}
 assert.equal((await tools.executePrepared(admin,fresh,{authorize,operationId})).receipt.replayed,true);
 assert.equal((await tools.recoverPrepared(admin,fresh,randomUUID())).state,'not-recorded');
 await assert.rejects(tools.recoverPrepared(admin,{...fresh,request:{...request,planId:randomUUID()}},operationId),{code:'operations_agentos_operation_conflict'});
 await assert.rejects(tools.recoverPrepared(admin,{...fresh,command:{expectedRevision:fresh.command.expectedRevision+1}},operationId),{code:'operations_agentos_operation_conflict'});
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE action='file-cleanup-approve' AND operation_id=$1",[operationId])).rows[0].n,1,'original GET/replay have one approval effect');
 await assert.rejects(prepare(),{code:'operations_agentos_operation_unavailable'});
 // A reader's actual PG grant can authorize this human action; a forged role
 // snapshot cannot. Revoking that same grant also blocks original recovery.
 const role=(await current.permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'具体清理批准',description:'',enabled:true,permissions:['workbench.read','files.read','files.cleanup.approve']},{authorize})).role;
 const assignment=(await current.permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:reader.operatorId,roleId:role.id,enabled:true},{authorize})).assignment;
 const second=(await cleanup.create(admin,{operationId:randomUUID(),items:[{kind:candidates[0].kind,id:candidates[0].id,expectedVersion:candidates[0].expectedVersion}]},{authorize})).plan,
  secondRequest={kind:'file-cleanup-approve',planId:second.id},readerProposal=await tools.prepareFor(reader,'maintenance',secondRequest),readerOperation=randomUUID();
 await assert.rejects(tools.executePrepared(reader,readerProposal,{authorize:async()=>other,operationId:readerOperation}),{code:'business_admin_denied'});
 await tools.executePrepared(reader,readerProposal,{authorize:async()=>reader,operationId:readerOperation});
 await assert.rejects(tools.recoverPrepared(admin,readerProposal,readerOperation),{code:'operations_agentos_operation_conflict'});
 await current.permissions.saveAssignment(admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:reader.operatorId,roleId:role.id,enabled:false},{authorize});
 await assert.rejects(tools.recoverPrepared({...reader,role:'administrator'},readerProposal,readerOperation),{code:'operations_permission_denied'});
 assert.equal(storageCalls,0);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM chat_attachments WHERE purged_at IS NOT NULL')).rows[0].n,0);
});
