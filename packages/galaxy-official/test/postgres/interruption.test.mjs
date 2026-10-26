import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from "../../src/infrastructure/database.mjs";
import { serviceFixture } from '../service-fixture.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function until(check, description, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await pause(); }
  assert.fail(description);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('actual Worker drains HTTPS and recovers killed source/COMMIT work without duplicate facts', { timeout: 90000 }, async t => {
  assert.equal(process.env.GALAXY_TEST_PG_ISOLATED, '1');
  const openssl = process.env.GALAXY_TEST_OPENSSL_BIN;
  assert.ok(openssl && isAbsolute(openssl), 'Absolute OpenSSL executable required');
  const directory = await mkdtemp(join(tmpdir(), 'galaxy-interruption-'));
  const children = [], sockets = new Set(), sources = new Map();
  const admin = new pg.Pool();
  let db, tls;
  try {
    const keyPath = join(directory, 'source.key'), certPath = join(directory, 'source.pem');
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-days', '2',
      '-subj', '/CN=api.github.com', '-addext', 'subjectAltName=DNS:api.github.com',
      '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    tls = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
      const id = Number(request.url.match(/\/runs\/(\d+)\//)?.[1]), source = sources.get(id);
      assert.ok(source, 'Only the explicit synthetic sources may be requested');
      assert.equal(request.headers.authorization, undefined);
      source.requests++; source.response = response;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (source.hold) { response.write('{'); return; }
      response.end(JSON.stringify({ id, run_attempt: 1, head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success',
        updated_at: new Date().toISOString(), repository: { id: 1, full_name: 'fixture/example', private: false,
          owner: { id: 1, login: 'fixture', type: 'Organization' } } }));
    });
    tls.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    tls.on('tlsClientError', () => {});
    await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
    await admin.query('CREATE DATABASE galaxy_integration');
    db = new pg.Pool({ database: 'galaxy_integration', max: 6 });
    await migrate(db, { roles: ['api', 'worker'] });
    const f = await serviceFixture(['binding', 'consent', 'case-teaser', 'evidence'], db,
      { migrateDatabase: false, now: Math.floor(Date.now() / 1000) });
    const enqueue = async (runId, hold) => {
      const parent = { id: randomUUID(), kind: 'case', localRef: 'interrupt_' + runId, title: 'Synthetic interruption',
        summary: 'Fixture only', source: { kind: 'local', reference: 'interrupt_' + runId },
        participants: [{ subjectId: f.actor.subjectId, role: 'requester' }] };
      await f.cases.submit(f.actor, await f.authorize(parent));
      const attempt = { id: randomUUID(), kind: 'attempt', caseId: parent.id, expectedVersion: 1, sequence: 1,
        approach: 'Fixture', configuration: { environment: 'integration', version: '1', tools: [] } };
      await f.cases.submit(f.actor, await f.authorize(attempt));
      const result = { id: randomUUID(), kind: 'result', caseId: parent.id, expectedVersion: 2, attemptId: attempt.id,
        outcome: 'failed', summary: 'Fixture', failureReason: 'Synthetic', limitations: ['Fixture only'] };
      await f.cases.submit(f.actor, await f.authorize(result));
      const evidence = { id: randomUUID(), caseId: parent.id, resultId: result.id,
        source: { provider: 'github-actions', owner: 'fixture', repository: 'example', runId, attempt: 1, commit: 'a'.repeat(40) } };
      const grant = await f.authorize(evidence, 'evidence.submit');
      await f.evidence.submit(f.actor, grant);
      await db.query("UPDATE jobs SET available_at=now()-interval '1 minute' WHERE payload->>'evidenceId'=$1", [evidence.id]);
      const source = { id: evidence.id, consentId: grant.consentId, hold, requests: 0 };
      sources.set(runId, source); return source;
    };
    const job = async source => (await db.query("SELECT id,state,attempts FROM jobs WHERE payload->>'evidenceId'=$1", [source.id])).rows[0];
    const observations = async source => (await db.query('SELECT observation FROM verification_attempts WHERE evidence_id=$1 ORDER BY ordinal', [source.id])).rows;
    const launch = async () => {
      const port = await freePort();
      const url = new URL(`postgresql://${process.env.PGHOST}:${process.env.PGPORT}/galaxy_integration`);
      url.username = process.env.PGUSER; url.password = process.env.PGPASSWORD;
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GALAXY_') && name !== 'DATABASE_URL' && name !== 'NODE_OPTIONS'));
      Object.assign(env, { DATABASE_URL: url.href, GALAXY_ENVIRONMENT: 'integration', GALAXY_ENDPOINT: f.bindings.endpoint,
        PGOPTIONS: '-c role=galaxy_evidence_worker', GALAXY_METRICS_PORT: String(port), GALAXY_SEARCH_INDEX_ENABLED: 'true',
        GALAXY_TEST_PG_ISOLATED: '1', GALAXY_TEST_SOURCE_PORT: String(tls.address().port), GALAXY_TEST_SOURCE_CA: certPath });
      const child = spawn(process.execPath, ['--import', new URL('./interruption-channel.mjs', import.meta.url).href,
        fileURLToPath(new URL('../../src/worker.mjs', import.meta.url))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child); child.stderr.resume(); child.drain = null; child.stopSeen = false;
      let lines = '';
      child.stdout.on('data', data => {
        lines += data.toString(); const split = lines.split('\n'); lines = split.pop();
        for (const line of split) { try { const event = JSON.parse(line); if (event.event === 'fixture-drain') child.drain = event; } catch {} }
      });
      child.on('message', message => { if (message?.event === 'fixture-stop-seen') child.stopSeen = true; });
      child.result = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      await until(async () => {
        assert.equal(child.exitCode, null, 'Worker startup failed');
        try { const res = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(250) }); await res.arrayBuffer(); return res.status === 200; }
        catch { return false; }
      }, 'Worker metrics listener did not start');
      return child;
    };
    const signalStop = async child => {
      if (process.platform === 'win32') child.send('stop-fixture'); else child.kill('SIGTERM');
      await until(() => child.stopSeen, 'Stop signal was not observed');
    };
    const stopped = async child => {
      assert.equal((await child.result).code, 0);
      assert.deepEqual(child.drain?.afterStopCalls, [], 'Stopping Worker claimed work from another queue');
    };
    const recover = async source => {
      // Accelerate only the synthetic lease clock, not the production lease rule.
      await db.query("UPDATE jobs SET available_at=now()-interval '1 minute',locked_until=now()-interval '1 minute' WHERE payload->>'evidenceId'=$1 AND state IN ('running','pending')", [source.id]);
      const child = await launch();
      await until(async () => (await job(source)).state === 'completed', 'Recovered job did not complete');
      await signalStop(child); await stopped(child);
    };
    await t.test('SIGTERM during an HTTPS body drains the current observation and leaves the next job untouched', async () => {
      const first = await enqueue(101, true), second = await enqueue(102, false);
      await db.query("UPDATE jobs SET available_at=now()-interval '2 minutes' WHERE payload->>'evidenceId'=$1", [first.id]);
      const child = await launch();
      await until(() => first.requests === 1, 'Worker did not reach the HTTPS stream');
      await signalStop(child); first.response.destroy(); await stopped(child);
      assert.equal((await job(first)).state, 'pending'); assert.equal((await job(first)).attempts, 1);
      assert.equal((await observations(first))[0].observation.status, 'unavailable');
      assert.equal((await job(second)).attempts, 0); assert.equal(second.requests, 0);
      first.hold = false;
      await recover(first);
      assert.equal((await observations(first)).length, 2);
      assert.equal((await observations(first))[1].observation.status, 'observed');
      // Complete the second fixture before the next scenario, regardless of scheduling.
      await recover(second);
      assert.equal((await observations(second)).length, 1);
    });
    await t.test('forced death during HTTPS leaves a lease; revocation blocks the restarted source read', async () => {
      const source = await enqueue(103, true), child = await launch();
      await until(() => source.requests === 1, 'Worker did not enter the source request');
      child.kill('SIGKILL'); await child.result; source.response.destroy();
      assert.equal((await job(source)).state, 'running'); assert.equal((await observations(source)).length, 0);
      await f.consents.revoke(f.actor, source.consentId);
      await recover(source);
      assert.equal((await observations(source)).length, 1);
      assert.equal((await observations(source))[0].observation.status, 'revoked');
      assert.equal(source.requests, 1, 'Restart fetched a revoked source');
    });
    await t.test('forced death while PostgreSQL executes COMMIT is reconciled before retry', async () => {
      const source = await enqueue(104, false), lock = await db.connect();
      const lockId = 734912399;
      try {
        await lock.query('SELECT pg_advisory_lock($1)', [lockId]);
        await db.query(`CREATE FUNCTION fixture_commit_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.evidence_id = '${source.id}'::uuid THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$;
          CREATE CONSTRAINT TRIGGER fixture_commit_barrier AFTER INSERT ON verification_attempts
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_commit_barrier()`);
        const child = await launch(); let backend;
        await until(async () => {
          backend = (await db.query("SELECT pid FROM pg_stat_activity WHERE datname='galaxy_integration' AND application_name='galaxy-official' AND query='COMMIT' AND wait_event_type='Lock'")).rows[0];
          return !!backend;
        }, 'Worker did not reach a deferred trigger inside COMMIT');
        child.kill('SIGKILL'); await child.result;
        await lock.query('SELECT pg_advisory_unlock($1)', [lockId]);
        await until(async () => !(await db.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [backend.pid])).rows.length, 'Killed Worker backend did not settle');
        const count = (await observations(source)).length;
        assert.ok(count === 0 || count === 1, 'COMMIT must leave an atomic result');
        assert.equal((await job(source)).state, count ? 'completed' : 'running');
        await db.query('DROP TRIGGER fixture_commit_barrier ON verification_attempts; DROP FUNCTION fixture_commit_barrier()');
        await recover(source);
        assert.equal((await observations(source)).length, 1);
        assert.equal((await observations(source))[0].observation.status, 'observed');
        assert.equal(Number((await db.query("SELECT count(*) FROM audit_events WHERE object_id=$1 AND action='evidence.observe'", [source.id])).rows[0].count), 1);
        console.log(JSON.stringify({ event: 'forced_commit_reconciled', committedBeforeRestart: count === 1, observationsAfterRestart: 1 }));
      } finally {
        await lock.query('SELECT pg_advisory_unlock($1)', [lockId]); lock.release();
        await db.query('DROP TRIGGER IF EXISTS fixture_commit_barrier ON verification_attempts; DROP FUNCTION IF EXISTS fixture_commit_barrier()');
      }
    });
    assert.equal(Number((await db.query('SELECT count(*) FROM proofs')).rows[0].count), 0);
    assert.equal(Number((await db.query("SELECT count(*) FROM pg_stat_activity WHERE datname='galaxy_integration' AND application_name='galaxy-official'")).rows[0].count), 0);
    console.log(JSON.stringify({ event: 'worker_interruption_verified', platform: process.platform,
      gracefulSignal: process.platform === 'win32' ? 'test IPC invokes SIGTERM handler' : 'OS SIGTERM', forcedSignal: 'SIGKILL',
      source: 'real TLS sockets with test-only local routing; no GitHub request', scenarios: 3, duplicateObservations: 0 }));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map(child => child.result));
    for (const socket of sockets) socket.destroy();
    if (tls?.listening) await new Promise(resolve => tls.close(resolve));
    if (db) await db.end(); await admin.end();
    const path = relative(tmpdir(), directory); assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
    await rm(directory, { recursive: true, force: true });
  }
});
