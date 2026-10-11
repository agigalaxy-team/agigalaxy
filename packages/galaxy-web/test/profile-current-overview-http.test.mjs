import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from '../../galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../galaxy-official/src/http.mjs';
import {HonorService} from '../../galaxy-official/src/honor.mjs';
import {browserScopes} from '../../galaxy-official/src/browser-client.mjs';
import {readProfileDisplayNames} from '../../galaxy-official/src/profile-display-names.mjs';
import {createProfileClient} from '../src/profile-client.mjs';
import {createHistoryClient} from '../src/history-client.mjs';

async function fixture(t){
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)+30}),
  p=await serviceFixture(browserScopes,f.db,{now:f.now,migrateDatabase:false});
 const policy={id:'visible-work',version:'1',title:'合成协作贡献',kind:'open-contributor',capabilityId:'compiler',communityId:'isolated',
  members:[f.actor.subjectId,p.actor.subjectId],relatedPartyGroups:[],notBefore:f.now-1,notAfter:f.now+1000,
  windowFrom:f.now-100,windowUntil:f.now+100,minAcceptedCases:1,minProofs:0,repositories:[],rankingEnabled:false};
 f.honor=new HonorService(f.access,f.assistance,f.proofs,[policy,{...policy,id:'unearned-ci',kind:'ci-backed-contributor',minProofs:1,
  repositories:[{owner:'isolated',repository:'example'}]}]);
 const api=createApi({...f,rateLimit:10000});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+api.address().port,calls=[];
 // The service uses real signed, scoped fixture sessions. This small browser
 // adapter isolates only local session generation and network response timing.
 function runtime(who=null){
  let generation=1,hold=null;
  const snapshot=()=>who?{endpoint:f.access.endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,generation,scopes:browserScopes}:null;
  return{api:{endpoint:f.access.endpoint,snapshot,async call(path,input,{authenticated=true}={}){
   calls.push(path);const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',
    ...(authenticated&&who?{Authorization:`Bearer ${who.credential}`}:{})},body:JSON.stringify(input)});
   const value=await response.json();if(response.status!==200)throw Object.assign(new Error(value.error),{code:value.error,status:response.status});
   if(hold?.path===path){const pending=hold;hold=null;pending.started();await pending.released;}
   return value;
  }},status:async()=>({identity:who?{subjectId:who.actor.subjectId}:null}),receiptStatus:{captureLease(){
   const captured=generation;return{assertCurrent(){if(captured!==generation)throw Error('receipt_status_authority_changed');}};
  }},renew(){generation++;},hold(path){let started,release;const began=new Promise(resolve=>{started=resolve;}),released=new Promise(resolve=>{release=resolve;});
   hold={path,started,released};return{began,release};}};
 }
 const publish=async(who,revision,selfDeclared,options={visibility:'Public',purpose:'public-profile'})=>{
  const statement={id:randomUUID(),expectedRevision:revision,selfDeclared},grant=await who.authorize(statement,'profile.publish',options);
  await f.profiles.publish(who.actor,grant);return grant;
 };
 const publicWork=async()=>{
  const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'合成工作',summary:'隔离测试',source:{kind:'local',reference:randomUUID()},
   participants:[{subjectId:f.actor.subjectId,role:'requester'}]};await f.cases.submit(f.actor,await f.authorize(root));
  const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'合成诊断',configuration:{environment:'test',version:'1',tools:[]}};
  await f.cases.submit(f.actor,await f.authorize(attempt));
  const request={id:randomUUID(),caseId:root.id,title:'合成求助',problem:'合成问题',attemptedApproaches:[],scope:'合成范围',visibility:'Public',
   collaboration:'open-assistance',capabilityId:'compiler',enrollmentExpiresAt:f.now+800};
  await f.assistance.create(f.actor,await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));
  let version=1;
  const event=async(who,kind,fields={},publicEvent=false)=>{
   const ev={id:randomUUID(),expectedVersion:version,kind,...fields},grant=await who.authorize({assistanceId:request.id,event:ev},'assistance.publish',
    {objectId:ev.id,...(publicEvent?{visibility:'Public',purpose:'public-profile'}:{viewers:[who===f?p.actor.subjectId:f.actor.subjectId]})});
   version=(await f.assistance.submit(who.actor,request.id,grant)).version;return{ev,grant};
  };
  const offer=await event(p,'offer',{proposal:'诊断',scope:'合成范围'});await event(f,'select',{offerId:offer.ev.id});
  await event(p,'confirm',{},true);const delivery=await event(p,'deliver',{attemptId:attempt.id,evidenceIds:[],summary:'合成提交'},true);
  return event(f,'accept',{deliveryId:delivery.ev.id,summary:'合成接受'},true);
 };
 const fact=async(who,title,options={visibility:'Public',purpose:'public-profile'})=>{
  const id=randomUUID(),payload={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:who.actor.subjectId,
   localRef:randomUUID(),title,summary:'仅隔离验证',synthetic:true,source:{kind:'local',reference:randomUUID()}};
  const grant=await who.authorize(payload,'case.teaser.publish',{objectId:id,...options});await f.cases.submitV2(who.actor,grant);return{payload,grant};
 };
 t.after(async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();});
 return{f,p,policy,runtime,publish,publicWork,fact,calls};
}

test('current profile overview and shared names preserve viewer permissions, declaration source, actual Honor and revocation',async t=>{
 const f=await fixture(t),viewer=f.runtime(f.f),visitor=f.runtime(),owner=f.runtime(f.p);
 const selected=createProfileClient(viewer,{subjectId:f.f.actor.subjectId,targetSubjectId:f.p.actor.subjectId,authenticated:true}),
  publicProfile=createProfileClient(visitor,{targetSubjectId:f.p.actor.subjectId}),mine=createProfileClient(owner,{subjectId:f.p.actor.subjectId,authenticated:true});
 const project={id:randomUUID(),kind:'project',title:'隔离资料页验证',summary:'仅用于检验当前允许阅读的自述项目。',functions:['协作'],technologies:[],sourceUrl:'https://example.org/profile-project',discoverable:false};
 await f.publish(f.p,0,{displayName:'当前可见名字',about:'自述介绍',claimedCapabilities:['自述编译器调试'],projects:[project]});
 let card=await selected.overview();assert.equal(card.subjectId,f.p.actor.subjectId);assert.equal(card.displayName,'当前可见名字');
 assert.equal(card.about,'自述介绍');assert.deepEqual(card.tags,['自述编译器调试']);assert.equal(card.profileSource.classification,'self-declared');
 assert.deepEqual(card.projects,[project]);
 assert.equal(card.profileRevision,undefined,'a selected other subject does not acquire the owner revision');assert.deepEqual(card.honors,[]);
 assert.equal((await mine.overview()).profileRevision,1);assert.equal((await publicProfile.overview()).displayName,'当前可见名字');
 assert.deepEqual(await selected.displayNames([f.p.actor.subjectId]),[{subjectId:f.p.actor.subjectId,displayName:'当前可见名字',readExpiresAt:f.f.now+60}],
  'shared name views receive the same current reading deadline as the profile declaration');
 const accepted=await f.publicWork();card=await publicProfile.overview();assert.equal(card.honors.length,1);
 assert.equal(card.honors[0].title,f.policy.title);assert.equal(card.honors[0].status,'active');assert.equal(card.honorsError,null);
 assert.equal((await publicProfile.honor(card.honors[0])).card.acceptedCases,1);
 const privateGrant=await f.publish(f.p,1,{displayName:'现在仅本人可见',about:'私有替换'},{visibility:'Private',viewers:[]});
 assert.equal((await selected.overview()).displayName,null);assert.equal((await publicProfile.overview()).displayName,null);
 assert.deepEqual((await selected.overview()).projects,[],'a new private declaration removes previously public projects too');
 assert.equal((await mine.overview()).displayName,'现在仅本人可见');
 assert.deepEqual(await readProfileDisplayNames(viewer.api.call.bind(viewer.api),[f.p.actor.subjectId,f.p.actor.subjectId]),
  [{subjectId:f.p.actor.subjectId,displayName:null}]);
 await f.f.consents.revoke(f.p.actor,privateGrant.consentId);assert.equal((await mine.overview()).displayName,null,'revocation never restores the old public name');
 assert.deepEqual(await selected.displayNames([f.p.actor.subjectId]),[{subjectId:f.p.actor.subjectId,displayName:null}]);
 await f.f.consents.revoke(f.f.actor,accepted.grant.consentId);assert.deepEqual((await publicProfile.overview()).honors,[],'current source revocation removes the actual award');
 assert.ok(f.calls.every(path=>['/v1/history/query','/v1/honor/rules','/v1/honor/query'].includes(path)),'the overview creates no new publications or permissions');
});

test('history defaults to the viewer, separates selected subject, and restarts pagination when current sources change',async t=>{
 const f=await fixture(t),viewer=f.runtime(f.f),mine=createHistoryClient(viewer,{subjectId:f.f.actor.subjectId,authenticated:true}),
  selected=createHistoryClient(viewer,{subjectId:f.f.actor.subjectId,targetSubjectId:f.p.actor.subjectId,authenticated:true});
 const own=await f.fact(f.f,'本人履历'),other=await f.fact(f.p,'公开履历'),privateFact=await f.fact(f.p,'向当前观察者授权的履历',{visibility:'Private',viewers:[f.f.actor.subjectId]});
 assert.deepEqual((await mine.query()).items.map(item=>item.caseId),[own.payload.caseId]);
 const first=await selected.query({limit:1});assert.equal(first.subjectId,f.p.actor.subjectId);assert.ok(first.nextCursor);
 const next=await selected.more({limit:1,after:first.nextCursor});assert.equal(next.restarted,undefined);
 assert.deepEqual(new Set([...first.items,...next.items].map(item=>item.caseId)),new Set([other.payload.caseId,privateFact.payload.caseId]));
 await f.f.consents.revoke(f.p.actor,privateFact.grant.consentId);
 const fresh=await selected.more({limit:1,after:first.nextCursor});assert.equal(fresh.restarted,true);assert.equal(fresh.nextCursor,null);
 assert.deepEqual(fresh.items.map(item=>item.caseId),[other.payload.caseId]);
 viewer.renew();await assert.rejects(selected.query(),/authority_changed|history_identity_changed/);
});

test('profile overview and shared name reads discard a late authorized response after connection generation changes',async t=>{
 const f=await fixture(t),viewer=f.runtime(f.p),profile=createProfileClient(viewer,{subjectId:f.p.actor.subjectId,authenticated:true});
 await f.publish(f.p,0,{displayName:'仅原会话可读'},{visibility:'Private',viewers:[]});
 const wait=viewer.hold('/v1/history/query'),pending=profile.overview();await wait.began;viewer.renew();wait.release();
 await assert.rejects(pending,/authority_changed|profile_identity_changed/);
 const next=createProfileClient(viewer,{subjectId:f.p.actor.subjectId,authenticated:true}),held=viewer.hold('/v1/history/query'),names=next.displayNames([f.p.actor.subjectId]);
 await held.began;viewer.renew();held.release();await assert.rejects(names,/authority_changed|profile_identity_changed/);
});
