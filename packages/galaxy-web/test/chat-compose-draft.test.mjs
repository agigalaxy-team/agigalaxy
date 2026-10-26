import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatComposeDraft} from "../src/features/chat/chat-compose-draft.ts";

function fixture(){
 const rows=new Map(),roomId=crypto.randomUUID(),subjectId='GUID'+'A'.repeat(28);let generation=1,failNext=false;
 const runtime={receiptStatus:{captureLease(){const captured=generation;return{assertCurrent(){if(captured!==generation)throw Error('identity_changed');}};}},
  getLocal:async key=>structuredClone(rows.get(key)),updateLocal:async(key,update)=>{if(failNext){failNext=false;throw Error('temporary_local_failure');}const value=update(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);}};
 return{rows,roomId,subjectId,store:(id='page-a')=>createChatComposeDraft(runtime,subjectId,roomId,id),invalidate:()=>generation++,fail:()=>{failNext=true;},canonical:()=>rows.get('chat-draft:'+roomId)};
}
const attachment=()=>({id:crypto.randomUUID(),sha256:'b'.repeat(64)});
const source=subjectId=>({messageId:crypto.randomUUID(),sequence:'7',subjectId});

test('legacy text and exact compose choices survive reopening; another person’s body is excluded',async()=>{
 const f=fixture();f.rows.set('chat-draft:'+f.roomId,'my unsent words');const a=f.store();await a.start();assert.equal(a.read().value.text,'my unsent words');
 const reply={...source(f.subjectId),text:'controlled source must never be persisted'},file=attachment();
 a.change({reply,attachments:[file],edit:{...source(f.subjectId),revision:3,text:'my own edited words'}});await a.flush();a.close();
 assert.equal(JSON.stringify(f.canonical()).includes('controlled source'),false);
 const reopened=f.store();await reopened.start();assert.equal(reopened.read().value.text,'my unsent words');assert.deepEqual(reopened.read().value.reply,((({text:_text,...rest})=>rest)(reply)));assert.deepEqual(reopened.read().value.attachments,[file]);assert.equal(reopened.read().value.edit.text,'my own edited words');
});
test('two tabs retain both inputs across refresh and merge only untouched choices',async()=>{
 const f=fixture(),a=f.store('a'),b=f.store('b');await Promise.all([a.start(),b.start()]);
 const file=attachment();a.change({attachments:[file],text:'first tab'});await a.flush();b.change({text:'second tab'});await b.flush();
 assert.equal(b.read().conflict,true);assert.equal(f.canonical().value.text,'first tab');assert.equal(b.read().other.text,'first tab');b.close();
 const recovered=f.store('b');await recovered.start();assert.equal(recovered.read().value.text,'second tab');assert.equal(recovered.read().conflict,true);
 await recovered.resolve('mine');assert.equal(f.canonical().value.text,'second tab');assert.deepEqual(f.canonical().value.attachments,[file]);
 recovered.change({text:'second tab, continued'});await recovered.flush();assert.equal(f.canonical().value.text,'second tab, continued');assert.equal(recovered.read().conflict,false);
});
test('late exact acknowledgement preserves new input and does not poison later saves',async()=>{
 const f=fixture(),a=f.store();await a.start();a.change({text:'sent original'});const snapshot=await a.snapshot(),id=crypto.randomUUID();await a.attach({kind:'send',id,requestHash:'a'.repeat(64)},snapshot.revision);
 a.change({text:'new words while awaiting the result'});await a.flush();await a.settle(id);
 assert.equal(f.canonical().value.text,'new words while awaiting the result');assert.equal(f.canonical().attempt,null);
 a.change({text:'continued new words'});await a.flush();assert.equal(a.read().conflict,false);assert.equal(f.canonical().value.text,'continued new words');
});
test('only the attached operation clears submitted fields, and editing retains the other unsent draft',async()=>{
 const f=fixture(),a=f.store();await a.start();const edit={...source(f.subjectId),revision:2,text:'edited original'},file=attachment();
 a.change({text:'separate unsent draft',edit,attachments:[file]});const snapshot=await a.snapshot(),id=crypto.randomUUID();await a.attach({kind:'edit',id,messageId:edit.messageId},snapshot.revision);
 await a.settle(crypto.randomUUID());assert.equal(a.read().value.edit.text,'edited original');assert.equal(a.read().attempt.id,id);await a.settle(id);
 assert.equal(a.read().value.edit,null);assert.equal(a.read().value.text,'separate unsent draft');assert.deepEqual(a.read().value.attachments,[file]);
});
test('a later tab revision is never erased by acknowledgement of an earlier input',async()=>{
 const f=fixture(),a=f.store('a');await a.start();a.change({text:'original'});const snapshot=await a.snapshot(),id=crypto.randomUUID();await a.attach({kind:'send',id},snapshot.revision);
 const b=f.store('b');await b.start();b.change({text:'another page’s new draft'});await b.flush();await a.settle(id);assert.equal(f.canonical().value.text,'another page’s new draft');
 a.change({text:'a still has its words'});await a.flush();assert.equal(a.read().conflict,true);assert.equal(a.read().value.text,'a still has its words');
});
test('one rejected storage write does not prevent subsequent saves; changed identity still fences writes',async()=>{
 const f=fixture(),a=f.store();await a.start();f.fail();a.change({text:'kept after failure'});await assert.rejects(a.flush(),/temporary_local_failure/);assert.equal(a.read().value.text,'kept after failure');
 await a.retrySave();await a.flush();assert.equal(f.canonical().value.text,'kept after failure');
 a.change({text:'saved after recovery'});await a.flush();assert.equal(f.canonical().value.text,'saved after recovery');f.invalidate();a.change({text:'cannot cross identity'});await assert.rejects(a.flush(),/identity_changed/);assert.equal(f.canonical().value.text,'saved after recovery');
});
test('safe navigation keeps this page’s words even when another page changed the shared draft',async()=>{
 const f=fixture(),a=f.store('a');await a.start();a.change({text:'words still visible on page a'});await a.flush();
 const b=f.store('b');await b.start();b.change({text:'new words on page b'});await b.flush();
 await a.flush();a.close();const returned=f.store('a');await returned.start();
 assert.equal(returned.read().value.text,'words still visible on page a');assert.equal(returned.read().other.text,'new words on page b');assert.equal(returned.read().conflict,true);
});
test('binding an older input exposes both retained drafts instead of offering an endless send retry',async()=>{
 const f=fixture(),a=f.store('a');await a.start();a.change({text:'page a still intends this'});const snapshot=await a.snapshot();
 const b=f.store('b');await b.start();b.change({text:'page b changed the input'});await b.flush();
 await assert.rejects(a.attach({kind:'send',id:crypto.randomUUID()},snapshot.revision));assert.equal(a.read().conflict,true);assert.equal(a.read().other.text,'page b changed the input');
 a.close();const returned=f.store('a');await returned.start();assert.equal(returned.read().value.text,'page a still intends this');assert.equal(returned.read().conflict,true);
});
test('the original submission can be enriched once and retried without changing its exact locator',async()=>{
 const f=fixture(),a=f.store();await a.start();a.change({text:'same intended message'});const snapshot=await a.snapshot(),id=crypto.randomUUID();
 await a.attach({kind:'send',id},snapshot.revision);await a.attach({kind:'send',id,requestHash:'a'.repeat(64)},snapshot.revision);await a.attach({kind:'send',id},snapshot.revision);
 assert.equal(f.canonical().attempt.requestHash,'a'.repeat(64));await assert.rejects(a.attach({kind:'send',id,requestHash:'b'.repeat(64)},snapshot.revision));assert.equal(f.canonical().attempt.requestHash,'a'.repeat(64));
 await a.release(id);assert.equal(f.canonical().attempt,null);assert.equal(f.canonical().value.text,'same intended message');
});
