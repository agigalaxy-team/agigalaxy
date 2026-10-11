import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';

async function fixture(){
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000)}),api=createApi({...f,rateLimit:1000});
 try{
  const id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,actorId:f.actor.subjectId,
   localRef:randomUUID(),title:'Lifecycle candidate',summary:'Synthetic actual source',synthetic:true,source:{kind:'local',reference:randomUUID()}};
  const grant=await f.authorize(root,'case.teaser.publish',{objectId:id,visibility:'Public',purpose:'public-profile'});await f.cases.submitV2(f.actor,grant);
  const search={type:'history',query:{query:'Lifecycle candidate'}},item=(await f.search.v2.query(f.actor,search)).items[0],snapshotId=randomUUID();
  const input={snapshotId,versionId:randomUUID(),baseRevision:0,preferenceRevision:1,content:{localVersion:1,localTaskRef:'local-work',
   visibleRationale:'Private summary based on selected source',rationaleAuthor:'user',candidateRefs:[{type:item.type,...item.ref}],selectedRefs:[],resultRefs:[]},witnesses:[{search,ref:item.ref}]};
  await f.choices.savePreference(f.actor,{endpoint:f.access.endpoint,expectedRevision:0,enabled:true,snapshotIds:[snapshotId]});
  const original=await f.choices.put(f.actor,input);
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${api.address().port}`;
  const call=async(path,value)=>{const response=await fetch(origin+'/v2/choice-snapshots/'+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${f.credential}`},body:JSON.stringify(value)});
   const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  return {f,grant,input,original,call,async close(){await new Promise(resolve=>api.close(resolve));await f.db.close();}};
 }catch(error){await new Promise(resolve=>api.close(resolve));await f.db.close();throw error;}
}

test('Choice expiry is projected before any source read; original retry, list, export and cleanup do not renew its TTL',async()=>{
 const t=await fixture();let reads=0;
 try{
  const expiredAt=new Date((t.f.now-1)*1000).toISOString();
  // Stored expiry is a clock boundary fixture; request bytes, IDs and hashes
  // are not forged or replaced. Public HTTP and canonical services stay real.
  await t.f.db.query('UPDATE choice_snapshot_versions SET expires_at=$2 WHERE version_id=$1',[t.input.versionId,expiredAt]);
  const read=t.f.choices.sourceReader.statusWithin.bind(t.f.choices.sourceReader);
  t.f.choices.sourceReader.statusWithin=async(...args)=>{reads++;return read(...args);};
  const get=await t.call('get',{snapshotId:t.input.snapshotId});assert.equal(get.current.state,'expired');assert.deepEqual(get.current.content,{});
  const replay=await t.call('put',t.input);assert.equal(replay.replayed,true);assert.equal(replay.current.versionId,t.input.versionId);assert.equal(replay.current.expiresAt,expiredAt);
  assert.equal((await t.call('list',{})).items[0].current.state,'expired');
  const exported=await t.f.access.runAuthorized(t.f.actor,'data-export',db=>t.f.choices.exportOwnedWithin(db,t.f.actor,{limit:8}));
  assert.equal(exported.items[0].current.state,'expired');assert.deepEqual(exported.items[0].current.content,{});
  await t.f.choices.purgeExpired();await t.f.choices.purgeInvalidSources();assert.equal(reads,0);
  const row=(await t.f.db.query('SELECT content,dependencies,expires_at FROM choice_snapshot_versions WHERE version_id=$1',[t.input.versionId])).rows[0];
  assert.deepEqual(row.content,{});assert.deepEqual(row.dependencies,[]);assert.equal(new Date(row.expires_at).toISOString(),expiredAt);
 }finally{await t.close();}
});

test('A revoked actual source hides rationale across get, list, export and cleanup while preserving original version/hash/expiry',async()=>{
 const t=await fixture();
 try{
  const before=(await t.f.db.query('SELECT request_hash,expires_at FROM choice_snapshot_versions WHERE version_id=$1',[t.input.versionId])).rows[0];
  await t.f.consents.revoke(t.f.actor,t.grant.consentId);
  const get=await t.call('get',{snapshotId:t.input.snapshotId});assert.equal(get.current.content.visibleRationale,null);assert.equal(get.current.priorRationaleCurrent,false);
  assert.equal((await t.call('list',{})).items[0].current.content.visibleRationale,null);
  const exported=await t.f.access.runAuthorized(t.f.actor,'data-export',db=>t.f.choices.exportOwnedWithin(db,t.f.actor,{limit:8}));assert.equal(exported.items[0].current.content.visibleRationale,null);
  const cleanup=await t.f.choices.purgeInvalidSources();assert.equal(cleanup.redacted,1);
  const after=(await t.f.db.query('SELECT request_hash,expires_at,content FROM choice_snapshot_versions WHERE version_id=$1',[t.input.versionId])).rows[0];
  assert.equal(after.request_hash,before.request_hash);assert.equal(new Date(after.expires_at).toISOString(),new Date(before.expires_at).toISOString());assert.equal(after.content.visibleRationale,null);
  const replay=await t.call('put',t.input);assert.equal(replay.replayed,true);assert.equal(replay.operationVersionId,t.input.versionId);assert.equal(replay.current.content.visibleRationale,null);
 }finally{await t.close();}
});
