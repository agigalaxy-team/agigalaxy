import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/database.mjs';
import {migrations} from '../src/infrastructure/migrations.mjs';
import {accountUidV1MigrationSql} from '../src/infrastructure/account-uid-v1-schema.mjs';
import {OfficialAccountData} from '../src/official-account-data.mjs';
import {CommunityAccountRegistry} from '../src/community-accounts.mjs';
import {accountUidPattern,upsertOfficialAccountWithin,ensureOfficialAccountProfileWithin} from '../src/official-account-uid.mjs';

const endpoint='https://official.example.org',issuer='https://issuer.example.org',now=2000000000;
const input=externalSubject=>({endpoint,issuer,externalSubject,verificationMethod:'email',verifiedAt:now});
const uid=character=>'G'+character.repeat(10)+'1';

test('schema92 backfills every account without changing existing names or subjects and enforces a fixed unique UID',{timeout:60000},async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(migrations.filter(item=>item.version<92).map(item=>item.sql).join('\n'));
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  for(const id of ids)await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    VALUES($1::uuid,$2,$3,$1::text,'email',$4,$4)`,[id,endpoint,issuer,new Date(now*1000).toISOString()]);
  await db.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at)
    VALUES($1,'organization','Owner chosen name',$3),($2,NULL,NULL,$3)`,[ids[0],ids[1],new Date(now*1000).toISOString()]);
  await db.exec(accountUidV1MigrationSql);
  const rows=(await db.query(`SELECT a.id,a.uid,p.display_name,p.subject_type FROM community_accounts a
    JOIN official_account_profiles_v1 p ON p.account_id=a.id`)).rows;
  assert.equal(rows.length,3);assert.equal(new Set(rows.map(row=>row.uid)).size,3);
  for(const row of rows)assert.match(row.uid,accountUidPattern);
  assert.equal(rows.find(row=>row.id===ids[0]).display_name,'Owner chosen name');
  assert.equal(rows.find(row=>row.id===ids[0]).subject_type,'organization');
  for(const row of rows.filter(row=>row.id!==ids[0])){assert.equal(row.display_name,row.uid);assert.equal(row.subject_type,null);}
  assert.equal((await db.query('SELECT count(*)::int AS n FROM subjects')).rows[0].n,0);
  const insert=(value,subject=randomUUID())=>db.query(`INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    VALUES($1,$2,$3,$4,$5,'email',$6,$6)`,[randomUUID(),value,endpoint,issuer,subject,new Date(now*1000).toISOString()]);
  await assert.rejects(insert(null),{code:'23502'});
  await assert.rejects(insert('123456789012'),{code:'23514'});
  await assert.rejects(insert(rows[0].uid),{code:'23505'});
  await assert.rejects(db.query('UPDATE community_accounts SET uid=$2 WHERE id=$1',[ids[0],uid('Z')]),{code:'23514'});
  await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    VALUES($1,$2,$3,$4,'email',$5,$5)`,[randomUUID(),endpoint,issuer,'internal-default',new Date(now*1000).toISOString()]);
  assert.match((await db.query("SELECT uid FROM community_accounts WHERE external_subject='internal-default'")).rows[0].uid,accountUidPattern);
});

test('actual account creation retries UID collisions and concurrent profile initialization retains the winning name',{timeout:60000},async t=>{
  const db=new PGlite();t.after(()=>db.close());await migrate(db);
  const first=await upsertOfficialAccountWithin(db,input('first'),{generateUid:()=>uid('A')});
  let attempts=0;
  const second=await upsertOfficialAccountWithin(db,input('second'),{generateUid:()=>++attempts===1?uid('A'):uid('B')});
  assert.equal(attempts,2);assert.notEqual(first.id,second.id);assert.equal(second.uid,uid('B'));
  const same=await upsertOfficialAccountWithin(db,input('first'),{generateUid:()=>uid('B')});
  assert.equal(same.id,first.id);assert.equal(same.uid,first.uid);assert.equal(same.created,false);
  await assert.rejects(upsertOfficialAccountWithin(db,input('bounded-collision'),{generateUid:()=>uid('A')}),{code:'official_account_unavailable'});
  const concurrent=await Promise.all([
    upsertOfficialAccountWithin(db,input('same-owner'),{generateUid:()=>uid('C')}),
    upsertOfficialAccountWithin(db,input('same-owner'),{generateUid:()=>uid('D')})
  ]);
  assert.equal(concurrent[0].id,concurrent[1].id);assert.equal(concurrent[0].uid,concurrent[1].uid);
  const profiles=await Promise.all(concurrent.map(account=>ensureOfficialAccountProfileWithin(db,account.id,{subjectType:'person',now})));
  for(const profile of profiles){assert.equal(profile.uid,concurrent[0].uid);assert.equal(profile.display_name,profile.uid);}
  await db.query('UPDATE official_account_profiles_v1 SET display_name=$2 WHERE account_id=$1',[concurrent[0].id,'An edited name']);
  const retained=await ensureOfficialAccountProfileWithin(db,concurrent[0].id,{subjectType:'organization',now:now+60});
  assert.equal(retained.display_name,'An edited name');assert.equal(retained.subject_type,'person');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM community_accounts')).rows[0].n,3);
});

test('settings and public exact UID lookup preserve UUID authority and current visibility',{timeout:60000},async t=>{
  const db=new PGlite();t.after(()=>db.close());await migrate(db);
  const account=await upsertOfficialAccountWithin(db,input('profile')),data=new OfficialAccountData({db,endpoint,now:()=>now});
  const actor={kind:'official-account',accountId:account.id,endpoint},settings=await data.settings(actor);
  assert.equal(settings.uid,account.uid);assert.equal(settings.displayName,account.uid);
  const update={expectedRevision:0,displayName:'A chosen name',publicQuery:{enabled:true,scope:'profile'},archiveRetentionDays:null};
  await assert.rejects(data.updateSettings(actor,{...update,uid:uid('Z')}),{code:'invalid_account_data'});
  await assert.rejects(data.settings({...actor,accountId:account.uid}),{code:'official_account_login_required'});
  await assert.rejects(data.publicProfileByUid(account.uid),{code:'not_found'});
  await data.updateSettings(actor,update);
  const publicProfile=await data.publicProfileByUid(account.uid.toLowerCase());
  assert.equal(publicProfile.accountId,account.id);assert.equal(publicProfile.uid,account.uid);assert.equal(publicProfile.displayName,'A chosen name');
  assert.equal('email' in publicProfile,false);assert.equal('externalSubject' in publicProfile,false);
  const registry=new CommunityAccountRegistry({endpoint,now:()=>now});
  assert.equal((await registry.publicChoicesWithin(db,{query:account.uid.toLowerCase()})).items[0].uid,account.uid);
  await data.updateSettings(actor,{...update,expectedRevision:1,displayName:null,publicQuery:{enabled:false,scope:'profile'}});
  const current=await data.settings(actor);assert.equal(current.uid,account.uid);assert.equal(current.displayName,account.uid);
  await assert.rejects(data.publicProfileByUid(account.uid),{code:'not_found'});
  assert.deepEqual((await registry.publicChoicesWithin(db,{query:account.uid})).items,[]);
});
