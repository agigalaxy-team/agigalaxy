import { DatabaseSync } from 'node:sqlite';
import { open, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { failureActorSchema,failureActor } from '../shared/http-failure-context.mjs';

const eventSchema = z.object({
  requestId: z.uuid(), status: z.number().int().min(400).max(599),
  route: z.string().max(100).regex(/^(http\.(request|parser)|(?:GET|POST) \/[a-z0-9/.:_-]+)$/),
  actor: failureActorSchema.nullable(),
  observedAt: z.iso.datetime(),
}).strict();

// Durable local outbox; SQLite FULL commits precede the HTTP acknowledgement.
// Delivery is at least once; the PostgreSQL request/action index deduplicates it.
export async function createFailureAuditSpool({ path, endpoint, write, maxEvents = 10000, intervalMs = 1000,
  batchSize = 32, logger = () => {} }) {
  if (!isAbsolute(path) || typeof write !== 'function' || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10000
    || !Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60000
    || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Invalid audit spool configuration.');
  try { const file = await open(path, 'wx', 0o600); await file.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077)))
    throw new Error('Invalid audit spool file.');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192; PRAGMA wal_autocheckpoint=128;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2].includes(version)) throw new Error('Unsupported audit spool version.');
    db.exec('CREATE TABLE IF NOT EXISTS metadata(endpoint TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS pending(request_id TEXT PRIMARY KEY,event_json TEXT NOT NULL);');
    const previous = db.prepare('SELECT endpoint FROM metadata').all();
    if (previous.length && (previous.length !== 1 || previous[0].endpoint !== endpoint)) throw new Error('Audit spool endpoint mismatch.');
    if (!previous.length) db.prepare('INSERT INTO metadata(endpoint) VALUES (?)').run(endpoint);
    db.exec('PRAGMA user_version=2;');
  } catch (error) { db.close(); throw error; }
  let active = null, closed = false, storageAvailable = true, delivery = 'idle';
  const count = () => db.prepare('SELECT count(*) AS count FROM pending').get().count;
  const log = event => { try { logger(event); } catch { /* Logging is not delivery. */ } };
  const status = () => {
    if (closed) return { ready: false, closed: true, pending: null, delivery };
    try { const pending = count(); return { ready: storageAvailable && pending < maxEvents, pending, delivery }; }
    catch(error) { storageAvailable = false;log({event:'failure_audit_spool_failed',stage:'audit-spool-status',error});return { ready: false, pending: null, delivery }; }
  };
  const flush = () => {
    if (closed) return Promise.resolve();
    if (active) return active;
    active = (async () => {
      let rows;
      try { rows = db.prepare('SELECT request_id,event_json FROM pending ORDER BY rowid LIMIT ?').all(batchSize); }
      catch(error) { storageAvailable = false;log({event:'failure_audit_spool_failed',stage:'audit-spool-read',error});return; }
      for (const row of rows) {
        const startedAt=performance.now();
        try {
          const event = eventSchema.parse(JSON.parse(row.event_json));
          const result=await write(event);
          db.prepare('DELETE FROM pending WHERE request_id=? AND event_json=?').run(row.request_id, row.event_json);
          storageAvailable = true; delivery = result?.state==='suppressed-by-deletion'?'suppressed-by-deletion':'recorded';
        } catch(error) { delivery = 'retry-pending';log({event:'failure_audit_delivery',stage:'audit-delivery',requestId:row.request_id,delivery,startedAt,error});break; }
      }
      if (rows.length) log({ event: 'failure_audit_delivery', delivery, pending: status().pending });
    })().finally(() => { active = null; });
    return active;
  };
  const record = async input => {
    if (closed) return 'closed';
    try {
      // Select fields even if an internal caller passes a complete request.
      const event = eventSchema.parse({ requestId: input.requestId, status: input.status, route: input.route,
        actor: failureActor(input.actor),
        observedAt: input.observedAt ?? new Date().toISOString() });
      const json = JSON.stringify(event);
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db.prepare('SELECT event_json FROM pending WHERE request_id=?').get(event.requestId);
        if (prior && prior.event_json !== json) throw new Error('Conflicting audit event.');
        if (!prior && count() >= maxEvents) { db.exec('ROLLBACK'); return 'capacity'; }
        if (!prior) db.prepare('INSERT INTO pending(request_id,event_json) VALUES (?,?)').run(event.requestId, json);
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve queue failure. */ } throw error; }
      storageAvailable = true;
      void flush();
      return 'queued';
    } catch(error) { storageAvailable = false; log({event:'failure_audit_spool_failed',stage:'audit-spool-record',requestId:input?.requestId,error}); return 'failed'; }
  };
  const timer = setInterval(() => { void flush(); }, intervalMs);
  timer.unref();
  // Replay records retained by a terminated previous process.
  void flush();
  return { record, flush, status, async close() {
    if (closed) return;
    closed = true; clearInterval(timer);
    if (active) await active;
    db.close();
  } };
}
