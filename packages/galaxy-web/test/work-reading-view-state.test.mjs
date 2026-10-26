import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaterialDeadline} from "../src/features/outcome-materials/outcome-material-deadline.ts";
import {checkedOutcomeDraft,hasMaterialAttempt} from "../src/features/outcome-materials/outcome-material-view-types.ts";
import {ownerRecordBody} from "../src/features/tasks/owner/task-owner-read-view-types.ts";

function clock(start=1000){
 let now=start,id=0;const pending=new Map();
 return{pending,advance:value=>{now=value;},run:()=>{const [key,job]=pending.entries().next().value;pending.delete(key);job.fn();},
  source:{now:()=>now,later:(fn,milliseconds)=>{pending.set(++id,{fn,milliseconds});return id;},cancel:timer=>pending.delete(timer)}};
}
test('a source body expires at its own exact deadline and unsubscribed clocks cannot revive an old view',()=>{
 const time=clock(),state=createMaterialDeadline(2,time.source);let changes=0;
 assert.equal(state.read(),true);const close=state.subscribe(()=>changes++);
 assert.equal([...time.pending.values()][0].milliseconds,1000);
 time.advance(2000);time.run();assert.equal(state.read(),false);assert.equal(changes,1);assert.equal(time.pending.size,0);close();
 const renewed=createMaterialDeadline(3,time.source),end=renewed.subscribe(()=>changes++);
 assert.equal(renewed.read(),true);const late=[...time.pending.values()][0].fn;end();time.advance(4000);late();assert.equal(changes,1);assert.equal(time.pending.size,0);
});
test('expired and invalid source deadlines stay unavailable; unlimited and long deadlines have no early expiry',()=>{
 const time=clock();for(const deadline of [1,'invalid']){const state=createMaterialDeadline(deadline,time.source);assert.equal(state.read(),false);state.subscribe(()=>assert.fail('no transition for an already expired source'))();}
 const unlimited=createMaterialDeadline(null,time.source);assert.equal(unlimited.read(),true);unlimited.subscribe(()=>assert.fail('no deadline'))();assert.equal(time.pending.size,0);
 const at=2147483647+5000,state=createMaterialDeadline(at/1000,time.source);let changes=0;const close=state.subscribe(()=>changes++);
 assert.equal([...time.pending.values()][0].milliseconds,2147483647);time.advance(2147484647);time.run();assert.equal(state.read(),true);assert.equal(changes,0);assert.equal([...time.pending.values()][0].milliseconds,4000);
 time.advance(at);time.run();assert.equal(state.read(),false);assert.equal(changes,1);close();
});
test('material draft checks preserve the exact original envelope and reject another room or incomplete operation locator',()=>{
 const draft={revision:'original-revision',version:1,value:{source:{kind:'message',id:'original-message',version:2,sha256:'original-hash',roomId:'original-room'},caseId:'original-work',title:'原材料',purpose:'已输入的用途',viewers:'GUID-ORIGINAL',visibility:'Private',uses:['evidence'],until:'2026-10-11T18:01:32',step:0},attempt:{operationId:'same-operation',materialId:'same-material',payloadHash:'same-bytes'}};
 const bytes=JSON.stringify(draft);assert.equal(checkedOutcomeDraft(draft,'original-room'),draft);assert.equal(JSON.stringify(draft),bytes);assert.equal(hasMaterialAttempt(draft),true);
 assert.throws(()=>checkedOutcomeDraft(draft,'another-room'),/草稿暂时无法读取/);
 const malformed=structuredClone(draft);delete malformed.attempt.materialId;assert.throws(()=>checkedOutcomeDraft(malformed,'original-room'),/草稿暂时无法读取/);
 malformed.attempt={operationId:'same-operation',materialId:'same-material',payloadHash:7};assert.equal(hasMaterialAttempt(malformed),false);
 assert.equal(checkedOutcomeDraft(null,'original-room'),null);
});
test('owner reading keeps original accepted legacy event fields without reparsing them as a newer task schema',()=>{
 const event={kind:'original-historic-kind',summary:'本人原记录',legacyExtension:{nested:['kept',2]},actorId:'original-owner'};
 assert.deepEqual(ownerRecordBody(JSON.stringify({event,originalEnvelopeField:'preserved in original payload'})),event);
 assert.deepEqual(ownerRecordBody(JSON.stringify(event)),event);assert.throws(()=>ownerRecordBody('[]'),/原记录格式/);
});
