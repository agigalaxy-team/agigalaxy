import { compactVerify, importSPKI } from 'jose';
import { AuditService } from "../audit/audit.mjs";
import { deletionIntentSchema, deletionReadSchema, deletionQuerySchema, deletionStatusIntentSchema } from "../shared/deletion-schema.mjs";
import { digest } from "../shared/digest.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { currentControlKey,captureIdentityControlChain } from "../infrastructure/identity-control-repository.mjs";
const parse = (schema, input) => { const value = schema.safeParse(input); if (!value.success) throw new ServiceError('invalid_deletion_request'); return value.data; };
export const deletionReceipt = (row, endpoint) => ({ version: 1, endpoint, id: row.id, subjectId: row.subject_id,
  revision: row.revision, state: row.state, requestHash: row.payload_hash,
  scope: 'all-owned-service-data', receivedAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  minimizedAt: row.minimized_at ? new Date(row.minimized_at).toISOString() : null,
  physicalDeletionPerformed: row.execution_result?.physicalDeletionPerformed ?? false, execution: row.execution_result ?? null,
  statusSource: 'request-review-and-execution-ledger', executionImplemented: true, serviceWideDeletionComplete: false });

export class DeletionService {
  constructor(access) { this.access = access; this.audit = new AuditService(access); }
  config(actor) { return this.access.runAuthorized(actor, 'data-delete', async () => ({ version: 1, endpoint: this.access.endpoint,
    subjectId: actor.subjectId, scope: 'all-owned-service-data', intentLifetimeSeconds: 300,
    physicalDeletionOnSubmission: false, oneActiveRequestPerSubject: true, executionImplemented: true })); }
  async statusWithProof(signed) {
    if(typeof signed!=='string'||signed.length>12000)throw new ServiceError('invalid_deletion_status');
    let intent,row;
    try{
      // Decode only to locate a public verification key; authorize only after
      // verifying the exact signed payload and current nonce lifetime below.
      const parts=signed.split('.');if(parts.length!==3)throw new Error();
      intent=deletionStatusIntentSchema.parse(JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')));
      row=(await this.access.db.query('SELECT * FROM deletion_requests WHERE id=$1 AND subject_id=$2',[intent.requestId,intent.subjectId])).rows[0];
      if(!row)throw new Error();
      const verified=await compactVerify(signed,await importSPKI(row.requester_public_key,'Ed25519'),{algorithms:['Ed25519']});
      if(verified.protectedHeader.typ!=='galaxy-deletion-status+jws'||Object.keys(verified.protectedHeader).sort().join(',')!=='alg,typ'
        ||intent.endpoint!==this.access.endpoint||intent.issuedAt>this.access.now()||intent.expiresAt<=this.access.now())throw new Error();
    }catch{throw new ServiceError('deletion_status_unavailable',403);}
    return {...deletionReceipt(row,this.access.endpoint),statusIntentId:intent.id,checkedAt:this.access.now(),holderProofVerified:true};
  }
  async owned(db, actor, id, lock = false) {
    const row = (await db.query(`SELECT * FROM deletion_requests WHERE id=$1 AND subject_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, actor.subjectId])).rows[0];
    if (!row) throw new ServiceError('not_found', 404); return row;
  }
  submit(actor, signed) {
    if (typeof signed !== 'string' || signed.length > 16384) throw new ServiceError('invalid_deletion_request');
    return this.access.runAuthorized(actor, 'data-delete', async (db, authorization) => {
      const control=authorization.identityControl??await currentControlKey(db,actor.subjectId,{scope:'data-delete'});
      let payloadJson, intent;
      try {
        const verified = await compactVerify(signed, await importSPKI(control.publicKey, 'Ed25519'), { algorithms: ['Ed25519'] });
        if (verified.protectedHeader.typ !== 'galaxy-deletion-intent+jws' || Object.keys(verified.protectedHeader).sort().join(',') !== 'alg,typ') throw new Error();
        payloadJson = new TextDecoder('utf-8', { fatal: true }).decode(verified.payload);
        intent = deletionIntentSchema.parse(JSON.parse(payloadJson));
      } catch { throw new ServiceError('invalid_deletion_signature', 403); }
      const now = this.access.now();
      if (intent.subjectId !== actor.subjectId || intent.bindingId !== authorization.callerBindingId || intent.endpoint !== this.access.endpoint
        || intent.issuedAt > now || intent.expiresAt <= now) throw new ServiceError('deletion_intent_expired_or_mismatched', 403);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deletion:${actor.subjectId}`]);
      const previous = (await db.query('SELECT request_id,payload_hash,actor_ref FROM deletion_events WHERE id=$1', [intent.id])).rows[0];
      if (previous) {
        if (previous.actor_ref !== actor.subjectId || previous.payload_hash !== digest(payloadJson)) throw new ServiceError('deletion_conflict', 409);
        return deletionReceipt(await this.owned(db, actor, previous.request_id), this.access.endpoint);
      }
      let row;
      if (intent.action === 'request') {
        if ((await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('requested','review-needed','approved','partial','primary-erased')", [actor.subjectId])).rows.length)
          throw new ServiceError('active_deletion_request_exists', 409);
        row = (await db.query(`INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,'requested',1) RETURNING *`, [intent.id, actor.subjectId, intent.bindingId, control.publicKey, payloadJson, digest(payloadJson), signed])).rows[0];
      } else {
        row = await this.owned(db, actor, intent.requestId, true);
        if (row.revision !== intent.expectedRevision || !['requested','review-needed','approved'].includes(row.state)) throw new ServiceError('deletion_request_changed', 409);
        row = (await db.query("UPDATE deletion_requests SET state='cancelled',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
      }
      const chain=await captureIdentityControlChain(db,actor.subjectId);
      await db.query(`INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash,signature,signer_public_key,signer_control_chain)
        VALUES($1,$2,$3,'subject',$4,$5,$6,$7,$8,$9,$10)`, [intent.id, row.id, row.revision, actor.subjectId, intent.action, payloadJson, digest(payloadJson), signed,control.publicKey,chain?JSON.stringify(chain):null]);
      await this.audit.record(db, actor, authorization, `data.deletion.${intent.action}`, intent.id, 'data-delete');
      return deletionReceipt(row, this.access.endpoint);
    });
  }
  read(actor, input) {
    const selection = parse(deletionReadSchema, input);
    return this.access.runAuthorized(actor, 'data-delete', async db => {
      const row = await this.owned(db, actor, selection.id, true);
      if (selection.afterRevision > row.revision) throw new ServiceError('invalid_deletion_cursor');
      const events = (await db.query(`SELECT id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash,signature,created_at,payload_minimized,retained_payload,retained_hash,signer_public_key,signer_control_chain
        FROM deletion_events WHERE request_id=$1 AND revision>$2 ORDER BY revision LIMIT 21`, [row.id, selection.afterRevision])).rows;
      return { ...deletionReceipt(row, this.access.endpoint), request: { payloadJson: row.payload_text, signature: row.signature,
        publicKeyPem: row.requester_public_key }, events: events.slice(0,20).map(event => ({ ...event, created_at: new Date(event.created_at).toISOString() })),
        nextAfterRevision: events.length > 20 ? events[19].revision : null };
    });
  }
  query(actor, input = {}) {
    const selection = parse(deletionQuerySchema, input);
    return this.access.runAuthorized(actor, 'data-delete', async db => {
      const rows = (await db.query('SELECT * FROM deletion_requests WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
        [actor.subjectId, selection.after ?? null, selection.limit + 1])).rows;
      const items = rows.slice(0, selection.limit).map(row => deletionReceipt(row, this.access.endpoint));
      return { version: 1, endpoint: this.access.endpoint, subjectId: actor.subjectId, items, nextAfter: rows.length > selection.limit ? items.at(-1).id : null };
    });
  }
}
