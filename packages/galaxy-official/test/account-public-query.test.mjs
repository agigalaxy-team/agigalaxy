import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {communityForumFixture} from './community-forum-fixture.mjs';
import {AccountPublicQuery} from '../src/account-public-query.mjs';
import {createExternalCredentialsService} from '../src/external-credentials.mjs';

async function accountBrowser(f,name){
 const cookies=new Map(),accept=response=>{for(const item of response.headers.getSetCookie()){const pair=item.split(';')[0];cookies.set(pair.split('=')[0],pair);}},cookie=()=>[...cookies.values()].join('; ');
 f.issuer.setAccount(name);
 const start=await fetch(f.origin+'/v1/account/login',{redirect:'manual'});accept(start);assert.equal(start.status,303);
 const returned=await f.issuer.authorize(start.headers.get('location'));
 const callback=await fetch(f.origin+returned.pathname+returned.search,{redirect:'manual',headers:{Cookie:cookie()}});accept(callback);assert.equal(callback.status,303);
 const session=await(await fetch(f.origin+'/v1/account/session',{headers:{Cookie:cookie(),Origin:f.website}})).json();assert.equal(session.state,'signed-in');
 async function request(path,input){const response=await fetch(f.origin+path,{method:input===undefined?'GET':'POST',headers:{Cookie:cookie(),Origin:f.website,
  'X-Galaxy-Account-ID':session.account.id,'X-Galaxy-Account-CSRF':session.csrfToken,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  return {status:response.status,body:await response.json()};}
 async function settings(publicQuery){const current=await request('/v1/account/settings');assert.equal(current.status,200);const saved=await request('/v1/account/settings',{
  expectedRevision:current.body.revision,displayName:name,archiveRetentionDays:current.body.archiveRetentionDays,publicQuery});assert.equal(saved.status,200,JSON.stringify(saved.body));return saved;}
 return {id:session.account.id,request,settings};
}

test('anonymous account↔ID lookup uses current real associations and independent display choices without changing old clients',{timeout:60000},async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const first=await accountBrowser(f,'public relation one'),second=await accountBrowser(f,'public relation two'),hidden=await accountBrowser(f,'private relation');
  await f.login(f.owner,'public relation one');await f.login(f.responder,'public relation one');await f.login(f.owner,'public relation two');await f.login(f.owner,'private relation');
  const base='/v1/account/public/',anonymous=path=>f.request(path,{authorization:false});
  assert.equal((await anonymous(base+first.id)).status,404);
  await first.settings({enabled:true,scope:'profile'});
  const oldProfile=await anonymous(base+first.id);assert.equal(oldProfile.status,200);assert.equal(oldProfile.body.publicQuery.showLinkedIds,false);assert.equal(oldProfile.body.publicQuery.showExternalCredentials,false);
  assert.equal((await anonymous(base+first.id+'/ids')).status,404);assert.equal((await anonymous(base+first.id+'/credentials')).status,404);
  assert.deepEqual((await anonymous(base+'by-id/'+f.owner.actor.subjectId)).body.items,[]);
  await first.settings({enabled:true,scope:'profile',showLinkedIds:true,showExternalCredentials:true});
  await second.settings({enabled:true,scope:'profile',showLinkedIds:true});
  await hidden.settings({enabled:false,scope:'profile',showLinkedIds:true,showExternalCredentials:true});
  // Legacy saves (including cleanup-only consumers) omit both new fields.
  await first.settings({enabled:true,scope:'profile'});
  const saved=(await first.request('/v1/account/settings')).body;assert.equal(saved.publicQuery.showLinkedIds,true);assert.equal(saved.publicQuery.showExternalCredentials,true);
  const page1=await anonymous(base+first.id+'/ids?limit=1');assert.equal(page1.status,200);assert.equal(page1.body.items.length,1);assert.ok(page1.body.nextAfter);
  const page2=await anonymous(base+first.id+'/ids?limit=1&after='+page1.body.nextAfter);assert.equal(page2.body.nextAfter,null);
  assert.deepEqual(new Set([...page1.body.items,...page2.body.items].map(item=>item.subjectId)),new Set([f.owner.actor.subjectId,f.responder.actor.subjectId]));
  const reverse1=await anonymous(base+'by-id/'+f.owner.actor.subjectId+'?limit=1'),reverse2=await anonymous(base+'by-id/'+f.owner.actor.subjectId+'?limit=1&after='+reverse1.body.nextAfter);
  assert.deepEqual(new Set([...reverse1.body.items,...reverse2.body.items].map(item=>item.accountId)),new Set([first.id,second.id]));
  assert.ok([...reverse1.body.items,...reverse2.body.items].every(item=>typeof item.displayName==='string'&&item.typeSource==='account-owner-statement'));
  assert.equal(JSON.stringify(reverse1.body).includes('externalSubject'),false);assert.equal(JSON.stringify(reverse1.body).includes('email'),false);
  assert.equal((await anonymous(base+hidden.id+'/ids')).status,404);
  assert.equal((await anonymous(base+first.id+'/ids?limit=51')).status,400);
  assert.equal((await anonymous(base+first.id+'/ids?limit=1&limit=2')).status,400);
  // A configured source removed at runtime is no longer a current association.
  const providers=f.forum.accounts.providers;f.forum.accounts.providers=new Set();
  assert.deepEqual((await anonymous(base+first.id+'/ids')).body.items,[]);
  assert.deepEqual((await anonymous(base+'by-id/'+f.owner.actor.subjectId)).body.items,[]);f.forum.accounts.providers=providers;
  const link=(await f.ok('/v1/identity/query',{input:{}})).items.find(item=>item.externalSubject==='public relation one');assert.ok(link);
  assert.equal((await f.request('/v1/identity/revoke',{input:{id:link.id}})).status,200);
  assert.deepEqual((await anonymous(base+first.id+'/ids')).body.items.map(item=>item.subjectId),[f.responder.actor.subjectId]);
  assert.deepEqual((await anonymous(base+'by-id/'+f.owner.actor.subjectId)).body.items.map(item=>item.accountId),[second.id]);
  await first.settings({enabled:true,scope:'profile',showLinkedIds:false});
  assert.equal((await anonymous(base+first.id+'/ids')).status,404);
  assert.deepEqual((await anonymous(base+'by-id/'+f.responder.actor.subjectId)).body.items,[]);
  await second.settings({enabled:false,scope:'profile'});
  assert.equal((await anonymous(base+second.id)).status,404);assert.equal((await anonymous(base+second.id+'/ids')).status,404);
  assert.deepEqual((await anonymous(base+'by-id/'+f.owner.actor.subjectId)).body.items,[]);
 }finally{await f.close();}
});

test('public external credential metadata remains account-bound, current and withdrawable without exposing private signed material',{timeout:60000},async()=>{
 const f=await communityForumFixture({officialAccountPortal:true});try{
  const account=await accountBrowser(f,'credential holder'),{privateKey,publicKey}=await generateKeyPair('EdDSA',{extractable:true}),issuer='https://credential-source.example.org';
  const key={...await exportJWK(publicKey),kid:'public-query-fixture',alg:'EdDSA',use:'sig'},endpoint=f.owner.access.endpoint;let unavailable=false,revoked=[];
  const configuration={version:1,issuers:[{id:'source',name:'Synthetic external source',issuer,keys:[key],revocation:{kind:'signed-list',url:issuer+'/status',maxAgeSeconds:300}}]},
   externalCredentials=createExternalCredentialsService({db:f.db,endpoint,configuration,now:()=>f.clock.now,fetchStatus:async()=>{
    if(unavailable)throw Error('synthetic source offline');return {jwt:await new SignJWT({purpose:'revocation',complete:true,revoked}).setIssuer(issuer)
     .setIssuedAt(f.clock.now-1).setExpirationTime(f.clock.now+240).setProtectedHeader({alg:'EdDSA',kid:key.kid,typ:'credential-status+jwt'}).sign(privateKey)};}}),
   actor={kind:'official-account',accountId:account.id,endpoint},query=new AccountPublicQuery({data:f.officialAccounts.data,accounts:f.forum.accounts,externalCredentials});
  async function credential({subjectId=endpoint+'/v1/account/public/'+account.id,id='urn:public-query:'+randomUUID(),expires=f.clock.now+3600}={}){
   const token=await new SignJWT({vc:{'@context':['https://www.w3.org/2018/credentials/v1'],type:['VerifiableCredential','SyntheticQualification'],credentialSubject:{privateStatement:'Private issuer claim, not a public metadata field.'}}})
    .setIssuer(issuer).setSubject(subjectId).setJti(id).setIssuedAt(f.clock.now-10).setNotBefore(f.clock.now-10).setExpirationTime(expires)
    .setProtectedHeader({alg:'EdDSA',kid:key.kid,typ:'JWT'}).sign(privateKey);
   return externalCredentials.importCredential(actor,{credential:token});
  }
  const owned=await credential({id:'urn:public-query:owned'}),expired=await credential({expires:f.clock.now-1});
  await credential({subjectId:'urn:someone-else'});await credential({subjectId:endpoint+'/v1/account/public/'+randomUUID()});
  await account.settings({enabled:true,scope:'profile'});await assert.rejects(query.credentials(account.id),{code:'not_found'});
  await account.settings({enabled:true,scope:'profile',showExternalCredentials:true});
  let page=await query.credentials(account.id,{limit:1}),items=[...page.items];
  while(page.nextAfter){page=await query.credentials(account.id,{limit:1,after:page.nextAfter});items.push(...page.items);}
  assert.deepEqual(new Set(items.map(item=>item.id)),new Set([owned.id,expired.id]));
  const visible=items.find(item=>item.id===owned.id);assert.equal(visible.issuer.uri,issuer);assert.equal(visible.subject.binding,'bound');assert.equal(visible.signature.state,'valid');assert.equal(visible.revocation.state,'not-revoked');assert.equal(visible.galaxyIssued,false);
  assert.equal(items.find(item=>item.id===expired.id).validity.state,'expired');
  const serialized=JSON.stringify(items);for(const excluded of ['credential_jws','issuerClaims','privateStatement','Private issuer claim','"vc"','"eligibility"'])assert.equal(serialized.includes(excluded),false,excluded);
  f.clock.now+=301;assert.equal((await query.credentials(account.id)).items.find(item=>item.id===owned.id).revocation.state,'unknown');
  revoked=['urn:public-query:owned'];await externalCredentials.recheck(actor,owned.id);
  assert.equal((await query.credentials(account.id)).items.find(item=>item.id===owned.id).revocation.state,'revoked');
  unavailable=true;await externalCredentials.recheck(actor,owned.id);
  assert.equal((await query.credentials(account.id)).items.find(item=>item.id===owned.id).revocation.state,'unknown');
  await externalCredentials.withdraw(actor,owned.id);assert.equal((await query.credentials(account.id)).items.some(item=>item.id===owned.id),false);
  await account.settings({enabled:true,scope:'profile',showExternalCredentials:false});await assert.rejects(query.credentials(account.id),{code:'not_found'});
  await account.settings({enabled:false,scope:'profile',showExternalCredentials:true});await assert.rejects(query.credentials(account.id),{code:'not_found'});
 }finally{await f.close();}
});
