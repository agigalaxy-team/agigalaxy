import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {OperationsPermissionsService} from '../src/operations/permissions/service.mjs';
import {operationsPermissionCatalog as catalog,operationsPermissionCodes} from '../src/operations-permission-catalog.mjs';
import {copyRoleDraft,roleDraft,roleMerge,permissionFilterItems,permissionSelectScope,permissionScopeState,permissionRoleTemplates,personPermissionImpact,permissionOperationResult,permissionOperationSelection,permissionHistoryQuery,permissionsLocation,automationDraft,automationSaveBody,permissionScopeLabel,permissionHistoryDeltaLines} from '../../../apps/galaxy-admin/src/lib/permissions-view-model.ts';

// Real local PostgreSQL semantics and galaxy_api column rights. Only the current
// upstream management directory is an explicit double. Pure UI helpers consume
// actual service receipts; this is not OIDC/HTTP/browser or production evidence.
test('permission management preserves scoped drafts and current impacts, filters real personnel history and recovers a committed self-revoke without another write',{timeout:90000},async t=>{
 const allowed=new Set(operationsPermissionCodes),selected=['content.read','notices.read'];
 const visible=permissionFilterItems(catalog,selected,{query:'下架',group:'content',selectedOnly:false});
 assert(visible.length>0);assert(visible.every(item=>item.group==='content'&&item.label.includes('下架')));
 const all=permissionSelectScope(selected,visible,'all',allowed);assert(all.includes('notices.read'));
 const cleared=permissionSelectScope(all,visible,'clear',allowed);assert.deepEqual(cleared,selected);
 assert.deepEqual(permissionSelectScope(all,visible,'invert',allowed),selected);
 const group=catalog.filter(item=>item.group==='content');assert.equal(permissionScopeState(group,selected,allowed).indeterminate,true);
 const automated=permissionSelectScope([],catalog,'all',allowed,true);assert(automated.every(code=>!catalog.find(item=>item.code===code).humanOnly));
 const narrow=permissionSelectScope([],catalog,'all',new Set(['content.read']));assert.deepEqual(narrow,['content.read']);
 assert(permissionRoleTemplates.every(template=>template.permissions.every(code=>allowed.has(code))));
 const beforeTemplate=permissionRoleTemplates.map(item=>[...item.permissions]);
 const futureCatalog=[...catalog,{code:'future.unapproved',group:'content',groupLabel:'公开内容',label:'未来动作',sensitive:false,humanOnly:false}];
 assert.deepEqual(permissionRoleTemplates.map(item=>[...item.permissions]),beforeTemplate);assert(!permissionRoleTemplates.some(item=>item.permissions.includes(futureCatalog.at(-1).code)));

 const db=new PGlite();t.after(()=>db.close());await migrate(db);
 const endpoint='https://permission-management.example',time='2030-01-01T00:00:00.000Z',now=()=>1893456000;
 const admin={kind:'business-operator',operatorId:'management-admin',endpoint},manager={...admin,operatorId:'management-reader'},person={...admin,operatorId:'target-reader'},other={...admin,operatorId:'other-reader'};
 const upstream=new Map([[admin.operatorId,'administrator'],[manager.operatorId,'reader'],[person.operatorId,'reader'],[other.operatorId,'reader']]);
 for(const actor of [admin,manager,person,other])await db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://manager.example',$1,$3,$4,$4)",[actor.operatorId,endpoint,actor.operatorId===admin.operatorId?'授权管理者':actor.operatorId===person.operatorId?'目标人员':'当前成员',time]);
 const permissions=new OperationsPermissionsService({db,endpoint,operatorAuthorization:async actor=>upstream.get(actor.operatorId),now}),options={authorize:async()=>admin};
 const make=async(name,codes)=>(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name,description:'真实权限服务合成资料',enabled:true,permissions:codes},options)).role;
 const assign=async(role,target)=>(await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:target.operatorId,roleId:role.id,enabled:true},options)).assignment;
 const management=await make('可自行调整的角色',['permissions.read','permissions.roles.write','permissions.assignments.write','content.read']);await assign(management,manager);
 const viewing=await make('查看权限',['permissions.read','content.read']),notices=await make('消息查看',['content.read','notices.read']);
 await assign(viewing,other);const first=await assign(viewing,person),second=await assign(notices,person);
 const personBefore=(await permissions.personnel(admin)).items.find(item=>item.operatorId===person.operatorId);
 const impact=personPermissionImpact(personBefore,[management,viewing,notices],{assignment:{roleId:notices.id,enabled:false}});
 assert.deepEqual(impact.removed,['notices.read']);assert(impact.retained.includes('content.read'));
 assert.equal(personPermissionImpact({...personBefore,authorizationState:'unknown',effective:null},[viewing,notices],{assignment:{roleId:notices.id,enabled:false}}).state,'unknown');
 assert.equal(personPermissionImpact({...personBefore,effective:{...personBefore.effective,source:'upstream-administrator'}},[viewing,notices],{role:{...viewing,enabled:false}}).state,'upstream');
 const draft=roleDraft(notices);draft.name='我的名称';draft.permissions.push('jobs.read');
 const current={...notices,version:2,name:'其他人的名称',description:'其他人补充说明',permissions:[...notices.permissions,'resources.read']};
 const conflict=roleMerge(draft,current);assert.equal(conflict.unresolved,1);assert.equal(conflict.conflicts[0].key,'name');assert.equal(draft.baseVersion,1);
 const merged=roleMerge(draft,current,{name:'mine'});assert.equal(merged.unresolved,0);assert.equal(merged.draft.baseVersion,2);assert.equal(merged.draft.name,'我的名称');assert.equal(merged.draft.description,'其他人补充说明');assert(merged.draft.permissions.includes('resources.read'));assert(merged.draft.permissions.includes('jobs.read'));
 const copied=copyRoleDraft(notices);assert.equal(copied.id,null);assert.equal(copied.baseVersion,0);assert.deepEqual(copied.permissions,notices.permissions);assert.notEqual(copied.permissions,notices.permissions);assert.equal('assignments' in copied,false);
 const legacyGrant={id:randomUUID(),name:'旧范围',executorKind:'ai',mode:'assisted',enabled:false,version:2,permissions:['content.read'],resourceIds:[],executionState:'not-connected',executionAvailable:false,createdAt:time,updatedAt:time};
 const legacyDraft=automationDraft(legacyGrant);assert.equal(legacyDraft.resourceScope.kind,'unresolved');assert.equal(automationSaveBody({...legacyDraft,name:'仅改名称'},catalog).resourceScope.kind,'unresolved');
 assert.equal(automationSaveBody({...automationDraft(),name:'未选范围'},catalog),null);
 assert.equal(permissionScopeLabel([]),'对象范围未确定');assert(permissionScopeLabel({kind:'eligible'}).includes('后续新对象'));
 const oldDelta={delta:{kind:'automation',permissions:{added:[],removed:[]},enabled:{before:false,after:false},scope:{before:[],after:{kind:'eligible'}},mode:{before:'assisted',after:'assisted'},executorKind:{before:'ai',after:'ai'}}};
 const scopeLine=permissionHistoryDeltaLines(oldDelta,catalog).find(line=>line.label==='对象范围');assert(scopeLine.text.includes('未确定'));assert(scopeLine.text.includes('后续新对象'));

 await migrate(db,{roles:['api']});await db.exec('SET ROLE galaxy_api');
 const targetQuery={targetOperatorId:person.operatorId,limit:1},page=await permissions.history(admin,targetQuery);assert.equal(page.items.length,1);assert.equal(page.items[0].delta.operatorId,person.operatorId);assert.equal(page.items[0].operatorDisplayName,'授权管理者');assert.equal(page.items[0].assignmentOperatorDisplayName,'目标人员');assert(page.nextAfter);
 const next=await permissions.history(admin,{...targetQuery,after:page.nextAfter});assert.equal(next.items.length,1);assert.equal(next.items[0].delta.operatorId,person.operatorId);assert.equal(next.nextAfter,null);
 assert.deepEqual(new Set([page.items[0].resourceId,next.items[0].resourceId]),new Set([first.id,second.id]));
 assert.equal((await permissions.history(admin,{...targetQuery,resourceId:randomUUID()})).items.length,0);
 await assert.rejects(permissions.history(admin,{targetOperatorId:'foreign-person'}),{code:'operations_person_not_found'});
 const location=permissionsLocation({tab:'personnel',id:person.operatorId}),params=new URLSearchParams(permissionHistoryQuery(location,undefined,person.operatorId));assert.equal(params.get('targetOperatorId'),person.operatorId);assert.equal(params.has('resourceId'),false);
 const input={operationId:randomUUID(),id:management.id,expectedVersion:management.version,name:management.name,description:management.description,enabled:true,permissions:['permissions.read']};
 const result=await permissions.saveRole(manager,input,{authorize:async()=>manager});assert.equal(result.role.version,2);assert.deepEqual((await permissions.effective(manager)).permissions,['permissions.read']);
 await assert.rejects(permissions.saveRole(manager,input,{authorize:async()=>manager}),{code:'operations_permission_denied'});
 const count=(await db.query('SELECT count(*)::int AS n FROM operations_permission_events_v1')).rows[0].n;
 const receipt=await permissions.operation(manager,input.operationId);assert.equal(receipt.state,'recorded');assert.equal(receipt.result.role.version,2);assert.deepEqual(receipt.selection,permissionOperationSelection('role-save',input));assert.equal(receipt.result.replayed,true);assert.equal(Object.hasOwn(receipt,'input'),false);assert.equal(Object.hasOwn(receipt.result,'delta'),false);
 const intent={path:'/v1/operations/permissions/roles',body:input};assert.equal(permissionOperationResult(receipt,intent,manager.operatorId).operationId,input.operationId);
 for(const changed of [{...input,name:'错的名称'},{...input,description:'错的说明'},{...input,enabled:false},{...input,expectedVersion:99},{...input,permissions:['permissions.read','content.read']}])assert.equal(permissionOperationResult(receipt,{...intent,body:changed},manager.operatorId),null);
 assert.equal(permissionOperationResult({...receipt,operatorId:other.operatorId},intent,manager.operatorId),null);
 assert.equal(permissionOperationResult({...receipt,selection:{...receipt.selection,extra:'not closed'}},intent,manager.operatorId),null);
 assert.equal((await permissions.operation(manager,randomUUID())).state,'not-recorded');
 await assert.rejects(permissions.operation(other,input.operationId),{code:'operations_permissions_operation_not_found'});
 await assert.rejects(permissions.operation({...manager,endpoint:'https://other.example'},input.operationId),{code:'business_admin_denied'});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM operations_permission_events_v1')).rows[0].n,count,'original receipt reads do not create a new permission write');
 await permissions.saveRole(admin,{...input,operationId:randomUUID(),expectedVersion:2,permissions:[]},options);
 await assert.rejects(permissions.operation(manager,input.operationId),{code:'operations_permission_denied'});
});
