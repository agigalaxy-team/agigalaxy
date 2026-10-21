import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OfficialAccountData} from '../src/official-account-data.mjs';
import {CommunityAccountRegistry} from '../src/community-accounts.mjs';
import {dispatchBusinessAdmin} from '../src/adapters/http/business-admin-http.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real SQL and domain commands. The identity directory is an explicit contract,
// not evidence of a live Keycloak administration connection.
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const endpoint='https://official.example.org',issuer='https://issuer.example.org',ids=[randomUUID(),randomUUID(),randomUUID()];let clock=2000000000,offline=false;
 const identities=new Map();
 for(let index=0;index<ids.length;index++){
  const externalSubject='synthetic-operator-account-'+index,at=new Date(clock*1000).toISOString();
  await db.query(`INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
   VALUES($1,$2,$3,$4,$5,'email',$6,$6)`,[ids[index],'G0000000000'+(index+1),endpoint,issuer,externalSubject,at]);
  await db.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,'person',$2,$3)`,[ids[index],['测试甲','测试乙','测试丙'][index],at]);
  identities.set(externalSubject,{issuer,externalSubject,email:'synthetic-'+index+'@example.org',emailVerified:true,enabled:true});
 }
 const directory={async findByEmail(email){if(offline)throw Error('directory offline');return[...identities.values()].filter(row=>row.email.toLowerCase()===email.toLowerCase());},async get({issuer:requested,externalSubject}){if(offline)throw Error('directory offline');return requested===issuer?identities.get(externalSubject)??null:null;}};
 const now=()=>clock,service=new BusinessAdminService({db,endpoint,identityDirectory:directory,now});
 const actor={kind:'business-operator',operatorId:issuer+'|synthetic-operator',role:'administrator',endpoint,httpRequestId:randomUUID()};
 return{db,ids,endpoint,now,service,actor,reader:{...actor,role:'reader'},directory,identities,offline:()=>{offline=true;},advance:seconds=>{clock+=seconds;},owner:{kind:'official-account',accountId:ids[0],endpoint}};
}

test('operations readers find business accounts by UID, username or verified directory email without gaining private content',{timeout:60000},async t=>{
 const f=await fixture(t),owner=new OfficialAccountData({db:f.db,endpoint:f.endpoint,now:f.now});
 const archive={id:randomUUID(),title:'DO_NOT_READ_PRIVATE_TITLE',selection:{workspaceId:null,sessionIds:['synthetic-private']},uploadLevel:'conversation-archive',includeFullConversation:true};
 await owner.createArchive(f.owner,archive);await owner.appendChunk(f.owner,{id:archive.id,sequence:0,content:'DO_NOT_READ_PRIVATE_BODY'});
 assert.equal((await f.service.list(f.reader,{query:'g00000000001'})).items[0].accountId,f.ids[0]);
 assert.equal((await f.service.list(f.reader,{query:'测试乙'})).items[0].accountId,f.ids[1]);
 const byEmail=await f.service.list(f.reader,{query:'synthetic-1@example.org'});
 assert.equal(byEmail.items.length,1);assert.equal(byEmail.items[0].accountId,f.ids[1]);assert.equal(byEmail.items[0].identity.email,'synthetic-1@example.org');
 const detail=await f.service.get(f.reader,f.ids[0]);assert.equal(detail.account.uid,'G00000000001');assert.equal(detail.permissions.canManage,false);
 assert.equal(detail.linkedIds.items.length,0);assert.equal(JSON.stringify(detail).includes('DO_NOT_READ_PRIVATE'),false);
 await assert.rejects(owner.listArchives(f.reader),{code:'official_account_login_required'});
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM subjects')).rows[0].n,0,'operator access never creates a Galaxy principal');
 const audit=await f.service.audit(f.reader,{accountId:f.ids[0]});assert.equal(audit.items.some(row=>row.action==='user-read'&&row.operatorId===f.actor.operatorId),true);
 assert.equal(JSON.stringify(await f.service.audit(f.reader)).includes('synthetic-1@example.org'),false,'search audit stores the selection kind, not a copy of the email query');
});

test('immutable UID pagination survives deletion, while directory outages remain distinct from an absent account',{timeout:60000},async t=>{
 const f=await fixture(t),first=await f.service.list(f.actor,{limit:1});assert.equal(first.nextAfter,'G00000000001');
 await f.db.query('DELETE FROM official_account_profiles_v1 WHERE account_id=$1',[f.ids[0]]);await f.db.query('DELETE FROM community_accounts WHERE id=$1',[f.ids[0]]);
 assert.equal((await f.service.list(f.actor,{after:first.nextAfter,limit:1})).items[0].uid,'G00000000002');
 f.offline();const current=await f.service.get(f.reader,f.ids[1]);assert.equal(current.account.identity.state,'temporarily-unavailable');assert.equal(current.account.identity.email,null);
 await assert.rejects(f.service.list(f.actor,{query:'synthetic-1@example.org'}),{code:'identity_directory_unavailable'});
 assert.equal((await f.service.audit(f.reader)).items.some(row=>row.result.accountIds?.includes(f.ids[0])),true,'necessary audit metadata survives account removal');
});

test('account restrictions are bounded in time, enforced by existing participation gates and retried without repeating a command',{timeout:60000},async t=>{
 const f=await fixture(t),input={operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+60)*1000).toISOString(),reason:'运营处理测试原因'};
 const restricted=await f.service.restrict(f.actor,f.ids[0],input);assert.equal(restricted.restriction.active,true);assert.equal(restricted.restriction.revision,1);
 assert.equal((await f.service.restrict(f.actor,f.ids[0],input)).replayed,true);
 await assert.rejects(f.service.restrict(f.actor,f.ids[0],{...input,reason:'不能替换原来的原因'}),{code:'business_admin_operation_conflict'});
 const registry=new CommunityAccountRegistry({db:f.db,endpoint:f.endpoint,now:f.now});
 await assert.rejects(registry.runAuthorized(f.owner,'assistance',async()=>true,{resourceWrite:true}),{code:'community_restricted'});
 assert.equal(await registry.runAuthorized(f.owner,'assistance',async()=>true,{resourceWrite:true,control:true}),true,'restriction does not prevent retraction/control');
 f.advance(61);assert.equal(await registry.runAuthorized(f.owner,'assistance',async()=>true,{resourceWrite:true}),true);
 const records=await f.service.audit(f.reader,{accountId:f.ids[0]});assert.equal(records.items.filter(row=>row.action==='restriction-set').length,1);
 await assert.rejects(f.service.restrict(f.actor,f.ids[0],{...input,operationId:randomUUID(),expectedRevision:1}),{code:'invalid_restriction_expiry'});
});

test('reader and ordinary account principals cannot restrict, release or change types; optimistic release preserves a newer restriction',{timeout:60000},async t=>{
 const f=await fixture(t),restriction={operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+3600)*1000).toISOString(),reason:'待处理的测试限制'};
 await assert.rejects(f.service.restrict(f.reader,f.ids[0],restriction),{code:'business_admin_denied'});
 await assert.rejects(f.service.get(f.owner,f.ids[0]),{code:'business_admin_denied'});
 await assert.rejects(f.service.get({...f.actor,endpoint:'https://other.example.org'},f.ids[0]),{code:'business_admin_denied'});
 await f.service.restrict(f.actor,f.ids[0],restriction);
 await assert.rejects(f.service.releaseRestriction(f.reader,f.ids[0],{operationId:randomUUID(),expectedRevision:1,reason:'测试解除原因'}),{code:'business_admin_denied'});
 await assert.rejects(f.service.releaseRestriction(f.actor,f.ids[0],{operationId:randomUUID(),expectedRevision:0,reason:'测试解除原因'}),{code:'account_restriction_changed'});
 const release=await f.service.releaseRestriction(f.actor,f.ids[0],{operationId:randomUUID(),expectedRevision:1,reason:'复核后解除限制'});
 assert.equal(release.restriction.active,false);assert.equal(release.restriction.until,null);assert.equal(release.restriction.revision,2);
});

test('operator and owner type changes share revision and evidence rules while recording their actual source',{timeout:60000},async t=>{
 const f=await fixture(t),input={operationId:randomUUID(),expectedRevision:0,subjectType:'organization',reason:'根据用户提出的更正申请',basis:'此账户实际由该组织用于发布和维护内容',preserveHistory:true};
 await assert.rejects(f.service.changeType(f.reader,f.ids[0],input),{code:'business_admin_denied'});
 await assert.rejects(f.service.changeType(f.actor,f.ids[0],{...input,basis:'无'}),{code:'invalid_business_admin_request'});
 const changed=await f.service.changeType(f.actor,f.ids[0],input);assert.equal(changed.basisKind,'operator-recorded-statement');assert.equal(changed.permissionsChanged,false);
 assert.equal((await f.service.changeType(f.actor,f.ids[0],input)).replayed,true);
 const owner=new OfficialAccountData({db:f.db,endpoint:f.endpoint,now:f.now});
 await f.db.query('UPDATE official_account_profiles_v1 SET query_enabled=true WHERE account_id=$1',[f.ids[0]]);
 assert.equal((await owner.publicProfile(f.ids[0])).typeSource,'operator-recorded-statement');
 await assert.rejects(owner.changeType(f.owner,{expectedRevision:0,subjectType:'person',reason:'本人申请进行类型更正',basis:'目前由本人独立维护的个人账户',preserveHistory:true}),{code:'account_settings_changed'});
 const own=await owner.changeType(f.owner,{expectedRevision:1,subjectType:'person',reason:'本人申请进行类型更正',basis:'目前由本人独立维护的个人账户',preserveHistory:true});assert.equal(own.basisKind,'account-owner-statement');
 assert.equal((await owner.publicProfile(f.ids[0])).typeSource,'account-owner-statement');
 const detail=await f.service.get(f.reader,f.ids[0]);assert.equal(detail.account.uid,'G00000000001');
 assert.deepEqual(detail.typeHistory.map(row=>[row.actorKind,row.operatorId]),[['account-owner',null],['business-operator',f.actor.operatorId]]);
 const page=await f.service.typeHistory(f.reader,f.ids[0],{limit:1});assert.equal(page.nextAfter,'2');assert.equal((await f.service.typeHistory(f.reader,f.ids[0],{after:page.nextAfter,limit:1})).items[0].actorKind,'business-operator');
});

test('audit pages continue across reads and command IDs cannot be claimed for another account or operator',{timeout:60000},async t=>{
 const f=await fixture(t),input={operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+600)*1000).toISOString(),reason:'测试审计限制记录'};
 await f.service.restrict(f.actor,f.ids[0],input);
 await assert.rejects(f.service.restrict(f.actor,f.ids[1],input),{code:'business_admin_operation_conflict'});
 await assert.rejects(f.service.restrict({...f.actor,operatorId:'another-operator'},f.ids[0],input),{code:'business_admin_operation_conflict'});
 await f.service.get(f.reader,f.ids[0]);const head=await f.service.audit(f.reader,{limit:1});assert.ok(head.nextAfter);
 const next=await f.service.audit(f.reader,{after:head.nextAfter,limit:10});assert.equal(next.items.some(row=>row.action==='restriction-set'),true);
 await assert.rejects(f.service.audit(f.reader,{after:'9999999999999999999'}),{code:'invalid_business_admin_request'});
});

test('operations HTTP always invokes the server authorizer and never accepts a JSON role as authority',{timeout:60000},async t=>{
 const f=await fixture(t),calls=[];
 const request=(method,input)=>Object.assign(Readable.from(input?[Buffer.from(JSON.stringify(input))]:[]),{method,headers:{'content-type':'application/json'}});
 async function dispatch(method,path,input,authorizeOperator){let response;const accepted=await dispatchBusinessAdmin({businessAdmin:f.service,authorizeOperator,request:request(method,input),requestId:randomUUID(),url:new URL(path,f.endpoint),send:(status,body)=>{response={status,body};}});return{accepted,response};}
 await assert.rejects(dispatch('GET','/v1/operations/users',null,async()=>{throw new ServiceError('operator_login_required',401);}),{code:'operator_login_required'});
 await assert.rejects(dispatch('GET','/v1/operations/users',null,undefined),{code:'business_admin_unavailable'});
 const authorize=async(req,context)=>{calls.push(context);return {...f.reader,httpRequestId:context.requestId};};
 const users=await dispatch('GET','/v1/operations/users?limit=1',null,authorize);assert.equal(users.accepted,true);assert.equal(users.response.body.items.length,1);assert.equal(calls[0].write,false);
 await assert.rejects(dispatch('POST','/v1/operations/users/'+f.ids[0]+'/restriction',{role:'administrator',operatorId:f.actor.operatorId,operationId:randomUUID(),expectedRevision:0,until:new Date((f.now()+60)*1000).toISOString(),reason:'伪造请求不能取得权限'},authorize),{code:'business_admin_denied'});
 assert.equal(calls.at(-1).write,true);assert.equal((await f.service.get(f.reader,f.ids[0])).account.restriction.active,false);
 await assert.rejects(dispatch('GET','/v1/operations/users?role=administrator',null,authorize),{code:'invalid_business_admin_request'});
});
