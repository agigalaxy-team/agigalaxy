import test from 'node:test';
import assert from 'node:assert/strict';
import { xml } from '@xmpp/component';
import { serviceFixture } from '../service-fixture.mjs';
import { createApi } from '../../src/http.mjs';
import { ChatService } from '../../src/chat.mjs';
import { ProsodyChatTransport } from '../../src/infrastructure/prosody-chat.mjs';
import { chatResults } from '../../src/shared/chat-schema.mjs';
import { createChatClient } from '../../src/chat-client.mjs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createPersonalMcp } from '../../src/personal-mcp.mjs';

test('real Prosody: Galaxy-authenticated ownerless rooms, membership, messages, MAM, reconnect and sole-member choices', {
  timeout: 100000,
  skip: !process.env.GALAXY_CHAT_TEST_SERVICE,
}, async () => {
  const transport = new ProsodyChatTransport({ service: process.env.GALAXY_CHAT_TEST_SERVICE,
    password: process.env.GALAXY_CHAT_TEST_PASSWORD, domain: 'gateway.galaxy.test', roomsDomain: 'rooms.galaxy.test' });
  const f = await serviceFixture(['binding', 'chat']);
  const other = await serviceFixture(['binding', 'chat'], f.db, { migrateDatabase: false });
  const legacy = await serviceFixture(['binding', 'history', 'assistance'], f.db, { migrateDatabase: false });
  const chat = new ChatService(f.access, transport);
  const mcp = createPersonalMcp({ ...f, chat }, f.actor);
  const sdk = new Client({ name: 'synthetic-chat-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport); await sdk.connect(clientTransport);
  const call = async (action, input) => {
    const result = await sdk.callTool({ name: 'galaxy_chat_' + action, arguments: input });
    assert.ok(!result.isError, 'MCP chat operation rejected: ' + action);
    return chatResults[action].parse(JSON.parse(result.content[0].text));
  };
  const api = createApi({ ...f, chat });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${api.address().port}`;
  const post = async (fixture, action, input, status = 200) => {
    const response = await fetch(origin + '/v1/chat/' + action, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fixture.credential }, body: JSON.stringify(input) });
    const value = await response.json();
    assert.equal(response.status, status, action + ': ' + String(value.error?.code ?? value.error ?? 'unexpected status'));
    return response.status === 200 ? chatResults[action].parse(value) : value;
  };
  const rooms = [];
  try {
    await transport.start();
    const available = await sdk.listTools();
    assert.equal(available.tools.filter(tool => tool.name.startsWith('galaxy_chat_')).length, 8);
    assert.equal(available.tools.length, 38);
    assert.deepEqual((await call('list', {})).rooms, []);
    const authorization = { credential: f.credential, scopes: ['chat'] };
    const client = createChatClient({ endpoint: f.bindings.endpoint,
      sessions: { readAuthorization: async () => authorization, matchesAuthorization: value => value === authorization, isAuthorizationCurrent: async () => true },
      send: async (url, options) => {
        const response = await fetch(origin + new URL(url).pathname, { method: 'POST', signal: options.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + options.credential }, body: options.bodyJson });
        assert.equal(response.status, 200); return response.json();
      } });
    await post(legacy, 'list', {}, 401);
    const room = await post(f, 'create', { title: 'Synthetic functional module discussion', description: 'G0 integration only' });
    rooms.push(room.roomId);
    assert.equal(room.mode, 'ownerless'); assert.equal(room.ownerSubjectId, null);
    assert.equal(room.members[0].affiliation, 'member'); assert.equal(room.memberCount, 1);
    assert.deepEqual(room.choices, ['dissolve', 'become-owner']);
    assert.equal(room.decisionRequired, true);
    await post(other, 'read', { roomId: room.roomId }, 403);
    await post(other, 'join', { roomId: room.roomId, joinCode: 'a'.repeat(43) }, 403);
    const joined = await post(other, 'join', { roomId: room.roomId, joinCode: room.joinCode });
    assert.equal(joined.memberCount, 2); assert.equal(joined.decisionRequired, false);
    assert.ok(joined.members.every(person => person.affiliation === 'member'));
    await post(f, 'decide', { roomId: room.roomId, expectedRevision: room.revision, choice: 'dissolve' }, 409);
    assert.equal((await post(f, 'list', {})).rooms.some(value => value.roomId === room.roomId), true);
    assert.equal((await client.read({ roomId: room.roomId })).roomId, room.roomId);

    const message = await call('send', { roomId: room.roomId, text: '真实 XMPP 合成测试 <tags> & 中文\n第二行' });
    assert.equal(message.acceptedByRoom, true); assert.equal(message.readByOthers, false);
    assert.ok(message.archiveId);
    const history = await post(other, 'messages', { roomId: room.roomId });
    assert.equal(history.source, 'prosody-mam');
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].text, '真实 XMPP 合成测试 <tags> & 中文\n第二行');
    assert.equal(history.items[0].subjectId, f.actor.subjectId);
    assert.equal(history.items[0].archiveId, message.archiveId);
    const reply = await post(other, 'send', { roomId: room.roomId, text: 'Synthetic reply' });
    const next = await post(f, 'messages', { roomId: room.roomId, after: message.archiveId, limit: 1 });
    assert.equal(next.items.length, 1); assert.equal(next.items[0].archiveId, reply.archiveId);
    // Creator cannot kick, promote or reconfigure merely by knowing raw MUC IQ.
    await assert.rejects(transport.iq(f.actor, transport.room(room.roomId), xml('query', { xmlns: 'http://jabber.org/protocol/muc#admin' },
      xml('item', { jid: transport.address(other.actor).split('/')[0], affiliation: 'outcast' }))), error => error.code === 'chat_protocol_rejected');
    await assert.rejects(transport.iq(f.actor, transport.room(room.roomId), xml('query', { xmlns: 'http://jabber.org/protocol/muc#owner' },
      xml('destroy'))), error => error.code === 'chat_protocol_rejected');

    await transport.stop(); await transport.start();
    const restored = await post(f, 'read', { roomId: room.roomId });
    assert.equal(restored.memberCount, 2); assert.equal(restored.mode, 'ownerless');
    assert.equal((await post(f, 'messages', { roomId: room.roomId })).items.length, 2);
    await post(other, 'leave', { roomId: room.roomId });
    await post(other, 'messages', { roomId: room.roomId }, 403);
    await assert.rejects(transport.messages(other.actor, { roomId: room.roomId, limit: 10 }), error => error.code === 'chat_protocol_rejected');
    const alone = await post(f, 'read', { roomId: room.roomId });
    assert.equal(alone.decisionRequired, true); assert.equal(alone.memberCount, 1);
    const owned = await post(f, 'decide', { roomId: room.roomId, expectedRevision: alone.revision, choice: 'become-owner' });
    assert.equal(owned.ownerSubjectId, f.actor.subjectId); assert.equal(owned.members[0].affiliation, 'owner');
    assert.equal(owned.decisionRequired, false);
    await post(f, 'leave', { roomId: room.roomId });
    await post(f, 'read', { roomId: room.roomId }, 404);

    const single = await post(f, 'create', { title: 'Synthetic dissolve choice' }); rooms.push(single.roomId);
    await post(f, 'decide', { roomId: single.roomId, expectedRevision: single.revision, choice: 'dissolve' });
    await post(f, 'read', { roomId: single.roomId }, 404);
    await f.db.query('UPDATE bindings SET revoked_at=now() WHERE id=$1', [f.actor.bindingId]);
    await post(f, 'list', {}, 401);
  } finally {
    // Only the synthetic rooms created by this test; no all-room deletion.
    for (const roomId of rooms) for (const actor of [f.actor, other.actor]) {
      try { await transport.command(actor, { action: 'leave', roomId }); } catch { /* Already dissolved or not a member. */ }
    }
    await transport.stop();
    await sdk.close(); await mcp.close();
    await new Promise(resolve => api.close(resolve));
    await f.db.close();
  }
});
