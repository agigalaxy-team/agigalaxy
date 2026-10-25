import test from 'node:test';
import assert from 'node:assert/strict';
import {registeredCanCommand,registeredDateFromInput,registeredDateInput,registeredEmailLabel,registeredLoginLabel,registeredParticipationLabel,registeredReceiptLabel,registeredReceiptMatches,registeredSourceMessage,registeredUserName,registeredUsersHref,registeredUsersLocation,registeredUsersQuery} from '../src/lib/registered-users-view-model.ts';

const registrationId='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',operationId='33333333-3333-4333-8333-333333333333';
const native=()=>({registrationId,identity:{source:'keycloak-website',issuer:null,subject:null,displayName:'身份源姓名',email:null,emailVerified:false,enabled:true,registeredAt:'2026-10-24T00:12:34.567Z',presence:'present',readState:'not-authorized'},business:null,stage:{state:'unknown',basis:'not-read'},observedAt:'2026-10-24T00:12:34Z'});

test('registered-only identities remain readable without a business UID or email privilege and do not infer incomplete registration',()=>{
  const item=native();assert.equal(registeredUserName(item),'身份源姓名');assert.equal(registeredEmailLabel(item),'无权查看邮箱');assert.equal(registeredParticipationLabel(item),'尚无业务资料');assert.equal(registeredLoginLabel(item),'登录已启用');
  item.identity.displayName=null;assert.equal(registeredUserName(item),'未提供姓名');assert.notEqual(registeredUserName(item),'尚无业务资料');
  item.identity.presence='unavailable';item.identity.enabled=false;assert.equal(registeredLoginLabel(item),'登录状态暂不可用');
  item.identity.presence='not-found';assert.equal(registeredLoginLabel(item),'登录身份未找到');
  item.identity.presence='present';assert.equal(registeredLoginLabel(item),'登录已停用');
});

test('registration selection, pagination and filters survive directory/detail links while API queries exclude UI and authority fields',()=>{
  const location=registeredUsersLocation({page:7,pageSize:50,query:'真实名称',source:'registered',business:'not-formed',participation:'restricted',login:'disabled',registration:registrationId.toUpperCase(),view:'detail',tab:'security',registeredFrom:'2026-10-01T01:02:03.004+08:00',registeredTo:'2026-10-24T00:00:00Z'});
  const query=registeredUsersQuery(location);assert.equal(query.get('page'),'7');assert.equal(query.get('pageSize'),'50');assert.equal(query.get('business'),'not-formed');assert.equal(query.get('participation'),'restricted');assert.equal(query.has('registration'),false);assert.equal(query.has('view'),false);assert.equal(query.has('tab'),false);
  assert.deepEqual([...query.keys()],['page','pageSize','source','sort','query','business','login','participation','registeredFrom','registeredTo']);
  const detail=new URL(registeredUsersHref(location,{tab:'profile',days:28}),'https://example.invalid');assert.equal(detail.searchParams.get('registration'),registrationId);assert.equal(detail.searchParams.get('page'),'7');assert.equal(detail.searchParams.get('days'),'28');
  const back=new URL(registeredUsersHref(location,{view:'directory',tab:'overview'}),'https://example.invalid');assert.equal(back.searchParams.has('view'),false);assert.equal(back.searchParams.get('registration'),registrationId);assert.equal(back.searchParams.get('query'),'真实名称');
  const invalid=registeredUsersLocation({page:'NaN',pageSize:'30',registration:'not-an-id',login:'administrator',source:'future-source'});assert.equal(invalid.page,1);assert.equal(invalid.pageSize,20);assert.equal(invalid.registration,'');assert.equal(invalid.login,'');assert.equal(invalid.source,'all');
  assert.equal(location.registeredFrom,'2026-09-30T17:02:03.004Z');assert.equal(registeredDateInput(location.registeredFrom),'2026-10-01T01:02');assert.equal(registeredDateFromInput('2026-10-01T01:02'),'2026-09-30T17:02:00.000Z');assert.equal(registeredDateFromInput('invalid'),'');
});

test('only the original operation, registration and action receipt may resolve a pending account command',()=>{
  const value={operationId,registrationId,kind:'password-reset',state:'submitted',result:{effects:{identity:{state:'submitted',code:null}},passwordChanged:false,participationChanged:false}};
  assert.equal(registeredReceiptMatches(value,operationId,registrationId,'password-reset'),true);
  assert.equal(registeredReceiptMatches({...value,state:'not-recorded'},operationId,registrationId,'password-reset'),false);assert.equal(registeredReceiptMatches(value,other,registrationId,'password-reset'),false);assert.equal(registeredReceiptMatches(value,operationId,other,'password-reset'),false);assert.equal(registeredReceiptMatches(value,operationId,registrationId,'login-disable'),false);
  assert.match(registeredReceiptLabel(value),/请求已接收/);assert.match(registeredReceiptLabel(value),/送达尚未确认/);assert.match(registeredReceiptLabel({...value,state:'unknown'}),/正在读取/);assert.match(registeredReceiptLabel({...value,state:'partial'}),/部分处理/);
  const detail={capabilities:{canResetPassword:false,canDisableLogin:true,canRestoreLogin:false,canRevokeSessions:false,canCorrectProfile:false},role:'administrator'};assert.equal(registeredCanCommand(detail,'password-reset'),false);assert.equal(registeredCanCommand(detail,'login-disable'),true);assert.equal(registeredCanCommand(detail,'constructor'),false);assert.equal(registeredCanCommand(null,'login-disable'),false);
});

test('incomplete directory generations never imply an empty complete registration population',()=>{
  assert.match(registeredSourceMessage(null),/尚未取得/);assert.match(registeredSourceMessage({source:{state:'syncing',coverage:'not-ready'}}),/完成后/);assert.match(registeredSourceMessage({source:{state:'syncing',coverage:'complete-generation'}}),/上次完整/);assert.match(registeredSourceMessage({source:{state:'not-configured'}}),/尚未配置/);assert.match(registeredSourceMessage({source:{state:'unavailable'}}),/暂时无法/);assert.equal(registeredSourceMessage({source:{state:'ready',coverage:'complete-generation'}}),'');
});
