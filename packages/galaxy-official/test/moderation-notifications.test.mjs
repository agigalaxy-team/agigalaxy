import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {ModerationNotificationAdapter} from "../src/notifications/moderation-notifications.mjs";
import {moderationNotificationsV2MigrationSql} from '../src/infrastructure/moderation-notifications-v2-schema.mjs';

async function fixture({collidingEventId=false}={}){
 const scopes=['binding','consent','case-teaser','moderation','notifications'];
 const owner=await serviceFixture(scopes),reporter=await serviceFixture(scopes,owner.db),moderator=await serviceFixture(scopes,owner.db),verifier=await serviceFixture(scopes,owner.db),outsider=await serviceFixture(scopes,owner.db);
 let clock=owner.now;owner.access.now=()=>clock;owner.consents.now=()=>clock;
 owner.moderation.moderatorIds=[moderator.actor.subjectId];
 const applied=(await owner.db.query('SELECT version FROM schema_migrations WHERE version=77')).rows.length;
 if(!applied)await owner.db.exec(moderationNotificationsV2MigrationSql);
 // When constructor integration is not yet captured, inject only the same
 // adapter dependency, never a synthetic notification or permission result.
 owner.inbox.moderationNotifications??=new ModerationNotificationAdapter(owner.moderation);
 const api=createApi({...owner,rateLimit:600});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${api.address().port}`;
 const request=async(who,path,body={})=>{
  const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${who.credential}`},body:JSON.stringify(body)});
  return{status:response.status,body:await response.json()};
 };
 const post=async(who,path,body={})=>{const result=await request(who,path,body);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
 const root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Synthetic notification source',summary:'Private Case statement',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:owner.actor.subjectId,role:'requester'}]};
 const source=await owner.authorize(root,'case.teaser.publish',{viewers:[reporter.actor.subjectId,moderator.actor.subjectId,verifier.actor.subjectId]});
 await owner.cases.submit(owner.actor,source);
 const report={id:randomUUID(),caseId:root.id,caseVersion:1,targetEventId:root.id,category:'other',summary:'Private allegation is never notification content'};
 const reportGrant=await reporter.authorize(report,'moderation.publish',{viewers:[moderator.actor.subjectId]});
 await post(reporter,'/v1/moderation/reports',reportGrant);
 const invite={id:collidingEventId?report.id:randomUUID(),reportId:report.id,expectedVersion:1,kind:'invite-verifier',summary:'Private invitation statement',verifierId:verifier.actor.subjectId,
  target:{caseId:root.id,caseVersion:1,targetEventId:root.id},scope:'Private exact review scope',expiresAt:clock+30};
 const invitationGrant=await moderator.authorize(invite,'moderation.publish',{viewers:[owner.actor.subjectId,reporter.actor.subjectId,verifier.actor.subjectId]});
 await post(moderator,`/v1/moderation/reports/${report.id}/events`,invitationGrant);
 // PostgreSQL source timestamps normally use now(). The deterministic fixture
 // clock is 2033, so align only synthetic event dates with the fixture clock.
 await owner.db.query('UPDATE moderation_reports SET created_at=$1',[new Date(clock*1000).toISOString()]);
 await owner.db.query('UPDATE moderation_events SET created_at=$1',[new Date(clock*1000).toISOString()]);
 return{owner,reporter,moderator,verifier,outsider,source,report,invite,invitationGrant,post,request,
  query:who=>post(who,'/v2/notifications/query'),advance:seconds=>{clock+=seconds;},
  close:async()=>{api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await owner.db.close();}};
}
const claim=id=>({id,deliveryClientId:randomUUID(),claimId:randomUUID()});

test('real signed invitation reaches its exact inbox object and shared display/read state without private content',async()=>{
 const f=await fixture();try{
  const adapter=f.owner.inbox.moderationNotifications;f.owner.inbox.moderationNotifications=null;
  assert.equal((await f.query(f.verifier)).items.some(v=>v.object.type==='moderation'),false,'Without the new source adapter the actual invitation never reaches the inbox');
  f.owner.inbox.moderationNotifications=adapter;
  const id='moderation-event:'+f.invite.id,item=(await f.query(f.verifier)).items.find(v=>v.id===id);
  assert.deepEqual(item.object,{type:'moderation',id:f.report.id,eventId:f.invite.id,version:2});
  assert.equal(item.category,'invitations');assert.equal(item.eventKind,'moderation-invite-verifier');assert.equal(item.interruptiveEligible,true);
  for(const privateText of [f.report.summary,f.invite.summary,f.invite.scope,'Private Case statement'])assert.equal(JSON.stringify(item).includes(privateText),false);
  assert.equal((await f.query(f.outsider)).items.some(v=>v.object.type==='moderation'),false);
  assert.equal((await f.query(f.owner)).items.some(v=>v.id===id),false,'Another affected Case party is not the invited verifier');
  const first=claim(id),other=claim(id);
  assert.equal((await f.post(f.verifier,'/v2/notifications/presentation/claim',first)).claimed,true);
  assert.equal((await f.post(f.verifier,'/v2/notifications/presentation/claim',first)).claimed,true,'Original claim is idempotent');
  assert.equal((await f.post(f.verifier,'/v2/notifications/presentation/claim',other)).claimed,false,'A second client cannot acquire the active lease');
  const displayed=await f.post(f.verifier,'/v2/notifications/presentation/ack',first);assert.equal(displayed.presented,true);assert.equal(displayed.humanReadChanged,false);assert.equal(displayed.read,false);
  assert.equal((await f.query(f.verifier)).items.find(v=>v.id===id).read,false);
  assert.equal((await f.post(f.verifier,'/v2/notifications/presentation/claim',other)).claimed,false);
  await f.post(f.verifier,'/v2/notifications/read',{id,reader:'human'});
  assert.equal((await f.query(f.verifier)).items.find(v=>v.id===id).read,true);
  assert.equal((await f.post(f.verifier,'/v2/notifications/query',{unreadOnly:true})).items.some(v=>v.id===id),false);
  const read=await f.post(f.verifier,`/v1/moderation/reports/${f.report.id}/read`);assert.equal(read.verifierParticipation.own.invitationId,f.invite.id);assert.equal(read.canAcceptVerifier,true);
 }finally{await f.close();}
});

test('a report and signed event with the same UUID keep separate notification/read/claim identities',async()=>{
 const f=await fixture({collidingEventId:true});try{
  const reportId='moderation-report:'+f.report.id,eventId='moderation-event:'+f.invite.id;
  assert.equal(f.report.id,f.invite.id);
  const report=(await f.query(f.moderator)).items.find(v=>v.id===reportId),invite=(await f.query(f.verifier)).items.find(v=>v.id===eventId);
  assert.equal(report.object.version,1);assert.equal(invite.object.version,2);assert.equal(invite.category,'invitations');
  await f.post(f.moderator,'/v2/notifications/read',{id:reportId,reader:'human'});
  assert.equal((await f.query(f.verifier)).items.find(v=>v.id===eventId).read,false);
  assert.equal((await f.post(f.verifier,'/v2/notifications/presentation/claim',claim(eventId))).claimed,true);
 }finally{await f.close();}
});

test('revoked invitation disappears before old private parsing but an already displayed original claim can still ACK',async()=>{
 const f=await fixture();try{
  const id='moderation-event:'+f.invite.id,original=claim(id);await f.post(f.verifier,'/v2/notifications/presentation/claim',original);
  await f.owner.consents.revoke(f.moderator.actor,f.invitationGrant.consentId);
  await f.owner.db.query('UPDATE moderation_events SET payload_text=$2 WHERE id=$1',[f.invite.id,'private bytes removed']);
  f.owner.moderation.readWithin=()=>{throw new Error('revoked candidate must not parse old private report');};
  assert.equal((await f.query(f.verifier)).items.some(v=>v.id===id),false);
  assert.equal((await f.request(f.verifier,'/v2/notifications/presentation/claim',claim(id))).status,404);
  const result=await f.post(f.verifier,'/v2/notifications/presentation/ack',original);assert.equal(result.presented,true);assert.equal(result.read,false);assert.equal(result.humanReadChanged,false);
  assert.equal((await f.post(f.outsider,'/v2/notifications/presentation/ack',original)).presented,false);
 }finally{await f.close();}
});

test('business expiry and current source withdrawal each invalidate invitation notifications without altering original facts',async()=>{
 const f=await fixture();try{
  const id='moderation-event:'+f.invite.id;assert.ok((await f.query(f.verifier)).items.some(v=>v.id===id));
  await f.owner.consents.revoke(f.owner.actor,f.source.consentId);
  assert.equal((await f.query(f.verifier)).items.some(v=>v.id===id),false);
  assert.equal((await f.request(f.verifier,'/v2/notifications/presentation/claim',claim(id))).status,404);
  assert.equal(Number((await f.owner.db.query('SELECT count(*) FROM moderation_events WHERE id=$1',[f.invite.id])).rows[0].count),1);
 }finally{await f.close();}
 const expired=await fixture();try{
  expired.advance(31);assert.equal((await expired.query(expired.verifier)).items.some(v=>v.id==='moderation-event:'+expired.invite.id),false);
 }finally{await expired.close();}
});

test('muted invitations do not interrupt and exact necessary handling notices stay quiet without expanding audience',async()=>{
 const f=await fixture();try{
  const prefs=await f.owner.notifications.preferences(f.verifier.actor);
  await f.owner.notifications.save(f.verifier.actor,{expectedRevision:prefs.revision,settings:{...prefs.settings,invitations:false,incidents:false}});
  const inviteId='moderation-event:'+f.invite.id;assert.equal((await f.query(f.verifier)).items.some(v=>v.id===inviteId),false);
  const pause={id:randomUUID(),reportId:f.report.id,expectedVersion:2,kind:'pause',summary:'Private temporary process decision'};
  const grant=await f.moderator.authorize(pause,'moderation.publish',{viewers:[f.owner.actor.subjectId,f.reporter.actor.subjectId]});
  await f.post(f.moderator,`/v1/moderation/reports/${f.report.id}/events`,grant);
  await f.owner.db.query('UPDATE moderation_events SET created_at=$2 WHERE id=$1',[pause.id,new Date(f.owner.now*1000).toISOString()]);
  const reporterPrefs=await f.owner.notifications.preferences(f.reporter.actor);
  await f.owner.notifications.save(f.reporter.actor,{expectedRevision:reporterPrefs.revision,settings:{...reporterPrefs.settings,enabled:false}});
  const item=(await f.query(f.reporter)).items.find(v=>v.id==='moderation-event:'+pause.id);
  assert.ok(item);assert.equal(item.serviceReceipt,true);assert.equal(item.quiet,true);assert.equal(item.interruptiveEligible,false);assert.equal(item.object.type,'moderation');
  assert.equal(JSON.stringify(item).includes(pause.summary),false);assert.equal((await f.query(f.outsider)).items.some(v=>v.id===item.id),false);
  assert.equal((await f.query(f.verifier)).items.some(v=>v.id===item.id),false,'Being invited never grants unseen process-event recipients');
  assert.equal((await f.post(f.reporter,'/v2/notifications/presentation/claim',claim(item.id))).claimed,false);
 }finally{await f.close();}
});
