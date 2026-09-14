import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceFixture } from './service-fixture.mjs';
import { createApi } from '../src/http.mjs';
import { createSessionMemory } from '../src/session-memory.mjs';
import { createProfileFlow } from '../src/profile-flow.mjs';
import { createHostConnectionController } from '../src/host-connection-controller.mjs';

test('Profile signed host flow does not overwrite intervening edits or publish after cancellation during authorization',async()=>{
  const scopes=['binding','history','consent'],f=await serviceFixture(scopes),endpoint=f.access.endpoint;
  const api=createApi(f);await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+500,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  let afterConsent=()=>{},signed=0;
  const send=async(url,input)=>{
    const response=await fetch(origin+new URL(url).pathname,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${input.credential}`},body:input.bodyJson,signal:input.signal});
    const data=await response.json();if(response.status!==200)throw new Error(data.error);
    if(url.endsWith('/consents'))afterConsent();return data;
  };
  const flow=createProfileFlow({endpoint,sessions,consentSend:send,historySend:send,now:()=>f.now,signIntent:(payload,typ)=>{
    assert.equal(flow.isSigningIntent(payload),true);signed++;return f.signForTest(payload,typ);
  }});
  const host=createHostConnectionController({endpoint,sessions,profileFlow:flow});
  try{
    const preview=await host.prepareProfile({expectedRevision:0,selfDeclared:{about:'Pending text'}});
    assert.equal(signed,0);
    await assert.rejects(flow.execute(preview,'wrong'),/Exact Profile/);assert.equal(signed,0);
    const intervening={id:randomUUID(),expectedRevision:0,selfDeclared:{about:'Newer text'}};
    await f.profiles.publish(f.actor,await f.authorize(intervening,'profile.publish'));
    await assert.rejects(host.executeProfile(preview,preview.confirmation),/profile_revision_conflict/);
    assert.equal((await f.history.query(f.actor,{subjectId:f.actor.subjectId})).selfDeclared.about,'Newer text');
    const canceled=await host.prepareProfile({expectedRevision:1,selfDeclared:{about:'Canceled text'}});
    afterConsent=()=>host.cancel();
    await assert.rejects(host.executeProfile(canceled,canceled.confirmation));
    assert.equal((await f.db.query('SELECT id FROM profile_statements')).rows.length,1);
    assert.equal(flow.isSigningIntent(canceled.intentJson),false);
  }finally{host.cancel();sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
