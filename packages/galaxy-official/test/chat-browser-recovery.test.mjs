import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatClient } from '../../galaxy-web/src/chat-client.mjs';

test('browser chat retains stable send and edit operations across lost replies and reload, without auto resending drafts', async () => {
  const rows = new Map(), calls = [], roomId = crypto.randomUUID(), messageId = crypto.randomUUID();
  let drop = true, accepted = false;
  const configuration = { getLocal: async key => structuredClone(rows.get(key)), putLocal: async (key, value) => rows.set(key, structuredClone(value)),
    api: { snapshot: () => ({ subjectId: 'test-viewer' }), call: async (path, input) => {
      calls.push({ path, input });
      if (path.endsWith('/receipt')) return { state: accepted ? 'accepted' : 'pending' };
      if (drop) { drop = false; accepted = true; throw new Error('lost reply'); }
      return { messageId, state: 'accepted', revision: 2 };
    } } };
  let chat = createChatClient(configuration);
  await assert.rejects(chat.send(roomId, '只在确认后发出'), /确认/); assert.equal(calls.length, 0);
  await assert.rejects(chat.send(roomId, '需保留的原消息', { confirmed: true }), /lost reply/);
  const pending = await chat.pending(roomId); assert.equal(pending.input.text, '需保留的原消息');
  chat = createChatClient(configuration); assert.equal(calls.length, 1);
  await assert.rejects(chat.send(roomId, '不可悄悄变成第二条', { confirmed: true }), /上一次操作/);
  const receipt = await chat.retry(roomId, { confirmed: true }); assert.equal(receipt.state, 'accepted'); assert.equal(calls.filter(call => call.path.endsWith('/send')).length, 1);
  assert.equal(await chat.pending(roomId), null);
  drop = true;
  await assert.rejects(chat.edit(roomId, messageId, { expectedRevision: 1, text: '编辑后的内容' }, { confirmed: true }), /lost reply/);
  const firstEdit = calls.at(-1).input;
  chat = createChatClient(configuration); await chat.retry(roomId, { confirmed: true });
  assert.deepEqual(calls.at(-1).input, firstEdit); assert.equal(await chat.pending(roomId), null);
});
