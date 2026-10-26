import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {communityForumFixture} from '../../galaxy-official/test/community-forum-fixture.mjs';
import {createAccountVerificationClient} from "../src/features/accounts/account-verification-client.mjs";

async function fixture(t){
 const f=await communityForumFixture();t.after(()=>f.close());const saved=new Map(),writes=[];
 let generation=1,dropBefore=null,dropAfter=null,loginCount=0;const deviceId=randomUUID(),subjectId=f.owner.actor.subjectId;
 const connection=()=>({endpoint:f.owner.access.endpoint,subjectId,bindingId:f.owner.actor.bindingId,generation,
  expiresAt:f.clock.now+600,bindingExpiresAt:f.clock.now+900,scopes:['binding']});
 const api={endpoint:f.owner.access.endpoint,snapshot:connection,async call(path,input){
  if(['/v1/identity/confirm','/v1/identity/revoke','/v1/identity/cancel'].includes(path))writes.push({path,input:structuredClone(input)});
  if(dropBefore===path){dropBefore=null;throw Error('isolated account before delivery');}
  const response=await f.request(path,{input});if(response.status!==200)throw Object.assign(Error(response.body.error),{code:response.body.error,status:response.status});
  if(dropAfter===path){dropAfter=null;throw Error('isolated account ACK lost');}return response.body;
 }};
 const client=createAccountVerificationClient({api,endpoint:api.endpoint,now:()=>f.clock.now,
  captureLease:()=>{const initial=connection();return{...initial,deviceId,assertCurrent(){if(generation!==initial.generation||f.owner.actor.bindingId!==initial.bindingId)throw Error('account_authority_changed');}};},
  sign:(payload,type)=>f.owner.signForTest(payload,type),getLocal:async(name,owner)=>structuredClone(saved.get(owner+':'+name)),
  updateLocal:async(name,update,owner)=>{const key=owner+':'+name,value=update(structuredClone(saved.get(key)));saved.set(key,structuredClone(value));return structuredClone(value);}});
 async function login(){
  f.issuer.setAccount('isolated-account-'+(++loginCount));
  const begun=await f.ok('/v1/identity/begin',{input:{providerId:'forum-fixture'}}),callback=await f.issuer.authorize(begun.authorizationUrl);
  const response=await fetch(f.origin+callback.pathname+callback.search);assert.equal(response.status,200);await response.arrayBuffer();
  // Seed the exact original begin receipt into the explicit local Map adapter.
  // The real independent OIDC fixture uses loopback HTTP, so it is not evidence
  // for the production browser's HTTPS authorization-link check in begin().
  const key=subjectId+':account-verification-operations',journal=saved.get(key)??{version:1,subjectId,endpoint:api.endpoint,activeId:null,operations:{}};
  const record={version:1,id:begun.loginId,subjectId,endpoint:api.endpoint,bindingId:f.owner.actor.bindingId,providerId:begun.id,
   issuer:begun.issuer,authorizationUrl:begun.authorizationUrl,expiresAt:begun.expiresAt,state:'awaiting-login'};
  saved.set(key,{...journal,activeId:record.id,operations:{...journal.operations,[record.id]:record}});return record.id;
 }
 return{f,client,writes,login,dropBefore:path=>{dropBefore=path;},dropAfter:path=>{dropAfter=path;},
  count:async()=>Number((await f.db.query('SELECT count(*) FROM external_identity_links WHERE subject_id=$1',[subjectId])).rows[0].count),
  rebound:async()=>{await f.reconnect(f.owner);generation++;}};
}

test('account auto continuation only replays an already approved exact signature and recovers an accepted unknown association without repetition',async t=>{
 const f=await fixture(t),id=await f.login();const preview=await f.client.resumePending();
 assert.equal(preview.state,'awaiting-local-signature');assert.equal(f.writes.length,0);assert.equal(await f.count(),0,'first local approval is never automated');
 f.dropBefore('/v1/identity/confirm');await assert.rejects(f.client.confirm(id,{confirmed:true,preview}),/isolated account before delivery/);
 const original=f.writes.at(-1).input;assert.equal((await f.client.resumePending()).state,'linked');assert.equal(await f.count(),1);
 assert.deepEqual(f.writes.at(-1).input,original);assert.equal(await f.client.pending(),null);
 const next=await f.login(),shown=await f.client.status(next);f.dropAfter('/v1/identity/confirm');
 await assert.rejects(f.client.confirm(next,{confirmed:true,preview:shown}),/isolated account ACK lost/);
 const before=f.writes.length;assert.equal((await f.client.resumePending()).state,'linked');assert.equal(f.writes.length,before);assert.equal(await f.count(),2);
});

test('saved account cancellation and revocation requests resume only the already chosen action; a stopped login never becomes associated',async t=>{
 const f=await fixture(t),id=await f.login();f.dropBefore('/v1/identity/cancel');
 await assert.rejects(f.client.cancel(id,{confirmed:true}),/isolated account before delivery/);
 assert.equal((await f.client.resumePending()).state,'canceled');assert.equal(await f.count(),0);
 const other=await f.login(),preview=await f.client.status(other);await f.client.confirm(other,{confirmed:true,preview});
 f.dropBefore('/v1/identity/revoke');await assert.rejects(f.client.revoke(other,{confirmed:true}),/isolated account before delivery/);
 assert.equal((await f.client.resumePending()).state,'revoked');assert.equal((await f.client.query({id:other})).items[0].state,'revoked');
 const stopped=await f.login();await f.client.stop(stopped,{confirmed:true});const before=f.writes.length;
 assert.equal((await f.client.resumePending(stopped)).reason,'stopped-local');assert.equal(f.writes.length,before);assert.equal(await f.count(),1);
});

test('expired or reconnected uncommitted account signatures remain queryable originals and are never renewed or associated automatically',async t=>{
 const f=await fixture(t),id=await f.login(),shown=await f.client.status(id);f.dropBefore('/v1/identity/confirm');
 await assert.rejects(f.client.confirm(id,{confirmed:true,preview:shown}),/isolated account before delivery/);const before=f.writes.length;
 f.f.clock.now+=301;assert.equal((await f.client.resumePending()).reason,'authorization-expired');assert.equal(f.writes.length,before);
 await f.rebound();assert.equal((await f.client.resumePending()).reason,'original-binding-changed');assert.equal(f.writes.length,before);assert.equal(await f.count(),0);
});
