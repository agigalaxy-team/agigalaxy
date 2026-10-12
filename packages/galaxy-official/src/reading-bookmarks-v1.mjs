import {randomUUID} from 'node:crypto';
import {digest} from './shared/digest.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {
  readingBookmarkCommandSchema, readingBookmarkStatusSchema,
  readingBookmarkQuerySchema, readingBookmarkReceiptSchema,
  readingBookmarkKey, readingBookmarkPath,
} from './shared/reading-bookmarks-v1-schema.mjs';

const stamp = seconds => new Date(seconds * 1000).toISOString();
const text = (value, limit) => typeof value === 'string' ? Array.from(value).slice(0, limit).join('') : '';
const parse = (schema, input) => {
  const value = schema.safeParse(input);
  if (!value.success) throw new ServiceError('invalid_reading_bookmark_request', 400);
  return value.data;
};
const sourceActor = (actor, scope) => actor.scopes.includes(scope) ? actor : null;
const unavailable = reason => ({state: 'unavailable', reason});
const stateOf = (reference, row) => ({reference, saved: row?.saved ?? false,
  revision: row?.revision ?? 0, ...(row ? {id: row.id, savedAt: new Date(row.saved_at).toISOString()} : {})});

export class ReadingBookmarksV1 {
  /** @param {import('./access.mjs').AccessService} access
   * @param {{forum?:import('./community-forum-v1.mjs').CommunityForumV1,
   * capsules?:import('./capsules-v2.mjs').CapsuleServiceV2,
   * projects?:import('./projects-v2.mjs').ProjectV2Service,
   * profiles?:import('./profile.mjs').ProfileService}} readers */
  constructor(access, readers = {}) { this.access = access; this.readers = readers; }

  async statusWithin(db, subjectId, reference) {
    const row = (await db.query('SELECT * FROM reading_bookmarks_v1 WHERE subject_id=$1 AND reference_key=$2',
      [subjectId, readingBookmarkKey(reference)])).rows[0];
    return stateOf(reference, row);
  }
  status(actor, input) {
    const request = parse(readingBookmarkStatusSchema, input);
    return this.access.runAuthorized(actor, 'binding', db => this.statusWithin(db, actor.subjectId, request.reference));
  }
  async receiptWithin(db, actor, request) {
    const row = (await db.query('SELECT * FROM reading_bookmark_operations_v1 WHERE subject_id=$1 AND operation_id=$2',
      [actor.subjectId, request.operationId])).rows[0];
    if (!row) return {state: 'absent', operationId: request.operationId, payloadHash: request.payloadHash};
    if (row.request_hash !== request.payloadHash) throw new ServiceError('reading_bookmark_operation_conflict', 409);
    return row.result;
  }
  receipt(actor, input) {
    const request = parse(readingBookmarkReceiptSchema, input);
    return this.access.runAuthorized(actor, 'binding', db => this.receiptWithin(db, actor, request));
  }
  async readDeadlineWithin(db, consentIds, until) {
    // Metadata from grants already checked by the owning source reader. This
    // only shortens the current display window; it cannot grant source access.
    const rows=(await db.query(`SELECT c.expires_at,b.expires_at AS binding_expires_at
      FROM consents c JOIN bindings b ON b.id=c.binding_id WHERE c.id=ANY($1::uuid[])`,[consentIds])).rows;
    for(const row of rows)until=Math.min(until,Date.parse(row.expires_at)/1000,Date.parse(row.binding_expires_at)/1000);
    return until;
  }

  async sourceWithin(db, actor, reference) {
    const now = this.access.now(), {forum, capsules, projects, profiles} = this.readers;
    try {
      let title, summary, until = now + 15;
      if (reference.kind === 'forum-post') {
        if (!forum) throw new ServiceError('reading_bookmark_reader_unavailable', 503);
        const view = await forum.headWithin(db, reference.postId);
        if (view.availability !== 'available') return unavailable(view.availability === 'expired' ? 'source-expired' : view.availability === 'withdrawn' ? 'source-withdrawn' : 'source-not-readable');
        title = view.payload.title; summary = view.payload.body;
        until = Math.min(until, view.publishedUntil);
      } else if (reference.kind === 'capsule') {
        if (!capsules) throw new ServiceError('reading_bookmark_reader_unavailable', 503);
        const view = await capsules.readWithin(db, sourceActor(actor, 'capsules'), reference);
        if (!view.version) return unavailable('source-not-readable');
        title = view.version.title; summary = view.version.problemPattern;
        const rows=(await db.query('SELECT consent_id FROM capsule_events WHERE id=$1 AND capsule_id=$2',[reference.versionId,reference.capsuleId])).rows;
        until=await this.readDeadlineWithin(db,rows.map(row=>row.consent_id),until);
      } else if (reference.kind === 'project') {
        if (!projects) throw new ServiceError('reading_bookmark_reader_unavailable', 503);
        const view = await projects.readWithin(db, sourceActor(actor, 'history'), reference.projectId);
        if (!view.document) return unavailable('source-not-readable');
        title = view.document.title; summary = view.document.summary;
        const sourceIds=[view.source.policyEventId,...view.source.fieldSources.filter(source=>['title','summary'].includes(source.field)).map(source=>source.operationId)];
        const rows=(await db.query('SELECT consent_id FROM project_events_v2 WHERE operation_id=ANY($1::uuid[])',[sourceIds])).rows;
        until=await this.readDeadlineWithin(db,rows.map(row=>row.consent_id),until);
      } else {
        if (!profiles) throw new ServiceError('reading_bookmark_reader_unavailable', 503);
        const registered = (await db.query('SELECT id FROM subjects WHERE id=$1', [reference.subjectId])).rows[0];
        if (!registered) return unavailable('source-not-readable');
        const view = await profiles.readWithin(db, sourceActor(actor, 'history'), reference.subjectId);
        // The registered identity remains a real object when its current
        // introduction is not shared. Never revive a previous display name.
        if (!view.selfDeclaredSource) return unavailable('source-not-readable');
        title = view.selfDeclared.displayName || '尚未填写称呼的个人资料'; summary = view.selfDeclared.about;
        if (view.selfDeclaredReadExpiresAt) until = Math.min(until, view.selfDeclaredReadExpiresAt);
      }
      if (until <= now) return unavailable('source-expired');
      return {state: 'available', title: text(title, 200), summary: text(summary, 360),
        path: readingBookmarkPath(reference), availableUntil: until};
    } catch (error) {
      if (error instanceof ServiceError && [401, 403, 404, 409, 410].includes(error.status)) return unavailable('source-not-readable');
      return {state: 'temporarily-unavailable', reason: 'source-check-failed'};
    }
  }
  command(actor, input) {
    const command = parse(readingBookmarkCommandSchema, input), payloadHash = digest(JSON.stringify(command));
    return this.access.runResourceWrite(actor, 'binding', {}, async (db, authorization) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,839177))', [actor.subjectId + ':' + command.operationId]);
      const prior = await this.receiptWithin(db, actor, {operationId: command.operationId, payloadHash});
      // A late duplicate save must not overwrite a later explicit removal.
      if (prior.state === 'acknowledged') return prior;
      const key = readingBookmarkKey(command.reference);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,839178))', [actor.subjectId + ':' + key]);
      const row = (await db.query('SELECT * FROM reading_bookmarks_v1 WHERE subject_id=$1 AND reference_key=$2 FOR UPDATE', [actor.subjectId, key])).rows[0];
      if ((row?.revision ?? 0) !== command.expectedRevision && (row?.saved ?? false) !== command.saved)
        throw new ServiceError('reading_bookmark_changed', 409);
      if (command.saved && !row) {
        const freshActor = {...actor, scopes: [...authorization.credentialScopes]};
        const source = await this.sourceWithin(db, freshActor, command.reference);
        if (source.state !== 'available') throw new ServiceError(source.state === 'temporarily-unavailable'
          ? 'reading_bookmark_reader_unavailable' : 'reading_bookmark_source_unavailable', source.state === 'temporarily-unavailable' ? 503 : 404);
      }
      const now = stamp(this.access.now());
      if (!row || row.saved !== command.saved) {
        await db.query(`INSERT INTO reading_bookmarks_v1(id,subject_id,reference_key,reference,saved,revision,created_at,saved_at,updated_at)
          VALUES($1,$2,$3,$4,$5,1,$6,$6,$6)
          ON CONFLICT(subject_id,reference_key) DO UPDATE SET saved=$5,revision=reading_bookmarks_v1.revision+1,
          saved_at=CASE WHEN $5 THEN $6 ELSE reading_bookmarks_v1.saved_at END,updated_at=$6`,
        [row?.id ?? randomUUID(), actor.subjectId, key, JSON.stringify(command.reference), command.saved, now]);
      }
      const result = {state: 'acknowledged', operationId: command.operationId, payloadHash,
        bookmark: await this.statusWithin(db, actor.subjectId, command.reference)};
      await db.query('INSERT INTO reading_bookmark_operations_v1(subject_id,operation_id,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5)',
        [actor.subjectId, command.operationId, payloadHash, JSON.stringify(result), now]);
      return result;
    });
  }
  query(actor, input = {}) {
    const request = parse(readingBookmarkQuerySchema, input);
    return this.access.runAuthorized(actor, 'binding', async (db, authorization) => {
      const cursor = request.after ? (await db.query('SELECT id,saved_at FROM reading_bookmarks_v1 WHERE subject_id=$1 AND id=$2', [actor.subjectId, request.after])).rows[0] : null;
      if (request.after && !cursor) throw new ServiceError('reading_bookmark_cursor_unavailable', 409);
      const rows = (await db.query(`SELECT * FROM reading_bookmarks_v1 WHERE subject_id=$1 AND saved=true
        AND ($2::text IS NULL OR reference->>'kind'=$2)
        AND ($3::timestamptz IS NULL OR (saved_at,id)<($3::timestamptz,$4::uuid))
        ORDER BY saved_at DESC,id DESC LIMIT $5`, [actor.subjectId, request.kind ?? null, cursor?.saved_at ?? null, cursor?.id ?? null, request.limit + 1])).rows;
      const items = [], freshActor = {...actor, scopes: [...authorization.credentialScopes]};
      for (const row of rows.slice(0, request.limit)) items.push({...stateOf(row.reference, row),
        source: await this.sourceWithin(db, freshActor, row.reference)});
      return {items, nextAfter: rows.length > request.limit ? rows[request.limit - 1].id : null, checkedAt: this.access.now(), visibility: 'Private'};
    });
  }
}
