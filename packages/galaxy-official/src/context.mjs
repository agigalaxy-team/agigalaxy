import * as z from 'zod/v4';
import { contextGrantSchema, contextAcceptanceSchema, contextScopeEvent, contextReceiptSchema } from './shared/context-schema.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { recordObjectAudit } from './infrastructure/object-audit.mjs';
import { recordContextRead } from './infrastructure/context-read-audit.mjs';
function parse(payload, schema) {
  try { if (typeof payload !== 'string' || Buffer.byteLength(payload) > 16000) throw new Error(); return schema.parse(JSON.parse(payload)); }
  catch { throw new ServiceError('invalid_context_payload'); }
}
export class ContextService {
  constructor(access, consents, assistance) { Object.assign(this, { access, consents, assistance }); }
  receipt(actor,input){
    const parsed=contextReceiptSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_context_query');
    return this.access.runAuthorized(actor,'context',async db=>{
      const query=parsed.data;
      const row=query.kind==='grant'?(await db.query('SELECT id,subject_id,consent_id,payload_hash FROM context_grants WHERE id=$1',[query.grantId])).rows[0]
        :(await db.query('SELECT id,subject_id,consent_id,payload_hash FROM context_acceptances WHERE grant_id=$1',[query.grantId])).rows[0];
      if(row&&row.subject_id!==actor.subjectId)throw new ServiceError('not_found',404);
      const matched=row&&row.id===query.eventId&&row.payload_hash===query.payloadHash;
      return {...query,state:!row?'absent':matched?'acknowledged':'conflict',checkedAt:this.access.now(),
        ...(matched?{consentId:row.consent_id}:{}),authority:'accepted-event-only; no current material access'};
    });
  }
  async active(db, payload) {
    const { row, paused } = await this.assistance.load(db, payload.assistanceId), state = row.snapshot;
    if (paused || state.state !== 'active' || state.request.caseId !== payload.caseId || state.selected?.providerId !== payload.participantId
      || state.agreedScope !== payload.scope || contextScopeEvent(state) !== payload.scopeEventId)
      throw new ServiceError('context_collaboration_changed', 403);
    return state;
  }
  async grant(db, subjectId, consentId, objectId, payloadJson) {
    return this.consents.require(db, { id: consentId, subjectId, objectId, action: 'context.grant', recipient: this.access.endpoint, payloadJson });
  }
  async create(actor, { consentId, payloadJson }) {
    const payload = parse(payloadJson, contextGrantSchema);
    return this.access.runResourceWrite(actor,'context',{}, async (db, authorization) => {
      const state = await this.active(db, payload);
      if (state.requesterId !== actor.subjectId) throw new ServiceError('context_requester_required', 403);
      const consent = await this.grant(db, actor.subjectId, consentId, payload.id, payloadJson);
      if (consent.visibility !== 'Private' || consent.viewers.length !== 1 || consent.viewers[0] !== payload.participantId
        || payload.expiresAt <= this.access.now() || payload.expiresAt > consent.expiresAt)
        throw new ServiceError('context_scope_mismatch', 403);
      const existing = (await db.query('SELECT * FROM context_grants WHERE id=$1 FOR UPDATE', [payload.id])).rows[0];
      if (existing) {
        if (existing.subject_id !== actor.subjectId || existing.consent_id !== consentId || existing.payload_hash !== digest(payloadJson) || existing.revoked_at)
          throw new ServiceError('context_conflict', 409);
        return { grantId: payload.id, state: 'recorded' };
      }
      const count = Number((await db.query('SELECT count(*) FROM context_grants WHERE assistance_id=$1', [payload.assistanceId])).rows[0].count);
      if (count >= 64) throw new ServiceError('context_grant_limit', 413);
      await db.query(`INSERT INTO context_grants(id,assistance_id,subject_id,participant_id,consent_id,payload_text,payload_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [payload.id, payload.assistanceId, actor.subjectId, payload.participantId, consentId, payloadJson, digest(payloadJson)]);
      await recordObjectAudit(db, { subjectId: actor.subjectId, objectId: payload.id, action: 'context.create', httpRequestId: actor.httpRequestId ?? null, ...authorization });
      return { grantId: payload.id, state: 'recorded' };
    });
  }
  async live(db, actor, id) {
    // Collaboration first, then grant locks: same order as create/accept.
    const candidate = (await db.query('SELECT * FROM context_grants WHERE id=$1 AND (subject_id=$2 OR participant_id=$2)', [id, actor.subjectId])).rows[0];
    if (!candidate) throw new ServiceError('not_found', 404);
    const payload = parse(candidate.payload_text, contextGrantSchema);
    await this.active(db, payload);
    const row = (await db.query('SELECT * FROM context_grants WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (row.revoked_at || payload.expiresAt <= this.access.now()) throw new ServiceError('context_unavailable', 403);
    await this.grant(db, row.subject_id, row.consent_id, id, row.payload_text);
    return { row, payload };
  }
  async accept(actor, id, { consentId, payloadJson }) {
    const acceptance = parse(payloadJson, contextAcceptanceSchema);
    if (acceptance.grantId !== id) throw new ServiceError('context_target_mismatch');
    return this.access.runResourceWrite(actor,'context',{}, async (db, authorization) => {
      const { row, payload } = await this.live(db, actor, id);
      if (actor.subjectId !== row.participant_id || acceptance.assistanceId !== payload.assistanceId
        || acceptance.scopeEventId !== payload.scopeEventId || acceptance.materialsHash !== digest(JSON.stringify(payload.materials)))
        throw new ServiceError('context_acceptance_mismatch', 403);
      const consent = await this.grant(db, actor.subjectId, consentId, acceptance.id, payloadJson);
      if (consent.visibility !== 'Private' || consent.viewers.length !== 1 || consent.viewers[0] !== row.subject_id)
        throw new ServiceError('context_scope_mismatch', 403);
      const existing = (await db.query('SELECT * FROM context_acceptances WHERE grant_id=$1', [id])).rows[0];
      if (existing) {
        if (existing.id !== acceptance.id || existing.consent_id !== consentId || existing.payload_hash !== digest(payloadJson)) throw new ServiceError('context_acceptance_conflict', 409);
      } else {
        await db.query('INSERT INTO context_acceptances(id,grant_id,subject_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6)',
          [acceptance.id, id, actor.subjectId, consentId, payloadJson, digest(payloadJson)]);
        await recordObjectAudit(db, { subjectId: actor.subjectId, objectId: acceptance.id, action: 'context.accept', httpRequestId: actor.httpRequestId ?? null, ...authorization });
      }
      return { grantId: id, eventId: acceptance.id, state: 'accepted' };
    });
  }
  async readWithin(db, actor, id, includeContent = true, authorization, readKind='direct') {
    const { row, payload } = await this.live(db, actor, id);
    const acceptance = (await db.query('SELECT * FROM context_acceptances WHERE grant_id=$1', [id])).rows[0];
    if (acceptance) await this.grant(db, acceptance.subject_id, acceptance.consent_id, acceptance.id, acceptance.payload_text);
    const canRead = actor.subjectId === row.subject_id || !!acceptance;
    const { materials, ...metadata } = payload;
    if(includeContent)await recordContextRead(db,actor,authorization,{objectId:id,
      action:readKind==='inspect'?'context.export.inspect':readKind==='export'?'context.export.read':canRead?'context.read':'context.metadata.read',
      consentId:actor.subjectId===row.subject_id?row.consent_id:acceptance?.consent_id??row.consent_id});
    return { grantId: id, ...metadata, ownerId: row.subject_id, state: acceptance ? 'accepted' : 'pending',
      materialsHash: digest(JSON.stringify(materials)), materials: materials.map(({ content, ...item }) =>
        ({ ...item, ...(canRead && includeContent ? { content } : {}), contentHash: digest(content) })),
      contextAccessGranted: canRead && includeContent, capabilityVerified: false };
  }
  async get(actor, id) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'context', (db, authorization) => this.readWithin(db, actor, id, true, authorization));
  }
  async query(actor, { assistanceId }) {
    if (!z.uuid().safeParse(assistanceId).success) throw new ServiceError('invalid_context_query');
    return this.access.runAuthorized(actor, 'context', async (db, authorization) => {
      const candidates = (await db.query('SELECT id FROM context_grants WHERE assistance_id=$1 AND (subject_id=$2 OR participant_id=$2) AND revoked_at IS NULL ORDER BY id LIMIT 64', [assistanceId, actor.subjectId])).rows;
      const items = [];
      for (const row of candidates) {
        try { items.push(await this.readWithin(db, actor, row.id, false)); }
        catch (error) { if (!(error instanceof ServiceError) || !['context_unavailable', 'context_collaboration_changed', 'consent_required', 'assistance_case_unavailable'].includes(error.code)) throw error; }
      }
      await recordContextRead(db,actor,authorization,{objectId:assistanceId,action:'context.query'});
      return { items };
    });
  }
  async revoke(actor, id) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'context', async (db, authorization) => {
      const row = (await db.query('SELECT * FROM context_grants WHERE id=$1 AND subject_id=$2 FOR UPDATE', [id, actor.subjectId])).rows[0];
      if (!row) throw new ServiceError('not_found', 404);
      if (!row.revoked_at) {
        await db.query('UPDATE context_grants SET revoked_at=$2 WHERE id=$1', [id, new Date(this.access.now() * 1000).toISOString()]);
        await recordObjectAudit(db, { subjectId: actor.subjectId, objectId: id, action: 'context.revoke', httpRequestId: actor.httpRequestId ?? null, ...authorization });
      }
      return { grantId: id, state: 'revoked' };
    });
  }
}
