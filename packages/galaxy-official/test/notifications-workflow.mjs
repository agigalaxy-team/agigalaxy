import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createNotificationsClient } from "../src/clients/notifications.mjs";
import { createAssistanceClient } from "../src/clients/assistance.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";

import { digest } from '../src/shared/digest.mjs';
import { defaultCommunityPolicy } from "../src/publishing/public-writes.mjs";

export async function verifyNotificationsWorkflow(db = null, options = {}) {
  const scopes = ['binding','consent','case-teaser','assistance','notifications'];
  const endpoint='https://official.example.org', issuer='https://issuer.example.org';
  const identityProvider={describe:()=>({id:'synthetic',name:'Synthetic account fixture',issuer,clientId:'synthetic',redirectUri:`${endpoint}/v1/identity/callback/synthetic`})};
  const communityPolicy={...defaultCommunityPolicy,new:{...defaultCommunityPolicy.new,task:20,invitation:8},normal:{...defaultCommunityPolicy.normal,task:20,invitation:8}};
  const fixtureOptions={...options,endpoint,identityProviders:[identityProvider],communityPolicy,syntheticCommunityQuota:false};
  const f = await serviceFixture(scopes, db, fixtureOptions), p = await serviceFixture(scopes, f.db, {...fixtureOptions,migrateDatabase:false}), other = await serviceFixture(scopes, f.db, {...fixtureOptions,migrateDatabase:false});
  const accountId=randomUUID(), linkId=randomUUID(), verifiedAt=new Date(f.now*1000).toISOString();
  await f.db.query("INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature,created_at) VALUES($1,$2,$3,$4,'synthetic',$5,$6,'synthetic','{}',$7,'synthetic',$8)", [linkId,f.actor.subjectId,f.actor.bindingId,f.bindings.endpoint,issuer,'notifications-account',digest('{}'),verifiedAt]);
  await f.db.query("INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at) VALUES($1,$2,$3,$4,'external-account',$5,$5)", [accountId,f.bindings.endpoint,issuer,'notifications-account',verifiedAt]);
  await f.db.query('INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)',[linkId,accountId,f.actor.subjectId,verifiedAt]);
  const api = createApi(f); await new Promise(resolve => api.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${api.address().port}`, memories = [];
  function host(who) {
    const sessions = createSessionMemory({ now: () => f.now, isCurrent: async () => true }); memories.push(sessions);
    sessions.adopt({ endpoint, subjectId: who.actor.subjectId, bindingId: who.actor.bindingId, scopes: who.actor.scopes,
      expiresAt: f.now + 500, bindingExpiresAt: f.now + 1000, takeCredential: () => who.credential });
    const send = async (url,input) => {
      const response = await fetch(origin + new URL(url).pathname, { method:'POST', headers: { 'Content-Type':'application/json', Authorization:`Bearer ${input.credential}` }, body:input.bodyJson, signal:input.signal });
      const result = await response.json(); if (response.status !== 200) throw new Error(JSON.stringify(result)); return result;
    };
    const notificationsClient = createNotificationsClient({ endpoint,sessions,send }), assistanceClient = createAssistanceClient({ endpoint,sessions,send });
    return createHostConnectionController({ endpoint,sessions,notificationsClient,assistanceClient });
  }
  const requester=host(f), provider=host(p), outsider=host(other);
  try {
    const parent={ id:randomUUID(),kind:'case',localRef:randomUUID(),title:'Notification fixture',summary:'Selected Case',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}] };
    await f.cases.submit(f.actor,await f.authorize(parent));
    const base={caseId:parent.id,title:'Small invitation',problem:'Compiler issue',attemptedApproaches:[],scope:'Inspect',visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.now+1000};
    const create=async()=>{ const request={...base,id:randomUUID()}; const grant=await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'}); await f.assistance.create(f.actor,grant); return {request,grant}; };
    const {request,grant}=await create(); let version=1;
    async function submit(who,kind,fields={}) {
      const event={id:randomUUID(),expectedVersion:version,kind,...fields};
      const auth=await who.authorize({assistanceId:request.id,event},'assistance.publish',{objectId:event.id,viewers:[who===f?p.actor.subjectId:f.actor.subjectId]});
      version=(await f.assistance.submit(who.actor,request.id,auth)).version; return {event,auth};
    }
    const invitation=await submit(f,'invite',{participantId:p.actor.subjectId,note:'Please inspect this scoped request'});
    await f.assistance.submit(f.actor,request.id,invitation.auth);
    await f.assistance.publicWrites.markInvitationRespondedWithin(f.db,{taskId:request.id,recipientId:p.actor.subjectId});
    const first=await provider.queryNotifications({}); assert.equal(first.items.length,1); assert.equal(first.items[0].eventKind,'invite');
    assert.equal(first.items[0].summary,'Please inspect this scoped request');
    assert.deepEqual((await provider.queryNotifications({})).items.map(item=>item.id),first.items.map(item=>item.id));
    assert.equal((await outsider.queryNotifications({})).items.length,0);
    await provider.markNotificationRead(first.items[0].id); await provider.markNotificationRead(first.items[0].id);
    assert.equal((await provider.queryNotifications({unreadOnly:true})).items.length,0);
    let preferences=await provider.notificationPreferences(); assert.equal(preferences.revision,0);
    preferences=await provider.saveNotificationPreferences({expectedRevision:0,settings:{...preferences.settings,enabled:false}});
    assert.equal((await provider.queryNotifications({})).enabled,false);
    await assert.rejects(provider.saveNotificationPreferences({expectedRevision:0,settings:preferences.settings}),/preferences_conflict/);
    preferences=await provider.saveNotificationPreferences({expectedRevision:preferences.revision,settings:{...preferences.settings,enabled:true,mutedAssistanceIds:[request.id]}});
    assert.equal((await provider.queryNotifications({})).items.length,0);
    await provider.saveNotificationPreferences({expectedRevision:preferences.revision,settings:{...preferences.settings,mutedAssistanceIds:[]}});
    const offer=await submit(p,'offer',{proposal:'Provider private proposal',scope:'Inspect'});
    const ownerInbox=await requester.queryNotifications({}); assert.equal(ownerInbox.items.length,1); assert.equal(ownerInbox.items[0].eventKind,'offer');
    await assert.rejects(provider.markNotificationRead(ownerInbox.items[0].id),/not_found/);
    await submit(f,'select',{offerId:offer.event.id}); await submit(p,'confirm'); await submit(f,'cancel',{reason:'Scope completed elsewhere'});
    await submit(p,'requester-feedback',{descriptionClarity:'clear',scopeMatched:true,note:'Requester supplied the necessary detail'});
    const history=await requester.queryRequesterHistory({subjectId:f.actor.subjectId,limit:20});
    assert.equal(history.items.length,1); assert.equal(history.counts.cancellations,1);
    const feedback=history.items[0].facts.find(item=>item.kind==='requester-feedback'); assert.equal(feedback.authority,'provider-reported'); assert.equal(feedback.descriptionClarity,'clear');
    assert.equal(history.items[0].independentQualityRating,false);
    const publicHistory=await outsider.queryRequesterHistory({subjectId:f.actor.subjectId});
    assert.equal(publicHistory.items[0].facts.length,0); assert.equal(publicHistory.items[0].responseSeconds,null);
    await assert.rejects(submit(p,'requester-feedback',{descriptionClarity:'clear',scopeMatched:true,note:'Duplicate'}),/transition_denied/);
    // One original invitation plus seven more reaches the configured account limit.
    for(let i=0;i<7;i++) {
      const another=await create(),event={id:randomUUID(),expectedVersion:1,kind:'invite',participantId:p.actor.subjectId,note:'Synthetic invitation'};
      await f.assistance.submit(f.actor,another.request.id,await f.authorize({assistanceId:another.request.id,event},'assistance.publish',{objectId:event.id,viewers:[p.actor.subjectId]}));
      await f.assistance.publicWrites.markInvitationRespondedWithin(f.db,{taskId:another.request.id,recipientId:p.actor.subjectId});
    }
    const over=await create(),event={id:randomUUID(),expectedVersion:1,kind:'invite',participantId:p.actor.subjectId,note:'Over quota'};
    await assert.rejects(f.assistance.submit(f.actor,over.request.id,await f.authorize({assistanceId:over.request.id,event},'assistance.publish',{objectId:event.id,viewers:[p.actor.subjectId]})),/community_quota_exceeded/);
    await f.consents.revoke(f.actor,grant.consentId);
    const remaining=await provider.queryNotifications({limit:20}); assert.ok(remaining.items.every(item=>item.assistanceId!==request.id));
    const histories=await requester.queryRequesterHistory({subjectId:f.actor.subjectId,limit:20}); assert.ok(histories.items.every(item=>item.assistanceId!==request.id));
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE actor=$1 AND action LIKE 'notification.%' ORDER BY sequence",[p.actor.subjectId])).rows;
    assert.equal(audit.filter(row=>row.action==='notification.preferences').length,3);
    assert.equal(audit.filter(row=>row.action==='notification.read').length,1,'marking the same notification read twice has one state-change audit');
    assert.ok(audit.every(row=>row.context_version===1&&row.scope==='notifications'&&row.consent_id===null&&row.binding_id===p.actor.bindingId
      &&row.caller_binding_id===p.actor.bindingId&&row.http_request_id&&row.client_id&&row.audience===endpoint));
    assert.ok(audit.every(row=>JSON.stringify(row.credential_scopes)===JSON.stringify(scopes)));
    assert.equal(new Set(audit.map(row=>row.idempotency_key)).size,4);
    for(const value of [p.credential,p.actor.credentialHash,'Please inspect this scoped request','Provider private proposal'])assert.ok(!JSON.stringify(audit).includes(value));
  } finally {memories.forEach(memory=>memory.close()); api.closeAllConnections(); await new Promise(resolve=>api.close(resolve)); if(!db) await f.db.close();}
}
