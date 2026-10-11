import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createHelpSearchClient} from '../../galaxy-web/src/help-search-client.mjs';
import {createChoiceSyncClient} from '../../galaxy-web/src/choice-sync-client.mjs';

// Actual HTTP, PGlite and browser runtime/signatures. The local store and its
// completion barrier are explicit doubles, not physical browser/device QA.
async function fixture() {
  const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000});
  let runtime;const data=new Map(),writes=[];let onGet=null,onPut=null,dropAfterPut=false;
  try {
    const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,
      localRef:randomUUID(),title:'Choice continuity',summary:'Synthetic public source',synthetic:true,source:{kind:'local',reference:randomUUID()}};
    const grant=await f.authorize(root,'case.teaser.publish',{objectId:id,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,grant);
    await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
    runtime=await createWebRuntime({endpoint:f.access.endpoint,trustedKeys:f.bindings.trustedKeys},{now:()=>f.now,
      store:{get:async key=>{const value=structuredClone(data.get(key));if(onGet)await onGet(key,value);return value;},
        put:async(key,value)=>{data.set(key,structuredClone(value));if(onPut)await onPut(key,value);}},
      fetch:async(url,options)=>{const path=new URL(url).pathname;if(path==='/v2/choice-snapshots/put')writes.push(JSON.parse(options.body));const response=await fetch(origin+path,options);
        if(path==='/v2/choice-snapshots/put'&&dropAfterPut){dropAfterPut=false;throw new Error('synthetic lost ACK after actual put');}return response;}});
    await runtime.createIdentity({confirmed:true});await runtime.connect({confirmed:true});
    const subjectId=(await runtime.status()).identity.subjectId,search=createHelpSearchClient(runtime,{authenticated:true,subjectId});
    const page=await search.query({type:'history',query:{query:'Choice continuity'}}),candidate=search.candidateKey(page.items[0]);
    const choice={id:randomUUID(),expectedVersion:0,localTaskRef:'Local current work',visibleRationale:'Private reasoning visible only to this user',
      rationaleAuthor:'user',candidateKeys:[candidate],selectedKeys:[candidate],resultRefs:[]};
    return {f,runtime,search,choice,writes,subjectId,data,
      onGet(fn){onGet=fn;},onPut(fn){onPut=fn;},
      loseNextPut(){dropAfterPut=true;},
      async close(){search.close();runtime.close();await new Promise(resolve=>api.close(resolve));await f.db.close();}};
  } catch(error){runtime?.close();await new Promise(resolve=>api.close(resolve));await f.db.close();throw error;}
}

test('Choice pending journal completion cannot dispatch an old intent through a replacement connection',async()=>{
  const t=await fixture();let cloud;
  try {
    await t.search.saveChoice(t.choice);cloud=createChoiceSyncClient(t.runtime,{subjectId:t.subjectId});
    await cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[t.choice.id]});
    const before=(await t.runtime.status()).connection;
    t.onPut(async(key,value)=>{if(key.endsWith(':choice-cloud-v2')&&value?.pending?.[t.choice.id]){
      t.onPut(null);await t.runtime.connect({confirmed:true});}});
    await assert.rejects(cloud.sync(t.choice.id),/connection_changed/);
    const after=(await t.runtime.status()).connection;assert.equal(after.subjectId,before.subjectId);assert.notEqual(after.generation,before.generation);
    assert.equal(t.writes.length,0,'a completed local write is not fresh permission to send through a different lease');
    const retained=await t.runtime.getLocal('choice-cloud-v2');assert.ok(retained.pending[t.choice.id]?.versionId,'retain the original intent on guard failure');
  } finally{cloud?.close();await t.close();}
});

test('Choice get withholds a current private response if reconnection occurs during its final local write',async()=>{
  const t=await fixture();let cloud;
  try {
    await t.search.saveChoice(t.choice);cloud=createChoiceSyncClient(t.runtime,{subjectId:t.subjectId});
    await cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[t.choice.id]});await cloud.sync(t.choice.id);
    t.onPut(async key=>{if(key.endsWith(':choice-cloud-v2')){t.onPut(null);await t.runtime.connect({confirmed:true});}});
    await assert.rejects(cloud.get(t.choice.id),/connection_changed/);
    assert.equal(t.writes.length,1,'return guard must not create a retry or undo an accepted original operation');
  }finally{cloud?.close();await t.close();}
});

test('Opting out prevents a new put for an unknown original version while owner get remains a read and retains the journal',async()=>{
  const t=await fixture();let cloud;
  try {
    await t.search.saveChoice(t.choice);cloud=createChoiceSyncClient(t.runtime,{subjectId:t.subjectId});
    await cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[t.choice.id]});
    t.loseNextPut();await assert.rejects(cloud.sync(t.choice.id),/lost ACK/);const pending=(await cloud.localState()).pending[t.choice.id];
    await cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:1,enabled:false,snapshotIds:[]});
    await assert.rejects(cloud.sync(t.choice.id),/choice_sync_not_selected/);assert.equal(t.writes.length,1);
    const original=await cloud.get(t.choice.id);assert.equal(original.current.versionId,pending.versionId);
    const retained=(await cloud.localState()).pending[t.choice.id];assert.deepEqual(retained,pending);
    assert.equal(original.current.content.visibleRationale,t.choice.visibleRationale,'owner read is independent of enabling new cloud writes');
    await cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:2,enabled:true,snapshotIds:[t.choice.id]});
    const replay=await cloud.sync(t.choice.id);assert.equal(replay.replayed,true);assert.equal(t.writes.length,1,'accepted original is reconciled without a second PUT');
    assert.equal(replay.operationReceipt.state,'acknowledged');assert.equal(replay.operationReceipt.versionId,pending.versionId);
    assert.deepEqual(t.writes[0].content,pending.content);assert.deepEqual(t.writes[0].witnesses,pending.witnesses);
    const stored=(await t.f.db.query('SELECT request_hash,content,expires_at FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2',[t.subjectId,pending.versionId])).rows[0];
    assert.equal(stored.request_hash,replay.operationReceipt.requestHash);assert.deepEqual(stored.content,pending.content);
    assert.equal(new Date(stored.expires_at).toISOString(),original.current.expiresAt);
    assert.equal(replay.current.expiresAt,original.current.expiresAt,'renewed category selection does not renew accepted content TTL');
  }finally{cloud?.close();await t.close();}
});

test('Choice local preview withholds private content when a real runtime reconnects during store completion',async()=>{
  const t=await fixture();let cloud;
  try {
    await t.search.saveChoice(t.choice);cloud=createChoiceSyncClient(t.runtime,{subjectId:t.subjectId});
    t.onGet(async key=>{if(key.endsWith(':help-choices-v2')){t.onGet(null);await t.runtime.connect({confirmed:true});}});
    await assert.rejects(cloud.localPreview(t.choice.id),/connection_changed/);
  } finally{cloud?.close();await t.close();}
});

test('Help choice preparation stops before later local writes after same-owner reconnection',async()=>{
  const t=await fixture();let writesAfterReplacement=0,replaced=false;
  try {
    t.onGet(async key=>{if(key.endsWith(':help-choices-v2')){t.onGet(null);await t.runtime.connect({confirmed:true});replaced=true;}});
    t.onPut(async key=>{if(replaced&&/:(help-choices-v2|help-choice-lookups-v2|choice-cloud-bases-v2)$/.test(key))writesAfterReplacement++;});
    await assert.rejects(t.search.saveChoice(t.choice),/connection_changed/);
    assert.equal(writesAfterReplacement,0,'an earlier page read cannot silently prepare in the new connection');
  } finally{await t.close();}
});

test('Stopping an unknown superseded Choice or deleting its cloud head retains the exact body-free original locator',async()=>{
  const t=await fixture();let cloud;
  try {
    await t.search.saveChoice(t.choice);cloud=createChoiceSyncClient(t.runtime,{subjectId:t.subjectId});
    await cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[t.choice.id]});
    t.loseNextPut();await assert.rejects(cloud.sync(t.choice.id),/lost ACK/);const original=(await cloud.localState()).pending[t.choice.id];
    const next={...original,versionId:randomUUID(),baseRevision:1,content:{...original.content,localVersion:2,visibleRationale:'Later explicitly selected alternative'}};
    await t.runtime.api.call('/v2/choice-snapshots/put',next);
    const current=await cloud.get(t.choice.id);assert.equal(current.current.versionId,next.versionId);assert.deepEqual(current.conflicts,[]);
    const stop=await cloud.discardPending(t.choice.id),stopped=(await cloud.localState()).stoppedVersions?.[original.versionId];
    assert.ok(stopped,'a later head is not evidence for the original unknown version');
    const expected=(await t.f.db.query('SELECT request_hash FROM choice_snapshot_versions WHERE version_id=$1',[original.versionId])).rows[0].request_hash;
    assert.equal(stopped.requestHash,expected);assert.equal(stopped.snapshotId,t.choice.id);assert.equal(stopped.state,'unknown');assert.equal(stopped.localRetryStopped,true);
    assert.equal(JSON.stringify(stopped).includes(original.content.visibleRationale),false);assert.equal('content' in stopped,false);assert.equal('witnesses' in stopped,false);
    assert.equal(stop.serverCancellationConfirmed,false);assert.equal(t.writes.length,2);
    assert.equal((await cloud.localState()).pending[t.choice.id],undefined);
    await cloud.delete(t.choice.id);assert.deepEqual((await cloud.localState()).stoppedVersions[original.versionId],stopped);
    assert.equal((await t.search.local()).choices[0].versions[0].visibleRationale,t.choice.visibleRationale,'stopping cloud retry does not erase the private local choice');
  }finally{cloud?.close();await t.close();}
});

test('A confirmed cloud deletion does not turn an unknown earlier version into a cancelled business operation',async()=>{
  const t=await fixture();let cloud;
  try{
    await t.search.saveChoice(t.choice);cloud=createChoiceSyncClient(t.runtime,{subjectId:t.subjectId});
    await cloud.savePreference({endpoint:t.f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[t.choice.id]});
    t.loseNextPut();await assert.rejects(cloud.sync(t.choice.id),/lost ACK/);const original=(await cloud.localState()).pending[t.choice.id];
    await cloud.get(t.choice.id);await cloud.delete(t.choice.id);
    const state=await cloud.localState(),locator=state.stoppedVersions[original.versionId];
    assert.equal(state.pending[t.choice.id],undefined);assert.equal(locator.state,'unknown');assert.equal(locator.serverCancellationConfirmed,false);
    assert.equal(locator.requestHash,(await t.f.db.query('SELECT request_hash FROM choice_snapshot_versions WHERE version_id=$1',[original.versionId])).rows[0].request_hash);
    assert.equal((await cloud.get(t.choice.id)).deleted,true);assert.equal(t.writes.length,1);assert.equal('content' in locator,false);
  }finally{cloud?.close();await t.close();}
});
