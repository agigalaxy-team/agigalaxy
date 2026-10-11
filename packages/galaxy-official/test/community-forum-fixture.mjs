import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createApi} from '../src/http.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {forumWriteSpec} from '../src/shared/community-forum-v1-schema.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {digest} from '../src/shared/digest.mjs';
import {createServices} from '../src/services.mjs';

export async function communityForumFixture({policy,resourceBudgetPolicy,endpoint='https://official.example.org'}={}){
 const clock={now:Math.floor(Date.now()/1000)},scopes=['binding','consent','assistance','moderation','data-export','data-delete','history','case-teaser','context','notifications'];
 const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/forum-fixture'],{emailVerified:true});let owner,api;
 try{
  const provider=await createOidcLoginProvider({id:'forum-fixture',name:'Isolated real OIDC fixture',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/forum-fixture',allowLoopbackHttp:true,now:()=>clock.now});
  const options={now:clock.now,endpoint,identityProviders:[provider],resourceBudgetPolicy,syntheticCommunityQuota:false};
  owner=await serviceFixture(scopes,null,options);
  const responder=await serviceFixture(scopes,owner.db,{...options,migrateDatabase:false}),moderator=await serviceFixture(['binding','consent','moderation','data-export'],owner.db,{...options,migrateDatabase:false});
  // Rebuild production services with one actual signer whose clock also moves.
  // Altering service.now alone leaves the old signing closure at fixture time.
  const server=generateKeyPairSync('ed25519'),trustedKeys=new Map([['forum-clock',{publicKeyPem:server.publicKey.export({type:'spki',format:'pem'}),notBefore:clock.now-1,notAfter:clock.now+40000000,revoked:false}]]);
  for(const who of [owner,responder,moderator])Object.assign(who,createServices({db:owner.db,endpoint,kid:'forum-clock',signingKey:server.privateKey,trustedKeys,now:()=>clock.now,operator:'Isolated actual forum fixture',region:'test',identityProviders:[provider],resourceBudgetPolicy,allowedScopes:scopes}));
  const forum=new CommunityForumV1(owner.access,owner.consents,{accounts:owner.communityAccounts,publicWrites:owner.publicWrites,policy});
  const governance=new CommunityForumGovernanceV1(owner.access,owner.consents,forum,{accounts:owner.communityAccounts,moderatorIds:[moderator.actor.subjectId]});
  owner.forum=forum;owner.forumGovernance=governance;owner.dataExport.viewServices.forum=forum;owner.dataExport.viewServices.forumGovernance=governance;
  api=createApi({...owner,forum,forumGovernance:governance,rateLimit:10000,failureAudit:async()=> 'fixture-error-recorded'});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+api.address().port;
  async function request(path,{who=owner,input,method=input===undefined?'GET':'POST',authorization=true}={}){
   const response=await fetch(origin+path,{method,headers:{...(input===undefined?{}:{'content-type':'application/json'}),...(authorization?{authorization:'Bearer '+who.credential}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});
   return {status:response.status,body:await response.json()};
  }
  async function ok(path,options){const out=await request(path,options);assert.equal(out.status,200,JSON.stringify(out.body));return out.body;}
  async function login(who,account){
   issuer.setAccount(account);const started=await ok('/v1/identity/begin',{who,input:{providerId:'forum-fixture'}}),callback=await issuer.authorize(started.authorizationUrl);
   const response=await fetch(origin+callback.pathname+callback.search);assert.equal(response.status,200);await response.arrayBuffer();
   const preview=await ok('/v1/identity/status',{who,input:{id:started.loginId}});
   await ok('/v1/identity/confirm',{who,input:{id:started.loginId,signed:await who.signForTest(preview.payloadJson,'galaxy-identity-link+jws')}});
  }
  async function authorize(who,kind,p,overrides={}){
   const spec=forumWriteSpec(kind,p),payloadJson=JSON.stringify(p),intent={version:1,id:randomUUID(),subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,endpoint,objectId:spec.objectId,action:spec.action,purpose:spec.visibility==='Public'?'public-profile':'operational',recipient:endpoint,fields:Object.keys(p),visibility:spec.visibility,viewers:[],payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:clock.now,expiresAt:p.publishedUntil??clock.now+3600,...overrides};
   const signedIntent=await who.signForTest(JSON.stringify(intent),'galaxy-consent+jws');return {signedIntent,payloadJson};
  }
  // New-operation client preparation uses the production helper before signing.
  // Raw authorize/request deliberately do not repair IDs, for server negatives.
  async function prepare(who,kind,p){return bindForumIds(kind,who.actor.subjectId,p);}
  async function write(who,kind,p,overrides={}){Object.assign(p,await prepare(who,kind,p));const spec=forumWriteSpec(kind,p),input=await authorize(who,kind,p,overrides),consentId=JSON.parse(Buffer.from(input.signedIntent.split('.')[1],'base64url')).id;return {input,consentId,...await request(spec.path,{who,input})};}
  async function reconnect(who,requestedScopes=scopes,control=null){
   const c=await who.bindings[control?'challengeV2':'challenge']({subjectId:who.actor.subjectId,genesisProof:who.genesis.genesisProof,installationId:randomUUID(),scopes:requestedScopes,...(control?{control}:{})}),b=await who.bindings.bind({challenge:c.challenge,clientSession:c.clientSession,signature:await who.signForTest(c.challenge,'galaxy-binding-response+jws')});
   who.credential=randomBytes(32).toString('base64url');const s=await who.access.challenge({bindingId:b.bindingId,credentialHash:digest(who.credential)});await who.access.activate({...s,signature:await who.signForTest(s.challenge,'galaxy-session-response+jws')});who.actor=await who.access.authenticate(who.credential);return who.actor;
  }
  async function post(overrides={},who=owner){const p={schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),expectedHeadVersion:0,versionId:randomUUID(),title:'Independent ordinary discussion',body:'A useful question without a Task, model or history prerequisite.',links:[],publishedUntil:clock.now+2592000,...overrides};return prepare(who,p.expectedHeadVersion===0?'create-post':'publish-version',p);}
  async function reply(p,overrides={},who=responder){return prepare(who,'create-reply',{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),postId:p.postId,postVersionId:p.versionId,expectedRevision:0,body:'An exact-version reply.',publishedUntil:clock.now+2592000,replyTo:null,...overrides});}
  return {owner,responder,moderator,forum,governance,db:owner.db,issuer,clock,origin,request,ok,login,authorize,prepare,write,reconnect,post,reply,close:async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await issuer.close();await owner.db.close();}};
 }catch(error){if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve));}await issuer.close();if(owner)await owner.db.close();throw error;}
}
