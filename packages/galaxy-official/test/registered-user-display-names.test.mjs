import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {RegisteredUsersReadModel} from '../src/operations/accounts/registered-read-model.mjs';
import {registeredDirectoryItem} from '../src/operations/agentos/query/registered-directory.mjs';

const source=await readFile(new URL("../../../apps/galaxy-admin/src/lib/accounts/registered-users-view-model.ts",import.meta.url),'utf8');
const {registeredUserName,registeredUserUid}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'));

// These are SQL-result rows, not database or native transport doubles.
// Exercise the actual common list/detail mapper, actual front-end helper and
// actual AI allowlist projection. No authority, database, or native I/O is used.
const db={},endpoint='display-name-check',issuer='https://identity.synthetic.invalid';
const model=new RegisteredUsersReadModel({businessAdmin:{db,endpoint},db,endpoint,directory:{issuer},now:()=>1792915200});
const base={
 registration_id:'11111111-1111-4111-8111-111111111111',issuer,external_subject:'synthetic-subject',
 present:true,email:'not-a-display-name@synthetic.invalid',email_verified:true,enabled:true,
 registered_at:'2026-10-24T00:00:00Z',identity_display_name:'苏云帆',observed_at:'2026-10-25T08:00:00Z',
 account_id:null,profile_account_id:null,display_name:null,reserved_account_id:'22222222-2222-4222-8222-222222222222',
 reserved_uid:'G9QZ0MP931I8',preset_name:null,preset_avatar_key:null,preset_revision:0,preset_updated_at:null,
};

test('reserved locator cannot mask a current name; preset/business priority and privacy remain closed',()=>{
 const reserved=model.item(base);
 assert.equal(reserved.registrationProfile.state,'reserved');
 assert.equal(reserved.registrationProfile.displayName,'');
 assert.equal(registeredUserName(reserved),'苏云帆');
 assert.equal(registeredUserUid(reserved),base.reserved_uid);
 assert.equal(reserved.registrationProfile.revision,0);

 // Old server snapshots may still have UID in reserved.displayName. The client
 // guard must fix the real previously served shape without needing a new page.
 const oldSnapshot={...reserved,registrationProfile:{...reserved.registrationProfile,displayName:base.reserved_uid}};
 assert.equal(registeredUserName(oldSnapshot),'苏云帆');
 const staleUncommitted=model.item({...base,preset_name:'Uncommitted'});
 assert.equal(staleUncommitted.registrationProfile.displayName,'');

 const latin=model.item({...base,identity_display_name:'Kai'});
 assert.equal(registeredUserName(latin),'Kai');
 assert.equal(registeredUserUid(latin),base.reserved_uid);

 const preset=model.item({...base,preset_revision:1,preset_name:'  小麦  ',preset_avatar_key:'sunrise'});
 assert.equal(preset.registrationProfile.state,'preset');
 assert.equal(registeredUserName(preset),'小麦');
 assert.equal(preset.registrationProfile.avatarKey,'sunrise');
 assert.equal(registeredUserUid(preset),base.reserved_uid);
 const unnamedPreset=model.item({...base,preset_revision:1,preset_name:null});
 assert.equal(registeredUserName(unnamedPreset),'苏云帆');

 const business=model.item({...base,account_id:'33333333-3333-4333-8333-333333333333',
  profile_account_id:'33333333-3333-4333-8333-333333333333',uid:'GABCDE123452',
  display_name:'业务昵称',profile_revision:3,business_created_at:'2026-10-24T00:00:00Z',
  preset_revision:1,preset_name:'预置昵称'});
 assert.equal(business.registrationProfile,null);
 assert.equal(registeredUserName(business),'业务昵称');
 assert.equal(registeredUserUid(business),'GABCDE123452');

 const nameless=model.item({...base,identity_display_name:null});
 assert.equal(nameless.identity.email,'not-a-display-name@synthetic.invalid');
 assert.equal(registeredUserName(nameless),'未提供姓名');
 assert.ok(!registeredUserName(nameless).includes('@'));
 const missing=model.item({...base,present:false,identity_display_name:null});
 assert.equal(registeredUserName(missing),'姓名未取得');
 const noIdentityPermission=model.item(base,{readIdentity:false});
 assert.equal(noIdentityPermission.identity.email,null);
 assert.equal(noIdentityPermission.identity.issuer,null);
 assert.equal(noIdentityPermission.identity.subject,null);
 assert.equal(registeredUserName(noIdentityPermission),'苏云帆');

 const ai=registeredDirectoryItem(reserved);
 assert.equal(ai.identity.displayName,'苏云帆');
 assert.equal(ai.business,null);
 assert.ok(!('registrationProfile' in ai));
 for(const field of ['email','issuer','subject'])assert.ok(!(field in ai.identity));
 assert.equal(registeredDirectoryItem(latin).identity.displayName,'Kai');
 assert.equal(registeredDirectoryItem(business).business.displayName,'业务昵称');
 assert.equal(registeredDirectoryItem(nameless).identity.displayName,null);
});

