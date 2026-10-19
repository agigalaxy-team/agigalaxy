import {randomUUID} from 'node:crypto';
import {mkdir,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import * as z from 'zod/v4';
import {withLocalRead,withLocalWrite} from '../storage/write-lock.mjs';
import {localPaths,readJson} from '../storage/files.mjs';
import {redactLocalWorkData} from '../local-data-redaction.mjs';

const id = z.string().min(1).max(512);
const owner = {galaxyId: id.optional()};
export const archiveSettingsInputSchema = z.strictObject({...owner, enabled: z.boolean(),
  sessions: z.array(z.strictObject({host: id, sessionId: id})).max(500),
  autoCleanAfterDays: z.number().int().min(1).max(36500).nullable().default(null)});
export const archiveListInputSchema = z.strictObject({...owner, limit: z.number().int().min(1).max(100).default(30), after: z.string().max(200).optional()});
export const archiveExportInputSchema = z.strictObject({...owner, archiveSessionId: z.uuid(), afterSequence: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20)});
export const archiveDeleteInputSchema = z.strictObject({...owner, archiveSessionId: z.uuid()});
const archiveSnapshotInputSchema = archiveDeleteInputSchema.extend({afterSequence:z.number().int().nonnegative().default(0)});
export const archiveCleanupInputSchema = z.strictObject(owner);
const failure = code => Object.assign(new Error(code), {code});
const exists = async path => {try {await stat(path);return true;} catch (error) {if (error.code === 'ENOENT') return false;throw error;}};
const parse = (schema, input) => {const parsed = schema.safeParse(input);if (!parsed.success) throw failure('local_archive_input_invalid');return parsed.data;};
const defaults = () => ({enabled: false, sessions: [], autoCleanAfterDays: null});
const ddl = `
CREATE TABLE IF NOT EXISTS archive_preferences(owner_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archive_sessions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, workspace_id TEXT,revision INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id,host,session_id));
CREATE TABLE IF NOT EXISTS archive_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
 captured_at TEXT NOT NULL, body_json TEXT NOT NULL, UNIQUE(session_id,message_id));`;

/** @typedef {string | {id?: string, subjectId?: string} | null | undefined} LocalArchiveIdentity */

/** Private local originals, explicitly selected at the host. This module never
 * fetches attachments, supplies a model, or transfers anything to a service.
 * The identity reader runs inside the existing local coordination lock and
 * must read that directory directly rather than acquire another lock.
 * @param {{dataDirectory?: string, getIdentity?: (directory: string) => LocalArchiveIdentity | Promise<LocalArchiveIdentity>, now?: () => string}} [options]
 */
export function createLocalConversationArchive({dataDirectory,getIdentity,now = () => new Date().toISOString()} = {}) {
  async function access(write, requested, operation) {
    return (write ? withLocalWrite : withLocalRead)(dataDirectory, async directory => {
      const paths = localPaths(directory);
      if (await exists(paths.initializationJournal) || await exists(paths.resetJournal)) throw failure('local_archive_identity_recovery_required');
      const identity = getIdentity ? await getIdentity(directory) : await readJson(paths.identity,null) ?? await readJson(paths.legacyIdentity,null);
      const ownerId = typeof identity === 'string' ? identity : identity?.id ?? identity?.subjectId;
      if (requested && requested !== ownerId) throw failure('local_archive_identity_changed');
      if (!ownerId) {if (write) throw failure('local_archive_identity_required');return operation(null,null);}
      const folder = join(directory,'conversation-archive'), file = join(folder,'private.sqlite');
      if (!write && !(await exists(file))) return operation(null,ownerId);
      if (write) await mkdir(folder,{recursive:true,mode:0o700});
      const db = process.versions.bun ? new (await import('bun:sqlite')).Database(file,{readonly:!write,create:write})
        : new (await import('node:sqlite')).DatabaseSync(file,{readOnly:!write});
      try {
        if (write) {await chmod(file,0o600);db.exec(ddl);
          const columns=db.prepare('PRAGMA table_info(archive_sessions)').all().map(column=>column.name);
          if(!columns.includes('revision'))db.exec('ALTER TABLE archive_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
          if(!columns.includes('workspace_id'))db.exec('ALTER TABLE archive_sessions ADD COLUMN workspace_id TEXT');
          db.exec('BEGIN IMMEDIATE');}
        const result = await operation(db,ownerId);
        if (write) db.exec('COMMIT');
        return result;
      } catch (error) {if (write) {try {db.exec('ROLLBACK');} catch { /* transaction did not begin */ }}throw error;}
      finally {db.close();}
    });
  }
  const preferences = (db,ownerId) => db ? JSON.parse(db.prepare('SELECT settings_json FROM archive_preferences WHERE owner_id=?').get(ownerId)?.settings_json || 'null') ?? defaults() : defaults();
  function cleanupWithin(db, ownerId, settings) {
    if (!settings.autoCleanAfterDays) return 0;
    const cutoff = new Date(Date.parse(now()) - settings.autoCleanAfterDays * 86400000).toISOString();
    return Number(db.prepare('DELETE FROM archive_messages WHERE session_id IN (SELECT id FROM archive_sessions WHERE owner_id=?) AND captured_at<?').run(ownerId,cutoff).changes);
  }
  const view = row => ({archiveSessionId:row.id, host:row.host, sessionId:row.session_id, createdAt:row.created_at, updatedAt:row.updated_at,
    workspaceId:row.workspace_id??null,revision:row.revision??0,messageCount:row.message_count ?? 0, coverage:'captured-host-messages-only', localOnly:true});
  const messageView=m=>{
    const stored=JSON.parse(m.body_json),safe=redactLocalWorkData({message:stored.message,parts:stored.parts});
    return {sequence:m.sequence,messageId:m.message_id,capturedAt:m.captured_at,...safe.value,exclusions:[...(stored.exclusions??[]),...safe.exclusions]};
  };
  async function settings() {return access(false,undefined,(db,galaxyId) => ({galaxyId,settings:preferences(db,galaxyId),localOnly:true,uploadStarted:false}));}
  async function configure(input) {
    const x = parse(archiveSettingsInputSchema,input);
    return access(true,x.galaxyId,(db,galaxyId) => {
      const sessions = [...new Map(x.sessions.map(s => [JSON.stringify([s.host,s.sessionId]),s])).values()];
      if (x.enabled && sessions.length === 0) throw failure('local_archive_session_scope_required');
      const selected = {enabled:x.enabled,sessions,autoCleanAfterDays:x.autoCleanAfterDays};
      db.prepare('INSERT INTO archive_preferences(owner_id,settings_json) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET settings_json=excluded.settings_json').run(galaxyId,JSON.stringify(selected));
      for (const session of sessions) db.prepare('INSERT OR IGNORE INTO archive_sessions(id,owner_id,host,session_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),galaxyId,session.host,session.sessionId,now(),now());
      const deletedMessages = cleanupWithin(db,galaxyId,selected);
      return {galaxyId,settings:selected,deletedMessages,uploadStarted:false,localOnly:true};
    });
  }
  async function captureMessage({galaxyId,host,sessionId,messageId,message,parts,workspaceId} = {}) {
    if (![host,sessionId,messageId].every(value => typeof value === 'string' && value && value.length <= 512)) throw failure('local_archive_capture_invalid');
    if(workspaceId!==undefined&&(typeof workspaceId!=='string'||!workspaceId||workspaceId.length>512))throw failure('local_archive_workspace_invalid');
    // Check the explicit choice before materializing full message JSON.
    const selected = await access(false,galaxyId,(db,ownerId) => {
      const p = preferences(db,ownerId);return {ownerId,autoCleanAfterDays:p.autoCleanAfterDays,selected:p.enabled && p.sessions.some(s => s.host === host && s.sessionId === sessionId)};
    });
    if (!selected.selected) return {captured:false,reason:'not-selected'};
    const sourceTime=message?.time?.updated??message?.time?.created??message?.updatedAt??message?.createdAt;
    const sourceMs=typeof sourceTime==='number'?sourceTime<1e12?sourceTime*1000:sourceTime:typeof sourceTime==='string'?Date.parse(sourceTime):NaN;
    if(selected.autoCleanAfterDays&&Number.isFinite(sourceMs)&&sourceMs<Date.parse(now())-selected.autoCleanAfterDays*86400000)
      return {captured:false,reason:'outside-selected-retention',sourcePreservedInHost:true};
    const sanitized=redactLocalWorkData({message,parts});
    const body = JSON.stringify({...sanitized.value,exclusions:sanitized.exclusions});
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) return {captured:false,reason:'message-too-large',sourcePreservedInHost:true};
    return access(true,selected.ownerId,(db,ownerId) => {
      const p = preferences(db,ownerId);
      if (!p.enabled || !p.sessions.some(s => s.host === host && s.sessionId === sessionId)) return {captured:false,reason:'not-selected'};
      cleanupWithin(db,ownerId,p);
      const session = db.prepare('SELECT id,workspace_id FROM archive_sessions WHERE owner_id=? AND host=? AND session_id=?').get(ownerId,host,sessionId);
      if (!session) throw failure('local_archive_session_unavailable');
      const old = db.prepare('SELECT body_json FROM archive_messages WHERE session_id=? AND message_id=?').get(session.id,messageId);
      if (old?.body_json === body&&(!workspaceId||workspaceId===session.workspace_id)) return {captured:true,duplicate:true,archiveSessionId:session.id};
      db.prepare('INSERT INTO archive_messages(session_id,message_id,captured_at,body_json) VALUES(?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET captured_at=excluded.captured_at,body_json=excluded.body_json').run(session.id,messageId,now(),body);
      db.prepare('UPDATE archive_sessions SET updated_at=?,workspace_id=COALESCE(?,workspace_id),revision=revision+1 WHERE id=?').run(now(),workspaceId??null,session.id);
      return {captured:true,archiveSessionId:session.id,sourceKind:'host-original-with-exclusions',exclusions:sanitized.exclusions,localOnly:true};
    });
  }
  async function list(input = {}) {
    const x = parse(archiveListInputSchema,input);
    return access(false,x.galaxyId,(db,galaxyId) => {
      if (!db) return {galaxyId,items:[],nextAfter:null};
      const [afterTime,afterId] = x.after ? x.after.split('|') : [];
      if (x.after && (!afterTime || !afterId)) throw failure('local_archive_cursor_invalid');
      const rows = db.prepare('SELECT s.*, (SELECT count(*) FROM archive_messages m WHERE m.session_id=s.id) message_count FROM archive_sessions s WHERE owner_id=? AND (? IS NULL OR updated_at<? OR (updated_at=? AND id>?)) ORDER BY updated_at DESC,id LIMIT ?').all(galaxyId,afterTime ?? null,afterTime ?? null,afterTime ?? null,afterId ?? null,x.limit+1);
      return {galaxyId,items:rows.slice(0,x.limit).map(view),nextAfter:rows.length>x.limit?rows[x.limit-1].updated_at+'|'+rows[x.limit-1].id:null,localOnly:true};
    });
  }
  async function exportSession(input) {
    const x = parse(archiveExportInputSchema,input);
    return access(false,x.galaxyId,(db,galaxyId) => {
      const row = db?.prepare('SELECT * FROM archive_sessions WHERE owner_id=? AND id=?').get(galaxyId,x.archiveSessionId);
      if (!row) throw failure('local_archive_session_unavailable');
      const messages = db.prepare('SELECT * FROM archive_messages WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(row.id,x.afterSequence,x.limit+1);
      row.message_count=db.prepare('SELECT count(*) AS total FROM archive_messages WHERE session_id=?').get(row.id).total;
      return {galaxyId,session:view(row),messages:messages.slice(0,x.limit).map(messageView),
        nextAfter:messages.length>x.limit?messages[x.limit-1].sequence:null,completeConversation:false,
        coverage:'Only host originals actually captured after explicit selection, with credentials/inline binary excluded and listed per message. Earlier, missing or host-unexportable content is not reconstructed.',localOnly:true};
    });
  }
  async function snapshot(input) {
    const x=parse(archiveSnapshotInputSchema,input);
    return access(false,x.galaxyId,(db,galaxyId)=>{
      const row=db?.prepare('SELECT * FROM archive_sessions WHERE owner_id=? AND id=?').get(galaxyId,x.archiveSessionId);
      if(!row)throw failure('local_archive_session_unavailable');
      const messages=[];let bytes=0;
      for(const stored of db.prepare('SELECT * FROM archive_messages WHERE session_id=? AND sequence>? ORDER BY sequence').iterate(row.id,x.afterSequence)){
        const message=messageView(stored),size=Buffer.byteLength(JSON.stringify(message));
        if(messages.length&&bytes+size>32*1024*1024)break;messages.push(message);bytes+=size;
      }
      row.message_count=db.prepare('SELECT count(*) AS count FROM archive_messages WHERE session_id=?').get(row.id).count;
      const last=messages.at(-1)?.sequence??x.afterSequence,hasMore=!!db.prepare('SELECT 1 FROM archive_messages WHERE session_id=? AND sequence>? LIMIT 1').get(row.id,last);
      return {galaxyId,session:view(row),messages,nextAfter:hasMore?last:null,completeConversation:false,
        selectedCoverage:{afterSequence:x.afterSequence,throughSequence:last,sourceMessages:row.message_count,hasEarlier:x.afterSequence>0,hasLater:hasMore},
        coverage:'Selected retained host messages in this sequence window; credentials and unavailable content are excluded.',localOnly:true};
    });
  }
  async function describe(input) {
    const x=parse(archiveDeleteInputSchema,input);
    return access(false,x.galaxyId,(db,galaxyId)=>{
      const row=db?.prepare('SELECT s.*, (SELECT count(*) FROM archive_messages WHERE session_id=s.id) message_count FROM archive_sessions s WHERE owner_id=? AND id=?').get(galaxyId,x.archiveSessionId);
      return row?view(row):null;
    });
  }
  async function findSession(input) {
    const x=parse(z.strictObject({galaxyId:z.string().optional(),host:z.string().min(1).max(512),sessionId:z.string().min(1).max(512)}),input);
    return access(false,x.galaxyId,(db,galaxyId)=>{
      const row=db?.prepare('SELECT s.*, (SELECT count(*) FROM archive_messages WHERE session_id=s.id) message_count FROM archive_sessions s WHERE owner_id=? AND host=? AND session_id=?').get(galaxyId,x.host,x.sessionId);
      return row?view(row):null;
    });
  }
  async function deleteSession(input) {
    const x = parse(archiveDeleteInputSchema,input);
    return access(true,x.galaxyId,(db,galaxyId) => {
      const row = db.prepare('SELECT * FROM archive_sessions WHERE owner_id=? AND id=?').get(galaxyId,x.archiveSessionId);
      if (!row) throw failure('local_archive_session_unavailable');
      const deletedMessages = Number(db.prepare('DELETE FROM archive_messages WHERE session_id=?').run(row.id).changes);
      db.prepare('DELETE FROM archive_sessions WHERE id=?').run(row.id);
      const p = preferences(db,galaxyId);p.sessions = p.sessions.filter(s => s.host !== row.host || s.sessionId !== row.session_id);
      if (!p.sessions.length) p.enabled=false;
      db.prepare('INSERT INTO archive_preferences(owner_id,settings_json) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET settings_json=excluded.settings_json').run(galaxyId,JSON.stringify(p));
      return {galaxyId,archiveSessionId:row.id,deletedMessages,hostOriginalsChanged:false,cloudReplicasChanged:false,localOnly:true};
    });
  }
  async function cleanup(input = {}) {
    const x = parse(archiveCleanupInputSchema,input);
    const selected = await access(false,x.galaxyId,(db,galaxyId)=>({galaxyId,age:preferences(db,galaxyId).autoCleanAfterDays}));
    if (!selected.age) return {galaxyId:selected.galaxyId,deletedMessages:0,localOnly:true};
    return access(true,selected.galaxyId,(db,galaxyId) => ({galaxyId,deletedMessages:cleanupWithin(db,galaxyId,preferences(db,galaxyId)),localOnly:true}));
  }
  return Object.freeze({settings,configure,captureMessage,list,describe,findSession,exportSession,snapshot,deleteSession,cleanup});
}
