import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import {getContributionClient} from "../../galaxy-web/src/features/work-records/contribution-client.mjs";

test('actual browser identity and signed contribution operations recover lost Consent, publication and revoke replies without changing selected fields',async()=>{
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000}),data=new Map();
  const store={get:async key=>structuredClone(data.get(key)),put:async(key,value)=>{data.set(key,structuredClone(value));},update:memoryAtomicUpdate(data)};
  let runtime,loseConsent=false,loseWrite=false;
  try{
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    const config={endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys};
    const fetcher=async(url,options)=>{const path=new URL(url).pathname,response=await fetch(origin+path,options);
      if(loseConsent&&path==='/v1/consents'){loseConsent=false;assert.equal(response.status,200);throw new Error('synthetic lost Consent reply');}
      if(loseWrite&&path==='/v2/contributions/publish'){loseWrite=false;assert.equal(response.status,200);throw new Error('synthetic lost contribution reply');}return response;};
    runtime=await createExistingWebRuntime(config,{store,fetch:fetcher,now:()=>f.now});await runtime.connect({confirmed:true});
    const subjectId=(await runtime.status()).identity.subjectId,id=randomUUID(),root={kind:'case-created',schemaVersion:2,eventId:id,caseId:id,expectedVersion:0,
      actorId:subjectId,localRef:randomUUID(),title:'PRIVATE CASE TITLE',summary:'PRIVATE CASE BACKGROUND',source:{kind:'local',reference:randomUUID()},synthetic:true};
    await runtime.api.call('/v2/cases/events',await runtime.api.authorizePayload(root,{action:'case.teaser.publish',objectId:id,confirmed:true}));
    const owned=await runtime.api.call('/v2/contributions/sources',{kind:'case-event',parentId:id}),source={...owned.items[0].source,fields:['eventType','actorId']};
    const preview=await runtime.api.call('/v2/contributions/preview',{sourceRefs:[source],purposes:['honor']});
    assert.deepEqual(Object.keys(preview.items[0].projection).sort(),['actorId','eventType']);
    const payload={kind:'publish',sourceRefs:[source],purposes:['honor'],purpose:'public-contribution-projections-only',expiresAt:new Date((f.now+86400)*1000).toISOString(),
      redactionConfirmed:true,publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
    let client=getContributionClient(runtime,subjectId);loseConsent=true;await assert.rejects(client.submit(payload,{confirmed:true}),/lost Consent/);
    const pending=(await client.local()).pending;assert.ok(pending.prepared?.signedIntent);assert.equal(pending.submission,null);
    runtime.close();runtime=await createExistingWebRuntime(config,{store,fetch:fetcher,now:()=>f.now});await runtime.connect({confirmed:true});client=getContributionClient(runtime,subjectId);
    loseWrite=true;await assert.rejects(client.reconcile({retry:true,confirmed:true}),/lost contribution/);
    assert.equal((await client.local()).pending.prepared.signedIntent,pending.prepared.signedIntent);
    assert.equal((await client.reconcile()).state,'published');assert.equal((await client.local()).pending,null);
    const publicationId=pending.payload.id;assert.equal(Number((await f.db.query('SELECT count(*) FROM contribution_publications WHERE subject_id=$1',[subjectId])).rows[0].count),1);
    assert.equal((await client.refresh())[0].state,'published');
    const published=await runtime.api.call('/v2/contributions/read',{source:owned.items[0].source,purpose:'honor'},{authenticated:false});
    assert.equal(JSON.stringify(published).includes(id),false);assert.equal(JSON.stringify(published).includes(root.summary),false);
    await assert.rejects(runtime.api.call('/v2/contributions/read',{...published.ref,purpose:'requester-history'},{authenticated:false}),/contribution_source_unavailable/);
    loseWrite=true;await assert.rejects(client.submit({kind:'revoke',publicationId,reason:'只撤销本次许可'},{confirmed:true}),/lost contribution/);
    assert.equal((await client.reconcile()).state,'revoked');assert.equal((await client.refresh())[0].state,'revoked');
    await assert.rejects(runtime.api.call('/v2/contributions/read',{...published.ref,purpose:'honor'},{authenticated:false}),/contribution_source_unavailable/);
    runtime.api.disconnect();await assert.rejects(client.local(),/身份或连接已变化/);
  }finally{runtime?.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();}
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
