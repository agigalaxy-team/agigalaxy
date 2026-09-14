import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from '../src/oidc-login.mjs';
import { createApi } from '../src/http.mjs';

// All participants are synthetic; authentication is real local OIDC code/PKCE,
// signed Galaxy linkage and the production Account/quota services, without stubs.
export async function verifyContactsV2(database=null,options={}) {
 const endpoint='https://official.example.org',now=Math.floor(Date.now()/1000);
 const issuer=await oidcProviderFixture([endpoint+'/v1/identity/callback/fixture'],{emailVerified:true});
 let f,api;
 try {
  const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',
   redirectUri:endpoint+'/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
  const config={...options,now,identityProviders:[provider],syntheticCommunityQuota:false};
  const scopes=['binding','consent','history','notifications','assistance','data-export','data-delete'];
  f=await serviceFixture(scopes,database,config);
  const p=await serviceFixture(scopes,f.db,{...config,migrateDatabase:false});
  const alias=await serviceFixture(scopes,f.db,{...config,migrateDatabase:false});
  api=createApi({...f,rateLimit:300,failureAudit:async()=> 'stored'});await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+api.address().port;
  const request=async(who,path,input={},status=200)=>{
   const response=await fetch(origin+path,{method:input===null?'GET':'POST',headers:{'content-type':'application/json',
    ...(who?{authorization:'Bearer '+who.credential}:{})},...(input===null?{}:{body:JSON.stringify(input)})});
   const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;
  };
  const login=async(who,account)=>{
   issuer.setAccount(account);const started=await request(who,'/v1/identity/begin',{providerId:'fixture'});
   const callback=await issuer.authorize(started.authorizationUrl),response=await fetch(origin+callback.pathname+callback.search);
   assert.equal(response.status,200);assert.equal((await response.json()).state,'awaiting-local-signature');
   const pending=await request(who,'/v1/identity/status',{id:started.loginId});
   await request(who,'/v1/identity/confirm',{id:started.loginId,signed:await who.signForTest(pending.payloadJson,'galaxy-identity-link+jws')});
  };
  await login(f,'initiator');await login(alias,'initiator');await login(p,'recipient');
  const accountA=await request(f,'/v2/account/quotas'),accountP=await request(p,'/v2/account/quotas');
  assert.equal(accountA.accountId,(await request(alias,'/v2/account/quotas')).accountId);assert.notEqual(accountA.accountId,accountP.accountId);
  const doc={kind:'module',title:'Synthetic parser',summary:'Looking to discuss table extraction',functions:['table-extraction'],discoverable:true};
  const project={operationId:randomUUID(),projectId:randomUUID(),expectedRevision:0,kind:'create',document:doc};
  await request(p,'/v2/projects',await p.authorize(project,'project.write',{objectId:project.operationId,visibility:'Public',purpose:'public-profile'}));
  const prefs=await p.discovery.preferences(p.actor);await p.discovery.save(p.actor,{expectedRevision:prefs.revision,preferences:{enabled:true}});
  const context={kind:'ephemeral',title:'Discuss a new parser',functions:['table-extraction']};
  const query={context,purposes:['conversation']};
  const opportunity=(await request(f,'/v2/discovery/query',query)).items.find(x=>x.projectId===project.projectId);
  assert.ok(opportunity,'no existing Project or failure history required for initiator');
  const send={operationId:randomUUID(),contactId:randomUUID(),expectedRevision:0,kind:'send',recipientId:p.actor.subjectId,
   purpose:'conversation',context,opportunityRef:opportunity.opportunityRef,note:'Talk about parser trade-offs; no promised delivery',roomTitle:'Parser conversation'};
  const sign=async(who,event,viewers)=>who.authorize(event,'contact.write',{objectId:event.operationId,viewers});
  const denied=await sign(f,send,[]);await request(f,'/v2/contacts',denied,403);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM contacts_v2')).rows[0].n,0);
  const grant=await sign(f,send,[p.actor.subjectId]);const sent=await request(f,'/v2/contacts',grant);
  assert.equal(sent.state,'sent');assert.equal(sent.roomId,null);assert.equal(sent.taskId,null);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM chat_rooms')).rows[0].n,0,'send must not pre-create a room');
  assert.equal((await request(f,'/v2/contacts',grant)).replayed,true);
  await request(alias,'/v2/contacts/'+send.contactId,null,404,'same Account does not grant another GUID private Contact access');
  assert.equal((await request(p,'/v2/contacts/query',{direction:'incoming'})).items[0].events[0].note,send.note);

  const duplicate={...send,operationId:randomUUID(),contactId:randomUUID()};
  assert.equal((await request(alias,'/v2/contacts',await sign(alias,duplicate,[p.actor.subjectId]),429)).error,'invitation_cooldown');
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',
   workContext:{goal:'Review working parser',currentSituation:'No failures',attemptRefs:[]},title:'Review parser',summary:'Optional review',
   visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:now+3600};
  await request(f,'/v2/tasks',await f.authorize(task,'assistance.publish',{objectId:task.operationId,visibility:'Public',purpose:'public-profile'}));
  const invitation={taskId:task.taskId,event:{eventId:randomUUID(),expectedTaskVersion:1,kind:'invite',recipientId:p.actor.subjectId,note:'Review?',expiresAt:now+300}};
  const taskGrant=await f.authorize(invitation,'assistance.publish',{objectId:invitation.event.eventId,viewers:[p.actor.subjectId]});
  assert.equal((await request(f,`/v2/tasks/${task.taskId}/events`,taskGrant,429)).error,'invitation_cooldown');
  const plainRoom=await request(alias,'/v2/chat/rooms/create',{roomId:randomUUID(),operationId:randomUUID(),title:'Separate ordinary room'});
  const roomInvite={decisionId:randomUUID(),expectedRevision:plainRoom.revision,action:'invite',targetSubjectId:p.actor.subjectId};
  assert.equal((await request(alias,`/v2/chat/rooms/${plainRoom.roomId}/propose`,roomInvite,429)).error,'invitation_cooldown');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM community_write_receipts WHERE category=\'invitation\'')).rows[0].n,1);

  let inbox=await request(p,'/v2/notifications/options/read');
  await request(p,'/v2/notifications/options/save',{expectedRevision:inbox.revision,settings:{blockedSubjectIds:[f.actor.subjectId]}});
  assert.equal((await request(f,'/v2/discovery/query',query)).items.some(x=>x.subjectId===p.actor.subjectId),false);
  const accept={operationId:randomUUID(),contactId:send.contactId,expectedRevision:1,kind:'accept',note:'I agree to a conversation, not an assigned task'};
  const responseGrant=await sign(p,accept,[f.actor.subjectId]);
  await request(p,'/v2/contacts',responseGrant,403);
  assert.equal((await request(f,'/v2/contacts/'+send.contactId,null)).state,'sent');
  inbox=await request(p,'/v2/notifications/options/read');
  await request(p,'/v2/notifications/options/save',{expectedRevision:inbox.revision,settings:{blockedSubjectIds:[]}});
  const accepted=await request(p,'/v2/contacts',responseGrant);
  assert.equal(accepted.state,'accepted');assert.equal(accepted.roomId,send.contactId);
  assert.equal((await request(p,'/v2/contacts',responseGrant)).replayed,true);
  const room=await request(p,`/v2/chat/rooms/${accepted.roomId}/read`);
  assert.equal(room.independentMemberCount,2);assert.equal(room.state,'active');assert.equal(room.mode,'ownerless');
  assert.equal(room.kind,'ordinary');assert.deepEqual(room.taskRefs,[]);assert.equal(room.ownerSubjectId,null);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_requests')).rows[0].n,1,'Contact did not fabricate another Task');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM task_participations')).rows[0].n,0,'accepting chat is not work participation');
  await request(alias,`/v2/chat/rooms/${accepted.roomId}/read`,{},403);
  await request(f,`/v2/tasks/${task.taskId}/events`,taskGrant);
  assert.equal((await request(alias,`/v2/chat/rooms/${plainRoom.roomId}/propose`,roomInvite,429)).error,'invitation_cooldown','new Task invitation creates the next shared cooldown');
  const reply={taskId:task.taskId,event:{eventId:randomUUID(),expectedTaskVersion:2,kind:'invitation-reply',invitationId:invitation.event.eventId,response:'declined',message:'Conversation only'}};
  await request(p,`/v2/tasks/${task.taskId}/events`,await p.authorize(reply,'assistance.publish',{objectId:reply.event.eventId,viewers:[f.actor.subjectId]}));
  await request(alias,`/v2/chat/rooms/${plainRoom.roomId}/propose`,roomInvite);
  const quota=(await request(f,'/v2/account/quotas')).quotas.find(x=>x.category==='invitation');assert.equal(quota.used,3);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM community_interactions')).rows[0].n,0,'no false work/reputation promotion from conversation acceptance');
  await f.consents.revoke(f.actor,grant.consentId);
  const redacted=await request(p,'/v2/contacts/'+send.contactId,null);
  assert.equal(redacted.events[0].contentUnavailable,true);assert.equal(redacted.events[0].note,undefined);
  assert.equal(redacted.events[1].note,accept.note,'independent recipient choice remains');
  assert.equal((await request(p,`/v2/chat/rooms/${accepted.roomId}/read`)).state,'active','source-note withdrawal is not retroactive removal of accepted membership');
  if(options.afterWorkflow)await options.afterWorkflow({f,p,alias,request,project,contact:send,contactAcceptance:accept,room,task});
  assert.deepEqual(issuer.failures,[]);
  return {realLocalOidc:true,actualHttp:true,sharedAccountInvitationCooldown:true,recipientScopedPrivateConsent:true,
   noPrematureRoom:true,uniqueAcceptedOwnerlessRoom:true,blockPreventsAcceptance:true,ordinaryChatNoTaskOrContribution:true};
 }finally{if(api){api.closeAllConnections();await new Promise(r=>api.close(r));}if(f&&!database)await f.db.close();await issuer.close();}
}
