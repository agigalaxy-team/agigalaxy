import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {OperationsFeedbackService} from '../src/operations-feedback.mjs';
import {dispatchOperationsFeedback} from '../src/adapters/http/operations-feedback-http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {attachOperationsFixtureAuthority} from './fixtures/operations-authority.mjs';
import {operationsProxyRequestPolicy,operationsReadPath} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';

// The database, API role, business roles, event transaction, receipt reader,
// loopback HTTP adapter and BFF admission rules are the real implementation.
// Only the upstream operator directory and HTTP session are local doubles.
// No external account, production record, model or old test group is used.
test('feedback lost acknowledgements read only the original owner operation through current read authority',{timeout:90000},async t=>{
 const db=new PGlite();t.after(()=>db.close());await migrate(db,{roles:['api']});
 const now=()=>2000000000,stamp=()=>new Date(now()*1000).toISOString(),endpoint='https://feedback-flow.example.invalid';
 const admin={kind:'business-operator',operatorId:'feedback-root',role:'administrator',endpoint},member={...admin,operatorId:'feedback-member',role:'reader'},other={...member,operatorId:'feedback-other'};
 const account=randomUUID(),feedbackId=randomUUID(),secondId=randomUUID(),privateBody='本次私有问题正文不进入结果回执',privateNote='本次内部处理备注不进入结果回执';
 await db.query("INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,'G00000000001',$2,'https://website.example.invalid','local-feedback-owner','email',$3,$3)",[account,endpoint,stamp()]);
 await db.query("INSERT INTO official_account_profiles_v1(account_id,display_name,subject_type,updated_at) VALUES($1,'林间','person',$2)",[account,stamp()]);
 for(const id of [feedbackId,secondId])await db.query(`INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,submitted_category,submitted_module,category,module,state,revision,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,'搜索使用问题',$6,'problem','discovery','problem','discovery','pending',1,$7,$7)`,[id,endpoint,account,randomUUID(),'a'.repeat(64),privateBody,stamp()]);
 for(const actor of [admin,member,other])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://management.example.invalid',$1,'本地管理成员',$3,$3)",[actor.operatorId,endpoint,stamp()]);
 const businessAdmin=new BusinessAdminService({db,endpoint,now}),service=new OperationsFeedbackService({businessAdmin,accounts:null,now}),authority=await attachOperationsFixtureAuthority({businessAdmin,admin,reader:member,permissions:['feedback.read','feedback.update']});
 authority.roles.set(other.operatorId,'reader');
 await authority.permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:other.operatorId,roleId:(await db.query('SELECT role_id FROM operations_role_assignments_v1 WHERE endpoint=$1 AND operator_id=$2',[endpoint,member.operatorId])).rows[0].role_id,enabled:true},{authorize:async()=>admin});
 const role=(await db.query('SELECT r.id,r.version FROM operations_business_roles_v1 r JOIN operations_role_assignments_v1 a ON a.role_id=r.id WHERE a.endpoint=$1 AND a.operator_id=$2',[endpoint,member.operatorId])).rows[0];
 await db.exec('SET ROLE galaxy_api');assert.equal((await db.query('SELECT current_user AS role')).rows[0].role,'galaxy_api');
 let actor=member,writes=0;const actions=[];
 const server=createServer(async(request,response)=>{try{
  const url=requestUrl(request,endpoint),handled=await dispatchOperationsFeedback({operationsFeedback:service,request,response,requestId:randomUUID(),url,
   authorizeOperator:async(req,{write,action})=>{actions.push(action);if(write){assert.equal(req.headers['x-local-csrf'],'current-session');writes++;}return actor;},
   send:(status,value)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));}});
  if(!handled){response.writeHead(404);response.end('{}');}
 }catch(error){response.writeHead(error.status??500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:error.code??'local_fixture_failed'}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const origin='http://127.0.0.1:'+server.address().port;
 const read=async path=>{const r=await fetch(origin+path);return{status:r.status,value:await r.json()};};
 const post=async(path,input)=>{const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Local-CSRF':'current-session'},body:JSON.stringify(input)});return{status:r.status,value:await r.json()};};
 const operationId=randomUUID(),base='/v1/operations/feedback/'+feedbackId,path=base+'/operations/'+operationId,input={operationId,expectedRevision:1,category:'suggestion',state:'processing',note:privateNote};
 const empty=await read(path);assert.equal(empty.status,200);assert.equal(empty.value.state,'not-recorded');assert.equal(empty.value.selection,null);assert.equal(empty.value.metadataOnly,true);
 const changed=await post(base+'/events',input);assert.equal(changed.status,200);assert.equal(changed.value.feedback.revision,2);assert.equal(changed.value.history.items[0].note,privateNote);
 const original=await read(path);assert.equal(original.status,200);assert.equal(original.value.state,'recorded');assert.equal(original.value.action,'feedback-update');assert.equal(original.value.feedbackId,feedbackId);assert.equal(original.value.operationId,operationId);assert.equal(original.value.readExpiresAt,now()+30);
 assert.deepEqual(original.value.selection,{expectedRevision:1,category:'suggestion',state:'processing',noteHash:createHash('sha256').update(privateNote).digest('hex')});
 assert.deepEqual(original.value.result,{feedbackId,revision:2,operationId,recordedAt:stamp()});
 const wire=JSON.stringify(original.value);assert.equal(wire.includes(privateBody),false);assert.equal(wire.includes(privateNote),false);assert.equal(wire.includes(account),false);
 assert.equal((await read('/v1/operations/feedback/'+secondId+'/operations/'+operationId)).status,404);
 actor=other;assert.equal((await read(path)).status,404,'another currently authorized reader cannot adopt the original operator receipt');actor=admin;assert.equal((await read(path)).status,404);actor=member;
 const proxy=search=>operationsProxyRequestPolicy({url:endpoint+path+search,method:'GET',headers:new Headers({host:'feedback-flow.example.invalid',origin:endpoint,'sec-fetch-site':'same-origin'}),publicOrigin:endpoint});
 assert.equal(proxy('').allowed,true);assert.equal(proxy('?after=1').allowed,false);assert.equal(operationsReadPath(path),true);assert.equal(operationsReadPath(path+'?after=1'),false);
 assert.equal((await read(path+'?after=1')).status,400);assert.equal((await post(path,{})).status,404);
 const later=await post(base+'/events',{operationId:randomUUID(),expectedRevision:2,state:'closed'});assert.equal(later.status,200);assert.equal(later.value.feedback.revision,3);
 assert.equal((await read(path)).value.result.revision,2,'original immutable receipt is not rewritten as the latest object state');
 await authority.permissions.saveRole(admin,{operationId:randomUUID(),id:role.id,expectedVersion:role.version,name:'反馈结果只读',description:'',enabled:true,permissions:['feedback.read']},{authorize:async()=>admin});
 assert.equal((await read(path)).status,200,'withdrawn write permission still allows current read recovery');
 assert.equal((await post(base+'/events',{operationId:randomUUID(),expectedRevision:3,state:'processing'})).status,403);
 const deletion=randomUUID();
 await db.query(`INSERT INTO account_feedback_data_operations_v1(operation_id,endpoint,account_id,kind,cutoff_sequence,state,feedback_count,attachment_count,created_at,updated_at)
 VALUES($1,$2,$3,'delete',(SELECT sequence FROM operations_feedback_v1 WHERE id=$4),'pending',1,0,$5,$5)`,[deletion,endpoint,account,feedbackId,stamp()]);
 await db.query('SELECT public.galaxy_account_erase_feedback_data($1,$2,$3)',[endpoint,account,deletion]);
 assert.equal((await service.get(member,feedbackId).catch(error=>error)).code,'not_found');assert.equal((await read(path)).status,200,'metadata proves the original result after prose removal without projecting the prose');
 await db.exec('RESET ROLE');await db.query("UPDATE business_admin_audit_v1 SET result=result||'{\"unexpected\":true}'::jsonb WHERE operation_id=$1",[operationId]);await db.exec('SET ROLE galaxy_api');
 assert.equal((await read(path)).status,503,'malformed or expanded audit result must not be accepted as confirmation');
 const version=(await db.query('SELECT version FROM operations_business_roles_v1 WHERE id=$1',[role.id])).rows[0].version;
 await authority.permissions.saveRole(admin,{operationId:randomUUID(),id:role.id,expectedVersion:version,name:'反馈读权已撤回',description:'',enabled:false,permissions:['feedback.read']},{authorize:async()=>admin});
 assert.equal((await read(path)).status,403);assert.equal((await db.query('SELECT revision FROM operations_feedback_v1 WHERE id=$1',[feedbackId])).rows[0].revision,4,'the real owner erasure advances revision once, receipt GETs do not');assert.equal((await db.query('SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',[endpoint,operationId])).rows[0].n,1);
 assert.equal(writes,3,'two accepted commands and one currently denied attempt; original GET recovery never reissues a command');assert.ok(actions.filter(value=>value==='feedback.read').length>=10);
});
