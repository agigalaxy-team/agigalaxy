import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { serviceFixture } from './service-fixture.mjs';
import { chatFixture } from './chat-workflow.mjs';
import { attachmentContractFixture } from './chat-attachments-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { ChatAttachmentsService } from "../src/chat/chat-attachments.mjs";
import { browserScopes } from '../src/browser-client.mjs';
import { createExistingWebRuntime } from './existing-web-identity-fixture.mjs';
import { createAttachmentsClient } from "../../galaxy-web/src/features/chat/attachments/chat-attachments-client.mjs";

// B diagnostic only: real signed Binding/WebRuntime/HTTP/PGlite. The local
// device store, attachment object store/scanner and chat transport are explicit
// contract doubles. No model, actual S3, Prosody or production operation.
const closeServer = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; };

test('diagnostic: same GUID reconnect while original attachment journal is read cannot send the old upload intent', { timeout: 60000 }, async t => {
  const f = await serviceFixture(browserScopes, null, { now: Math.floor(Date.now() / 1000) }), contract = attachmentContractFixture();
  Object.assign(f.attachments, contract); f.chat.requireAccountWithin = async () => {};
  f.chat.transport = { available: true, project: async () => {}, send: async x => ({ archiveId: x.messageId }) };
  const server = createApi({ ...f, browserOrigins: ['https://galaxy.example.org'], rateLimit: 1000 });
  let runtime, hook = null, putHook = null, prepares = 0, uploads = 0;
  const records = new Map();
  try {
    const base = await listen(server), fetcher = async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/v2/chat/attachments/prepare') prepares++;
      if (path.endsWith('/upload')) uploads++;
      return fetch(base + path, { ...options, headers: { ...options.headers, Origin: 'https://galaxy.example.org' } });
    };
    const store = { get: async key => {
      const value = structuredClone(records.get(key));
      if (hook && key.includes(':chat-attachment-operation:')) { const once = hook; hook = null; await once(); }
      return value;
    }, put: async (key, value) => { records.set(key, structuredClone(value)); await putHook?.(key, value); },
    update: memoryAtomicUpdate(records,async(key,value)=>{await putHook?.(key,value);}) };
    runtime = await createExistingWebRuntime({ endpoint: f.bindings.endpoint, trustedKeys: f.bindings.trustedKeys }, { store, fetch: fetcher, now: () => f.now });
    await runtime.connect({ confirmed: true });
    const room = await runtime.chat.create({ title: 'Attachment old intent lease diagnostic' }, { confirmed: true });
    const files = createAttachmentsClient(runtime), original = runtime.api.snapshot();
    let replacement;
    hook = async () => { await runtime.connect({ confirmed: true }); replacement = runtime.api.snapshot(); };
    let returned, error;
    try { returned = await files.send(room.roomId, new File(['synthetic selected attachment'], 'selected.txt', { type: 'text/plain' }), { confirmed: true }); }
    catch (failure) { error = failure.code ?? failure.message; }
    assert.equal(replacement.subjectId, original.subjectId); assert.notEqual(replacement.bindingId, original.bindingId);
    const rows = Number((await f.db.query('SELECT count(*) FROM chat_attachments')).rows[0].count);
    t.diagnostic('attachment_lifecycle_observed ' + JSON.stringify({ scenario: 'same-subject-reconnect-after-original-journal-read', sameSubject: true,
      changedBinding: true, generationChanged: replacement.generation !== original.generation, prepares, uploads, attachmentRows: rows,
      returnedState: returned?.state ?? null, error: error ?? null, database: 'PGlite', storage: 'explicit-contract', deviceStore: 'Map' }));
    assert.equal(prepares, 0, 'old upload intent must not prepare against a new binding');
    assert.equal(uploads, 0, 'old upload intent must not dispatch bytes against a new binding');
    assert.equal(rows, 0);
    const file = new File(['synthetic exact retry after local write'], 'original.txt', { type: 'text/plain' });
    let saved;
    putHook = async (key, value) => { if (key.includes(':chat-attachment-operation:') && value?.input) {
      putHook = null; saved = structuredClone(value.input); await runtime.connect({ confirmed: true });
    } };
    await assert.rejects(files.send(room.roomId, file, { confirmed: true }), e => e.code === 'attachment_authority_changed');
    assert.equal(prepares, 0); assert.equal(uploads, 0);
    const retained = await files.pending(room.roomId);
    assert.equal(retained.input.attachmentId, saved.attachmentId); assert.equal(retained.input.sha256, saved.sha256);
    assert.equal(retained.bytes, undefined, 'local late completion preserves the original body-free upload locator');
    const retry = await files.retry(room.roomId, file, { confirmed: true });
    assert.equal(retry.attachmentId, saved.attachmentId); assert.equal(retry.state, 'scan-pending');
    assert.equal(prepares, 1); assert.equal(uploads, 1);
    assert.equal((await files.pending(room.roomId)), null);
    t.diagnostic('attachment_local_write_observed ' + JSON.stringify({ realReconnectAfterLocalWrite: true,
      stalePrepareAndUploadCalls: 0, originalIdAndHashRetained: true, explicitCurrentRetryUsesOriginalId: true,
      acceptedPrepareCalls: prepares, acceptedUploadCalls: uploads, deviceStore: 'Map' }));
  } finally { runtime?.close(); await closeServer(server); await f.db.close(); }
});

test('diagnostic: attachment content cannot return bytes after expiry crosses during actual store read', { timeout: 60000 }, async t => {
  const f = await chatFixture({ transport: { available: true, project: async () => {}, send: async x => ({ archiveId: x.messageId }) } }),
    actor = f.people[0], contract = attachmentContractFixture();
  const files = new ChatAttachmentsService({ chat: f.chat, store: contract.store, scanner: contract.scanner }); f.chat.attachments = files;
  const server = createApi({ bindings: { endpoint: f.chat.access.endpoint }, access: f.chat.access, chat: f.chat, attachments: files,
    rateLimit: 1000, browserOrigins: ['https://galaxy.example.org'] });
  try {
    const base = await listen(server), roomId = randomUUID(), attachmentId = randomUUID(), bytes = Buffer.from('synthetic expiry boundary body');
    await f.chat.create(actor, { roomId, operationId: randomUUID(), title: 'Attachment expiry during read diagnostic' });
    await files.prepare(actor, { attachmentId, roomId, name: 'expiry.txt', mediaType: 'text/plain', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), purpose: 'temporary-room-attachment', confirmed: true });
    await files.upload(actor, attachmentId, Readable.from([bytes]), { contentLength: bytes.length }); await files.scanPending();
    // Compress elapsed time in this isolated fixture while retaining the
    // exact first-upload+30-day interval. Sessions remain currently valid.
    await f.db.query('UPDATE chat_attachments SET uploaded_at=$2,expires_at=$3 WHERE id=$1', [attachmentId,
      new Date((f.now() - 30 * 86400 + 1) * 1000).toISOString(), new Date((f.now() + 1) * 1000).toISOString()]);
    assert.equal((await files.get(actor, { attachmentId })).state, 'available');
    const get = contract.store.get.bind(contract.store); let crossed = false;
    contract.store.get = async input => { const content = await get(input); if (!crossed) { crossed = true; f.advance(2); } return content; };
    const request = (id = attachmentId, ownExport = false) => fetch(base + '/v2/chat/attachments/' + id + (ownExport ? '/export-content' : '/content'), { method: 'POST',
      headers: { Authorization: 'Bearer ' + f.credentials.get(actor.subjectId), 'Content-Type': 'application/json' }, body: '{}' });
    const response = await request(), returnedBytes = new Uint8Array(await response.arrayBuffer()), next = await request();
    const after = await files.get(actor, { attachmentId });
    t.diagnostic('attachment_lifecycle_observed ' + JSON.stringify({ scenario: 'expiry-during-storage-await', crossed,
      responseStatus: response.status, returnedBytes: returnedBytes.length, afterState: after.state, nextStatus: next.status,
      expiredBodyReturned: response.status === 200 && returnedBytes.length === bytes.length,
      database: 'PGlite', storage: 'explicit-contract', expiryTiming: 'compressed isolated first-upload+30d timestamps' }));
    assert.equal(after.state, 'expired'); assert.equal(next.status, 404);
    assert.equal(response.status, 404, 'crossed expiry must withhold the body from the original response');
    const messageFile = randomUUID(), sha256 = createHash('sha256').update(bytes).digest('hex');
    await files.prepare(actor, { attachmentId: messageFile, roomId, name: 'source-expiry.txt', mediaType: 'text/plain', size: bytes.length,
      sha256, purpose: 'temporary-room-attachment', confirmed: true });
    await files.upload(actor, messageFile, Readable.from([bytes]), { contentLength: bytes.length }); await files.scanPending();
    const sent = await f.chat.send(actor, roomId, { clientMessageId: randomUUID(), text: 'synthetic selected source', attachments: [{ id: messageFile, sha256 }] });
    await f.db.query('UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1', [sent.messageId, new Date((f.now() + 1) * 1000).toISOString()]);
    let sourceCrossed = false;
    contract.store.get = async input => { const content = await get(input); if (!sourceCrossed) { sourceCrossed = true; f.advance(2); } return content; };
    const sourceExpired = await request(messageFile); assert.equal(sourceExpired.status, 404, 'late source message expiry withholds ordinary room content');
    assert.equal((await files.get(actor, { attachmentId: messageFile })).state, 'available', 'the independent file TTL did not expire');
    assert.equal((await request(messageFile, true)).status, 200, 'own retained file export remains separate from room-source visibility');
    t.diagnostic('attachment_source_expiry_observed ' + JSON.stringify({ sourceCrossed, ordinaryContentStatus: sourceExpired.status,
      independentFileState: 'available', ownExportStatus: 200, currentAuthorizationRechecked: true }));
  } finally { await closeServer(server); await f.close(); }
});
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';
