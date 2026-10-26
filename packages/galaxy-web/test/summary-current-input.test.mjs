import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptySummary,readSummaryUnavailableSources,filterSummarySources,summaryVersionReadable,summaryError,summaryDraftCleanupNotice} from "../src/features/conversation-notes/native/presentation.ts";
import {informationLocalTime,informationError,restoredInformationSearch} from "../src/features/information/state.ts";

test('current source checks deduplicate exact versions and keep temporary loss out of the stored projection',async()=>{
 const permanent={messageId:randomUUID(),revision:1},temporary={messageId:randomUUID(),revision:2},personal={id:randomUUID(),kind:'personal-note',text:'自己的文字；同一行保留\n下一行',sourceRefs:[]};
 const content={...emptySummary(),coverage:{fromSequence:'1',throughSequence:'2',complete:true},fragments:[{id:randomUUID(),kind:'derived',text:'已撤回来源',sourceRefs:[permanent]},{id:randomUUID(),kind:'derived',text:'暂不可读来源',sourceRefs:[temporary]},personal],keyMessageRefs:[permanent,temporary]};
 const original=JSON.stringify(content),calls=[];
 const sourceCheck=async ref=>{calls.push(ref);return {available:/** @type {false} */(false),temporarilyUnavailable:ref.messageId===temporary.messageId};};
 const sources=await readSummaryUnavailableSources({sourceCheck},randomUUID(),content),visible=filterSummarySources(content,sources),retained=filterSummarySources(content,sources,true);
 assert.equal(calls.length,2);assert.deepEqual(visible.fragments,[personal]);assert.deepEqual(visible.keyMessageRefs,[]);assert.equal(visible.coverage.complete,false);
 assert.equal(retained.fragments.length,2);assert.deepEqual(retained.keyMessageRefs,[temporary]);assert.equal(JSON.stringify(content),original);
});

test('a late source result filters only the exact old reference and preserves current personal edits and newly selected sources',async()=>{
 const oldRef={messageId:randomUUID(),revision:1},newRef={messageId:randomUUID(),revision:2},derived={id:randomUUID(),kind:'derived',text:'旧来源',sourceRefs:[oldRef]},personal={id:randomUUID(),kind:'personal-note',text:'原输入',sourceRefs:[]};
 const captured={...emptySummary(),fragments:[derived,personal]};let release,entered;
 const wait=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const sourceCheck=async()=>{entered();await wait;return {available:/** @type {false} */(false)};};
 const reading=readSummaryUnavailableSources({sourceCheck},randomUUID(),captured);await started;
 const current={...captured,fragments:[derived,{...personal,text:'核对期间新增文字；分号仍在\n第二行'},{id:randomUUID(),kind:'derived',text:'新选择的准确版本',sourceRefs:[newRef]}]};
 release();const sources=await reading,filtered=filterSummarySources(current,sources,true);
 assert.equal(filtered.fragments.length,2);assert.equal(filtered.fragments[0].text,current.fragments[1].text);assert.deepEqual(filtered.fragments[1].sourceRefs,[newRef]);assert.equal(captured.fragments[1].text,'原输入');
});

test('temporary reads hide only the view, recover without replacing input, and errors do not invent a permission change',async()=>{
 const ref={messageId:randomUUID(),revision:1},content={...emptySummary(),fragments:[{id:randomUUID(),kind:'derived',text:'暂时保留的本机内容',sourceRefs:[ref]}]};
 const sourceCheck=async()=>{throw Error('network request failed');},sources=await readSummaryUnavailableSources({sourceCheck},randomUUID(),content);
 assert.equal(filterSummarySources(content,sources).fragments.length,0);assert.equal(filterSummarySources(content,sources,true),content);assert.equal(filterSummarySources(content,[]),content);
 assert.equal(summaryVersionReadable({}),false);assert.equal(summaryVersionReadable(content),true);
 assert.match(summaryError(Error('network request failed')),/暂时无法完成/);assert.match(informationError(Error('network request failed')),/暂时无法完成/);assert.doesNotMatch(informationError(Error('network request failed')),/许可.*变化/);
});

test('information local deadlines retain exact seconds and search restoration stays in the original owner',()=>{
 const seconds=1791619237;assert.equal(Math.floor(new Date(informationLocalTime(seconds)).getTime()/1000),seconds);
 const request={purpose:'原方向',sources:[{key:'original',source:{kind:'reference',request:{search:{type:'task',query:{limit:8}},ref:{id:randomUUID(),version:'a'.repeat(64)}}}}]};
 // Validate the real source schema without rewriting an existing saved request.
 const owner='GUID'+'A'.repeat(28),history={informationSearch:{owner,request}};
 const restored=restoredInformationSearch(history,owner);
 assert.equal(restored,request);assert.equal(restoredInformationSearch(history,'GUID'+'B'.repeat(28)),null);
});

test('a successful local save and an unconfirmed draft cleanup remain separate reported outcomes',()=>{
 assert.match(summaryDraftCleanupNotice(Error('summary_draft_conflict')),/原笔记已保存.*另一页保存的输入仍保留/);
 const unknown=summaryDraftCleanupNotice(Error('storage unavailable'));
 assert.match(unknown,/原笔记已保存.*清理尚未确认/);assert.doesNotMatch(unknown,/另一页|清理成功/);
});
