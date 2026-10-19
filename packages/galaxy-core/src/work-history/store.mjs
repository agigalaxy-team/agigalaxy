import {mkdir, chmod, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {withLocalRead, withLocalWrite} from '../storage/write-lock.mjs';
import {localPaths, readJson} from '../storage/files.mjs';

const ddl = `
CREATE TABLE IF NOT EXISTS work_capture_scopes (
 host TEXT NOT NULL, session_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 started_at TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(host,session_id));
CREATE TABLE IF NOT EXISTS work_sessions (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL,
 started_at TEXT NOT NULL, updated_at TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', last_sequence INTEGER NOT NULL DEFAULT 0,
 UNIQUE(owner_id,host,session_id));
CREATE TABLE IF NOT EXISTS work_environments (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL,
 version INTEGER NOT NULL, observed_at TEXT NOT NULL, facts_json TEXT NOT NULL, exclusions_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(owner_id,host,session_id,version));
CREATE TABLE IF NOT EXISTS work_observations (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, work_id TEXT NOT NULL,
 source_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, occurred_at TEXT, observed_at TEXT NOT NULL,
 source_json TEXT NOT NULL, content_json TEXT, details_json TEXT NOT NULL, environment_id TEXT, exclusions_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(work_id,source_id,revision));
CREATE INDEX IF NOT EXISTS work_observation_sources ON work_observations(work_id,source_id,revision);
CREATE TABLE IF NOT EXISTS work_summaries (
 work_id TEXT NOT NULL, revision INTEGER NOT NULL, through_sequence INTEGER NOT NULL, created_at TEXT NOT NULL,
 title TEXT NOT NULL, summary TEXT NOT NULL, outcome TEXT NOT NULL, model TEXT, sources_json TEXT NOT NULL, execution_json TEXT, exclusions_json TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(work_id,revision));
CREATE TABLE IF NOT EXISTS work_summary_state (
 work_id TEXT PRIMARY KEY, state TEXT NOT NULL, code TEXT, updated_at TEXT NOT NULL);`;

export const workError = code => Object.assign(new Error(code), {code});
const exists = async path => {try {await stat(path); return true;} catch (e) {if (e.code === 'ENOENT') return false; throw e;}};

export function createWorkStore({dataDirectory, getIdentity}) {
  async function identity(directory, requested) {
    const paths = localPaths(directory);
    if (await exists(paths.initializationJournal) || await exists(paths.resetJournal)) throw workError('local_work_identity_recovery_required');
    const current = getIdentity ? await getIdentity(directory) : await readJson(paths.identity, null) ?? await readJson(paths.legacyIdentity, null);
    const id = typeof current === 'string' ? current : current?.id ?? current?.subjectId;
    if (requested && requested !== id) throw workError('local_work_identity_changed');
    return id ? {id,...(typeof current?.createdAt==='string'?{createdAt:current.createdAt}:{})} : null;
  }
  async function access(write, requested, operation) {
    return (write ? withLocalWrite : withLocalRead)(dataDirectory, async directory => {
      const currentIdentity = await identity(directory, requested),ownerId=currentIdentity?.id;
      if (!ownerId) {if (write) throw workError('local_work_identity_required'); return operation(null, null);}
      const folder = join(directory, 'work-history'), path = join(folder, 'history.sqlite');
      if (!write && !(await exists(path))) return operation(null, ownerId, currentIdentity);
      if (write) await mkdir(folder, {recursive: true, mode: 0o700});
      const db = process.versions.bun
        ? new (await import('bun:sqlite')).Database(path, {readonly: !write, create: write})
        : new (await import('node:sqlite')).DatabaseSync(path, {readOnly: !write});
      try {
        if (write) {
          await chmod(path, 0o600); db.exec(ddl);
          for (const table of ['work_environments', 'work_observations', 'work_summaries']) {
            if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'exclusions_json'))
              db.exec(`ALTER TABLE ${table} ADD COLUMN exclusions_json TEXT NOT NULL DEFAULT '[]'`);
          }
          db.exec('BEGIN IMMEDIATE');
        }
        const value = await operation(db, ownerId, currentIdentity);
        if (write) db.exec('COMMIT');
        return value;
      } catch (error) {if (write) {try {db.exec('ROLLBACK');} catch { /* no active transaction */ }} throw error;}
      finally {db.close();}
    });
  }
  return {read: (owner, operation) => access(false, owner, operation), write: (owner, operation) => access(true, owner, operation)};
}
