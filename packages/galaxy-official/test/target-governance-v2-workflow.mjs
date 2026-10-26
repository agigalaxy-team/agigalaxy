import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { ChatService } from "../src/chat/service.mjs";
import { TargetGovernanceServiceV2 } from "../src/governance/target-governance-v2.mjs";
import { targetGovernanceV2MigrationSql } from '../src/infrastructure/target-governance-v2-schema.mjs';
import { targetRestrictionsWithin } from "../src/governance/target-governance-restrictions-v2.mjs";
import { digest } from '../src/shared/digest.mjs';
import { createApi } from '../src/http.mjs';
import { createBrowserClient } from '../src/browser-client.mjs';
import { createTargetGovernanceClientV2 } from "../src/clients/target-governance-v2.mjs";
import { oidcProviderFixture } from './oidc-provider-fixture.mjs';
import { createOidcLoginProvider } from "../src/identity/authentication/oidc-login.mjs";
import { defaultResourceBudgetPolicy } from '../src/infrastructure/resource-budgets.mjs';
import { purgeTargetGovernanceV2 } from '../src/operations/target-governance-retention-v2.mjs';
import { minimizeRetainedProductContent } from '../src/operations/lifecycle-product-v2.mjs';
import { productV2ExportSources } from '../src/infrastructure/lifecycle-export-v2.mjs';

export async function verifyTargetGovernanceV2({database=null,adminDatabase=null,workerDatabase=null,repositories,migrateDatabase=true,afterWorkflow}={}) {
 const now=Math.floor(Date.now()/1000),scopes=['binding','consent','assistance','moderation','notifications','data-export','data-delete'];
 let f,http;const issuer=await oidcProviderFixture(['https://official.example.org/v1/identity/callback/fixture'],{emailVerified:true});try {
  const provider=await createOidcLoginProvider({id:'fixture',name:'Synthetic OIDC',issuer:issuer.issuer,clientId:'galaxy-fixture',redirectUri:'https://official.example.org/v1/identity/callback/fixture',allowLoopbackHttp:true,now:()=>now});
  const options={now,repositories,migrateDatabase,identityProviders:[provider]};
  f=await serviceFixture(scopes,database,options);const admin=adminDatabase??f.db;
  if(!(await admin.query("SELECT 1 FROM information_schema.tables WHERE table_name='target_reports_v2'")).rows.length){if(admin.exec)await admin.exec(targetGovernanceV2MigrationSql);else await admin.query(targetGovernanceV2MigrationSql);}
  const owner=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false}),other=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false}),handler=await serviceFixture(scopes,f.db,{...options,migrateDatabase:false});
  const transportCalls=[],bodies=new Map();const transport={available:true,project:async()=>{},send:async x=>{transportCalls.push(x);bodies.set(x.messageId,{archiveId:x.messageId,text:x.text,revision:1});return{accepted:true,archiveId:x.messageId};},read:async x=>x.ids.map(id=>bodies.get(id)).filter(Boolean)};
  const chat=new ChatService({db:f.db,access:f.access,transport,now:()=>now,requireAccountWithin:async()=>{},consumeInviteWithin:async()=>{},markInviteRespondedWithin:async()=>{}});
  // Internal Account/transport callbacks isolate governance semantics. They are
  // not claims about account onboarding or a real Prosody transport.
  const g=new TargetGovernanceServiceV2(f.access,f.consents,{tasks:f.assistance,chat,accounts:f.communityAccounts,moderatorIds:[owner.actor.subjectId,handler.actor.subjectId]});
  f.inbox.chat=chat;f.inbox.targetGovernance=g;
  http=createApi({...f,chat,targetGovernance:g});await new Promise(r=>http.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${http.address().port}`;
  const request=async(who,path,p,method='POST')=>{const r=await fetch(origin+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+who.credential},...(p===undefined?{}:{body:JSON.stringify(p)})});return{status:r.status,body:await r.json()};};
  const post=async(who,path,p)=>{const r=await request(who,path,p);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const task={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'proactive-review',workContext:{goal:'Synthetic governance flow',currentSituation:'No failure required',attemptRefs:[]},title:'SYNTHETIC related repository review',summary:'Normal repository links are permitted',visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:now+3600};
  const taskEnv=await owner.authorize(task,'assistance.publish',{objectId:task.operationId,visibility:'Public',purpose:'public-profile'});
  await f.assistance.createTask(owner.actor,taskEnv);
  const authorization=(who,p,viewers=[handler.actor.subjectId])=>who.authorize(p,'moderation.publish',{viewers,objectId:p.id});
  const report=async(who,type,id)=>{const target=(await g.targetInfo(who.actor,{type,id})).target;
   const p={schemaVersion:2,id:randomUUID(),target,category:'other',summary:'SYNTHETIC limited original complaint; no copied room history'};
   const env=await authorization(who,p);const receipt=await g.report(who.actor,env);return{p,env,receipt};};
  const event=async(who,r,kind,extra={},viewers=[r.p?f.actor.subjectId:owner.actor.subjectId])=>{
   const id=r.p?.id??r,read=await g.read(who.actor,id),p={schemaVersion:2,id:randomUUID(),reportId:id,expectedVersion:read.version,kind,summary:'SYNTHETIC '+kind,...extra};
   const env=await authorization(who,p,viewers);return{p,env,receipt:await g.event(who.actor,env)};};
  const a=await report(f,'task',task.taskId);assert.equal(a.receipt.state,'acknowledged');
  assert.equal((await g.report(f.actor,a.env)).version,1);
  assert.deepEqual((await targetRestrictionsWithin(f.db,'task',task.taskId,now)).scopes,[]);
  const info=await g.read(handler.actor,a.p.id);assert.equal(info.canModerate,true);assert.equal(info.currentTarget.version,1);
  const self={schemaVersion:2,id:randomUUID(),reportId:a.p.id,expectedVersion:1,kind:'pause',summary:'Invalid self judgement',targetVersion:1,scopes:['discovery-hidden'],until:now+1000,rule:'synthetic-v1'};
  await assert.rejects(g.event(owner.actor,await authorization(owner,self,[f.actor.subjectId])),e=>e.code==='target_independent_handler_required');
  await assert.rejects(g.read(other.actor,a.p.id),e=>e.status===404);
  const _paused=await event(handler,a,'pause',{targetVersion:1,scopes:['discovery-hidden','new-participation-paused'],until:now+1000,rule:'synthetic-v1'});
  await assert.rejects(f.assistance.getPublicTask(task.taskId),e=>e.status===404);
  assert.equal((await f.assistance.queryPublicTasks({})).items.some(x=>x.taskId===task.taskId),false);
  assert.equal((await f.assistance.getTask(owner.actor,task.taskId)).governance.scopes.includes('discovery-hidden'),true);
  const b=await report(owner,'task',task.taskId);
  await event(handler,b,'pause',{targetVersion:1,scopes:['new-participation-paused'],until:now+1000,rule:'synthetic-v1'},[owner.actor.subjectId]);
  await event(handler,a,'resume');assert.deepEqual((await targetRestrictionsWithin(f.db,'task',task.taskId,now)).scopes,['new-participation-paused']);
  const application={taskId:task.taskId,event:{eventId:randomUUID(),expectedTaskVersion:1,kind:'apply',proposal:'Synthetic related help',scope:'Limited review'}};
  await assert.rejects(f.assistance.submitTaskEvent(other.actor,task.taskId,await other.authorize(application,'assistance.publish',{objectId:application.event.eventId,viewers:[owner.actor.subjectId]})),e=>e.code==='target_operation_restricted');
  await event(handler,b,'resolve',{targetVersion:1,verdict:'dismissed',rule:'synthetic-v1',restriction:null},[owner.actor.subjectId]);
  await event(owner,b,'appeal',{},[handler.actor.subjectId]);
  assert.equal((await g.read(owner.actor,b.p.id)).state,'appealed');
  const roomId=randomUUID();await chat.create(owner.actor,{roomId,operationId:randomUUID(),title:'SYNTHETIC ordinary room'});
  const invitation=await chat.proposeDecision(owner.actor,roomId,{decisionId:randomUUID(),expectedRevision:1,action:'invite',targetSubjectId:f.actor.subjectId});
  await chat.acceptInvite(f.actor,roomId,{decisionId:invitation.decisionId});
  const pendingInvite=await chat.proposeDecision(owner.actor,roomId,{decisionId:randomUUID(),expectedRevision:(await chat.get(owner.actor,roomId)).revision,action:'invite',targetSubjectId:other.actor.subjectId});
  await chat.voteDecision(f.actor,roomId,{decisionId:pendingInvite.decisionId,choice:'approve'});
  assert.equal((await chat.invitations(other.actor)).invitations.some(x=>x.decisionId===pendingInvite.decisionId),true);
  const originalMessage=await chat.send(owner.actor,roomId,{clientMessageId:randomUUID(),text:'SYNTHETIC ordinary conversation remains readable'});
  const roomReport=await report(f,'room',roomId),roomVersion=(await chat.get(f.actor,roomId)).revision;
  const rr=await event(handler,roomReport,'pause',{targetVersion:roomVersion,scopes:['sending-paused','invitations-paused'],until:now+1000,rule:'synthetic-v1'});
  assert.equal((await chat.invitations(other.actor)).invitations.some(x=>x.decisionId===pendingInvite.decisionId),false);
  assert.equal((await f.inbox.query(other.actor,{})).items.some(x=>x.object?.roomId===roomId),false);
  await assert.rejects(chat.acceptInvite(other.actor,roomId,{decisionId:pendingInvite.decisionId}),e=>e.code==='target_operation_restricted');
  const calls=transportCalls.length;
  await assert.rejects(chat.send(owner.actor,roomId,{clientMessageId:randomUUID(),text:'Must stop before transport'}),e=>e.code==='target_operation_restricted');
  await assert.rejects(chat.edit(owner.actor,roomId,originalMessage.messageId,{operationId:randomUUID(),expectedRevision:1,text:'Must not edit the archive'}),e=>e.code==='target_operation_restricted');
  assert.equal(transportCalls.length,calls);assert.equal((await chat.history(f.actor,roomId)).messages[0].text,'SYNTHETIC ordinary conversation remains readable');
  const notices=await f.inbox.query(owner.actor,{}),notice=notices.items.find(x=>x.id==='target-governance:'+rr.p.id);assert.ok(notice);assert.equal(JSON.stringify(notice).includes('limited original complaint'),false);
  const roomView=await g.read(handler.actor,roomReport.p.id);assert.equal(roomView.currentTarget.canReadTarget,false);assert.equal(roomView.currentTarget.contentAccess,'report-does-not-grant-room-history-or-membership');
  await assert.rejects(chat.get(handler.actor,roomId),e=>e.code==='chat_access_denied');
  assert.deepEqual((await chat.get(owner.actor,roomId)).taskRefs,[]);
  assert.deepEqual((await targetRestrictionsWithin(f.db,'room',roomId,now)).scopes,['sending-paused','invitations-paused']);
  assert.equal((await g.read(f.actor,roomReport.p.id)).canAppeal,true,'temporary pause itself can be appealed');
  await event(f,roomReport,'appeal',{},[handler.actor.subjectId]);
  assert.deepEqual((await targetRestrictionsWithin(f.db,'room',roomId,now)).scopes,['sending-paused','invitations-paused']);
  await f.consents.revoke(f.actor,roomReport.env.consentId);
  assert.equal((await g.read(handler.actor,roomReport.p.id)).events.some(x=>x.eventId===roomReport.p.id),false);
  assert.deepEqual((await targetRestrictionsWithin(f.db,'room',roomId,now)).scopes,['sending-paused','invitations-paused'],'revoking complaint does not silently cancel accepted restriction');
  await event(handler,roomReport,'resume');assert.deepEqual((await targetRestrictionsWithin(f.db,'room',roomId,now)).scopes,[]);
  assert.equal((await chat.invitations(other.actor)).invitations.some(x=>x.decisionId===pendingInvite.decisionId),true);
  assert.equal((await g.receipt(handler.actor,{eventId:rr.p.id,payloadHash:digest(rr.env.payloadJson)})).state,'acknowledged');
  await assert.rejects(g.receipt(other.actor,{eventId:rr.p.id,payloadHash:digest(rr.env.payloadJson)}),e=>e.status===404);
  async function login(who,account){issuer.setAccount(account);const start=await post(who,'/v1/identity/begin',{providerId:'fixture'}),cb=await issuer.authorize(start.authorizationUrl);
   assert.equal((await fetch(origin+cb.pathname+cb.search)).status,200);const status=await post(who,'/v1/identity/status',{id:start.loginId});
   await post(who,'/v1/identity/confirm',{id:start.loginId,signed:await who.signForTest(status.payloadJson,'galaxy-identity-link+jws')});}
  await login(f,'synthetic-same-controller');await login(other,'synthetic-same-controller');g.moderatorIds.push(other.actor.subjectId);
  const aliasReport={schemaVersion:2,id:randomUUID(),target:(await g.targetInfo(f.actor,{type:'task',id:task.taskId})).target,category:'other',summary:'SYNTHETIC same-Account independence boundary'};
  await g.report(f.actor,await authorization(f,aliasReport,[handler.actor.subjectId,other.actor.subjectId]));
  assert.equal((await g.read(other.actor,aliasReport.id)).canModerate,false);
  const aliasEvent={schemaVersion:2,id:randomUUID(),reportId:aliasReport.id,expectedVersion:1,kind:'review',summary:'Cannot judge via another controlled GUID'};
  await assert.rejects(g.event(other.actor,await authorization(other,aliasEvent,[f.actor.subjectId])),e=>e.code==='target_independent_handler_required');
  const raceInputs=await Promise.all([0,1].map(async()=>{const p={...aliasEvent,id:randomUUID()};return authorization(handler,p,[f.actor.subjectId]);}));
  const raced=await Promise.allSettled(raceInputs.map(x=>g.event(handler.actor,x)));
  assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);assert.equal(raced.find(x=>x.status==='rejected').reason.code,'target_governance_version_changed');
  assert.equal((await request(other,'/v2/target-governance/receipt',{eventId:rr.p.id,payloadHash:digest(rr.env.payloadJson)})).status,404);
  const budget=f.access.resourceBudgetPolicy;f.access.resourceBudgetPolicy={...defaultResourceBudgetPolicy,maxPayloadBytesPerSubject:0};
  try{await event(owner,b,'supplement',{},[handler.actor.subjectId]);}finally{f.access.resourceBudgetPolicy=budget;}
  // Actual browser-protocol client and HTTP server, injected local Map only.
  // No real browser IndexedDB or host UI is claimed by this test.
  const publicKey=f.genesis.genesisProof.publicKeyPem,deviceId=randomUUID(),upgrade={version:2,operationId:randomUUID(),subjectId:f.actor.subjectId,kind:'bootstrap',expectedEpoch:0,previousEventHash:null,signerKeyId:digest(publicKey),genesisProof:f.genesis.genesisProof,newDevice:{deviceId,publicKeyPem:publicKey,scopes:['manage-identity',...scopes]}};
  const challenge=await f.identityControl.challenge(upgrade),signature=await f.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');await f.identityControl.commit({operationId:upgrade.operationId,controllerSignature:signature,newDeviceProof:signature});
  let lost=true,writes=0;const browser=createBrowserClient({endpoint:f.access.endpoint,trustedKeys:f.access.trustedKeys,sign:f.signForTest,now:()=>now,fetch:async(url,init)=>{const path=new URL(url).pathname,res=await fetch(origin+path,init);if(path==='/v2/target-governance/reports'){writes++;if(lost&&res.status===200){lost=false;throw Error('synthetic lost governance ACK');}}return res;}});
  const connect=()=>browser.connect({subjectId:f.actor.subjectId,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes,control:{deviceId,keyId:digest(publicKey),epoch:1}},{confirmed:true});
  const local=new Map();await connect();const client=createTargetGovernanceClientV2({api:browser,subjectId:f.actor.subjectId,getLocal:async k=>structuredClone(local.get(k)),putLocal:async(k,v)=>local.set(k,structuredClone(v))});
  const browserPayload={schemaVersion:2,id:randomUUID(),target:(await client.target({type:'room',id:roomId})).target,category:'other',summary:'SYNTHETIC browser-client report exact lost reply'};
  const preview=await client.prepare('report',browserPayload,{viewers:[handler.actor.subjectId]});await assert.rejects(client.execute(preview,{confirmed:true}),/synthetic lost/);
  await connect();assert.equal((await client.retry(browserPayload.id,{confirmed:true})).state,'acknowledged');assert.equal(writes,1);assert.deepEqual(await client.pending(),[]);browser.disconnect();
  // Current source revocation is not undone by resuming the governance case.
  await owner.consents.revoke(owner.actor,taskEnv.consentId);await event(handler,b,'resume',{},[owner.actor.subjectId]);
  await assert.rejects(f.assistance.getPublicTask(task.taskId),e=>[403,404].includes(e.status));
  const worker=workerDatabase??admin;
  const exportSpec=productV2ExportSources['target-governance-events-v2'];assert.ok(exportSpec);assert.equal(exportSpec.owner,'t.subject_id');
  await minimizeRetainedProductContent(admin,{subjectId:f.actor.subjectId,at:now,retainedUntil:now+180*86400,requestId:randomUUID(),reason:'subject-deletion'});
  assert.equal((await admin.query('SELECT payload_text FROM target_governance_events_v2 WHERE id=$1',[aliasReport.id])).rows[0].payload_text,'');
  assert.notEqual((await admin.query('SELECT payload_text FROM target_governance_events_v2 WHERE id=$1',[rr.p.id])).rows[0].payload_text,'');
  await event(owner,b,'withdraw-report',{},[handler.actor.subjectId]);
  const cleaned=await purgeTargetGovernanceV2(worker,now+181*86400);assert.ok(cleaned.targetReports>=1);
  await afterWorkflow?.({f,owner,other,handler,g,chat,task,taskEnv,authorization,event,report,a,b,roomReport,roomId,now,admin,transportCalls});
  return{taskRoomTargets:true,independentHandler:true,sameVerifiedAccountDenied:true,exactRetry:true,actualHttpBrowserClient:true,privateRoomHistoryNotDisclosed:true,multipleRestrictions:true,appeal:true,revocationSeparateFromRestriction:true,sourceRevocationRespected:true,actualConsumers:true,ownerBodyErasure:true};
 }finally{if(http)await new Promise(r=>http.close(r));await issuer.close();if(f&&!database)await f.db.close();}
}
