import assert from 'node:assert/strict';
import test from 'node:test';
import {automationDraft,automationSaveBody,nextPermissionHistory,permissionDifference,permissionHistoryQuery,permissionReadCurrent,permissionsHref,permissionsLocation,personPermissionSources,previousPermissionHistory,roleDraft,roleDraftChanged,roleSaveBody} from '../src/lib/permissions-view-model.ts';

const id='a1111111-1111-4111-8111-111111111111',other='b2222222-2222-4222-8222-222222222222';
const actor='a'.repeat(64),time='2026-10-23T02:00:00.000Z';
const catalog=[
 {code:'content.read',label:'读取公开内容',group:'content',groupLabel:'公开内容',sensitive:false,humanOnly:false},
 {code:'chat-reports.materials.read',label:'读取选入材料',group:'chat-reports',groupLabel:'私聊案件',sensitive:true,humanOnly:false},
 {code:'permissions.roles.write',label:'维护业务角色',group:'permissions',groupLabel:'管理授权',sensitive:false,humanOnly:true},
];
const role={id,name:'内容维护',description:'公开内容读取',enabled:true,version:4,permissions:['content.read'],createdAt:time,updatedAt:time};

test('permissions page consumes bounded UI context without turning it into arbitrary API selectors',()=>{
 const location=permissionsLocation({tab:'personnel',id:actor,after:'1',trail:'start,2',role:'administrator',email:'sensitive@example.invalid',query:'private words'});
 assert.equal(location.id,actor);assert.equal(location.tab,'personnel');
 const query=new URLSearchParams(permissionHistoryQuery(location,id));
 assert.deepEqual([...query.keys()].sort(),['after','limit','resourceId']);assert.equal(query.get('resourceId'),id);
 assert.equal(query.get('limit'),'20');
 const href=new URL(permissionsHref(location),'https://admin.invalid');
 assert.equal(href.searchParams.has('role'),false);assert.equal(href.searchParams.has('email'),false);assert.equal(href.searchParams.has('query'),false);
 assert.equal(permissionsLocation({tab:'roles',id:actor}).id,'');
 assert.equal(permissionsLocation({tab:'automatic',id:'new'}).id,'new');
 assert.equal(permissionsLocation({tab:['personnel','roles'],id:other,after:'9223372036854775808',trail:'no,0,9223372036854775808'}).after,'');
});

test('history uses real sequence cursors and preserves the selected record across paging and return',()=>{
 const location=permissionsLocation({tab:'roles',id});
 const next={...location,...nextPermissionHistory(location,'9223372036854775807')};
 assert.equal(next.id,id);assert.deepEqual(next.trail,['start']);
 assert.deepEqual(previousPermissionHistory(next),{after:'',trail:[]});
 assert.deepEqual(nextPermissionHistory(location,'9223372036854775808'),{});
 assert.equal(new URLSearchParams(permissionHistoryQuery(location,'not-a-resource')).has('resourceId'),false);
});

test('role editing preserves its read version until explicit adoption and computes only real catalog differences',()=>{
 const draft=roleDraft(role);draft.name=' 内容查阅 ';draft.permissions=['chat-reports.materials.read'];
 const body=roleSaveBody(draft,catalog);
 assert.equal(body.expectedVersion,4);assert.equal(body.name,'内容查阅');assert.equal(body.id,id);
 const updated={...role,version:5,permissions:['content.read','permissions.roles.write']};
 assert.equal(roleSaveBody(draft,catalog).expectedVersion,4);assert.equal(roleDraftChanged(draft,updated),true);
 assert.deepEqual(permissionDifference(updated.permissions,draft.permissions,catalog).added.map(item=>item.code),['chat-reports.materials.read']);
 assert.deepEqual(permissionDifference(updated.permissions,draft.permissions,catalog).removed.map(item=>item.code),['content.read','permissions.roles.write']);
 assert.equal(roleSaveBody({...draft,baseVersion:updated.version},catalog).expectedVersion,5);
 assert.equal(roleSaveBody({...draft,permissions:['unknown.expression']},catalog),null);
 assert.equal(role.permissions.length,1);
});

test('new business roles have no fabricated id, version or selected permissions',()=>{
 const draft=roleDraft();assert.equal(draft.id,null);assert.equal(draft.baseVersion,0);assert.deepEqual(draft.permissions,[]);
 assert.equal(roleSaveBody(draft,catalog),null);
 const body=roleSaveBody({...draft,name:'新角色'},catalog);assert.equal('id' in body,false);assert.deepEqual(body.permissions,[]);
 assert.equal(roleSaveBody({...draft,name:'unsafe\nname'},catalog),null);
});

test('personnel display uses current effective permission facts instead of inferring grants from assignments',()=>{
 const person={operatorId:actor,displayName:'管理测试身份',identityState:'known-management-principal',authorizationState:'available',assignments:[{id:other,operatorId:actor,roleId:id,enabled:true,version:1,createdAt:time,updatedAt:time}],effective:{version:'7',permissions:[],source:'business-roles'}};
 assert.deepEqual(personPermissionSources(person,'content.read',[role]),{state:'denied',labels:[]});
 assert.deepEqual(personPermissionSources({...person,authorizationState:'unknown',effective:null},'content.read',[role]),{state:'unknown',labels:[]});
 assert.deepEqual(personPermissionSources({...person,authorizationState:'not-eligible',effective:null},'content.read',[role]),{state:'unknown',labels:[]});
 const granted={...person,effective:{...person.effective,permissions:['content.read']}};
 assert.deepEqual(personPermissionSources(granted,'content.read',[role]),{state:'granted',labels:['内容维护']});
 assert.deepEqual(personPermissionSources({...granted,effective:{...granted.effective,source:'upstream-administrator'}},'content.read',[role]),{state:'unknown',labels:['旧上游来源']});
});

test('automatic grants require explicit object intent and preserve existing scoped objects on ordinary save',()=>{
 const fresh=automationDraft();assert.equal(fresh.enabled,false);assert.equal(fresh.scopeConfirmed,false);
 assert.equal(automationSaveBody({...fresh,name:'内容例行处理',permissions:['content.read']},catalog),null);
 assert.deepEqual(automationSaveBody({...fresh,name:'内容例行处理',scopeConfirmed:true,resourceScope:{kind:'eligible'},permissions:['content.read']},catalog).resourceIds,[]);
 const grant={id,name:'指定对象处理',executorKind:'program',mode:'automatic',enabled:true,version:6,permissions:['content.read'],resourceIds:[other],executionState:'not-connected',executionAvailable:false,createdAt:time,updatedAt:time};
 const draft=automationDraft(grant),body=automationSaveBody({...draft,name:'改名'},catalog);
 assert.equal(body.expectedVersion,6);assert.deepEqual(body.resourceIds,[other]);assert.deepEqual(grant.resourceIds,[other]);
 for(const mode of ['assisted','automatic'])assert.equal(automationSaveBody({...draft,mode,permissions:['permissions.roles.write']},catalog),null);
});

test('protected permission snapshots disappear at the actual lease boundary and missing leases fail closed',()=>{
 const value={checkedAt:100,readExpiresAt:130,metadataOnly:true,permissions:{canManageRoles:false,canManageAssignments:false,canManageAutomation:false}};
 assert.equal(permissionReadCurrent(value,129999),value);assert.equal(permissionReadCurrent(value,130000),null);
 assert.equal(permissionReadCurrent({...value,readExpiresAt:undefined},100000),null);
 assert.equal(permissionReadCurrent(null,100000),null);
});
