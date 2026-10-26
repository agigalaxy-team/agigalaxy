import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeGalaxyIntegration } from '../../galaxy-core/src/local-store.mjs';
import { createHostConnectionController } from "../src/clients/flows/host-connection-controller.mjs";
import { readLocalSearchFeedback,saveLocalSearchFeedback,editLocalSearchFeedback } from "../src/clients/local/search-feedback.mjs";
import { createConfiguredRuntime } from '../../../integrations/host-adapters/opencode-stable/configured-runtime.mjs';

const endpoint='https://official.example.org',yes={relevance:'relevant',helpedSelection:true};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'galaxy-feedback-summary-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await initializeGalaxyIntegration(directory,{profile:'coding-case',source:'test'});
  const subjectId=JSON.parse(await readFile(join(directory,'galaxy-id.json'),'utf8')).id;
  const statePath=join(directory,'galaxy-local-state.json');
  return {directory,subjectId,statePath,read:async()=>JSON.parse(await readFile(statePath,'utf8'))};
}
function item(type,id=randomUUID()){
  return {type,id,title:'Compiler',source:{kind:type,id,...(['case','history'].includes(type)?{sourceVersion:3}:{observationId:randomUUID(),versionId:randomUUID()})},
    record:{projectionHash:'b'.repeat(64),body:'REMOTE_BODY_NOT_RETAINED'},matchReasons:['compiler']};
}
test('Worker and Hub feedback use current declaration IDs and the builders scope',async t=>{
  const f=await fixture(t);let source;
  const controller=createHostConnectionController({endpoint,client:{},sessions:{status:async()=>({state:'session-local',subjectId:f.subjectId,scopes:['builders']})},
    searchClient:{query:async()=>({items:[source]})},saveSearchFeedback:input=>saveLocalSearchFeedback(f.directory,input)});
  for(const type of ['worker','hub']){
    source=item(type);source.source.declarationId=randomUUID();
    await controller.querySearch({type,query:{ownerId:f.subjectId,query:'compiler'}});await controller.recordSearchFeedback(source.id,yes);
    const page=await readLocalSearchFeedback(f.directory,{endpoint,sourceType:type});
    assert.equal(page.items[0].sourceVersion,source.source.declarationId);assert.equal(page.summary.bySource[type].responses,1);
  }
  assert.equal((await readLocalSearchFeedback(f.directory,{endpoint})).summary.responses,2);
});
test('four source types retain explicit opinions, independent criteria and minimal snapshots with local summaries',async t=>{
  const f=await fixture(t);let source,writes=0;
  const controller=createHostConnectionController({endpoint,client:{},sessions:{status:async()=>({state:'session-local',subjectId:f.subjectId,scopes:['history','proof','capsules']})},
    searchClient:{query:async()=>({items:[source]})},saveSearchFeedback:input=>{writes++;return saveLocalSearchFeedback(f.directory,input);}});
  const sameId=randomUUID();
  for(const type of ['case','history','proof','capsule']){
    source=item(type,sameId);await controller.querySearch({type,query:{query:'compiler'}});
    assert.equal(writes,['case','history','proof','capsule'].indexOf(type));
    await controller.recordSearchFeedback(source.id,yes);
  }
  await controller.querySearch({type:'capsule',query:{query:'compiler',limit:20,after:randomUUID()}});
  await controller.recordSearchFeedback(source.id,{relevance:'not-relevant',helpedSelection:false});
  let page=await readLocalSearchFeedback(f.directory,{endpoint,limit:2});
  assert.equal(page.summary.responses,4);assert.equal(page.summary.sources,4);assert.equal(page.summary.queries,4);
  assert.deepEqual(page.summary.relevance,{relevant:3,notRelevant:1,unsure:0});
  assert.deepEqual(page.summary.helpedSelection,{yes:3,no:1,unanswered:0});
  assert.equal(page.items.length,2);assert.ok(page.nextCursor);
  const second=await readLocalSearchFeedback(f.directory,{endpoint,limit:2,after:page.nextCursor});
  assert.equal(second.items.length,2);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...page.items,...second.items].map(row=>row.id)).size,4);
  const stored=await f.read();assert.equal(JSON.stringify(stored.searchFeedback).includes('REMOTE_BODY_NOT_RETAINED'),false);
  assert.ok(Object.values(stored.searchFeedback).every(row=>row.sourceVersion&&/^[a-f0-9]{64}$/.test(row.snapshotHash)&&row.verificationEffect==='none'));
  assert.deepEqual(stored.cases,[]);assert.equal(page.sourceValidity,'not-rechecked');assert.equal('successRate' in page.summary,false);
  await controller.querySearch({type:'capsule',query:{query:'other'}});await controller.recordSearchFeedback(source.id,{relevance:'unsure',helpedSelection:null});
  page=await readLocalSearchFeedback(f.directory,{endpoint,sourceType:'capsule'});
  assert.equal(page.summary.responses,2);assert.equal(page.summary.sources,1);assert.equal(page.summary.queries,2);
  assert.deepEqual(page.summary.helpedSelection,{yes:0,no:1,unanswered:1});
  assert.equal((await readLocalSearchFeedback(f.directory,{endpoint:'https://other.example.org'})).summary.responses,0);
});

test('legacy opinions remain readable, edits use exact revisions and unrelated owners are excluded',async t=>{
  const f=await fixture(t),source={caseId:randomUUID(),projectionHash:'a'.repeat(64),sourceVersion:2};
  const saved=await saveLocalSearchFeedback(f.directory,{endpoint,subjectId:f.subjectId,query:{query:'compiler'},item:source,verdict:yes});
  const state=await f.read(),row=state.searchFeedback[saved.id];
  row.version=1;for(const key of ['revision','sourceType','sourceId','snapshotHash'])delete row[key];
  state.searchFeedback['c'.repeat(64)]={endpoint,subjectId:'GUID'+'A'.repeat(28),invalid:'other owner'};
  state.searchFeedback['d'.repeat(64)]={endpoint,subjectId:f.subjectId,version:2};
  await writeFile(f.statePath,JSON.stringify(state));const before=await readFile(f.statePath,'utf8');
  let page=await readLocalSearchFeedback(f.directory,{endpoint});
  assert.equal(await readFile(f.statePath,'utf8'),before);assert.equal(page.summary.responses,1);assert.equal(page.summary.unreadableEntries,1);
  assert.equal(page.items[0].sourceType,'history');assert.equal(page.items[0].revision,1);
  await editLocalSearchFeedback(f.directory,{endpoint,id:saved.id,revision:1,verdict:{relevance:'unsure',helpedSelection:null}});
  await assert.rejects(editLocalSearchFeedback(f.directory,{endpoint,id:saved.id,revision:1,verdict:null}),/changed/);
  await assert.rejects(editLocalSearchFeedback(f.directory,{endpoint:'https://other.example.org',id:saved.id,revision:2,verdict:null}),/unavailable/);
  page=await readLocalSearchFeedback(f.directory,{endpoint});assert.equal(page.items[0].revision,2);
  assert.equal((await f.read()).searchFeedback[saved.id].version,2);
  await editLocalSearchFeedback(f.directory,{endpoint,id:saved.id,revision:2,verdict:null});
  assert.equal((await readLocalSearchFeedback(f.directory,{endpoint})).summary.responses,0);
});

test('superseded pages and changed sessions cannot save a pending response',async t=>{
  const f=await fixture(t),source=item('proof');let release,entered,session={state:'session-local',subjectId:f.subjectId,bindingId:randomUUID(),scopes:['proof']};
  const pending=()=>new Promise(resolve=>{entered=resolve;});let waiting=pending();
  const controller=createHostConnectionController({endpoint,client:{},sessions:{status:async()=>session},searchClient:{query:async()=>({items:[source]})},
    saveSearchFeedback:async input=>{entered();await new Promise(resolve=>{release=resolve;});return saveLocalSearchFeedback(f.directory,input);}});
  await controller.querySearch({type:'proof',query:{}});
  const write=controller.recordSearchFeedback(source.id,yes);await waiting;controller.cancel();release();await assert.rejects(write,/changed/);
  assert.equal((await f.read()).searchFeedback,undefined);
  await controller.querySearch({type:'proof',query:{}});session={...session,bindingId:randomUUID()};
  await assert.rejects(controller.recordSearchFeedback(source.id,yes),/session required/);
  await controller.querySearch({type:'proof',query:{}});waiting=pending();
  const old=controller.recordSearchFeedback(source.id,yes);await waiting;
  await controller.querySearch({type:'proof',query:{query:'new criteria'}});release();await assert.rejects(old,/changed/);
  assert.equal((await f.read()).searchFeedback,undefined);
});

test('configured offline feedback works without a Manifest, binding or transport',async t=>{
  const f=await fixture(t);await saveLocalSearchFeedback(f.directory,{endpoint,subjectId:f.subjectId,query:{},item:{caseId:randomUUID(),projectionHash:'a'.repeat(64),sourceVersion:1},verdict:yes});
  let remoteCalls=0;
  const source=createConfiguredRuntime({endpoint,dataDirectory:f.directory,scopes:['history'],installationId:randomUUID(),bindingScopeId:'unused',trustedKeys:new Map()},
    {readManifest:async()=>{remoteCalls++;throw new Error('offline');}});
  const page=await source.querySearchFeedback();assert.equal(page.summary.responses,1);
  await source.editSearchFeedback({id:page.items[0].id,revision:1,verdict:null});
  assert.equal((await source.querySearchFeedback()).summary.responses,0);assert.equal(remoteCalls,0);assert.equal(source.status().state,'not-read');
  source.close();await assert.rejects(source.querySearchFeedback(),/closed/);
});
