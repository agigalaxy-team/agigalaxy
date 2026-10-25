import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {dispatchBusinessAdmin} from '../src/adapters/http/business-admin-http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {operationsProxyRequestPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';
import {businessUserEmptyDraft,businessUserOriginalReceipt,businessUserPendingReceipt,businessUserReceiptPath,businessUserReviewType,businessUserWriteResult,businessUsersDraftSnapshot} from '../../../apps/galaxy-admin/src/lib/business-users-draft-memory.ts';

// Real PG migrations/API role/current PG role permissions, original business
// methods, exact receipt queries and loopback HTTP adapter. Only the upstream
// operator directory and HTTP session/CSRF authority are explicit local doubles.
// No real identity, provider, production data or existing test group is used.
test('business user forms recover only the same owner target action and immutable input through current read permission',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
 const now=()=>2000000000,stamp=seconds=>new Date(seconds*1000).toISOString(),endpoint='https://business-flow.example.invalid',foreign='https://foreign-flow.example.invalid';
 const admin={kind:'business-operator',operatorId:'flow-root',role:'administrator',endpoint},reader={...admin,operatorId:'flow-member',role:'reader'},other={...admin,operatorId:'flow-other',role:'reader'},ids=[randomUUID(),randomUUID(),randomUUID()];
 for(const[index,id]of ids.entries()){await db.query("INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,'https://website.example.invalid',$4,'email',$5,$5)",[id,'G0000000000'+(index+1),index===2?foreign:endpoint,'local-subject-'+index,stamp(now())]);await db.query("INSERT INTO official_account_profiles_v1(account_id,display_name,subject_type,updated_at) VALUES($1,$2,'person',$3)",[id,index?'周若川':'林以安',stamp(now())]);}
 for(const actor of [admin,reader,other])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.example.invalid',$1,'本地管理成员',$3,$3)",[actor.operatorId,endpoint,stamp(now())]);
 const service=new BusinessAdminService({db,endpoint,now}),authority=await attachOperationsFixtureAuthority({businessAdmin:service,admin,reader,permissions:['accounts.read','accounts.type.change','accounts.restriction.apply','accounts.restriction.release']});authority.roles.set(other.operatorId,'reader');
 const memberRole=(await db.query("SELECT r.id,r.version FROM operations_business_roles_v1 r JOIN operations_role_assignments_v1 a ON a.role_id=r.id WHERE a.endpoint=$1 AND a.operator_id=$2",[endpoint,reader.operatorId])).rows[0];
 await db.exec('SET ROLE galaxy_api');assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'galaxy_api');
 let currentActor=reader,writes=0;const requestedActions=[];
 const server=createServer(async(req,res)=>{try{const url=requestUrl(req,endpoint),result=await dispatchBusinessAdmin({businessAdmin:service,authorizeOperator:async(request,{action,write})=>{requestedActions.push(action);if(write){assert.equal(request.headers['x-fixture-csrf'],'current-local-session');writes++;}return currentActor;},request:req,requestId:randomUUID(),url,send:(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}});if(!result){res.writeHead(404);res.end('{}');}}catch(error){res.writeHead(error.status??500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.code??'local_fixture_failed'}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const origin='http://127.0.0.1:'+server.address().port;
 const read=async path=>{const r=await fetch(origin+path);return{status:r.status,value:await r.json()};},post=async(path,body)=>{const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Fixture-CSRF':'current-local-session'},body:JSON.stringify(body)});return{status:r.status,value:await r.json()};};
 const accountPath='/v1/operations/users/'+ids[0],original=randomUUID(),input={operationId:original,expectedRevision:0,until:stamp(now()+600),reason:'本次本地完整流程检查'},path=accountPath+'/operations/'+original;
 const initial=await read(path);assert.equal(initial.status,200);assert.equal(initial.value.state,'not-recorded');assert.equal(initial.value.selection,null);assert.equal(initial.value.result,null);assert.equal(initial.value.accountId,ids[0]);
 const applied=await post(accountPath+'/restriction',input);assert.equal(applied.status,200);assert.equal(applied.value.restriction.active,true);
 const locator={operationId:original,kind:'restriction-set',accountId:ids[0],registrationId:randomUUID()},receipt=await read(path);assert.equal(receipt.status,200);assert.deepEqual(receipt.value.selection,input);assert.equal(receipt.value.state,'recorded');assert.equal(receipt.value.readExpiresAt,now()+30);assert.equal(receipt.value.metadataOnly,true);
 assert.ok(businessUserWriteResult(applied.value,locator,input));assert.ok(businessUserOriginalReceipt(receipt.value,locator,input,now()));
 for(const mismatch of [{...locator,accountId:ids[1]},{...locator,kind:'restriction-release'},{...locator,operationId:randomUUID()}])assert.equal(businessUserOriginalReceipt(receipt.value,mismatch,input,now()),null);
 for(const change of [{...input,expectedRevision:1},{...input,reason:'另一项处理原因'},{...input,until:stamp(now()+700)},{...input,extra:'not-allowed'}])assert.equal(businessUserOriginalReceipt(receipt.value,locator,change,now()),null);
 assert.equal(businessUserOriginalReceipt({...receipt.value,readExpiresAt:now()},locator,input,now()),null);assert.equal(businessUserOriginalReceipt({...receipt.value,result:{...receipt.value.result,secret:'must-not-project'}},locator,input,now()),null);
 assert.equal(businessUserPendingReceipt({...locator,body:input}),null);assert.equal(businessUserReceiptPath(locator),path);assert.equal(businessUserPendingReceipt({...locator,registrationId:'arbitrary-path'}),null);
 const proxy=search=>operationsProxyRequestPolicy({url:endpoint+path+search,method:'GET',headers:new Headers({host:'business-flow.example.invalid',origin:endpoint,'sec-fetch-site':'same-origin'}),publicOrigin:endpoint});
 assert.equal(proxy('').allowed,true);assert.equal(proxy('?limit=1').allowed,false);assert.equal(operationsReadPath(path),true);assert.equal(operationsReadPath(path+'?after=1'),false);
 assert.equal((await read(path+'?limit=1')).status,400);assert.equal((await post(path,{})).status,404);
 currentActor=other;assert.equal((await read(path)).status,403,'other principal still needs actual accounts.read');currentActor=admin;assert.equal((await read(path)).status,404,'root cannot read another operator original as its own');currentActor=reader;assert.equal((await read('/v1/operations/users/'+ids[1]+'/operations/'+original)).status,404);assert.equal((await read('/v1/operations/users/'+ids[2]+'/operations/'+original)).status,404);
 const releaseId=randomUUID(),released=await post(accountPath+'/restriction/release',{operationId:releaseId,expectedRevision:1,reason:'本次本地检查完成解除'});assert.equal(released.status,200);assert.equal(released.value.restriction.active,false);
 assert.equal((await read(path)).value.result.restriction.active,true,'old receipt preserves the original, never rewrites current state');assert.equal((await service.get(reader,ids[0])).account.restriction.revision,2);
 const beforeType=await service.get(reader,ids[0]),typeId=randomUUID(),typeInput={operationId:typeId,expectedRevision:beforeType.profile.revision,subjectType:'organization',reason:'依据本人明确更正声明',basis:'同一次本地合成账户声明资料',preserveHistory:true},changed=await post(accountPath+'/type-change',typeInput);assert.equal(changed.status,200);assert.equal(changed.value.permissionsChanged,false);
 const typeLocator={operationId:typeId,kind:'type-change',accountId:ids[0]},typeRead=await read(accountPath+'/operations/'+typeId);assert.ok(businessUserOriginalReceipt(typeRead.value,typeLocator,typeInput,now()));
 const initialDraft=businessUserEmptyDraft(beforeType),authored={...initialDraft,nextType:'agent',typeReason:'保留当前输入的更正理由',basis:'依据当前账户声明及原历史'};
 assert.equal(businessUserReviewType(authored,{...beforeType,account:{...beforeType.account,subjectType:'organization'},profile:{...beforeType.profile,revision:beforeType.profile.revision+1}}),null);
 const reviewed=businessUserReviewType(authored,{...beforeType,account:{...beforeType.account,subjectType:'organization'},profile:{...beforeType.profile,revision:beforeType.profile.revision+1}},'current');assert.equal(reviewed.nextType,'organization');assert.equal(reviewed.typeReason,authored.typeReason);assert.equal(authored.profileRevision,beforeType.profile.revision);
 assert.throws(()=>businessUsersDraftSnapshot({drafts:{[ids[0]]:authored},rawBody:input}));assert.deepEqual(businessUsersDraftSnapshot({drafts:{[ids[0]]:authored},foreign:'discard'}).drafts[ids[0]],authored);
 await authority.permissions.saveRole(admin,{operationId:randomUUID(),id:memberRole.id,expectedVersion:memberRole.version,name:'本次只读结果恢复',description:'',enabled:true,permissions:['accounts.read']},{authorize:async()=>admin});
 assert.equal((await read(path)).status,200,'write permission removal does not remove current read recovery');assert.equal((await post(accountPath+'/restriction',{...input,operationId:randomUUID(),expectedRevision:2})).status,403);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[endpoint,original])).rows[0].count,1);
 const version=(await db.query('SELECT version FROM operations_business_roles_v1 WHERE id=$1',[memberRole.id])).rows[0].version;
 await authority.permissions.saveRole(admin,{operationId:randomUUID(),id:memberRole.id,expectedVersion:version,name:'本次读权已撤回',description:'',enabled:false,permissions:['accounts.read']},{authorize:async()=>admin});
 assert.equal((await read(path)).status,403);assert.ok(requestedActions.includes('accounts.read'));assert.equal((await db.query('SELECT restriction_revision FROM community_accounts WHERE id=$1',[ids[0]])).rows[0].restriction_revision,2);assert.equal(writes,4,'three valid commands plus one current denied write; no GET or malformed-route replays');
});

