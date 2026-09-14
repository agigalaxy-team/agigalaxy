import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { serviceFixture } from './service-fixture.mjs';
import { createFailureAuditSpool } from '../src/infrastructure/failure-audit-spool.mjs';
import { httpFailureWriter } from '../src/infrastructure/http-failure-audit.mjs';

export async function verifyFailureSpool(database = null, options = {}) {
  const f = await serviceFixture(undefined, database, options);
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-failure-spool-'));
  const path = join(directory, 'queue.sqlite'), endpoint = f.bindings.endpoint;
  const event = { requestId: randomUUID(), status: 500, route: 'POST /v1/cases', actor: {subjectId:f.actor.subjectId,bindingId:f.actor.bindingId},
    observedAt: new Date(f.now * 1000).toISOString(), body: 'private-body-never-store', token: f.credential };
  const writer = httpFailureWriter(f.db, endpoint);
  let spool, peer;
  try {
    spool = await createFailureAuditSpool({ path, endpoint, maxEvents: 1, intervalMs: 60000,
      write: async () => { throw new Error('database unavailable'); } });
    assert.equal(await spool.record(event), 'queued'); await spool.flush();
    assert.equal(spool.status().pending, 1);
    assert.equal(spool.status().ready, false);
    assert.equal(await spool.record({ ...event, requestId: randomUUID() }), 'capacity');
    const store = new DatabaseSync(path, { readOnly: true });
    const saved = store.prepare('SELECT event_json FROM pending').get().event_json;
    store.close();
    for (const secret of ['private-body-never-store', f.credential, f.actor.credentialHash]) assert.ok(!saved.includes(secret));
    await spool.close();
    // Insert succeeds, but delivery acknowledgement is lost before queue delete.
    spool = await createFailureAuditSpool({ path, endpoint, intervalMs: 60000, write: async value => {
      await writer(value); throw new Error('lost commit acknowledgement');
    } });
    await spool.flush(); assert.equal(spool.status().pending, 1); await spool.close();
    // Two independent delivery instances replay the persisted event concurrently.
    spool = await createFailureAuditSpool({ path, endpoint, write: writer, intervalMs: 60000 });
    peer = await createFailureAuditSpool({ path, endpoint, write: writer, intervalMs: 60000 });
    await Promise.all([spool.flush(), peer.flush()]);
    assert.equal(spool.status().pending, 0);
    const rows = (await f.db.query('SELECT * FROM audit_events WHERE http_request_id=$1', [event.requestId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, f.actor.subjectId);
    assert.equal(rows[0].caller_binding_id, f.actor.bindingId);
    assert.equal(new Date(rows[0].created_at).toISOString(), event.observedAt);
    assert.equal(rows[0].credential_scopes, null);
    assert.equal(spool.status().ready, true);
    await assert.rejects(createFailureAuditSpool({ path, endpoint: 'https://other.example', write: writer }), /endpoint mismatch/);
  } finally {
    if (peer) await peer.close(); if (spool) await spool.close();
    await rm(directory, { recursive: true, force: true });
    if (!database) await f.db.close();
  }
}
