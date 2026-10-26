import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {communityForumFixture} from '../packages/galaxy-official/test/community-forum-fixture.mjs';
import {accountChatFixture} from '../packages/galaxy-official/test/account-chat-fixture.mjs';
import {attachmentContractFixture} from '../packages/galaxy-official/test/chat-attachments-workflow.mjs';
import {ForumAttachmentsV1Service} from "../packages/galaxy-official/src/community/forum-attachments-v1.mjs";
import {defaultAttachmentPolicy} from '../packages/galaxy-official/src/shared/chat-attachments-schema.mjs';
import {bindForumIds} from '../packages/galaxy-official/src/shared/community-forum-ids-v1.mjs';
import {forumWriteSpec} from '../packages/galaxy-official/src/shared/community-forum-v1-schema.mjs';

const root = '/v2/community/attachments/';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from('A synthetic discussion attachment, without private user data.\n');
const ref = file => ({id: file.attachmentId, sha256: file.sha256});
const source = post => ({postId: post.payload.postId, versionId: post.payload.versionId});

// The existing fixture runs the actual HTTP, OIDC, account, forum and PostgreSQL
// kernel. Only object storage and the antivirus daemon use explicit contracts.
async function fixture({policy = defaultAttachmentPolicy} = {}) {
  const f = await communityForumFixture({officialAccountPortal: true});
  const contract = attachmentContractFixture();
  const files = f.owner.forumAttachments;
  Object.assign(files, new ForumAttachmentsV1Service({forum: f.forum, store: contract.store, scanner: contract.scanner, policy}));
  f.forum.attachments = files;
  return Object.assign(f, {files, contract});
}

async function browser(f, name) {
  const cookies = new Map();
  const accept = response => {
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(';')[0];
      cookies.set(pair.split('=')[0], pair);
    }
  };
  const cookie = () => [...cookies.values()].join('; ');
  f.issuer.setAccount(name);
  const started = await fetch(f.origin + '/v1/account/login', {redirect: 'manual'});
  accept(started);
  assert.equal(started.status, 303);
  const returned = await f.issuer.authorize(started.headers.get('location'));
  const callback = await fetch(f.origin + returned.pathname + returned.search, {redirect: 'manual', headers: {Cookie: cookie()}});
  accept(callback);
  assert.equal(callback.status, 303);
  const session = await (await fetch(f.origin + '/v1/account/session', {headers: {Cookie: cookie(), Origin: f.website}})).json();
  assert.equal(session.state, 'signed-in');

  async function raw(path, {input, binary, method = binary ? 'PUT' : input === undefined ? 'GET' : 'POST', headers = {}} = {}) {
    return fetch(f.origin + path, {
      method,
      headers: {Cookie: cookie(), Origin: f.website, 'X-Galaxy-Account-ID': session.account.id,
        'X-Galaxy-Account-CSRF': session.csrfToken,
        ...(binary ? {'Content-Type': 'application/octet-stream', 'Content-Length': String(binary.length)} :
          input === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      ...(binary ? {body: binary} : input === undefined ? {} : {body: JSON.stringify(input)}),
    });
  }
  async function request(path, options) {
    const response = await raw(path, options);
    return {status: response.status, body: await response.json()};
  }
  async function write(kind, input) {
    const payload = await bindForumIds(kind, 'account:' + session.account.id, {...input, accountId: session.account.id});
    const payloadJson = JSON.stringify(payload);
    return {payload, payloadJson, ...await request(forumWriteSpec(kind, payload).path, {input: {payloadJson}})};
  }
  return {session, raw, request, write,
    actor: {kind: 'official-account', accountId: session.account.id, endpoint: f.owner.access.endpoint}};
}

function input(data = bytes, overrides = {}) {
  return {attachmentId: randomUUID(), name: 'discussion.txt', mediaType: 'text/plain', size: data.length, sha256: digest(data), ...overrides};
}

async function upload(f, owner, file = input(), data = bytes, {scan = true} = {}) {
  const prepared = await owner.request(root + 'prepare', {input: file});
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const sent = await owner.request(root + file.attachmentId + '/upload', {binary: data});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  if (scan) {
    await f.files.scanPending();
    const current = await owner.request(root + 'read', {input: {attachmentId: file.attachmentId}});
    assert.equal(current.body.state, 'available', JSON.stringify(current.body));
  }
  return file;
}

async function publish(f, owner, file, overrides = {}) {
  const result = await owner.write('create-post', await f.post({attachments: [ref(file)], ...overrides}));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

async function content(f, file, selectedSource, viewer = null) {
  const path = root + file.attachmentId + '/content';
  return viewer ? viewer.raw(path, {input: {source: selectedSource}}) : fetch(f.origin + path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({source: selectedSource}),
  });
}

test('Cookie account without a local ID uploads, scans, publishes and reads with the actual API/worker roles', {timeout: 90000}, async () => {
  const f = await fixture();
  try {
    const subjectsBefore = Number((await f.db.query('SELECT count(*) n FROM subjects')).rows[0].n);
    const owner = await browser(f, 'forum-file-author');
    assert.deepEqual(owner.session.linkedIds, []);
    await f.db.exec(await readFile(new URL('../packages/galaxy-official/src/infrastructure/api-role.sql', import.meta.url), 'utf8'));
    await f.db.exec(await readFile(new URL('../packages/galaxy-official/src/infrastructure/worker-role.sql', import.meta.url), 'utf8'));
    await f.db.exec('SET ROLE galaxy_api');
    const file = await upload(f, owner, input(), bytes, {scan: false});
    const candidate = await f.post({attachments: [ref(file)]});
    const pending = await owner.write('create-post', candidate);
    assert.equal(pending.status, 409);
    assert.equal(pending.body.error, 'attachment_reference_unavailable');
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_attachment_links_v1')).rows[0].n), 0);
    await f.db.exec('RESET ROLE');
    await f.db.exec('SET ROLE galaxy_evidence_worker');
    assert.equal((await f.files.scanPending()).scanned, 1);
    await f.db.exec('RESET ROLE');
    await f.db.exec('SET ROLE galaxy_api');
    const posted = await owner.write('create-post', candidate);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const retried = await owner.request('/v2/community/posts', {input: {payloadJson: posted.payloadJson}});
    assert.equal(retried.status, 200);
    const view = await f.ok('/v2/community/posts/' + posted.payload.postId, {authorization: false});
    assert.equal(view.attachments[0].attachmentId, file.attachmentId);
    assert.equal(view.attachments[0].name, file.name);
    assert.equal(view.attachments[0].state, 'available');
    const downloaded = await content(f, file, source(posted));
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('x-galaxy-content-sha256'), file.sha256);
    assert.equal(downloaded.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    const row = (await f.db.query('SELECT account_id,subject_id FROM forum_attachments_v1 WHERE id=$1', [file.attachmentId])).rows[0];
    assert.equal(row.account_id, owner.session.account.id);
    assert.equal(row.subject_id, null);
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM subjects')).rows[0].n), subjectsBefore);
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_attachment_links_v1')).rows[0].n), 1);
    const quotas = await owner.request('/v2/community/quotas');
    assert.equal(quotas.body.quotas.find(item => item.category === 'post').used, 1);
    for (const sql of ['UPDATE forum_attachments_v1 SET sha256=sha256', 'UPDATE forum_attachments_v1 SET scan_result=NULL', 'DELETE FROM forum_attachment_links_v1']) {
      await assert.rejects(f.db.query(sql), error => error.code === '42501', sql);
    }
    await f.db.exec('RESET ROLE');
    await f.db.exec('SET ROLE galaxy_evidence_worker');
    await assert.rejects(f.db.query('UPDATE forum_attachments_v1 SET account_id=account_id'), error => error.code === '42501');
    await assert.rejects(f.db.query('INSERT INTO forum_attachment_links_v1 SELECT * FROM forum_attachment_links_v1 WHERE false'), error => error.code === '42501');
  } finally {
    await f.db.exec('RESET ROLE');
    await f.close();
  }
});

test('each download follows its exact current source audience; another account and a private-chat reference cannot publish it', {timeout: 90000}, async () => {
  const f = await fixture();
  try {
    const owner = await browser(f, 'restricted-file-owner'), reader = await browser(f, 'restricted-file-reader'), outside = await browser(f, 'restricted-file-outsider');
    const file = await upload(f, owner);
    const audience = {read: {kind: 'selected-accounts', accountIds: [reader.session.account.id]}, participate: {kind: 'selected-accounts', accountIds: [reader.session.account.id]}};
    const restricted = await publish(f, owner, file, {audience});
    assert.equal((await content(f, file, source(restricted))).status, 404);
    assert.equal((await content(f, file, source(restricted), outside)).status, 404);
    const allowed = await content(f, file, source(restricted), reader);
    assert.equal(allowed.status, 200);
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), bytes);
    for (const action of ['read', 'revoke']) {
      assert.equal((await outside.request(root + action, {input: {attachmentId: file.attachmentId}})).status, 404);
    }
    assert.equal((await outside.request(root + file.attachmentId + '/upload', {binary: bytes})).status, 404);
    assert.equal((await outside.write('create-post', await f.post({attachments: [ref(file)]}))).body.error, 'attachment_reference_unavailable');
    const changedTarget = await owner.request(root + 'prepare', {input: input(), headers: {'X-Galaxy-Account-ID': outside.session.account.id}});
    assert.equal(changedTarget.status, 409);
    assert.equal(changedTarget.body.error, 'official_account_changed');
    assert.equal((await owner.request(root + 'prepare', {input: input(), headers: {'X-Galaxy-Account-CSRF': 'invalid'}})).status, 403);
    const unrelated = await owner.write('create-post', await f.post({title: 'A separate public post'}));
    assert.equal(unrelated.status, 200);
    assert.equal((await content(f, file, source(unrelated))).status, 404, 'a public post is not authority to download a restricted post attachment');
    assert.equal((await content(f, file, {postId: unrelated.payload.postId, versionId: restricted.payload.versionId}, reader)).status, 404);
    const widened = await owner.write('publish-version', await f.post({postId: restricted.payload.postId, expectedHeadVersion: 1,
      title: 'New public version without the old file', audience: {read: {kind: 'everyone'}, participate: {kind: 'accounts'}}}));
    assert.equal(widened.status, 200, JSON.stringify(widened.body));
    assert.equal((await content(f, file, source(widened))).status, 404);
    assert.equal((await content(f, file, source(restricted))).status, 404, 'a new public version does not widen an old restricted attachment');

    const chat = await accountChatFixture({identityFixture: {db: f.db, now: () => f.clock.now, chat: f.owner.chat, close: async () => {}}});
    const roomId = randomUUID();
    await chat.chat.create(owner.actor, {roomId, operationId: randomUUID(), title: 'Private source'});
    const privateFile = {...input(), roomId, purpose: 'temporary-room-attachment', confirmed: true};
    await chat.files.prepare(owner.actor, privateFile);
    await chat.files.upload(owner.actor, privateFile.attachmentId, Readable.from([bytes]), {contentLength: bytes.length});
    await chat.files.scanPending();
    await chat.chat.send(owner.actor, roomId, {clientMessageId: randomUUID(), text: 'This file belongs to the conversation.', attachments: [ref(privateFile)]});
    const crossNamespace = await owner.write('create-post', await f.post({attachments: [ref(privateFile)]}));
    assert.equal(crossNamespace.status, 409);
    assert.equal(crossNamespace.body.error, 'attachment_reference_unavailable');
    assert.equal((await content(f, privateFile, source(unrelated))).status, 404);
  } finally { await f.close(); }
});

test('reply parent withdrawal, revocation and expiry stop downloads, and cleanup-queued files cannot be revived by a new post', {timeout: 90000}, async () => {
  const f = await fixture();
  try {
    const owner = await browser(f, 'file-lifecycle-owner');
    const parent = await owner.write('create-post', await f.post());
    assert.equal(parent.status, 200);
    const replyFile = await upload(f, owner);
    const reply = await owner.write('create-reply', await f.reply(parent.payload, {attachments: [ref(replyFile)]}));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal((await content(f, replyFile, {replyId: reply.payload.replyId})).status, 200);
    assert.equal((await content(f, replyFile, source(parent))).status, 404, 'reply bytes are not a parent-post attachment');
    assert.equal((await owner.write('withdraw-post', {schemaVersion: 1, operationId: randomUUID(), postId: parent.payload.postId, expectedHeadVersion: 1})).status, 200);
    assert.equal((await content(f, replyFile, {replyId: reply.payload.replyId})).status, 404);

    // A retained queue mark prevents rebinding, but a parent's withdrawal
    // is not the reply attachment owner's deletion authority.
    await f.db.query('UPDATE forum_attachments_v1 SET purge_pending=true WHERE id=$1', [replyFile.attachmentId]);
    const revived = await owner.write('create-post', await f.post({attachments: [ref(replyFile)]}));
    assert.equal(revived.status, 409);
    assert.equal(revived.body.error, 'attachment_reference_unavailable');
    await f.files.purgeExpired();
    assert.equal(f.contract.objects.has('forum-attachments/' + replyFile.attachmentId), true, 'a queue mark and parent withdrawal do not authorize deleting the reply attachment');
    const retainedReply = (await owner.request(root + 'read', {input: {attachmentId: replyFile.attachmentId}})).body;
    assert.equal(retainedReply.cleanupPending, true);
    assert.equal(retainedReply.objectRemoved, false);
    assert.equal((await content(f, replyFile, {replyId: reply.payload.replyId})).status, 404);
    assert.equal((await owner.request(root + 'revoke', {input: {attachmentId: replyFile.attachmentId}})).status, 200);
    await f.files.purgeExpired();
    assert.equal(f.contract.objects.has('forum-attachments/' + replyFile.attachmentId), false);
    assert.equal((await owner.request(root + 'read', {input: {attachmentId: replyFile.attachmentId}})).body.objectRemoved, true);

    const revokedFile = await upload(f, owner), revokedPost = await publish(f, owner, revokedFile);
    assert.equal((await owner.request(root + 'revoke', {input: {attachmentId: revokedFile.attachmentId}})).status, 200);
    assert.equal((await content(f, revokedFile, source(revokedPost))).status, 404);
    assert.equal((await owner.request(root + revokedFile.attachmentId + '/upload', {binary: bytes})).status, 409);
    await f.files.purgeExpired();
    const sameId = await owner.request(root + 'prepare', {input: revokedFile});
    assert.equal(sameId.status, 200);
    assert.equal(sameId.body.state, 'erased');
    assert.equal((await owner.request(root + revokedFile.attachmentId + '/upload', {binary: bytes})).status, 409);

    const expiredFile = await upload(f, owner), expiredPost = await publish(f, owner, expiredFile, {publishedUntil: f.clock.now + 120});
    f.clock.now += 121;
    assert.equal((await content(f, expiredFile, source(expiredPost))).status, 404);
    await f.files.purgeExpired();
    assert.equal(f.contract.objects.has('forum-attachments/' + expiredFile.attachmentId), true, 'a published attachment expiry stops downloads but requires operational approval or owner revocation for physical deletion');
    assert.equal((await owner.request(root + 'read', {input: {attachmentId: expiredFile.attachmentId}})).body.objectRemoved, false);
    assert.equal((await owner.request(root + 'revoke', {input: {attachmentId: expiredFile.attachmentId}})).status, 200);
    await f.files.purgeExpired();
    assert.equal(f.contract.objects.has('forum-attachments/' + expiredFile.attachmentId), false);
  } finally { await f.close(); }
});

test('a failure after one attachment bind rolls back the post, source links, expiry, receipts and quota; the same operation can recover', {timeout: 90000}, async () => {
  const f = await fixture();
  try {
    const owner = await browser(f, 'file-transaction-owner');
    const first = await upload(f, owner, input(bytes, {attachmentId: '00000000-0000-4000-8000-000000000101'}));
    const second = input(bytes, {attachmentId: 'ffffffff-ffff-4fff-afff-ffffffffffff'});
    const before = (await owner.request(root + 'read', {input: {attachmentId: first.attachmentId}})).body;
    const rejected = await owner.write('create-post', await f.post({attachments: [ref(first), ref(second)]}));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'attachment_reference_unavailable');
    const p = rejected.payload;
    for (const [table, key, id] of [['forum_posts_v1', 'id', p.postId], ['forum_versions_v1', 'id', p.versionId], ['forum_events_v1', 'id', p.operationId], ['forum_write_receipts_v1', 'operation_id', p.operationId]]) {
      assert.equal(Number((await f.db.query(`SELECT count(*) n FROM ${table} WHERE ${key}=$1`, [id])).rows[0].n), 0, table);
    }
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_attachment_links_v1 WHERE attachment_id=$1', [first.attachmentId])).rows[0].n), 0);
    const restored = (await f.db.query('SELECT published_at,expires_at FROM forum_attachments_v1 WHERE id=$1', [first.attachmentId])).rows[0];
    assert.equal(restored.published_at, null);
    assert.equal(new Date(restored.expires_at).getTime(), new Date(before.expiresAt).getTime());
    const quotas = await owner.request('/v2/community/quotas');
    assert.equal(quotas.body.quotas.find(item => item.category === 'post').used, 0);
    await upload(f, owner, second);
    const recovered = await owner.request('/v2/community/posts', {input: {payloadJson: rejected.payloadJson}});
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal((await owner.request('/v2/community/posts', {input: {payloadJson: rejected.payloadJson}})).status, 200);
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_attachment_links_v1 WHERE post_id=$1', [p.postId])).rows[0].n), 2);
    assert.equal(f.contract.objects.size, 2);
  } finally { await f.close(); }
});

test('unknown upload acknowledgement and scanner outage resume the same file without renewal or duplicate reservation; chat and forum share the account quota', {timeout: 90000}, async () => {
  const f = await fixture({policy: {...defaultAttachmentPolicy, maxSubjectBytes: bytes.length * 2, maxGlobalBytes: bytes.length * 20}});
  try {
    const owner = await browser(f, 'file-resume-owner'), file = input();
    assert.equal((await owner.request(root + 'prepare', {input: file})).status, 200);
    assert.equal((await owner.request(root + 'prepare', {input: {...file, name: 'a different request.txt'}})).status, 409);
    const put = f.contract.store.put.bind(f.contract.store);
    let loseAcknowledgement = true, writes = 0;
    f.contract.store.put = async request => {
      await put(request); writes++;
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('synthetic acknowledgement loss'); }
    };
    assert.equal((await owner.request(root + file.attachmentId + '/upload', {binary: bytes})).status, 500);
    const interrupted = (await owner.request(root + 'read', {input: {attachmentId: file.attachmentId}})).body;
    assert.equal(interrupted.uploadRetryable, true);
    assert.equal(interrupted.state, 'uploading');
    assert.equal((await owner.request(root + file.attachmentId + '/upload', {binary: bytes})).status, 200);
    f.contract.outage(true);
    assert.equal((await f.files.scanPending()).scanned, 0);
    assert.equal((await owner.request(root + 'read', {input: {attachmentId: file.attachmentId}})).body.state, 'scan-pending');
    f.contract.outage(false); f.clock.now += 61;
    assert.equal((await f.files.scanPending()).scanned, 1);
    const resumed = (await owner.request(root + 'read', {input: {attachmentId: file.attachmentId}})).body;
    assert.equal(resumed.state, 'available');
    assert.equal(new Date(resumed.expiresAt).getTime(), new Date(interrupted.expiresAt).getTime());
    assert.equal((await owner.request(root + file.attachmentId + '/upload', {binary: bytes})).status, 200);
    assert.equal(writes, 2, 'an available object is not uploaded again');
    assert.equal(f.contract.objects.size, 1);
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_attachments_v1')).rows[0].n), 1);

    const chat = await accountChatFixture({identityFixture: {db: f.db, now: () => f.clock.now, chat: f.owner.chat, close: async () => {}}});
    const roomId = randomUUID();
    await chat.chat.create(owner.actor, {roomId, operationId: randomUUID(), title: 'Account quota source'});
    const chatFile = {...input(), roomId, purpose: 'temporary-room-attachment', confirmed: true};
    await chat.files.prepare(owner.actor, chatFile);
    const overQuota = input(Buffer.from('x'));
    const refused = await owner.request(root + 'prepare', {input: overQuota});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'attachment_storage_quota_exceeded');
    assert.equal(Number((await f.db.query('SELECT count(*) n FROM forum_attachments_v1 WHERE id=$1', [overQuota.attachmentId])).rows[0].n), 0);
    await owner.request(root + 'revoke', {input: {attachmentId: file.attachmentId}});
    await f.files.purgeExpired();
    assert.equal((await owner.request(root + 'prepare', {input: overQuota})).status, 200, 'physical removal releases the reserved bytes');
  } finally { await f.close(); }
});
