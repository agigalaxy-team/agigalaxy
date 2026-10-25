import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAccountConversationNotes} from '../src/features/conversation-notes/account/store.mjs';

// Explicit serial local-store and current-account lease contracts. This checks
// the client boundary, not IndexedDB internals or real OIDC authentication.
test('account conversation notes isolate owners and rooms, preserve exact draft CAS and reject late reads after a session lease changes',async()=>{
 const accountA=randomUUID(),accountB=randomUUID(),roomId=randomUUID(),otherRoom=randomUUID(),endpoint='https://account-notes.example.invalid';
 const records=new Map();let active=accountA,generation=1,tail=Promise.resolve(),readBarrier=null;
 const authority=owner=>({endpoint,captureLease(){const epoch=generation;return{assertCurrent(){if(active!==owner||epoch!==generation)throw Error('notes_session_changed');}};},
  async get(key){const value=structuredClone(records.get(key));if(readBarrier)await readBarrier();return value;},
  update(key,change){const result=tail.then(()=>{const next=change(structuredClone(records.get(key)));records.set(key,structuredClone(next));return structuredClone(next);});tail=result.catch(()=>{});return result;},
 });
 const first=createAccountConversationNotes(authority(accountA),{accountId:accountA,roomId}),second=createAccountConversationNotes(authority(accountA),{accountId:accountA,roomId});
 const draft=await first.saveDraft({text:'[合成] 本人未提交的输入',baseRevision:0,expectedDraftId:null});
 await assert.rejects(second.saveDraft({text:'[合成] 另一页的独立输入',baseRevision:0,expectedDraftId:null}),/conversation_notes_conflict/);
 assert.equal((await second.read()).draft.text,'[合成] 本人未提交的输入');
 const saved=await first.saveNote({text:'[合成] 明确保留的本人备注',expectedRevision:0,expectedDraftId:draft.draft.id});
 assert.equal(saved.noteRevision,1);assert.equal(saved.draft,null);
 const ref={messageId:randomUUID(),revision:2,text:'SOURCE_BODY_MUST_NOT_BE_COPIED'};await first.setSaved(ref,true);
 assert.equal(JSON.stringify(await first.read()).includes(ref.text),false,'References do not copy an arbitrary message body');
 assert.equal((await createAccountConversationNotes(authority(accountA),{accountId:accountA,roomId:otherRoom}).read()).note,'');
 active=accountB;generation++;
 const ownB=createAccountConversationNotes(authority(accountB),{accountId:accountB,roomId});assert.equal((await ownB.read()).note,'');
 await assert.rejects(first.read(),/notes_session_changed/);
 active=accountA;generation++;
 let release,entered;const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 readBarrier=async()=>{entered();await waiting;};const late=first.read();await started;
 active=accountB;generation++;release();await assert.rejects(late,/notes_session_changed/);readBarrier=null;
 active=accountA;generation++;assert.equal((await first.read()).note,saved.note,'A canceled late read does not erase the former owner\'s private local note');
 const raced=await Promise.allSettled([
  first.saveNote({text:'[合成] 并发选择甲',expectedRevision:1,expectedDraftId:null}),
  second.saveNote({text:'[合成] 并发选择乙',expectedRevision:1,expectedDraftId:null}),
 ]);
 assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);assert.match(raced.find(result=>result.status==='rejected').reason.message,/conversation_notes_conflict/);
 assert.equal((await first.read()).noteRevision,2);
 active=accountB;generation++;assert.equal((await ownB.read()).note,'');
});
