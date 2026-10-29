import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// A2A accepts only its caller-selected journal directory. Never select a
// default Native profile or open identity and work-history files here.
function journalDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Explicit A2A data directory required.');
  return resolve(directory);
}

export const COORDINATION_FILE = '.galaxy-coordination.sqlite';
const writers = new Map();

// SQLite supplies native cross-process locks, released by the OS on termination.
// No identity, key, Case or other user data is stored in this coordination file.
// Never unlink it while clients may be using it: that could split the lock domain.
export async function withJournalWrite(dataDirectory, operation) {
  const path = journalDirectory(dataDirectory);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const previous = writers.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeWithNativeLock(path, operation));
  writers.set(key, pending);
  try { return await pending; }
  finally { if (writers.get(key) === pending) writers.delete(key); }
}

async function writeWithNativeLock(dataDirectory, operation) {
  const requested = journalDirectory(dataDirectory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const directory = await realpath(requested);
  try {
    await stat(join(directory, '.galaxy-write.lock'));
    throw new Error('Legacy Galaxy write lock exists; stop old clients and review it before upgrading.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const path = join(directory, COORDINATION_FILE);
  const file = await open(path, 'a', 0o600);
  await file.close();
  return nativeLock(path, false, () => operation(directory));
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function withJournalRead(dataDirectory, operation) {
  const directory = journalDirectory(dataDirectory);
  const path = join(directory, COORDINATION_FILE);
  // No mkdir, create or migration on the read path. If the first writer creates
  // coordination during our read, discard that read and retry under its lock.
  for (;;) {
    if (await exists(path)) return nativeLock(path, true, () => operation(directory));
    const result = await operation(directory);
    if (!(await exists(path))) return result;
  }
}

async function nativeLock(path, readOnly, operation) {
  const createDatabase = process.versions.bun
    ? await import('bun:sqlite').then(({ Database }) => readOnly => new Database(path, { readonly: readOnly, create: !readOnly }))
    : await import('node:sqlite').then(({ DatabaseSync }) => readOnly => new DatabaseSync(path, { readOnly }));
  const deadline = Date.now() + 10000;
  for (;;) {
    let db;
    let acquired = false;
    try {
      db = createDatabase(readOnly);
      db.exec('PRAGMA busy_timeout=0');
      db.exec(readOnly ? 'BEGIN; SELECT count(*) FROM sqlite_schema' : 'BEGIN EXCLUSIVE');
      acquired = true;
      return await operation();
    } catch (error) {
      if (acquired || (error.errcode !== 5 && error.errcode !== 6 && !['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code))) throw error;
      if (Date.now() >= deadline) throw new Error('Local Galaxy storage is busy.');
    } finally {
      // Closing also rolls back any partially begun transaction on acquisition
      // failure. Operation failures are never retried or reported as committed.
      if (db) db.close();
    }
    await delay(25);
  }
}
