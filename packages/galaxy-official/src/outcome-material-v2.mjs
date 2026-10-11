import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { transaction } from './database.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { outcomeMaterialEventSchema, outcomeMaterialQuerySchema, outcomeMaterialReadSchema,
  outcomeMaterialSelectionSchema, outcomeMaterialReceiptSchema } from './shared/outcome-material-v2-schema.mjs';
import { cleanupOutcomeMaterialsWithin } from './operations/outcome-material-retention-v2.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const iso = seconds => new Date(seconds * 1000).toISOString();
const fail = (code, status = 409) => { throw new ServiceError(code, status); };
const parse = (schema, value) => { const r = schema.safeParse(value); if (!r.success) fail('invalid_outcome_material_request', 400); return r.data; };
const pendingStates = "('requested','review-needed','approved','partial','primary-erased')";

// The original chat and a separately permitted outcome copy have independent
// lifecycles. This service never changes a chat TTL or executes a user model.
export class OutcomeMaterialServiceV2 {
  constructor(access, { consents, chat, records, attachments = chat?.attachments ?? null }) {
    Object.assign(this, { access, consents, chat, records, attachments }); this.now = access.now;
  }
  parseEvent(input, kinds) {
    if (typeof input?.payloadJson !== 'string' || Buffer.byteLength(input.payloadJson) > 24000) fail('invalid_outcome_material_request', 400);
    if (!z.uuid().safeParse(input?.consentId).success) fail('invalid_outcome_material_request', 400);
    let payload;
    try { payload = JSON.parse(input.payloadJson); } catch { fail('invalid_outcome_material_request', 400); }
    const x = parse(outcomeMaterialEventSchema, payload);
    if (!kinds.includes(x.kind)) fail('invalid_outcome_material_request', 400);
    return { x, payloadText: input.payloadJson, payloadHash: hash(input.payloadJson), consentId: input.consentId };
  }
  async lock(db, id, mode = 'SHARE') {
    return (await db.query(`SELECT * FROM outcome_materials_v2 WHERE id=$1 FOR ${mode}`, [id])).rows[0];
  }
  async operation(db, id) { return (await db.query('SELECT * FROM outcome_material_events_v2 WHERE id=$1', [id])).rows[0]; }
  state(row) {
    if (row.purged_at) return 'erased';
    if (['declined', 'cancelled', 'revoked'].includes(row.state)) return row.state;
    if (row.state === 'requested' && Date.parse(row.request_expires_at) <= this.now() * 1000) return 'request-expired';
    if (row.expires_at && Date.parse(row.expires_at) <= this.now() * 1000) return 'permission-expired';
    return row.state;
  }
  view(row) {
    return { materialId: row.id, version: 1, ownerId: row.subject_id, authorId: row.author_id, caseId: row.case_id,
      ...(row.task_id ? { taskId: row.task_id } : {}), source: row.source, audience: row.audience,
      uses: row.uses, title: row.title, state: this.state(row), revision: row.revision,
      requestExpiresAt: row.request_expires_at, approvedAt: row.approved_at, permissionExpiresAt: row.expires_at,
      size: Number(row.byte_size), sha256: row.sha256, cleanupPending: !!row.purge_pending,
      objectRemoved: !!row.purged_at, contentAvailable: false, capabilityVerified: false,
      sourceCopyIndependent: !!row.approval_id, retention: 'independent-selected-material; original-chat-TTL-unchanged' };
  }
  async pending(db, ids) {
    return !!(await db.query(`SELECT 1 FROM deletion_requests WHERE subject_id=ANY($1::text[]) AND state IN ${pendingStates} LIMIT 1`, [ids])).rows.length;
  }
  async caseLive(db, caseId) {
    const parent = await this.records.caseWithin(db, caseId);
    if (parent.parent.state === 'withdrawn' || await this.pending(db, [parent.parent.subject_id])) fail('outcome_target_unavailable', 404);
    return parent;
  }
  async selectedWithin(db, actor, selection) {
    if (selection.kind === 'attachment') {
      if (!this.attachments?.specification().supported) fail('outcome_attachment_copy_unavailable', 503);
      const { row } = await this.attachments.roomRow(db, actor, selection.id);
      if (selection.version !== 1) fail('outcome_source_version_unavailable', 404);
      await this.attachments.readableWithin(db, actor, row);
      const bytes = await this.attachments.store.get({ key: row.storage_key, keyId: row.encryption_key_id, size: Number(row.byte_size) });
      if (!bytes || hash(bytes) !== row.sha256) fail('outcome_source_integrity_failed', 502);
      // Storage may finish after the original room/source permission or TTL.
      // A prior readable row is not permission to return its late bytes.
      const { row: current } = await this.attachments.roomRow(db, actor, selection.id);
      await this.attachments.readableWithin(db, actor, current);
      return { source: { kind: 'attachment', id: row.id, version: 1, sha256: row.sha256, roomId: row.room_id },
        authorId: row.subject_id, size: bytes.length, bytes, name: row.name, mediaType: row.media_type };
    }
    const selected = await this.chat.readSelectedWithin(db, actor, { messageId: selection.id, revision: selection.version });
    return { source: { kind: 'message', id: selected.messageId, version: selected.revision,
      sha256: selected.contentHash, roomId: selected.roomId }, authorId: selected.authorId,
      size: Buffer.byteLength(selected.text, 'utf8'), text: selected.text };
  }
  async exactSource(db, actor, source) {
    const selected = await this.selectedWithin(db, actor, source);
    if (canonicalize(selected.source) !== canonicalize(source)) fail('outcome_source_changed');
    return selected;
  }
  async source(actor, input) {
    const selection = parse(outcomeMaterialSelectionSchema, input);
    return this.access.runAuthorized(actor, 'evidence', async db => {
      const { text: _text, bytes: _bytes, ...selected } = await this.selectedWithin(db, actor, selection);
      return { ...selected, currentRoomReadOnly: true, independentRetentionGranted: false };
    });
  }
  async requireConsent(db, event) {
    if (hash(event.payload_text) !== event.payload_hash) fail('outcome_material_integrity_failed', 500);
    const intent = await this.consents.require(db, { id: event.consent_id, subjectId: event.subject_id,
      action: 'outcome.material', objectId: event.id, recipient: this.access.endpoint, payloadJson: event.payload_text });
    if (intent.visibility !== 'Private' || intent.purpose !== 'operational' || intent.currentVisibility?.deletionPending) fail('outcome_material_permission_unavailable', 403);
    return intent;
  }
  event(actor, envelope) {
    return { id: envelope.x.id, material_id: envelope.x.materialId, subject_id: actor.subjectId,
      consent_id: envelope.consentId, payload_text: envelope.payloadText, payload_hash: envelope.payloadHash };
  }
  async duplicate(db, actor, envelope) {
    const previous = await this.operation(db, envelope.x.id);
    if (!previous) return null;
    if (previous.subject_id !== actor.subjectId || previous.material_id !== envelope.x.materialId || previous.payload_hash !== envelope.payloadHash || previous.consent_id !== envelope.consentId) fail('outcome_material_operation_conflict');
    const row = await this.lock(db, previous.material_id);
    if (!row) fail('outcome_material_unavailable', 404);
    return { ...this.view(row), operationId: previous.id, operationState: 'recorded', replayed: true };
  }
  async append(db, actor, envelope, revision, authorization) {
    const e = this.event(actor, envelope);
    await db.query(`INSERT INTO outcome_material_events_v2(id,material_id,subject_id,kind,revision,consent_id,payload_text,payload_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [e.id, e.material_id, e.subject_id, envelope.x.kind, revision, e.consent_id, e.payload_text, e.payload_hash, iso(this.now())]);
    const audit = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,
      consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'evidence',c.id,b.id,$5,$4,b.scopes,$6::jsonb,
        cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
      FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
      JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
      WHERE c.id=$8 AND c.subject_id=$1 RETURNING sequence`, [actor.subjectId, 'outcome-material.' + envelope.x.kind, e.material_id, e.id,
        actor.httpRequestId ?? null, JSON.stringify(authorization.credentialScopes), authorization.callerBindingId, e.consent_id]);
    if (audit.rows.length !== 1) throw new Error('Outcome material audit context unavailable');
  }
  async serialize(db, x) {
    // Stable operation and material IDs prevent concurrent duplicate inserts.
    for (const key of ['operation:' + x.id, 'material:' + x.materialId].sort()) await db.query('SELECT pg_advisory_xact_lock(734912323,hashtext($1))', [key]);
  }
  async request(actor, input) {
    const e = this.parseEvent(input, ['request']), x = e.x;
    return this.access.runResourceWrite(actor, 'evidence', {}, async (db, authorization) => {
      await this.serialize(db, x);
      const replay = await this.duplicate(db, actor, e); if (replay) return replay;
      if (await this.lock(db, x.materialId)) fail('outcome_material_conflict');
      const intent = await this.requireConsent(db, this.event(actor, e));
      const expires = Date.parse(x.requestExpiresAt) / 1000;
      if (expires <= this.now() || expires > Math.min(intent.expiresAt, this.now() + 30 * 86400)) fail('outcome_request_expiry_invalid');
      // The independently retained copy is its own object. It is linked to a
      // live Case here; creating a VerificationRecord would incorrectly turn
      // a selected chat excerpt into an evidence claim and impose that record's
      // synthetic/participation rules.
      await this.caseLive(db, x.caseId);
      const selected = await this.exactSource(db, actor, x.source);
      if (await this.pending(db, [actor.subjectId, selected.authorId])) fail('outcome_material_permission_unavailable', 403);
      if (selected.authorId !== actor.subjectId && !intent.viewers.includes(selected.authorId)) fail('outcome_author_preview_permission_required', 403);
      const row = (await db.query(`INSERT INTO outcome_materials_v2
        (id,subject_id,author_id,case_id,task_id,source,source_kind,audience,uses,title,request_id,state,created_at,request_expires_at,byte_size,sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested',$12,$13,$14,$15) RETURNING *`,
      [x.materialId, actor.subjectId, selected.authorId, x.caseId, x.taskId ?? null, JSON.stringify(x.source), x.source.kind,
        JSON.stringify(x.audience), JSON.stringify(x.uses), x.title, x.id, iso(this.now()), x.requestExpiresAt, selected.size, x.source.sha256])).rows[0];
      await this.append(db, actor, e, row.revision, authorization);
      return { ...this.view(row), operationId: x.id, operationState: 'recorded', requestHash: e.payloadHash };
    });
  }
  async approve(actor, input) {
    const e = this.parseEvent(input, ['approve']), x = e.x;
    return this.access.runResourceWrite(actor, 'evidence', {}, async (db, authorization) => {
      await this.serialize(db, x); const replay = await this.duplicate(db, actor, e); if (replay) return replay;
      const row = await this.lock(db, x.materialId, 'UPDATE');
      if (!row || row.author_id !== actor.subjectId) fail('outcome_material_unavailable', 404);
      if (row.revision !== x.expectedRevision || this.state(row) !== 'requested') fail('outcome_material_revision_conflict');
      const request = await this.operation(db, row.request_id);
      if (!request || request.payload_hash !== x.requestHash || canonicalize(x.source) !== canonicalize(row.source)) fail('outcome_material_request_mismatch');
      await this.requireConsent(db, request);
      const intent = await this.requireConsent(db, this.event(actor, e));
      if (row.subject_id !== actor.subjectId && !intent.viewers.includes(row.subject_id)) fail('outcome_requester_preview_permission_required', 403);
      if (x.expiresAt && Date.parse(x.expiresAt) <= this.now() * 1000) fail('outcome_permission_expiry_invalid');
      await this.caseLive(db, row.case_id);
      const selected = await this.exactSource(db, actor, row.source);
      if (selected.authorId !== row.author_id || selected.size !== Number(row.byte_size)) fail('outcome_source_changed');
      // Reserving the exact body size on request charges the copy to its owner
      // before the other author approves, so approval cannot bypass that quota.
      let storageKey = null;
      if (row.source_kind === 'attachment') {
        if (!this.attachments?.specification().supported) fail('outcome_attachment_copy_unavailable', 503);
        storageKey = `outcome-materials/${x.materialId}`;
        await this.attachments.store.put({ key: storageKey, bytes: selected.bytes, sha256: selected.source.sha256 });
      }
      const updated = (await db.query(`UPDATE outcome_materials_v2 SET state='available',approval_id=$2,revision=revision+1,approved_at=$3,
        expires_at=$4,body_text=$5,name=$6,media_type=$7,storage_key=$8,encryption_key_id=$9,scan_result=$10,last_error=NULL WHERE id=$1 RETURNING *`,
      [x.materialId, x.id, iso(this.now()), x.expiresAt ?? null, selected.text ?? '', selected.name ?? x.source.kind,
        selected.mediaType ?? 'text/plain', storageKey, storageKey ? this.attachments.store.keyId : null,
        selected.scanResult ?? null])).rows[0];
      await this.append(db, actor, e, updated.revision, authorization);
      return { ...this.view(updated), operationId: x.id, operationState: 'recorded', copyStored: true };
    });
  }
  async control(actor, input) {
    const e = this.parseEvent(input, ['decline', 'cancel', 'revoke']), x = e.x;
    return this.access.runResourceWrite(actor, 'evidence', { control: true }, async (db, authorization) => {
      await this.serialize(db, x); const replay = await this.duplicate(db, actor, e); if (replay) return replay;
      const row = await this.lock(db, x.materialId, 'UPDATE');
      if (!row || ![row.subject_id, row.author_id].includes(actor.subjectId)) fail('outcome_material_unavailable', 404);
      if (row.revision !== x.expectedRevision) fail('outcome_material_revision_conflict');
      if (x.kind === 'decline' && actor.subjectId !== row.author_id || x.kind === 'cancel' && actor.subjectId !== row.subject_id) fail('outcome_material_action_not_allowed', 403);
      if (x.kind !== 'revoke' && row.state !== 'requested' || x.kind === 'revoke' && !['available', 'copying', 'copy-failed'].includes(row.state)) fail('outcome_material_action_not_allowed');
      await this.requireConsent(db, this.event(actor, e));
      const state = { revoke: 'revoked', decline: 'declined', cancel: 'cancelled' }[x.kind];
      const updated = (await db.query('UPDATE outcome_materials_v2 SET state=$2,revision=revision+1,purge_pending=true WHERE id=$1 RETURNING *', [x.materialId, state])).rows[0];
      await this.append(db, actor, e, updated.revision, authorization);
      return { ...this.view(updated), operationId: x.id, operationState: 'recorded' };
    });
  }
  async liveWithin(db, row) {
    if (this.state(row) !== 'available' || row.purge_pending) fail('outcome_material_unavailable', 404);
    const request = await this.operation(db, row.request_id), approval = await this.operation(db, row.approval_id);
    if (!request || !approval) fail('outcome_material_permission_unavailable', 404);
    await this.requireConsent(db, request); await this.requireConsent(db, approval);
    await this.caseLive(db, row.case_id);
    if (await this.pending(db, [row.subject_id, row.author_id])) fail('outcome_material_unavailable', 404);
    return { request, approval };
  }
  async readWithin(db, actor, id) {
    const row = await this.lock(db, id);
    if (!row) fail('outcome_material_unavailable', 404);
    const party = [row.subject_id, row.author_id].includes(actor.subjectId);
    const permitted = party || row.audience.visibility === 'Public' || row.audience.viewers.includes(actor.subjectId);
    if (!permitted) fail('outcome_material_unavailable', 404);
    try {
      await this.liveWithin(db, row);
      const content = row.body_text;
      let bytesBase64;
      if (row.source_kind === 'attachment') {
        if (!this.attachments?.store || !row.storage_key) fail('outcome_material_storage_unavailable', 503);
        const bytes = await this.attachments.store.get({ key: row.storage_key, keyId: row.encryption_key_id, size: Number(row.byte_size) });
        if (!bytes || hash(bytes) !== row.sha256) fail('outcome_material_integrity_failed', 500);
        bytesBase64 = bytes.toString('base64');
      } else if (hash(content) !== row.sha256) fail('outcome_material_integrity_failed', 500);
      // This is the independently approved copy's current permission, not the
      // original temporary chat attachment's lifetime. Keep original locators
      // even when a late read is withheld.
      await this.liveWithin(db, row);
      if (this.state(row) !== 'available' || row.purge_pending) fail('outcome_material_unavailable', 404);
      return { ...this.view(row), ...(row.source_kind === 'attachment' ? { bytesBase64 } : { content }), contentAvailable: true, authorization: 'current' };
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      if (!party) fail('outcome_material_unavailable', 404);
      return { ...this.view(row), contentAvailable: false, availability: 'unavailable', reason: error.code };
    }
  }
  read(actor, input) {
    const x = parse(outcomeMaterialReadSchema, input);
    return this.access.runAuthorized(actor, 'evidence', db => this.readWithin(db, actor, x.id));
  }
  inspect(actor, input) {
    const x = parse(outcomeMaterialReadSchema, input);
    return this.access.runAuthorized(actor, 'evidence', async db => {
      const row = await this.lock(db, x.id);
      if (!row || ![row.subject_id, row.author_id].includes(actor.subjectId)) fail('outcome_material_unavailable', 404);
      const request = await this.operation(db, row.request_id);
      // Permit the owner to reconcile even after a consent expires; other
      // authors only see the proposal while its exact request is authorised.
      if (actor.subjectId !== row.subject_id) await this.requireConsent(db, request);
      let sourceContent=null,sourceContentReason=null,sourceName=null,sourceMediaType=null,sourceReadExpiresAt=null;
      if(row.source.kind==='message'){
        try{
          const selected=await this.exactSource(db,actor,row.source);
          // Fetching the exact archive body may yield to the transport. Recheck
          // current room membership and source lifetime after that await.
          await this.chat.requireRoom(db,actor,row.source.roomId);
          const current=(await db.query('SELECT room_id,subject_id,state,revision,expires_at FROM chat_message_refs WHERE message_id=$1 FOR SHARE',[row.source.id])).rows[0];
          if(!current||current.room_id!==row.source.roomId||current.subject_id!==selected.authorId
            ||current.state!=='accepted'||current.revision!==row.source.version
            ||Date.parse(current.expires_at)<=this.now()*1000)fail('chat_message_version_unavailable');
          sourceContent={source:selected.source,authorId:selected.authorId,size:selected.size,content:selected.text,
            readExpiresAt:Math.floor(Date.parse(current.expires_at)/1000),currentRoomReadOnly:true,independentRetentionGranted:false};
        }catch(error){if(!(error instanceof ServiceError))throw error;sourceContentReason=error.code;}
      }else if(row.source.kind==='attachment'){
        try{
          if(!this.attachments)fail('outcome_attachment_copy_unavailable',503);
          const {row:attachment}=await this.attachments.roomRow(db,actor,row.source.id);
          if(row.source.version!==1||attachment.room_id!==row.source.roomId||attachment.sha256!==row.source.sha256)fail('outcome_source_changed');
          await this.attachments.readableWithin(db,actor,attachment);
          // Metadata follows current original-file permission. Inspect never
          // reads storage bytes or assumes approval grants original access.
          sourceName=attachment.name??null;sourceMediaType=attachment.media_type??null;
          const expiresAt=Date.parse(attachment.expires_at??attachment.prepare_expires_at);
          if(Number.isFinite(expiresAt))sourceReadExpiresAt=Math.floor(expiresAt/1000);
          if(attachment.message_id){
            const message=(await db.query('SELECT expires_at FROM chat_message_refs WHERE message_id=$1 FOR SHARE',[attachment.message_id])).rows[0],
              messageExpiry=Date.parse(message?.expires_at);
            if(Number.isFinite(messageExpiry))sourceReadExpiresAt=sourceReadExpiresAt===null?Math.floor(messageExpiry/1000):Math.min(sourceReadExpiresAt,Math.floor(messageExpiry/1000));
          }
        }catch(error){if(!(error instanceof ServiceError))throw error;sourceContentReason=error.code;}
      }
      if(actor.subjectId!==row.subject_id)await this.requireConsent(db,request);
      if(sourceContent&&sourceContent.readExpiresAt<=this.now()){
        sourceContent=null;sourceContentReason='chat_message_version_unavailable';
      }
      if(sourceReadExpiresAt!==null&&sourceReadExpiresAt<=this.now()){
        sourceName=null;sourceMediaType=null;sourceReadExpiresAt=null;sourceContentReason='attachment_content_unavailable';
      }
      return { ...this.view(row), requestHash: request.payload_hash, request: JSON.parse(request.payload_text),
        sourceContent,sourceContentReason,sourceName,sourceMediaType,sourceReadExpiresAt };
    });
  }
  query(actor, input) {
    const x = parse(outcomeMaterialQuerySchema, input);
    return this.access.runAuthorized(actor, 'evidence', async db => {
      const rows = (await db.query(`SELECT * FROM outcome_materials_v2 WHERE ${x.view === 'authored' ? 'author_id' : 'subject_id'}=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [actor.subjectId, x.after ?? null, x.limit + 1])).rows;
      const items = [];
      for (const row of rows.slice(0, x.limit)) {
        if (row.subject_id !== actor.subjectId) {
          try { await this.requireConsent(db, await this.operation(db, row.request_id)); } catch (e) { if (e instanceof ServiceError) continue; throw e; }
        }
        items.push(this.view(row));
      }
      return { items, nextAfter: rows.length > x.limit ? rows[x.limit - 1].id : null };
    });
  }
  operationReceipt(actor, input) {
    const x = parse(outcomeMaterialReceiptSchema, input);
    return this.access.runAuthorized(actor, 'evidence', async db => {
      const event = await this.operation(db, x.operationId);
      if (!event || event.subject_id !== actor.subjectId) return { operationId: x.operationId, state: 'absent' };
      if (event.payload_hash !== x.payloadHash) return { operationId: x.operationId, state: 'conflict' };
      return { operationId: x.operationId, state: 'recorded', material: this.view(await this.lock(db, event.material_id)) };
    });
  }
  async purgeExpired({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_outcome_material_request', 400);
    return transaction(this.access.db, db => cleanupOutcomeMaterialsWithin(db, this.now(), { limit, store: this.attachments?.store ?? null }));
  }
}
