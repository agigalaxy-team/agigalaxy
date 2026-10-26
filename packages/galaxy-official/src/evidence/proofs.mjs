import { proofRepository } from "../infrastructure/proofs-repository.mjs";
import * as z from 'zod/v4';
import { transaction } from "../infrastructure/database.mjs";
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { canReadProjection } from "../consents/consents.mjs";
import { verifyEnvelope } from "../security/signed-envelope.mjs";
import { readProofCaseContext } from "../domain/proof-case-context.mjs";
import { currentProofSource } from "../domain/proof-source.mjs";
import { describeCiProof } from "../shared/ci-provenance.mjs";

export class ProofService {
  constructor(access, consents, evidence, { sign = access.sign, lockEvidenceRead } = {}) {
    this.access = access; this.consents = consents; this.evidence = evidence; this.endpoint = access.endpoint; this.now = access.now;
    this.lockEvidenceRead = lockEvidenceRead;
    this.sign = sign; this.trustedKeys = access.trustedKeys;
  }

  async source(db, evidenceId, subjectId) {
    return currentProofSource(db,evidenceId,subjectId,{evidence:this.evidence,now:this.now,lockEvidenceRead:this.lockEvidenceRead});
  }

  payload({ id, subjectId, evidenceId, preparedAt }, source) {
    const o = source.observation;
    return { version: 1, type: 'ci-execution-observation', id, subject: subjectId, issuer: this.endpoint,
      evidenceId, observationId: source.id, scope: 'referenced-ci-run-only', strength: o.strength,
      independence: o.independence, attribution: o.attribution, source: o.source, conclusion: o.conclusion,
      ...(o.sourceControl?{sourceControl:o.sourceControl}:{}),
      taskOutcomeVerification: 'not-independently-verified', capabilityVerified: false,
      preparedAt, observedAt: o.collectedAt, expiresAt: o.validUntil, limitations: o.limitations,
      statusPath: `/v1/proofs/${id}/status` };
  }

  async preview(actor, { id, evidenceId }) {
    if (![id, evidenceId].every(value => z.uuid().safeParse(value).success)) throw new ServiceError('invalid_proof_request');
    return this.access.runAuthorized(actor, 'proof', async db => {
      const source = await this.source(db, evidenceId, actor.subjectId);
      const payloadJson = JSON.stringify(this.payload({ id, evidenceId, subjectId: actor.subjectId, preparedAt: this.now() }, source));
      return { payloadJson, payloadHash: digest(payloadJson), published: false };
    });
  }

  async publish(actor, { consentId, payloadJson }) {
    let candidate;
    try {
      if (typeof payloadJson !== 'string' || payloadJson.length > 12000) throw new Error();
      candidate = JSON.parse(payloadJson);
      if (!z.uuid().safeParse(candidate.id).success || !z.uuid().safeParse(candidate.evidenceId).success
        || !Number.isSafeInteger(candidate.preparedAt) || candidate.preparedAt > this.now()
        || candidate.preparedAt < this.now() - 300) throw new Error();
    } catch { throw new ServiceError('invalid_proof_payload'); }
    return this.access.runResourceWrite(actor,'proof',{}, async (db, authorization) => {
      const source = await this.source(db, candidate.evidenceId, actor.subjectId);
      const expected = this.payload({ id: candidate.id, evidenceId: candidate.evidenceId,
        subjectId: actor.subjectId, preparedAt: candidate.preparedAt }, source);
      if (payloadJson !== JSON.stringify(expected)) throw new ServiceError('proof_preview_changed', 409);
      await this.consents.require(db, { id: consentId, subjectId: actor.subjectId, action: 'proof.publish',
        objectId: candidate.id, recipient: this.endpoint, payloadJson });
      const existing = (await proofRepository(db).lock([candidate.id])).rows[0];
      if (existing) {
        if (existing.subject_id !== actor.subjectId || existing.payload_hash !== digest(payloadJson)
          || existing.consent_id !== consentId || existing.revoked_at) throw new ServiceError('proof_conflict', 409);
        return { proofId: existing.id, signed: existing.signed };
      }
      const signed = await this.sign('proof', expected, candidate.id, expected.expiresAt - this.now());
      const inserted = (await proofRepository(db).insert([candidate.id, actor.subjectId, candidate.evidenceId, source.id,
        consentId, payloadJson, digest(payloadJson), signed])).rows;
      if (!inserted.length) {
        const prior = (await proofRepository(db).get([candidate.id])).rows[0];
        if (prior.subject_id !== actor.subjectId || prior.payload_hash !== digest(payloadJson)
          || prior.consent_id !== consentId || prior.revoked_at) throw new ServiceError('proof_conflict', 409);
        return { proofId: prior.id, signed: prior.signed };
      }
      await proofRepository(db).auditPublish([actor.subjectId, candidate.id, actor.httpRequestId ?? null, authorization.credentialScopes, authorization.callerBindingId]);
      return { proofId: candidate.id, signed };
    });
  }

  async readWithin(db, actor, id, statusOnly = false) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 404);
      const row = (await proofRepository(db).get([id])).rows[0];
      if (!row || row.revoked_at) throw new ServiceError('not_found', 404);
      try {
        const source = await this.source(db, row.evidence_id, row.subject_id);
        if (source.id !== row.observation_id) throw new Error('Source changed');
        const intent = await this.consents.require(db, { id: row.consent_id, subjectId: row.subject_id, action: 'proof.publish',
          objectId: id, recipient: this.endpoint, payloadJson: row.payload_text });
        const current = (await proofRepository(db).lockStatus([id])).rows[0];
        if (!current || current.revoked_at) throw new Error('Proof revoked');
        if (!canReadProjection(intent, { viewerId: actor?.subjectId ?? null, projection: 'proof', now: this.now() }))
          throw new Error('Visibility denied');
        const checked = await verifyEnvelope(row.signed, { type: 'proof', issuer: this.endpoint,
          audience: this.endpoint, trustedKeys: this.trustedKeys, now: this.now(), maxAge: 86400 });
        const caseContext = await readProofCaseContext(db, { evidenceId: row.evidence_id, subjectId: row.subject_id,
          viewerId: actor?.subjectId ?? null, consents: this.consents, endpoint: this.endpoint, now: this.now() });
        const context = {...(caseContext ? { caseContext } : {}),provenance:describeCiProof(checked.data)};
        if(this.moderation){
          const evidence=(await proofRepository(db).evidence([row.evidence_id,row.subject_id])).rows[0];
          const moderationContext=await this.moderation.caseContextWithin(db,actor,evidence.case_id);
          if(moderationContext.items.length)context.moderationContext=moderationContext;
        }
        return statusOnly ? { status: 'active', expiresAt: checked.expiresAt, capabilityVerified: false, ...context }
          : { proofId: id, signed: row.signed, status: 'active', ...context };
      } catch (error) {
        if (error.code && /^[0-9A-Z]{5}$/.test(error.code)) throw error;
        throw new ServiceError('not_found', 404);
      }

  }

  async get(actor, id, statusOnly = false) {
    const read = db => this.readWithin(db, actor, id, statusOnly);
    return actor ? this.access.runAuthorized(actor, 'proof', read) : transaction(this.access.db, read);
  }

  async revoke(actor, id) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'proof', async (db, authorization) => {
      const row = (await proofRepository(db).lockOwned([id, actor.subjectId])).rows[0];
      if (!row) throw new ServiceError('not_found', 404);
      if (!row.revoked_at) {
        await proofRepository(db).revoke([id, new Date(this.now() * 1000).toISOString()]);
        await proofRepository(db).auditRevoke([actor.subjectId, id, actor.httpRequestId ?? null, authorization.credentialScopes, authorization.callerBindingId]);
      }
      return { proofId: id, status: 'revoked' };
    });
  }
}
