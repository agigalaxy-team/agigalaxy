import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAccountConversationNotes} from '../packages/galaxy-web/src/features/conversation-notes/account/store.mjs';

function localAuthority(){
  const records=new Map();let active=true;
  return {records,stop(){active=false;},authority:{endpoint:'https://example.test',captureLease(){return{assertCurrent(){if(!active)throw Error('account_session_changed');}};},
    async get(key){return structuredClone(records.get(key));},async update(key,change){const next=change(structuredClone(records.get(key)));records.set(key,structuredClone(next));return structuredClone(next);}}};
}

test('account chat annotations stay private to their account and room and retain references instead of message bodies',async()=>{
  const local=localAuthority(),accountId=randomUUID(),roomId=randomUUID(),first=createAccountConversationNotes(local.authority,{accountId,roomId});
  const reference={messageId:randomUUID(),revision:3,text:'a private original message'};
  await first.setSaved(reference,true);
  const saved=await first.read();assert.deepEqual(saved.references,[{messageId:reference.messageId,revision:3}]);
  assert.equal(JSON.stringify([...local.records.values()]).includes(reference.text),false);
  assert.equal((await createAccountConversationNotes(local.authority,{accountId:randomUUID(),roomId}).read()).references.length,0);
  assert.equal((await createAccountConversationNotes(local.authority,{accountId,roomId:randomUUID()}).read()).references.length,0);
});

test('a note draft survives closing and message selection changes, while a stale editor cannot replace the saved note',async()=>{
  const local=localAuthority(),owner={accountId:randomUUID(),roomId:randomUUID()},first=createAccountConversationNotes(local.authority,owner);
  const draft=await first.saveDraft({text:'Remember this for our next reply',baseRevision:0,expectedDraftId:null});
  const reopened=createAccountConversationNotes(local.authority,owner);assert.equal((await reopened.read()).draft.text,draft.draft.text);
  const ref={messageId:randomUUID(),revision:1};await reopened.setSaved(ref,true);
  const saved=await first.saveNote({text:draft.draft.text,expectedRevision:0,expectedDraftId:draft.draft.id});
  assert.deepEqual(saved.references,[ref]);assert.equal(saved.draft,null);
  await assert.rejects(reopened.saveNote({text:'stale replacement',expectedRevision:0,expectedDraftId:null}),/conversation_notes_conflict/);
  assert.equal((await first.read()).note,'Remember this for our next reply');
});

test('losing the actual account session prevents late local changes without creating an identity',async()=>{
  const local=localAuthority(),notes=createAccountConversationNotes(local.authority,{accountId:randomUUID(),roomId:randomUUID()});
  local.stop();await assert.rejects(notes.setSaved({messageId:randomUUID(),revision:1},true),/account_session_changed/);
  assert.equal(local.records.size,0);
});
