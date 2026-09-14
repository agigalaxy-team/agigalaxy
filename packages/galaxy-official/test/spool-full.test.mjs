import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFailureAuditSpool } from '../src/infrastructure/failure-audit-spool.mjs';
import { createApi } from '../src/http.mjs';

test('actual bounded SQLite FULL hides readiness, preserves pending records and recovers after delivery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-spool-full-')), path = join(directory, 'queue.sqlite');
  let connection, spool, api, writerAvailable = false;
  // oxlint-disable-next-line typescript/unbound-method -- forwarded with the original database receiver below.
  const exec = DatabaseSync.prototype.exec, delivered = [], logs = [];
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql) {
    if (sql.includes('PRAGMA max_page_count=8192')) connection = this;
    return exec.call(this, sql);
  });
  try {
    spool = await createFailureAuditSpool({ path, endpoint: 'https://official.example.org', maxEvents: 1000, intervalMs: 60000,
      logger: value => logs.push(value), write: async event => { if (!writerAvailable) throw new Error('Synthetic backend unavailable'); delivered.push(event.requestId); } });
    assert.ok(connection);await spool.flush();
    const pages = connection.prepare('PRAGMA page_count').get().page_count;
    connection.exec('PRAGMA max_page_count=' + String(pages));
    const accepted = [];
    for (let index = 0; index < 200; index++) {
      const event = { requestId: randomUUID(), status: 500, route: 'POST /v1/cases', actor: null,
        observedAt: new Date().toISOString(), body: 'synthetic-private-message', token: 'synthetic-token' };
      const state = await spool.record(event);
      if (state === 'failed') break;
      assert.equal(state, 'queued');accepted.push(event.requestId);
    }
    assert.ok(accepted.length > 0 && accepted.length < 200);
    assert.equal(spool.status().ready, false);assert.equal(spool.status().pending, accepted.length);
    assert.throws(() => connection.exec('CREATE TABLE fixture_space_probe AS SELECT zeroblob(65536) AS bytes'), error => error.errcode === 13);
    api = createApi({ bindings: { endpoint: 'https://official.example.org' }, readiness: () => spool.status().ready });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + api.address().port;
    assert.equal((await fetch(origin + '/readyz')).status, 503);assert.equal((await fetch(origin + '/healthz')).status, 200);
    const pending = connection.prepare('SELECT event_json FROM pending').all();
    assert.ok(!JSON.stringify({ pending, logs }).includes('synthetic-private-message'));
    assert.ok(!JSON.stringify({ pending, logs }).includes('synthetic-token'));
    connection.exec('PRAGMA max_page_count=8192');writerAvailable = true;await spool.flush();
    assert.deepEqual(delivered.sort((a, b) => a.localeCompare(b)), accepted.sort((a, b) => a.localeCompare(b)));
    assert.equal(spool.status().pending, 0);assert.equal((await fetch(origin + '/readyz')).status, 200);
    console.log(JSON.stringify({ event: 'sqlite_full_recovery', sqliteErrorCode: 13, boundedPages: pages, retainedEvents: accepted.length,
      unavailableReadiness: 503, recoveredReadiness: 200, physicalDiskFilled: false, actualSqliteFull: true, privatePayloadsAbsent: true }));
  } finally {
    if (api) { api.closeAllConnections();await new Promise(resolve => api.close(resolve)); }
    if (spool) await spool.close();t.mock.restoreAll();await rm(directory, { recursive: true, force: true });
  }
});
