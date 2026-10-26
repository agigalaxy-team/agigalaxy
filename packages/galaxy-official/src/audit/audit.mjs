import { compactVerify, importSPKI } from 'jose';
import { randomUUID } from 'node:crypto';
import { auditRoleIdsSchema, auditGrantSchema, auditQuerySchema, auditGrantIdSchema } from "../shared/audit-schema.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { digest } from "../shared/digest.mjs";
import { currentControlKey } from "../infrastructure/identity-control-repository.mjs";

const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) throw new ServiceError('invalid_audit_request'); return result.data; };
const iso = seconds => new Date(seconds * 1000).toISOString();

export class AuditService {
  constructor(access, { auditReaderIds = [], auditReviewerIds = [] } = {}) {
    this.access = access; this.readerIds = auditRoleIdsSchema.parse(auditReaderIds); this.reviewerIds = auditRoleIdsSchema.parse(auditReviewerIds);
  }
  async record(db, actor, authorization, action, id, scope) {
    const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
      context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,
      caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
      SELECT $1,$2,$3::text,$3::text,'accepted',1,ch.payload->>'installationId',b.audience,$4,b.id,$5::uuid,$3::text,
        b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes
      FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id
      WHERE b.id=$7::uuid AND b.subject_id=$1 AND b.scopes ? $4 RETURNING sequence`,
    [actor.subjectId, action, id, scope, actor.httpRequestId ?? null, JSON.stringify(authorization.credentialScopes), authorization.callerBindingId]);
    if (result.rows.length !== 1) throw new ServiceError('audit_context_unavailable', 503);
  }
  config(actor) {
    return this.access.runAuthorized(actor, 'audit', async () => ({ subjectId: actor.subjectId,
      canReadOthers: this.readerIds.includes(actor.subjectId), canReview: this.reviewerIds.includes(actor.subjectId),
      maxGrantSeconds: 3600, maxPageSize: 100, requiresIndependentApproval: true }));
  }
  approve(actor, signed) {
    if (typeof signed !== 'string' || signed.length > 16384) throw new ServiceError('invalid_audit_approval');
    return this.access.runAuthorized(actor, 'audit-review', async (db, authorization) => {
      if (!this.reviewerIds.includes(actor.subjectId)) throw new ServiceError('audit_reviewer_denied', 403);
      const control=authorization.identityControl??await currentControlKey(db,actor.subjectId,{scope:'audit-review'});
      let payloadJson;
      try {
        const verified = await compactVerify(signed, await importSPKI(control.publicKey, 'Ed25519'), { algorithms: ['Ed25519'] });
        if (verified.protectedHeader.typ !== 'galaxy-audit-approval+jws'
          || Object.keys(verified.protectedHeader).sort().join(',') !== 'alg,typ') throw new Error();
        payloadJson = new TextDecoder('utf-8', { fatal: true }).decode(verified.payload);
      } catch { throw new ServiceError('invalid_audit_approval', 403); }
      const grant = parse(auditGrantSchema, JSON.parse(payloadJson)), now = this.access.now();
      if (grant.endpoint !== this.access.endpoint || grant.reviewerId !== actor.subjectId
        || grant.reviewerBindingId !== authorization.callerBindingId || !this.readerIds.includes(grant.readerId)
        || grant.issuedAt > now || grant.expiresAt <= now) throw new ServiceError('audit_approval_denied', 403);
      const binding = (await db.query('SELECT expires_at FROM bindings WHERE id=$1', [authorization.callerBindingId])).rows[0];
      if (grant.expiresAt > Date.parse(binding.expires_at) / 1000) throw new ServiceError('audit_approval_denied', 403);
      const previous = (await db.query('SELECT payload_hash,revoked_at FROM audit_access_grants WHERE id=$1', [grant.id])).rows[0];
      if (previous) {
        if (previous.payload_hash !== digest(payloadJson) || previous.revoked_at) throw new ServiceError('audit_grant_conflict', 409);
        return { id: grant.id, expiresAt: grant.expiresAt, approved: true };
      }
      const inserted = await db.query(`INSERT INTO audit_access_grants(id,reviewer_id,reviewer_binding_id,reader_id,payload_text,payload_hash,signature,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING id`, [grant.id, actor.subjectId, grant.reviewerBindingId, grant.readerId, payloadJson, digest(payloadJson), signed, iso(grant.expiresAt)]);
      if (!inserted.rows.length) {
        const concurrent = (await db.query('SELECT payload_hash,revoked_at FROM audit_access_grants WHERE id=$1', [grant.id])).rows[0];
        if (!concurrent || concurrent.payload_hash !== digest(payloadJson) || concurrent.revoked_at) throw new ServiceError('audit_grant_conflict', 409);
        return { id: grant.id, expiresAt: grant.expiresAt, approved: true };
      }
      await this.record(db, actor, authorization, 'audit.grant', grant.id, 'audit-review');
      return { id: grant.id, expiresAt: grant.expiresAt, approved: true };
    });
  }
  revoke(actor, input) {
    const { id } = parse(auditGrantIdSchema, input);
    return this.access.runAuthorized(actor, 'audit-review', async (db, authorization) => {
      const row = (await db.query('SELECT reviewer_id,revoked_at FROM audit_access_grants WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row || row.reviewer_id !== actor.subjectId) throw new ServiceError('not_found', 404);
      // An original reviewer may still revoke after removal from new-approval configuration.
      if (!row.revoked_at) {
        await db.query('UPDATE audit_access_grants SET revoked_at=$2 WHERE id=$1', [id, iso(this.access.now())]);
        await this.record(db, actor, authorization, 'audit.grant.revoke', id, 'audit-review');
      }
      return { id, revoked: true };
    });
  }
  async requireGrant(db, actor, id, subjectId, action) {
    if (!id || !this.readerIds.includes(actor.subjectId)) throw new ServiceError('audit_approval_required', 403);
    const row = (await db.query(`SELECT g.*,b.revoked_at AS binding_revoked,b.expires_at AS binding_expires,b.scopes,b.subject_id,b.audience
      FROM audit_access_grants g JOIN bindings b ON b.id=g.reviewer_binding_id WHERE g.id=$1 FOR SHARE OF g,b`, [id])).rows[0];
    if (!row || row.reader_id !== actor.subjectId || row.revoked_at || row.binding_revoked
      || row.subject_id !== row.reviewer_id || !this.reviewerIds.includes(row.reviewer_id) || row.audience !== this.access.endpoint
      || !row.scopes.includes('audit-review') || Date.parse(row.expires_at) <= this.access.now() * 1000
      || Date.parse(row.binding_expires) <= this.access.now() * 1000) throw new ServiceError('audit_approval_required', 403);
    const grant = parse(auditGrantSchema, JSON.parse(row.payload_text));
    if (!grant.subjectIds.includes(subjectId) || !grant.actions.includes(action)) throw new ServiceError('audit_scope_denied', 403);
    return grant;
  }
  listGrants(actor) {
    return this.access.runAuthorized(actor, 'audit', async db => {
      const rows = (await db.query(`SELECT id,payload_text,revoked_at FROM audit_access_grants
        WHERE reader_id=$1 OR reviewer_id=$1 ORDER BY created_at DESC,id LIMIT 100`, [actor.subjectId])).rows;
      return { items: rows.map(row => ({ ...JSON.parse(row.payload_text), revoked: row.revoked_at !== null })) };
    });
  }
  query(actor, input = {}, action = 'query') {
    if (!['query', 'export'].includes(action)) throw new ServiceError('invalid_audit_action');
    const query = parse(auditQuerySchema, input), subjectId = query.subjectId ?? actor.subjectId;
    return this.access.runAuthorized(actor, 'audit', async (db, authorization) => {
      const grant = subjectId === actor.subjectId ? null : await this.requireGrant(db, actor, query.grantId, subjectId, action);
      const values = [subjectId, query.action ?? null, query.objectId ?? null, query.requestId ?? null];
      const filter = `(a.actor=$1 OR EXISTS (SELECT 1 FROM bindings owned WHERE owned.id=a.binding_id AND owned.subject_id=$1))
        AND ($2::text IS NULL OR a.action=$2) AND ($3::text IS NULL OR a.object_id=$3)
        AND ($4::uuid IS NULL OR a.http_request_id=$4)`;
      const upper = query.through ?? String((await db.query(`SELECT COALESCE(max(a.sequence),0)::text AS upper FROM audit_events a WHERE ${filter}`, values)).rows[0].upper);
      if (BigInt(query.after) > BigInt(upper)) throw new ServiceError('invalid_audit_cursor');
      const rows = (await db.query(`SELECT a.sequence::text,a.actor,a.action,a.object_id,a.request_id,a.outcome,a.created_at,
        a.context_version,a.client_id,a.audience,a.scope,a.consent_id,a.binding_id,a.http_request_id,a.idempotency_key,
        a.binding_scopes,a.credential_scopes,a.caller_binding_id,a.caller_client_id,a.caller_audience,a.caller_binding_scopes
        FROM audit_events a WHERE ${filter} AND a.sequence>$5::bigint AND a.sequence<=$6::bigint ORDER BY a.sequence LIMIT $7`,
      [...values, query.after, upper, query.limit + 1])).rows;
      const id = randomUUID(), items = rows.slice(0, query.limit).map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() }));
      const selection = { ...query, subjectId, through: upper, grantId: grant?.id ?? null };
      const snapshot = { version: 1, endpoint: this.access.endpoint, queryId: id, subjectId, grantId: grant?.id ?? null,
        action, selection, items, through: upper, nextAfter: rows.length > query.limit ? items.at(-1).sequence : null,
        checkedAt: this.access.now(), view: grant ? 'approved-reader' : 'owner', metadataOnly: true };
      const hash = digest(JSON.stringify(snapshot));
      await db.query(`INSERT INTO audit_reads(id,actor_id,subject_id,grant_id,action,selection,result_hash,result_count,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [id, actor.subjectId, subjectId, grant?.id ?? null, action, JSON.stringify(selection), hash, items.length, iso(this.access.now())]);
      await this.record(db, actor, authorization, `audit.${action}`, id, 'audit');
      return { ...snapshot, sha256: hash, ...(action === 'export' ? { filename: `galaxy-audit-${id}.json`, mediaType: 'application/json' } : {}) };
    });
  }
}
