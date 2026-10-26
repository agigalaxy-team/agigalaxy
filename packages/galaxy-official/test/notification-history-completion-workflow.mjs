import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createNotificationsClient } from "../src/clients/notifications.mjs";
import { createAssistanceClient } from "../src/clients/assistance.mjs";
import { createAssistanceFlow } from "../src/clients/flows/assistance.mjs";
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
import { applyAssistance,createAssistance } from '../src/domain/assistance.mjs';
import { digest } from '../src/shared/digest.mjs';

export async function verifyNotificationHistoryCompletion(db=null, options={}) {
  const scopes=['binding','consent','case-teaser','assistance','notifications'], now=Math.floor(Date.now()/1000);
  const f=await serviceFixture(scopes,db,{...options,now}),p=await serviceFixture(scopes,f.db,{...options,now}),other=await serviceFixture(scopes,f.db,{...options,now});
  const admin=options.adminDatabase??f.db, api=createApi(f),memories=[];
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.bindings.endpoint;let largestResponse=0;
  function host(who) {
    const sessions=createSessionMemory({now:()=>now,isCurrent:async()=>true});memories.push(sessions);
    sessions.adopt({endpoint,subjectId:who.actor.subjectId,bindingId:who.actor.bindingId,scopes,expiresAt:now+500,bindingExpiresAt:now+1000,takeCredential:()=>who.credential});
    const request=async(url,input,method)=>{
      const response=await fetch(origin+new URL(url).pathname,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},...(method==='POST'?{body:input.bodyJson}:{}),signal:input.signal});
      const text=await response.text();largestResponse=Math.max(largestResponse,Buffer.byteLength(text));
      assert.ok(Buffer.byteLength(text)<(input.maxBytes??1048576));const result=JSON.parse(text);
      if(response.status!==200)throw new Error(result.error);return result;
    };
    const send=(url,input)=>request(url,input,'POST'),read=(url,input)=>request(url,input,'GET');
    const assistanceClient=createAssistanceClient({endpoint,sessions,send,read}),notificationsClient=createNotificationsClient({endpoint,sessions,send});
    const assistanceFlow=createAssistanceFlow({endpoint,sessions,now:()=>now,signIntent:payload=>who.signForTest(payload,'galaxy-consent+jws'),consentSend:send,assistanceSend:send,assistanceRead:read});
    return createHostConnectionController({endpoint,sessions,assistanceClient,notificationsClient,assistanceFlow});
  }
  const requester=host(f),provider=host(p),outsider=host(other);
  try {
    const root={id:randomUUID(),kind:'case',localRef:randomUUID(),title:'History capacity',summary:'Request source',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};
    await f.cases.submit(f.actor,await f.authorize(root));
    const request={id:randomUUID(),caseId:root.id,title:'Public feedback and paged facts',problem:'界'.repeat(1200),attemptedApproaches:[],scope:'Inspect compiler',visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:now+1000};
    const rootGrant=await f.authorize(request,'assistance.publish',{visibility:'Public',purpose:'public-profile'});
    await f.assistance.create(f.actor,rootGrant);let version=1;
    const submit=async(who,kind,fields={},publicEvent=false)=>{
      const event={id:randomUUID(),expectedVersion:version,kind,...fields};
      const auth=await who.authorize({assistanceId:request.id,event},'assistance.publish',{objectId:event.id,
        ...(publicEvent?{visibility:'Public',purpose:'public-profile'}:{viewers:[who===f?p.actor.subjectId:f.actor.subjectId]})});
      version=(await f.assistance.submit(who.actor,request.id,auth)).version;return {event,auth};
    };
    const offer=await submit(p,'offer',{proposal:'Private offer',scope:'Inspect compiler'});
    const selected=await submit(f,'select',{offerId:offer.event.id});
    const confirmed=await submit(p,'confirm',{},true);
    for(let i=0;i<12;i++) {
      await submit(f,'change-scope',{scope:'Scope '+i,reason:'界'.repeat(1200)},i%2===0);
      await submit(p,'confirm-scope',{},i%2===0);
    }
    await submit(f,'cancel',{reason:'Requester closed work'},true);
    const preview=await provider.prepareCollaboration({assistanceId:request.id,event:{kind:'requester-feedback',descriptionClarity:'partly-clear',scopeMatched:false,note:'Provider account of a changing scope'},eventVisibility:'Public'});
    const intent=JSON.parse(preview.intentJson);assert.equal(intent.visibility,'Public');assert.equal(intent.purpose,'public-profile');assert.deepEqual(intent.viewers,[]);
    await provider.executeCollaboration(preview,preview.confirmation);version++;
    const feedback=JSON.parse(preview.payloadJson).event;
    await assert.rejects(submit(p,'requester-feedback',{descriptionClarity:'clear',scopeMatched:true,note:'Duplicate'},true),/transition_denied/);
    const history=await requester.queryRequesterHistory({subjectId:f.actor.subjectId,limit:20}),item=history.items[0];
    assert.equal(item.facts.length,8);assert.equal(item.visibleFactCount,28);assert.equal(history.counts.cancellations,1);
    assert.equal(item.counts.cancellations,1);assert.ok(item.facts.some(fact=>fact.summaryTruncated));assert.equal(item.responseSources.offerEventId,offer.event.id);
    assert.equal(item.responseSources.responseEventId,selected.event.id);
    let after,pages=0;const all=[];
    do {const page=await requester.queryRequesterHistoryFacts({assistanceId:request.id,limit:5,...(after?{after}:{})});
      all.push(...page.facts);after=page.nextAfter;pages++;assert.equal(page.counts.cancellations,1);assert.equal(page.visibleFactCount,28);
    } while(after);
    assert.equal(all.length,28);assert.equal(new Set(all.map(fact=>fact.eventId)).size,28);assert.equal(all.at(-1).eventId,feedback.id);
    assert.equal(all.find(fact=>fact.kind==='change-scope').summary.length,1200);
    const publicFacts=await outsider.queryRequesterHistoryFacts({assistanceId:request.id,limit:20});
    assert.equal(publicFacts.facts.length,15);assert.equal(publicFacts.responseSources,null);assert.equal(publicFacts.responseSeconds,null);
    assert.equal(publicFacts.facts.at(-1).authority,'provider-reported');assert.equal(publicFacts.independentQualityRating,false);
    assert.ok(!publicFacts.facts.some(fact=>fact.eventId===selected.event.id));
    assert.equal((await outsider.queryNotifications({})).items.length,0,'public readers are not broadcast recipients');
    const gather=async controller=>{let cursor;const items=[];do{const page=await controller.queryNotifications({limit:20,...(cursor?{after:cursor}:{})});items.push(...page.items);cursor=page.nextAfter;}while(cursor);return items;};
    const ownerInbox=await gather(requester),providerInbox=await gather(provider);
    assert.ok(ownerInbox.some(item=>item.id==='assistance:'+confirmed.event.id));assert.ok(ownerInbox.some(item=>item.id==='assistance:'+feedback.id));
    assert.equal(new Set(ownerInbox.map(item=>item.id)).size,ownerInbox.length);
    const readId='assistance:'+confirmed.event.id;await requester.markNotificationRead(readId);
    await provider.markNotificationRead(providerInbox[0].id);
    // Age only this fixture's source and marker; no sleeps or real user data.
    await admin.query('UPDATE assistance_events SET created_at=$2 WHERE id=$1',[confirmed.event.id,new Date((now-172800)*1000).toISOString()]);
    await admin.query('UPDATE notification_reads SET read_at=$2 WHERE subject_id=$1',[f.actor.subjectId,new Date((now-172800)*1000).toISOString()]);
    let prefs=await requester.notificationPreferences();const archive={expectedRevision:prefs.revision,before:now-86400};
    prefs=await requester.archiveNotifications(archive);assert.equal(prefs.removedReadMarkers,1);assert.equal(prefs.revision,1);
    assert.equal((await requester.archiveNotifications(archive)).removedReadMarkers,0);
    assert.equal(Number((await f.db.query('SELECT count(*) FROM notification_reads WHERE subject_id=$1',[p.actor.subjectId])).rows[0].count),1);
    assert.ok(!(await gather(requester)).some(item=>item.id===readId));assert.ok((await gather(requester)).some(item=>item.id==='assistance:'+feedback.id));
    await assert.rejects(requester.markNotificationRead(readId),/not_found/);
    await assert.rejects(requester.archiveNotifications({expectedRevision:1,before:now+1}),/invalid_notification_archive/);
    await assert.rejects(requester.archiveNotifications({expectedRevision:1,before:now-172800}),/cannot_rewind/);
    await assert.rejects(requester.saveNotificationPreferences({expectedRevision:0,settings:prefs.settings}),/preferences_conflict/);
    prefs=await requester.saveNotificationPreferences({expectedRevision:1,settings:{...prefs.settings,enabled:false}});
    prefs=await requester.saveNotificationPreferences({expectedRevision:prefs.revision,settings:{...prefs.settings,enabled:true}});
    assert.equal(prefs.archivedBefore,new Date(archive.before*1000).toISOString());assert.ok(!(await gather(requester)).some(item=>item.id===readId));
    assert.equal((await requester.queryRequesterHistoryFacts({assistanceId:request.id})).visibleFactCount,28,'archiving does not delete collaboration facts');
    const audit=(await f.db.query("SELECT * FROM audit_events WHERE actor=$1 AND action='notification.archive'",[f.actor.subjectId])).rows;
    assert.equal(audit.length,1);assert.equal(audit[0].scope,'notifications');assert.equal(audit[0].consent_id,null);assert.ok(audit[0].http_request_id);
    await f.consents.revoke(f.actor,rootGrant.consentId);
    assert.equal((await outsider.queryRequesterHistory({subjectId:f.actor.subjectId})).items.length,0);
    await assert.rejects(outsider.queryRequesterHistoryFacts({assistanceId:request.id}),/consent_required/);
    assert.equal((await requester.queryNotifications({})).items.length,0);
    // Signed synthetic capacity fixtures: use the real domain and Consent service,
    // bulk-insert event facts to avoid timing 205 unrelated write workflows.
    const capacity={...request,id:randomUUID(),title:'Sparse notification pages'};
    await f.assistance.create(f.actor,await f.authorize(capacity,'assistance.publish',{visibility:'Public',purpose:'public-profile'}));
    let state=createAssistance(f.actor.subjectId,capacity,now);const seeded=[];
    for(let i=0;i<205;i++){
      const event={id:`00000000-1212-4121-8121-${String(i+1).padStart(12,'0')}`,expectedVersion:state.version,kind:'shortlist',offerIds:[]};
      const auth=await f.authorize({assistanceId:capacity.id,event},'assistance.publish',{objectId:event.id,viewers:[p.actor.subjectId]});
      state=applyAssistance(state,f.actor.subjectId,event,now);
      seeded.push({id:event.id,assistance_id:capacity.id,subject_id:f.actor.subjectId,version:state.version,consent_id:auth.consentId,payload_text:auth.payloadJson,payload_hash:digest(auth.payloadJson)});
    }
    await admin.query(`INSERT INTO assistance_events(id,assistance_id,subject_id,version,consent_id,payload_text,payload_hash)
      SELECT id,assistance_id,subject_id,version,consent_id,payload_text,payload_hash FROM jsonb_to_recordset($1::jsonb)
      AS x(id uuid,assistance_id uuid,subject_id text,version integer,consent_id uuid,payload_text text,payload_hash text)`,[JSON.stringify(seeded)]);
    await admin.query('UPDATE assistance_requests SET version=$2,snapshot=$3 WHERE id=$1',[capacity.id,state.version,JSON.stringify(state)]);
    const invitation={id:'ffffffff-1212-4121-8121-000000000001',expectedVersion:state.version,kind:'invite',participantId:p.actor.subjectId,note:'Visible invitation after 205 hidden candidates'};
    await f.assistance.submit(f.actor,capacity.id,await f.authorize({assistanceId:capacity.id,event:invitation},'assistance.publish',{objectId:invitation.id,viewers:[p.actor.subjectId]}));
    const started=performance.now(),firstSparse=await provider.queryNotifications({limit:20});assert.deepEqual(firstSparse.items,[]);assert.ok(firstSparse.nextAfter);
    const secondSparse=await provider.queryNotifications({limit:20,after:firstSparse.nextAfter});
    assert.equal(secondSparse.items.length,1);assert.equal(secondSparse.items[0].id,'assistance:'+invitation.id);assert.equal(secondSparse.nextAfter,null);
    const sparseReadMs=Math.ceil(performance.now()-started);
    return {facts:28,historyPages:pages,publicFacts:15,largestResponseBytes:largestResponse,sparseCandidates:206,sparseReadMs,publicFeedbackExplicit:true,participantOnlyNotifications:true,archiveReplay:true,sourceEventsPreserved:true,withdrawalApplied:true};
  } finally {memories.forEach(memory=>memory.close());api.closeAllConnections();await new Promise(resolve=>api.close(resolve));if(!db)await f.db.close();}
}
