import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsDraftMemory,settingsManagementReceiptPath} from '../src/lib/settings-draft-memory.ts';
import {managementAccountQualification,managementRecoveredAssignment} from "../src/lib/management-accounts/management-accounts-view-model.ts";

test('management drafts remain non-secret in the same login and restored operations provide only owned original GET coordinates',()=>{
 const owner='a'.repeat(64),target='b'.repeat(64),version='c'.repeat(64),other='d'.repeat(64);
 const roleId='11111111-1111-4111-8111-111111111111',operationId='22222222-2222-4222-8222-222222222222',assignmentId='33333333-3333-4333-8333-333333333333';
 const memory=createSettingsDraftMemory(),session=memory.open(owner,'same-login-csrf');
 const snapshot={
  createDraft:{username:'draft.member',firstName:'未保存的名',lastName:'姓',note:'本次备注',roleIds:[roleId,roleId],unrelated:'DROP'},
  profileDrafts:{[target]:{firstName:'编辑中的名',lastName:'姓',note:'新备注',reason:'资料纠正',targetVersion:version,baseFirstName:'原名',baseLastName:'姓',baseNote:'旧备注',response:'DROP'},foreign:{targetVersion:version}},
  actionDrafts:{[target]:{kind:'password-reset',reason:'本人请求',targetVersion:version,newEmail:'',action:'promote',confirmed:false}},
  editing:{[target]:true,foreign:true},roleChoice:{[target]:roleId,foreign:roleId},
  mergeChoices:{[target]:{version,fields:{firstName:'mine',note:'current',unrelated:'mine'}}},
  tablePositions:[['page=2',128]],detailPositions:[[target+':overview:left',64]],providerResponse:{must:'DROP'},
 };
 session.write('management',snapshot);
 const saved=session.read('management');
 assert.equal(memory.open(owner,'same-login-csrf'),session);
 assert.equal(saved.createDraft.username,'draft.member');assert.deepEqual(saved.createDraft.roleIds,[roleId]);
 assert.equal(saved.profileDrafts[target].firstName,'编辑中的名');assert.equal(saved.profileDrafts.foreign,undefined);assert.equal(saved.profileDrafts[target].response,undefined);
 assert.equal(saved.providerResponse,undefined);assert.equal(saved.createDraft.unrelated,undefined);assert.deepEqual(saved.editing,{[target]:true});
 assert.deepEqual(saved.mergeChoices[target],{version,fields:{firstName:'mine',note:'current'}});assert.deepEqual(saved.tablePositions,[['page=2',128]]);
 saved.createDraft.firstName='外部修改';assert.equal(session.read('management').createDraft.firstName,'未保存的名');
 for(const excluded of ['temporaryPassword','password','credential','apiKey','rawBody','requestBody','body']){
  assert.throws(()=>session.write('management',{...snapshot,createDraft:{...snapshot.createDraft,[excluded]:'SYNTHETIC_NOT_SECRET'}}),/Excluded management snapshot field|Excluded settings snapshot field/);
 }
 session.setPending('management',{operationId,kind:'create',targetOperatorId:null});
 assert.equal(settingsManagementReceiptPath(session.pending('management')),'/v1/operations/management-accounts/operations/'+operationId);
 session.setPending('management',{operationId,kind:'password-reset',targetOperatorId:target});
 assert.deepEqual(session.pending('management'),{operationId,kind:'password-reset',targetOperatorId:target});
 assert.throws(()=>session.setPending('management',{operationId,kind:'password-reset',targetOperatorId:target,body:{}}),/Invalid management pending receipt/);
 assert.throws(()=>session.setPending('management',{operationId,kind:'password-reset',targetOperatorId:target,readPath:'https://example.invalid/arbitrary'}),/Invalid management pending receipt/);
 assert.throws(()=>session.setPending('management',{operationId,kind:'create',targetOperatorId:target}),/Invalid management pending receipt/);
 assert.throws(()=>session.setPending('management',{operationId,kind:'password-reset',targetOperatorId:null}),/Invalid management pending receipt/);
 assert.equal(settingsManagementReceiptPath({operationId,kind:'unknown',targetOperatorId:target}),null);
 const locator={operationId,kind:'assignment-save',targetOperatorId:target};session.setPending('management',locator);
 assert.equal(settingsManagementReceiptPath(session.pending('management')),'/v1/operations/management-accounts/'+target+'/assignments/operations/'+operationId);
 const assignment={id:assignmentId,operatorId:target,roleId,enabled:true,version:2,createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z'};
 const receipt={state:'recorded',operationId,operatorId:owner,kind:'assignment-save',selection:{id:assignmentId,expectedVersion:1,operatorId:target,roleId,enabled:true},result:{assignment,operationId,recordedAt:'2026-10-24T00:00:00Z',replayed:true}};
 assert.deepEqual(managementRecoveredAssignment(receipt,locator,owner),receipt.result);
 for(const patch of [{operatorId:other},{kind:'role-save'},{operationId:'44444444-4444-4444-8444-444444444444'}])assert.equal(managementRecoveredAssignment({...receipt,...patch},locator,owner),null);
 for(const patch of [{operatorId:other},{roleId:'55555555-5555-4555-8555-555555555555'},{enabled:false},{expectedVersion:0},{id:'66666666-6666-4666-8666-666666666666'}])assert.equal(managementRecoveredAssignment({...receipt,selection:{...receipt.selection,...patch}},locator,owner),null);
 assert.equal(managementRecoveredAssignment({...receipt,state:'not-recorded'},locator,owner),null);
 assert.equal(managementAccountQualification({admission:null,rootAdministrator:false}),'资格尚未取得');
 // Another page in this same login retains its own established memory slot.
 session.write('search',{draft:null,reasons:{draft:'原页面稿'},positions:[]});session.clear('management');
 assert.equal(session.read('management'),null);assert.deepEqual(session.pending('management'),locator);assert.equal(session.read('search').reasons.draft,'原页面稿');
 const next=memory.open(owner,'new-login-csrf');assert.equal(session.current(),false);assert.equal(next.read('management'),null);assert.equal(next.pending('management'),null);
 session.write('management',snapshot);session.setPending('management',locator);assert.equal(next.read('management'),null);assert.equal(next.pending('management'),null);
 next.write('management',snapshot);next.setPending('management',locator);memory.observeIdentity(other);assert.equal(next.current(),false);
 const otherSession=memory.open(other,'new-login-csrf');assert.equal(otherSession.read('management'),null);assert.equal(otherSession.pending('management'),null);
 otherSession.write('management',snapshot);memory.clear();assert.equal(otherSession.current(),false);assert.equal(memory.open(other,'new-login-csrf').read('management'),null);
});
