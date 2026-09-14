import * as z from 'zod/v4';
import { contextGrantV2Schema, contextEventV2Schema, contextQueryV2Schema, contextReceiptV2Schema } from './shared/context-v2-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { recordContextV2Audit } from './infrastructure/context-v2-audit.mjs';
import { recordContextRead } from './infrastructure/context-read-audit.mjs';

const iso = seconds => new Date(seconds * 1000).toISOString();
function parse(text, schema) {
  try { if (typeof text !== 'string' || Buffer.byteLength(text) > 40000) throw new Error(); return schema.parse(JSON.parse(text)); }
  catch { throw new ServiceError('invalid_context_v2_payload'); }
}
const visible = state => ['pending','accepted'].includes(state);
const withheld = error => error instanceof ServiceError && [403,404].includes(error.status);

// v2 is per agreed Participation. It neither mutates nor interprets v1 selected.
export class ContextServiceV2 {
  constructor(access, consents, tasks) { Object.assign(this, { access, consents, tasks }); }
  consent(db, subjectId, consentId, objectId, payloadJson) {
    return this.consents.require(db, { id: consentId, subjectId, objectId, payloadJson,
      action: 'context.grant', recipient: this.access.endpoint });
  }
  privateRecipient(consent, recipientId) {
    if (consent.visibility !== 'Private' || consent.viewers.length !== 1 || consent.viewers[0] !== recipientId)
      throw new ServiceError('context_scope_mismatch', 403);
  }
  async participation(db, actor, payload) {
    // Task -> Participation -> material grant; this matches v2 scope mutations.
    const p = await this.tasks.requireParticipationWithin(db, actor, {
      taskId: payload.taskId, participationId: payload.participationId, write: true,
    });
    if (p.subjectId !== payload.participantId || p.scopeVersion !== payload.scopeVersion || p.scopeEventId !== payload.scopeEventId)
      throw new ServiceError('context_scope_changed', 403);
    if (p.paused || p.taskState !== 'open' || !['active','delivered','accepted'].includes(p.state))
      throw new ServiceError('context_participation_inactive', 403);
    return p;
  }
  async create(actor, { consentId, payloadJson }) {
    const input = parse(payloadJson, contextGrantV2Schema);
    return this.access.runResourceWrite(actor, 'context', {}, async (db, authorization) => {
      const p = await this.participation(db, actor, input);
      if (p.requesterId !== actor.subjectId) throw new ServiceError('context_requester_required', 403);
      const prior = (await db.query('SELECT * FROM context_grants_v2 WHERE id=$1 FOR UPDATE', [input.id])).rows[0];
      if (prior) return this.replayedGrant(prior, actor, consentId, payloadJson);
      const consent = await this.consent(db, actor.subjectId, consentId, input.id, payloadJson);
      this.privateRecipient(consent, input.participantId);
      if (consent.currentVisibility?.deletionPending) throw new ServiceError('context_source_deletion_pending', 403);
      if (input.expiresAt <= this.access.now() || input.expiresAt > consent.expiresAt)
        throw new ServiceError('context_expiry_mismatch', 403);
      const materialsHash = digest(JSON.stringify(input.materials));
      // Unique ID arbitration covers different tasks as well as same-task retries.
      const inserted = (await db.query(`INSERT INTO context_grants_v2
        (id,task_id,participation_id,subject_id,participant_id,scope_version,scope_event_id,consent_id,payload_text,payload_hash,materials_hash,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [input.id,input.taskId,input.participationId,actor.subjectId,input.participantId,input.scopeVersion,input.scopeEventId,
        consentId,payloadJson,digest(payloadJson),materialsHash,iso(input.expiresAt),iso(this.access.now())])).rows.length;
      if (!inserted) return this.replayedGrant((await db.query('SELECT * FROM context_grants_v2 WHERE id=$1 FOR UPDATE',[input.id])).rows[0], actor, consentId, payloadJson);
      await this.audit(db, actor, authorization, input.id, 'context.create');
      return { grantId: input.id, eventId: input.id, state: 'recorded-awaiting-recipient-acceptance',
        materialsHash, contextAccessGranted: false };
    });
  }
  replayedGrant(row, actor, consentId, payloadJson) {
    if (row.subject_id !== actor.subjectId || row.consent_id !== consentId || row.payload_hash !== digest(payloadJson))
      throw new ServiceError('context_conflict',409);
    return { grantId: row.id, eventId: row.id, state: 'acknowledged', materialsHash: row.materials_hash,
      contextAccessGranted: false, authority: 'accepted-event-only; not-current-authorization' };
  }
  async audit(db, actor, authorization, id, action) {
    await recordContextV2Audit(db, { subjectId: actor.subjectId, objectId: id, action,
      httpRequestId: actor.httpRequestId ?? null, ...authorization });
  }
  async locate(db, actor, id, lock = false) {
    const row = (await db.query(`SELECT * FROM context_grants_v2 WHERE id=$1
      AND (subject_id=$2 OR participant_id=$2)${lock ? ' FOR UPDATE' : ''}`, [id, actor.subjectId])).rows[0];
    if (!row) throw new ServiceError('not_found',404);
    return row;
  }
  storedMetadata(row) {
    return { schemaVersion: 2, grantId: row.id, taskId: row.task_id, participationId: row.participation_id,
      ownerId: row.subject_id, participantId: row.participant_id, scopeVersion: row.scope_version,
      scopeEventId: row.scope_event_id, materialsHash: row.materials_hash,
      expiresAt: Math.floor(Date.parse(row.expires_at)/1000), createdAt: Math.floor(Date.parse(row.created_at)/1000) };
  }
  async inspect(db, actor, id) {
    const candidate = await this.locate(db, actor, id);
    let state = candidate.state;
    if (candidate.erased_at || !candidate.payload_text) state = 'source-erased';
    else if (candidate.revoked_at) state = 'revoked';
    else if (Date.parse(candidate.expires_at) <= this.access.now()*1000) state = 'expired';
    let payload = null;
    if (visible(state)) {
      payload = parse(candidate.payload_text, contextGrantV2Schema);
      try { await this.participation(db, actor, payload); }
      catch (error) {
        if (!withheld(error)) throw error;
        state = ['context_scope_changed','context_participation_inactive'].includes(error.code)
          ? error.code.slice('context_'.length).replaceAll('_','-') : 'participation-unavailable';
      }
    }
    const row = await this.locate(db, actor, id, true);
    // Revocation/erasure can win while the task lock was acquired.
    if (row.erased_at || !row.payload_text) state = 'source-erased';
    else if (row.revoked_at) state = 'revoked';
    else if (Date.parse(row.expires_at) <= this.access.now()*1000) state = 'expired';
    else if (visible(state)) state = row.state;
    if (visible(state)) {
      try {
        const consent = await this.consent(db, row.subject_id, row.consent_id, row.id, row.payload_text);
        if (consent.currentVisibility?.deletionPending && actor.subjectId !== row.subject_id) state = 'source-deletion-pending';
      } catch (error) { if (!withheld(error)) throw error; state = 'source-permission-unavailable'; }
    }
    let acceptance = null;
    if (visible(state) && row.state === 'accepted') {
      acceptance = (await db.query('SELECT * FROM context_events_v2 WHERE id=$1', [row.response_event_id])).rows[0];
      if (actor.subjectId !== row.subject_id) {
        try {
          if (!acceptance || acceptance.kind !== 'accept') throw new ServiceError('consent_required',403);
          await this.consent(db, acceptance.subject_id, acceptance.consent_id, acceptance.id, acceptance.payload_text);
        } catch (error) { if (!withheld(error)) throw error; state = 'acceptance-permission-unavailable'; }
      }
    }
    return { row, payload: visible(state) ? payload : null, state, acceptance };
  }
  async submitEvent(actor, id, { consentId, payloadJson }) {
    const input = parse(payloadJson, contextEventV2Schema);
    if (input.grantId !== id) throw new ServiceError('context_target_mismatch');
    return this.access.runResourceWrite(actor, 'context', { control: input.kind !== 'accept' }, async (db, authorization) => {
      await this.locate(db, actor, id);
      const prior = (await db.query('SELECT * FROM context_events_v2 WHERE id=$1', [input.id])).rows[0];
      if (prior) return this.replayedEvent(prior, actor, input, consentId, payloadJson);
      const inspected = input.kind === 'accept' ? await this.inspect(db, actor, id) : null;
      const row = inspected?.row ?? await this.locate(db, actor, id, true);
      if (input.taskId !== row.task_id || input.participationId !== row.participation_id
        || input.scopeVersion !== row.scope_version || input.materialsHash !== row.materials_hash)
        throw new ServiceError('context_response_mismatch',403);
      const expectedActor = input.kind === 'revoke' ? row.subject_id : row.participant_id;
      if (actor.subjectId !== expectedActor) throw new ServiceError('context_response_actor_required',403);
      // Recheck after taking the material lock: concurrent original retries win once.
      const raced = (await db.query('SELECT * FROM context_events_v2 WHERE id=$1', [input.id])).rows[0];
      if (raced) return this.replayedEvent(raced, actor, input, consentId, payloadJson);
      if (input.kind === 'accept' && inspected.state !== 'pending') throw new ServiceError('context_not_awaiting_acceptance',409);
      if (input.kind === 'decline' && row.state !== 'pending' || input.kind === 'revoke' && row.revoked_at)
        throw new ServiceError('context_response_conflict',409);
      const consent = await this.consent(db, actor.subjectId, consentId, input.id, payloadJson);
      this.privateRecipient(consent, input.kind === 'revoke' ? row.participant_id : row.subject_id);
      const collision = (await db.query('SELECT id FROM context_grants_v2 WHERE id=$1', [input.id])).rows.length;
      if (collision) throw new ServiceError('context_event_conflict',409);
      await db.query(`INSERT INTO context_events_v2(id,grant_id,subject_id,kind,consent_id,payload_text,payload_hash,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.id,id,actor.subjectId,input.kind,consentId,payloadJson,digest(payloadJson),iso(this.access.now())]);
      if (input.kind === 'revoke') await db.query("UPDATE context_grants_v2 SET state='revoked',revoked_at=$2 WHERE id=$1", [id,iso(this.access.now())]);
      else await db.query('UPDATE context_grants_v2 SET state=$2,response_event_id=$3 WHERE id=$1', [id,input.kind === 'accept'?'accepted':'declined',input.id]);
      await this.audit(db, actor, authorization, input.id, `context.${input.kind}`);
      return { grantId: id, eventId: input.id, state: input.kind === 'accept'?'accepted':input.kind === 'decline'?'declined':'revoked',
        materialsHash: row.materials_hash, contextAccessGranted: false, authority: 'accepted-event-only; recheck-before-read' };
    });
  }
  replayedEvent(row, actor, input, consentId, payloadJson) {
    if (row.subject_id !== actor.subjectId || row.grant_id !== input.grantId || row.consent_id !== consentId || row.payload_hash !== digest(payloadJson))
      throw new ServiceError('context_event_conflict',409);
    return { grantId: row.grant_id, eventId: row.id, state: 'acknowledged',
      contextAccessGranted: false, authority: 'accepted-event-only; not-current-authorization' };
  }
  async readWithin(db, actor, id, includeContent = true, authorization, readKind = 'direct') {
    const { row, payload, state, acceptance } = await this.inspect(db, actor, id);
    const canRead = visible(state) && (actor.subjectId === row.subject_id || state === 'accepted');
    const materials = payload?.materials.map(({content,...item}) => ({ ...item, contentHash: digest(content),
      ...(includeContent && canRead ? {content} : {}) })) ?? [];
    if (includeContent || readKind === 'metadata') await recordContextRead(db, actor, authorization, { objectId: id,
      action: readKind === 'export' ? 'context.export.read' : readKind === 'inspect' ? 'context.export.inspect' : canRead && includeContent ? 'context.read' : 'context.metadata.read',
      consentId: actor.subjectId === row.subject_id ? row.consent_id : acceptance?.consent_id ?? row.consent_id });
    return { metadata: this.storedMetadata(row), state, materials,
      contextAccessGranted: includeContent && canRead, capabilityVerified: false,
      executionPermissionGranted: false, roomMembershipGranted: false,
      originalContentErased: !!row.erased_at, authority: 'current-authorized-context-view' };
  }
  get(actor, id, { metadataOnly = false } = {}) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found',404);
    return this.access.runAuthorized(actor, 'context', async (db, authorization) => {
      return this.readWithin(db, actor, id, !metadataOnly, authorization, metadataOnly ? 'metadata' : 'direct');
    });
  }
  query(actor, input) {
    const parsed = contextQueryV2Schema.safeParse(input); if (!parsed.success) throw new ServiceError('invalid_context_query');
    const value = parsed.data;
    return this.access.runAuthorized(actor, 'context', async (db, authorization) => {
      const rows = (await db.query(`SELECT id FROM context_grants_v2 WHERE task_id=$1 AND (subject_id=$2 OR participant_id=$2)
        AND ($3::uuid IS NULL OR participation_id=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,
      [value.taskId,actor.subjectId,value.participationId??null,value.after??null,value.limit+1])).rows;
      const items = [];
      for (const row of rows.slice(0,value.limit)) items.push(await this.readWithin(db,actor,row.id,false));
      await recordContextRead(db, actor, authorization, {objectId:value.taskId,action:'context.query'});
      return {items,nextAfter:rows.length>value.limit?rows[value.limit-1].id:null};
    });
  }
  receipt(actor, input) {
    const parsed = contextReceiptV2Schema.safeParse(input); if (!parsed.success) throw new ServiceError('invalid_context_query');
    return this.access.runAuthorized(actor,'context',async db => {
      const row = input.eventId === input.grantId
        ? (await db.query('SELECT id,subject_id,consent_id,payload_hash,id AS grant_id FROM context_grants_v2 WHERE id=$1',[input.eventId])).rows[0]
        : (await db.query('SELECT id,subject_id,consent_id,payload_hash,grant_id FROM context_events_v2 WHERE id=$1',[input.eventId])).rows[0];
      const own = row?.subject_id === actor.subjectId ? row : null;
      const matched = own && own.grant_id === input.grantId && own.payload_hash === input.payloadHash;
      return {...input,state:!own?'absent':matched?'acknowledged':'conflict',checkedAt:this.access.now(),
        ...(matched?{consentId:own.consent_id}:{}),authority:'accepted-event-only; not-current-authorization'};
    });
  }
}
