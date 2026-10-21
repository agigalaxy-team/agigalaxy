import test from 'node:test';
import assert from 'node:assert/strict';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {createStoredOperatorAuthorization} from '../src/operations-config.mjs';

test('queued authority uses the stored principal and current management role, without accepting a payload subject',async()=>{
 const endpoint='https://official.example.invalid',issuer='https://admin.example.invalid/realms/management';
 const actor={kind:'business-operator',endpoint,operatorId:'operator-stable',role:'administrator',httpRequestId:'31338740-9a63-4283-b8ac-29b79c2696c9'};
 let roles=['admin'],calls=[];
 const db={async query(_sql,values){assert.deepEqual(values,[endpoint,'operator-stable']);return {rows:[{issuer,external_subject:'stored-management-subject'}]};}};
 const operatorAuthorization=createStoredOperatorAuthorization({db,endpoint,issuer,roles:{administrator:'admin',reader:'read'},roleDirectory:{async getOperatorRoles(input){calls.push(input);if(roles===null)throw Error('secret-upstream-response');return roles;}}});
 const service=new BusinessAdminService({db,endpoint,operatorAuthorization});
 await assert.rejects(service.revalidate({...actor,externalSubject:'attacker-choice'},{write:true}),error=>error.code==='business_admin_denied');
 assert.equal(calls.length,0);
 assert.deepEqual(await service.revalidate(actor,{write:true}),actor);
 assert.deepEqual(calls,[{issuer,externalSubject:'stored-management-subject'}]);
 roles=['read'];await assert.rejects(service.revalidate(actor,{write:true}),error=>error.code==='business_admin_denied'&&error.status===403);
 roles=[];await assert.rejects(service.revalidate(actor,{write:true}),error=>error.code==='business_admin_denied');
 roles=null;await assert.rejects(service.revalidate(actor,{write:true}),error=>error.code==='identity_directory_unavailable'&&!error.message.includes('secret'));
});
