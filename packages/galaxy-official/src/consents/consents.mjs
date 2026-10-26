import { consentRepository } from "../infrastructure/consent-repository.mjs";
import { currentControlKey } from "../infrastructure/identity-control-repository.mjs";
import { assertConsentPolicy } from "../domain/consent-policy.mjs";
export { canReadProjection } from "../domain/consent-policy.mjs";
import { ConsentReader } from './consent-reader.mjs';
import * as z from 'zod/v4';
import { compactVerify, importSPKI } from 'jose';
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";

import { consentSchema } from "../shared/consents-schema.mjs";
export { consentSchema } from "../shared/consents-schema.mjs";



export class ConsentService extends ConsentReader {
  constructor(access, { additionalPolicy = () => true } = {}) {
    super({ now: access.now }); this.access = access; this.endpoint = access.endpoint; this.additionalPolicy = additionalPolicy;
  }

  async list(actor, after = null) {
    if (after !== null && !z.uuid().safeParse(after).success) throw new ServiceError('invalid_cursor');
    return this.access.runAuthorized(actor, 'consent', async db => {
      const rows = await consentRepository(db).list(actor.subjectId, after);
      return { items: rows.slice(0, 100).map(row => ({ consentId: row.id, intent: row.intent,
        signatureEvidence:row.signature_envelope?'original-signature-envelope':'legacy-verified-record',
        status: row.revoked_at || row.binding_revoked ? 'revoked'
          : Math.min(Date.parse(row.expires_at), Date.parse(row.binding_expires)) <= this.now() * 1000 ? 'expired' : 'active' })),
      nextCursor: rows.length > 100 ? rows[99].id : null };
    });
  }

  async receipt(actor, id) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('invalid_consent_id');
    return this.access.runAuthorized(actor, 'consent', async db => {
      const row = (await db.query(`SELECT c.id,c.intent,c.signature_hash,c.revoked_at,c.expires_at,
        b.revoked_at AS binding_revoked,b.expires_at AS binding_expires
        FROM consents c JOIN bindings b ON b.id=c.binding_id
        WHERE c.id=$1 AND c.subject_id=$2 FOR SHARE OF c,b`, [id, actor.subjectId])).rows[0];
      // Another subject's ID is indistinguishable from an absent record.
      if (!row) return { consentId: id, state: 'absent' };
      return { consentId: id, state: 'recorded', intent: row.intent, signatureHash: row.signature_hash,
        status: row.revoked_at || row.binding_revoked ? 'revoked'
          : Math.min(Date.parse(row.expires_at), Date.parse(row.binding_expires)) <= this.now() * 1000 ? 'expired' : 'active' };
    });
  }

  async create(actor, signedIntent) {
    if (typeof signedIntent !== 'string' || signedIntent.length > 16384) throw new ServiceError('invalid_consent');
    return this.access.runAuthorized(actor, 'consent', (db, authorization) => this.createWithin(db,actor,signedIntent,authorization));
  }

  // Uses the caller's fresh business transaction; failed forum writes cannot
  // leave unused grants or their audit behind. Existing non-forum calls keep
  // their original authorization and mandatory signature/policy checks.
  async createWithin(db,actor,signedIntent,authorization,{forum=false,taskMaterial=false}={}) {
      if (typeof signedIntent !== 'string' || signedIntent.length > 16384) throw new ServiceError('invalid_consent');
      if((forum||taskMaterial)&&!authorization.credentialScopes.includes('consent'))throw new ServiceError('consent_scope_required',403);
      let control=authorization.identityControl??await currentControlKey(db,actor.subjectId,{scope:'consent'});
      if((forum||taskMaterial)&&!control.scopes.includes('*')&&!control.scopes.includes('consent'))throw new ServiceError('consent_scope_required',403);
      if(forum||taskMaterial)control=await currentControlKey(db,actor.subjectId,{deviceId:control.deviceId,keyId:control.keyId,epoch:control.epoch,scope:'consent'});
      let intent,payloadText;
      try {
        const signed = await compactVerify(signedIntent, await importSPKI(control.publicKey, 'Ed25519'), { algorithms: ['Ed25519'] });
        if (Object.keys(signed.protectedHeader).sort().join(',') !== 'alg,typ'
          || signed.protectedHeader.typ !== 'galaxy-consent+jws') throw new Error('Wrong signature type');
        payloadText=Buffer.from(signed.payload).toString('utf8');
        intent = consentSchema.parse(JSON.parse(payloadText));
      } catch { throw new ServiceError('invalid_consent', 400); }
      if(intent.action.startsWith('forum.')&&!forum)throw new ServiceError('forum_atomic_write_required',403);
      if(forum&&!intent.action.startsWith('forum.'))throw new ServiceError('forum_permission_mismatch',403);
      const materialIntent=intent.action==='assistance.publish'&&intent.fields.includes('materials');
      if(materialIntent&&!taskMaterial)throw new ServiceError('task_material_atomic_write_required',403);
      if(taskMaterial&&!materialIntent)throw new ServiceError('task_material_reuse_consent_required',403);
      const context = { actor, endpoint: this.endpoint, now: this.now() };
      assertConsentPolicy(intent, context);
      // Extension policies can narrow access, never bypass the mandatory rules.
      if (this.additionalPolicy(intent, context) !== true) throw new ServiceError('consent_policy_denied', 403);
      const hash = digest(signedIntent);
      await consentRepository(db).insert( [intent.id, actor.subjectId, actor.bindingId,
        JSON.stringify(intent), hash, new Date(intent.expiresAt * 1000).toISOString()],
        {envelope:signedIntent,payloadText,keyId:control.keyId,epoch:control.epoch,chainHead:control.chainHead});
      const existing = await consentRepository(db).lock(intent.id);
      if (existing.subject_id !== actor.subjectId || existing.signature_hash !== hash || existing.revoked_at)
        throw new ServiceError('consent_conflict', 409);
      // One audit record per intent ID, including idempotent retries.
      await consentRepository(db).auditCreate(actor.subjectId, intent.id, actor.httpRequestId ?? null, authorization.credentialScopes, authorization.callerBindingId);
      return { consentId: intent.id, status: 'active', intent };
  }

  async revoke(actor, id) {
    if (!z.uuid().safeParse(id).success) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'consent', async (db, authorization) => {
      const row = await consentRepository(db).lockOwned(id, actor.subjectId);
      if (!row) throw new ServiceError('not_found', 404);
      if (!row.revoked_at) {
        await consentRepository(db).revoke(id, new Date(this.now() * 1000).toISOString());
        await consentRepository(db).auditRevoke(actor.subjectId, id, actor.httpRequestId ?? null, authorization.credentialScopes, authorization.callerBindingId);
      }
      return { consentId: id, status: 'revoked' };
    });
  }


}

