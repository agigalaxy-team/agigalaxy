import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {ChatReadModel} from '../src/chat/read-model.mjs';
import {CommunityAccountRegistry} from "../src/accounts/community-accounts.mjs";
import {accountAvatarSelection} from "../../galaxy-web/src/features/accounts/account-avatar-assets.mjs";

test('current account avatar/type projection and local stable illustrations',async()=>{
 const db=new PGlite(),endpoint='https://avatar-check.invalid',ids=[
  '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004'
 ];
 try{
  await db.exec('CREATE TABLE community_accounts(id uuid PRIMARY KEY,uid text,endpoint text); CREATE TABLE official_account_profiles_v1(account_id uuid PRIMARY KEY,display_name text,avatar_key text,subject_type text,query_enabled boolean,bio text);');
  const types=['person','organization','agent',null],keys=['book','leaf','camera',null];
  for(let i=0;i<ids.length;i++){
   await db.query('INSERT INTO community_accounts VALUES($1,$2,$3)',[ids[i],'CHECK'+i,endpoint]);
   await db.query('INSERT INTO official_account_profiles_v1 VALUES($1,$2,$3,$4,$5,$6)',[ids[i],'账户'+i,keys[i],types[i],i!==1,'private fixture detail']);
  }
  // Authorization/transaction entry is an explicit double. The selected SQL
  // and public-choice SQL are the real product implementations.
  const model=Object.create(ChatReadModel.prototype),actor={kind:'official-account',accountId:ids[0],endpoint};
  model.access={endpoint};model.accounts=new CommunityAccountRegistry({endpoint});
  let admissions=0;
  model.run=async(current,write,operation)=>{assert.equal(current,actor);assert.equal(write,false);admissions++;return operation(db);};
  const known=await model.people(actor,{accountIds:ids});
  assert.equal(known.items.length,4);
  for(let i=0;i<ids.length;i++){
   const item=known.items.find(value=>value.accountId===ids[i]);
   assert.equal(item.actorRef,'account:'+ids[i]);assert.equal(item.avatarKey,keys[i]);assert.equal(item.subjectType,types[i]);
   for(const field of ['email','bio','issuer','externalSubject'])assert.equal(field in item,false);
  }
  const choices=await model.people(actor,{limit:20});
  assert.deepEqual(choices.items.map(value=>value.accountId),[ids[0],ids[2],ids[3]]);
  assert.equal(choices.items.find(value=>value.accountId===ids[2]).avatarKey,'camera');
  assert.equal(choices.items.find(value=>value.accountId===ids[2]).subjectType,'agent');
  await db.query('UPDATE community_accounts SET endpoint=$2 WHERE id=$1',[ids[3],'https://other.invalid']);
  assert.deepEqual((await model.people(actor,{accountId:ids[3]})).items,[]);
  assert.equal(admissions,3);

  const first=accountAvatarSelection('book',ids[0],'person');
  assert.equal(first.src,accountAvatarSelection('book','account:'+ids[0].toUpperCase(),'person').src);
  assert.notEqual(first.src,accountAvatarSelection('book',ids[1],'person').src);
  assert.notEqual(first.src,accountAvatarSelection('leaf',ids[0],'person').src);
  assert.notEqual(first.src,accountAvatarSelection('book',ids[0],'agent').src);
  for(const [i,kind] of ['person','organization','agent',null].entries()){
   const selected=accountAvatarSelection(keys[i],ids[i],kind);
   assert.match(selected.src,/^data:image\/svg\+xml;base64,/);
   const svg=Buffer.from(selected.src.split(',')[1],'base64').toString('utf8');
   assert.match(svg,/<svg/);
   assert.doesNotMatch(svg,/<(?:script|foreignObject|image|iframe)\b/i);
   assert.doesNotMatch(svg,/(?:href|src)=["'](?:https?:|\/\/)/i);
   assert.equal(svg.includes(ids[i]),false);
   assert.equal(selected.subjectType,kind??'unknown');
  }
  assert.equal(accountAvatarSelection('not-a-key',ids[0],'not-a-type').src,accountAvatarSelection(null,ids[0],null).src);
  const unique=new Set(),started=Date.now();
  for(let i=1;i<=3000;i++){
   const id='20000000-0000-4000-8000-'+String(i).padStart(12,'0');
   const svg=Buffer.from(accountAvatarSelection('book',id,'person').src.split(',')[1],'base64').toString('utf8');
   // Exclude seed-derived SVG identifier suffixes so the count represents
   // actual visible combinations rather than merely different DOM IDs.
   unique.add(svg.replace(/-[a-f0-9]{8}(?=["'#)])/g,''));
  }
  assert.ok(unique.size>2900,'3000 accounts with the same saved key should have distinct illustrations');
  assert.equal(accountAvatarSelection('book',ids[0],'person').src,first.src);
  console.log(JSON.stringify({accounts:3000,sameSavedKey:'book',distinctIllustrations:unique.size,renderMs:Date.now()-started,realSqlProjections:3,authorization:'explicit-double',productionRequests:0,userDataWrites:0}));
 }finally{await db.close();}
});
