import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from '../src/database.mjs';
import {messagingAudienceAccountsWithin} from '../src/operations/messaging/views.mjs';

// Actual migrations, endpoint-bound PostgreSQL query and the existing API role.
// There are no message plans, provider requests, sends or permission changes.
test('saved messaging audiences resolve only current same-endpoint names without changing selected IDs',async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const [first,second]=f.people,foreign=randomUUID(),missing=randomUUID(),at=new Date(f.now()*1000).toISOString();
 await f.db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,'https://foreign.example.invalid','https://login.example.org','foreign-only','external-account',$2,$2)",[foreign,at]);
 await f.db.query("INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at) VALUES($1,'person','foreign name must stay private',$2)",[foreign,at]);
 await f.db.query('UPDATE official_account_profiles_v1 SET display_name=$2 WHERE account_id=$1',[second.accountId,'当前第二位']);
 await migrate(f.db,{roles:['api']});await f.db.exec('SET ROLE galaxy_api');
 const config={audience:{kind:'accounts',accountIds:[second.accountId,missing,first.accountId,foreign]}},before=structuredClone(config);
 const result=await messagingAudienceAccountsWithin(f.db,config,f.endpoint);
 assert.deepEqual(config,before);assert.equal(result.state,'available');assert.deepEqual(result.items.map(item=>item.accountId),before.audience.accountIds);
 assert.equal(result.items[0].displayName,'当前第二位');assert.equal(result.items[0].state,'available');assert.equal(result.items[2].displayName,'甲');
 for(const index of [1,3])assert.deepEqual(result.items[index],{accountId:before.audience.accountIds[index],uid:null,displayName:null,state:'unavailable'});
 assert.equal(JSON.stringify(result).includes('foreign name'),false);
 assert.deepEqual(await messagingAudienceAccountsWithin(f.db,{audience:{kind:'all-accounts'}},f.endpoint),{state:'not-applicable',items:[]});
 assert.deepEqual(await messagingAudienceAccountsWithin(f.db,{audience:{kind:'attributes',subjectTypes:['person']}},f.endpoint),{state:'not-applicable',items:[]});
});
