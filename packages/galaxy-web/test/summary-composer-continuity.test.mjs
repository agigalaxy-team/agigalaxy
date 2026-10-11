import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getSummaryRuntime,closeSummaryRuntime} from '../src/summary-runtime.mjs';

// Local storage is an explicit atomic in-memory double. The unchanged sharing
// protocol has separate real signed HTTP/PGlite regressions.
function storeFixture(){const records=new Map();let tail=Promise.resolve(),afterUpdate=async()=>{};return {records,setAfterUpdate:fn=>{afterUpdate=fn;},read:async key=>structuredClone(records.get(key)),update(key,fn){const result=tail.then(()=>{const value=fn(structuredClone(records.get(key)));records.set(key,structuredClone(value));return structuredClone(value);});tail=result.catch(()=>{});return result.then(async value=>{await afterUpdate(key,value);return value;});},close(){}};}
async function fixture(t){
 const subjectId='GUID'+'A'.repeat(28),endpoint='https://local-note.example.org',store=storeFixture(),calls=[];
 let currentSubject=subjectId,generation=1,sourceReader=async()=>({available:true});
 const runtime={api:{endpoint,snapshot:()=>({subjectId:currentSubject,bindingId:'synthetic-binding',generation}),call:async(path,input)=>{calls.push({path,input:structuredClone(input)});if(path==='/v2/personal-summaries/sources')return {items:await Promise.all(input.refs.map(sourceReader))};throw Error('Unexpected business HTTP: '+path);}},status:async()=>({identity:{subjectId:currentSubject}}),receiptStatus:{captureLease(){const selected=[currentSubject,generation,runtime.api.endpoint].join(':');return {assertCurrent(){if([currentSubject,generation,runtime.api.endpoint].join(':')!==selected)throw Error('summary_binding_changed');}};}}};
 const otherRuntime={...runtime},bridge=await getSummaryRuntime(runtime,subjectId,{openStore:async()=>store}),other=await getSummaryRuntime(otherRuntime,subjectId,{openStore:async()=>store});
 t.after(()=>{closeSummaryRuntime(runtime);closeSummaryRuntime(otherRuntime);});
 const roomId=randomUUID(),summaryId=randomUUID(),content={generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:false},fragments:[],keyMessageRefs:[]};
 const draft={summaryId,baseRevision:0,content,note:'原笔记；同一行的分号保留\n下一行',dirty:true};
 return {runtime,bridge,other,store,subjectId,endpoint,roomId,summaryId,draft,calls,key:id=>`draft:${subjectId}:${endpoint}:${id}`,setSource:fn=>{sourceReader=fn;},switchIdentity:()=>{currentSubject='GUID'+'B'.repeat(28);generation++;},rebind:()=>{generation++;}};
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

test('legacy note input remains readable; two pages preserve the first write and report an exact draft conflict',async t=>{
 const f=await fixture(t);await f.store.update(f.key(f.roomId),()=>f.draft);
 const left=await f.bridge.readDraft(f.roomId),right=await f.other.readDraft(f.roomId);
 const {blockedSources,sourcesTemporarilyUnavailable,...legacy}=left;assert.deepEqual(legacy,f.draft);assert.equal(blockedSources,false);assert.equal(sourcesTemporarilyUnavailable,false);assert.equal(left.draftRevision,undefined);
 const first=await f.bridge.saveDraft(f.roomId,{...left,note:'第一页新输入'},{expectedRevision:null});
 await assert.rejects(f.other.saveDraft(f.roomId,{...right,note:'第二页仍未覆盖的输入'},{expectedRevision:null}),/summary_draft_conflict/);
 assert.deepEqual(await f.store.read(f.key(f.roomId)),first);
 const reread=await f.other.readDraft(f.roomId),second=await f.other.saveDraft(f.roomId,{...reread,note:'明确读取后继续'},{expectedRevision:reread.draftRevision});
 assert.notEqual(second.draftRevision,first.draftRevision);assert.equal(second.note,'明确读取后继续');assert.equal(f.calls.length,0);
});

test('a late local save cannot clear another page’s newer input and never changes the saved local revision',async t=>{
 const f=await fixture(t),original=await f.bridge.saveDraft(f.roomId,f.draft,{expectedRevision:null});
 const entered=deferred(),release=deferred();let held=true;
 f.store.setAfterUpdate(async key=>{if(held&&key==='personal-summary:'+f.subjectId){held=false;entered.resolve();await release.promise;}});
 const content={...f.draft.content,fragments:[{id:randomUUID(),kind:'personal-note',text:f.draft.note,sourceRefs:[]}]};
 const saving=f.bridge.local.save({summaryId:f.summaryId,roomId:f.roomId,endpoint:f.endpoint,expectedLocalRevision:0,content});await entered.promise;
 const newer=await f.other.saveDraft(f.roomId,{...original,note:'保存期间另一页后来输入',baseRevision:1},{expectedRevision:original.draftRevision});
 release.resolve();const saved=await saving;assert.equal(saved.localRevision,1);
 await assert.rejects(f.bridge.saveDraft(f.roomId,null,{expectedRevision:original.draftRevision}),/summary_draft_conflict/);
 assert.deepEqual(await f.store.read(f.key(f.roomId)),newer);assert.equal((await f.bridge.local.get({summaryId:f.summaryId})).content.fragments[0].text,f.draft.note);assert.equal(f.calls.length,0);
});

test('a permission-filtered old copy cannot overwrite newer input; the next exact read removes only revoked fragments',async t=>{
 const f=await fixture(t),ref={messageId:randomUUID(),revision:1},original=await f.bridge.saveDraft(f.roomId,{...f.draft,content:{...f.draft.content,fragments:[{id:randomUUID(),kind:'derived',text:'原消息来源',sourceRefs:[ref]}]}},{expectedRevision:null});
 const entered=deferred(),release=deferred();f.setSource(async()=>{entered.resolve();await release.promise;return {available:false};});
 const reading=f.bridge.readDraft(f.roomId);await entered.promise;
 const newer=await f.other.saveDraft(f.roomId,{...original,note:'来源核对期间新增的本人文字'},{expectedRevision:original.draftRevision});release.resolve();
 await assert.rejects(reading,/summary_draft_conflict/);assert.deepEqual(await f.store.read(f.key(f.roomId)),newer);
 f.setSource(async()=>({available:false}));const current=await f.other.readDraft(f.roomId);
 assert.equal(current.note,newer.note);assert.equal(current.content.fragments.length,0);assert.equal(current.blockedSources,true);assert.notEqual(current.draftRevision,newer.draftRevision);
 assert.equal((await f.store.read(f.key(f.roomId))).note,newer.note);assert.ok(f.calls.every(call=>call.path==='/v2/personal-summaries/sources'));
});

test('temporary source loss hides only the current view; stored input and its revision remain available for recovery',async t=>{
 const f=await fixture(t),original=await f.bridge.saveDraft(f.roomId,{...f.draft,content:{...f.draft.content,fragments:[{id:randomUUID(),kind:'derived',text:'暂时隐藏的原文',sourceRefs:[{messageId:randomUUID(),revision:1}]}]}},{expectedRevision:null});
 f.setSource(async()=>({available:false,temporarilyUnavailable:true}));const hidden=await f.bridge.readDraft(f.roomId);
 assert.equal(hidden.content.fragments.length,0);assert.equal(hidden.sourcesTemporarilyUnavailable,true);assert.equal(hidden.draftRevision,original.draftRevision);assert.deepEqual(await f.store.read(f.key(f.roomId)),original);
 f.setSource(async()=>({available:true}));assert.equal((await f.bridge.readDraft(f.roomId)).content.fragments[0].text,'暂时隐藏的原文');
});

test('identity and binding changes fence late source reads while separate room drafts keep their own input',async t=>{
 const f=await fixture(t),ref={messageId:randomUUID(),revision:1},first=await f.bridge.saveDraft(f.roomId,{...f.draft,content:{...f.draft.content,fragments:[{id:randomUUID(),kind:'derived',text:'A 的来源',sourceRefs:[ref]}]}},{expectedRevision:null}),otherRoom=randomUUID();
 const second=await f.other.saveDraft(otherRoom,{...f.draft,summaryId:randomUUID(),note:'另一个笔记的输入'},{expectedRevision:null});
 const entered=deferred(),release=deferred();f.setSource(async()=>{entered.resolve();await release.promise;return {available:false};});
 const reading=f.bridge.readDraft(f.roomId);await entered.promise;f.rebind();release.resolve();await assert.rejects(reading,/summary_binding_changed/);
 assert.deepEqual(await f.store.read(f.key(f.roomId)),first);assert.deepEqual(await f.store.read(f.key(otherRoom)),second);
 f.switchIdentity();await assert.rejects(f.other.saveDraft(otherRoom,null,{expectedRevision:second.draftRevision}),/当前身份已改变|summary_binding_changed/);
 assert.deepEqual(await f.store.read(f.key(otherRoom)),second);
});
