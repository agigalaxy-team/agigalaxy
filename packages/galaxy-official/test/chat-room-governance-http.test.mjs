import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {oidcProviderFixture} from './oidc-provider-fixture.mjs';
import {createOidcLoginProvider} from '../src/oidc-login.mjs';
import {createApi} from '../src/http.mjs';
import {nativeHttpDefinitions} from '../../galaxy-edge-mcp/src/native-v2/http-tools.mjs';

// Real independent OIDC/PKCE/JWS, signed Galaxy association, bearer HTTP and
// PostgreSQL-compatible transactions. Synthetic people; no MAM body is used.
test('actual verified accounts accept the exact shared open rule through HTTP and native adapters',{timeout:60000},async()=>{
 const endpoint='https://official.example.org',now=Math.floor(Date.now()/1000),issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
 let f,server;try{
  const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic governance OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
  const options={now,identityProviders:[provider],syntheticCommunityQuota:false},scopes=['binding'];f=await serviceFixture(scopes,null,options);
  const people=[f];for(let i=0;i<3;i++)people.push(await serviceFixture(scopes,f.db,{...options,migrateDatabase:false}));
  server=createApi({...f,rateLimit:1000});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const post=async(who,path,input={})=>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+who.credential},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};};
  const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
  const login=async(who,index)=>{issuer.setAccount('synthetic-governance-'+index);const started=ok(await post(who,'/v1/identity/begin',{providerId:'fixture'})),callback=await issuer.authorize(started.authorizationUrl);
   const completed=await fetch(origin+callback.pathname+callback.search);assert.equal(completed.status,200);assert.equal((await completed.json()).state,'awaiting-local-signature');
   const pending=ok(await post(who,'/v1/identity/status',{id:started.loginId}));ok(await post(who,'/v1/identity/confirm',{id:started.loginId,signed:await who.signForTest(pending.payloadJson,'galaxy-identity-link+jws')}));
  };
  const [a,b,c,d]=people;for(let i=0;i<3;i++)await login(people[i],i);
  const roomId=randomUUID(),path='/v2/chat/rooms/'+roomId;
  ok(await post(a,'/v2/chat/rooms/create',{roomId,operationId:randomUUID(),title:'Synthetic shared standing rule'}));
  const read=who=>post(who,path+'/read');
  const propose=async(action,extra={},voters=[a,b,c])=>{const view=ok(await read(a)),input={decisionId:randomUUID(),expectedRevision:view.revision,action,...extra};
   ok(await post(a,path+'/propose',input));for(const person of voters.slice(1))ok(await post(person,path+'/vote',{decisionId:input.decisionId,choice:'approve'}));return input;};
  let invitation=await propose('invite',{targetSubjectId:b.actor.subjectId},[a]);ok(await post(b,path+'/accept',{decisionId:invitation.decisionId}));
  invitation=await propose('invite',{targetSubjectId:c.actor.subjectId},[a,b]);ok(await post(c,path+'/accept',{decisionId:invitation.decisionId}));
  assert.equal(ok(await read(a)).independentMemberCount,3,'Distinct OIDC accounts supply independent parties');
  const rule=await propose('join-rule',{joinRule:{mode:'open',expiresAt:now+120}});
  const api={call:async(route,input)=>{const result=await post(d,route,input);if(result.status!==200)throw new Error(result.body.error);return result.body;}},native=nativeHttpDefinitions(api);
  assert.ok(native.galaxy_chat_join_preview);assert.equal(native.galaxy_chat_join.write,true);
  const preview=await native.galaxy_chat_join_preview.run({roomId});assert.equal(preview.joinRule.decisionId,rule.decisionId);assert.equal(Object.hasOwn(preview,'members'),false);
  const request={operationId:randomUUID(),ruleVersion:preview.ruleVersion,ruleHash:preview.ruleHash};
  const blocked=await post(d,path+'/join',request);assert.equal(blocked.status,403);assert.equal(blocked.body.error,'account_verification_required');
  await login(d,3);const accepted=await native.galaxy_chat_join.run({roomId,...request});assert.equal(accepted.membershipActive,true);assert.equal(accepted.room.members.length,4);
  const revision=accepted.room.revision;assert.equal(ok(await post(d,path+'/join',request)).room.revision,revision);
  const changed=await post(d,path+'/join',{...request,ruleHash:'0'.repeat(64)});assert.equal(changed.status,409);assert.equal(changed.body.error,'chat_operation_conflict');
  ok(await post(d,path+'/leave'));const replay=ok(await post(d,path+'/join',request));assert.equal(replay.membershipActive,false);assert.equal(replay.room,undefined);assert.equal((await read(d)).status,403);
  const owner=await propose('become-owner',{targetSubjectId:a.actor.subjectId});ok(await post(a,path+'/accept',{decisionId:owner.decisionId}));
  const admin=await propose('appoint-admin',{targetSubjectId:b.actor.subjectId});assert.deepEqual(ok(await read(a)).administratorSubjectIds,[]);ok(await post(b,path+'/accept',{decisionId:admin.decisionId}));
  const view=ok(await read(a));assert.deepEqual(view.administratorSubjectIds,[b.actor.subjectId]);assert.equal(view.managementAuthority.otherAgentControlGranted,false);
  assert.deepEqual(issuer.failures,[]);
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(f)await f.db.close();await issuer.close();}
});
