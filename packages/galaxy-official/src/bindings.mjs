import { bindingRepository } from './infrastructure/bindings-repository.mjs';
import { accessRepository } from './infrastructure/access-repository.mjs';
import { currentControlKey,lockSubjectControl } from './infrastructure/identity-control-repository.mjs';
import { bindingQuerySchema,bindingPageSchema } from './shared/binding-management-schema.mjs';
import { createSigningService } from './signing-service.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { compactVerify, importSPKI } from 'jose';
import { verifyGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { transaction } from './database.mjs';
import { verifyEnvelope } from './signed-envelope.mjs';

import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
export { ServiceError } from './shared/service-error.mjs';
export { digest } from './shared/digest.mjs';
const iso = seconds => new Date(seconds * 1000).toISOString();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== [...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join(',')) throw new ServiceError('invalid_request');
}

export class BindingService {
  constructor({ db, endpoint, signingKey, kid, trustedKeys, signer, readSubject, retirement, authorizeAdministrativeRevoke, allowedScopes = ['binding'], now = () => Math.floor(Date.now() / 1000) }) {
    this.db = db; this.endpoint = endpoint; this.signingKey = signingKey;
    this.kid = kid; this.trustedKeys = trustedKeys; this.now = now;
    this.readSubject = readSubject; this.retirement = retirement;
    this.authorizeAdministrativeRevoke=authorizeAdministrativeRevoke;
    this.allowedScopes = new Set(allowedScopes);
    this.signer = signer ?? createSigningService({ endpoint, signingKey, kid, trustedKeys, now },
      ['binding-challenge', 'binding-receipt', 'session-challenge', 'proof']);
  }

  async sign(type, data, id, maxAge) {
    return this.signer.sign(type, data, id, maxAge);
  }

  async challenge(input) {
    return this.issueChallenge(input);
  }
  async challengeV2(input) {
    exact(input,['subjectId','genesisProof','installationId','scopes','control']);
    exact(input.control,['deviceId','keyId','epoch']);
    if(!uuid(input.control.deviceId)||!Number.isSafeInteger(input.control.epoch)||input.control.epoch<1
      ||typeof input.control.keyId!=='string'||!/^[a-f0-9]{64}$/.test(input.control.keyId))throw new ServiceError('invalid_request');
    const {control,...base}=input;
    return this.issueChallenge(base,control);
  }
  async issueChallenge(input,control=null) {
    exact(input, ['subjectId', 'genesisProof', 'installationId', 'scopes']);
    if (!uuid(input.installationId) || !Array.isArray(input.scopes)
      || input.scopes.length < 1 || input.scopes.length > this.allowedScopes.size || !input.scopes.includes('binding')
      || new Set(input.scopes).size !== input.scopes.length || input.scopes.some(scope => !this.allowedScopes.has(scope))
      || !verifyGalaxyGenesis(input.subjectId, input.genesisProof)) throw new ServiceError('identity_or_scope_invalid');
    await this.assertNotDeleted(this.db,input.subjectId);
    await this.retirement?.assertBindingSubject(this.db, input.subjectId);
    const id = randomUUID();
    // Possession of this random session secret binds the reply to its requesting client.
    const clientSession = randomBytes(32).toString('base64url');
    const data = { ...input,...(control?{control}:{}), purpose: 'bind', endpoint: this.endpoint,
      clientSessionHash: digest(clientSession), bindingExpiresAt: this.now() + 86400 };
    const token = await this.sign('binding-challenge', data, id, 180);
    await bindingRepository(this.db).insertChallenge([id, input.subjectId, JSON.stringify(data), digest(token), iso(this.now() + 180)]);
    return { challengeId: id, challenge: token, clientSession };
  }

  async bind(input, { httpRequestId = null } = {}) {
    exact(input, ['challenge', 'signature', 'clientSession']);
    if (typeof input.challenge !== 'string' || input.challenge.length > 16384
      || typeof input.signature !== 'string' || input.signature.length > 24000
      || typeof input.clientSession !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.clientSession))
      throw new ServiceError('invalid_request');
    let opened;
    try {
      opened = await verifyEnvelope(input.challenge, { type: 'binding-challenge', issuer: this.endpoint,
        audience: this.endpoint, trustedKeys: this.trustedKeys, now: this.now(), maxAge: 180 });
      const data = opened.data;
      exact(data, ['subjectId', 'genesisProof', 'installationId', 'scopes', 'purpose', 'endpoint', 'clientSessionHash', 'bindingExpiresAt',...(data.control?['control']:[])]);
      if (!uuid(opened.id) || data.purpose !== 'bind' || data.endpoint !== this.endpoint
        || data.clientSessionHash !== digest(input.clientSession)
        || !verifyGalaxyGenesis(data.subjectId, data.genesisProof)) throw new Error('Invalid challenge');
    } catch { throw new ServiceError('binding_proof_invalid', 401); }
    const data = opened.data;
    // The request identity is the signed challenge, not alternative encodings of a signature.
    const requestHash = digest(input.challenge);
    return transaction(this.db, async db => {
      await this.assertNotDeleted(db,data.subjectId);
      await this.retirement?.assertBindingSubject(db, data.subjectId);
      await bindingRepository(db).declareSubject([data.subjectId, data.genesisProof.publicKeyPem, JSON.stringify(data.genesisProof)]);
      const declared=await lockSubjectControl(db,data.subjectId,{exclusive:true});
      if(declared.public_key!==data.genesisProof.publicKeyPem)throw new ServiceError('identity_conflict',409);
      const control=await currentControlKey(db,data.subjectId,{...data.control,scope:'binding'});
      if(data.scopes.some(s=>!control.scopes.includes('*')&&!control.scopes.includes(s)))throw new ServiceError('identity_scope_invalid',403);
      try {
        const result=await compactVerify(input.signature,await importSPKI(control.publicKey,'Ed25519'),{algorithms:['Ed25519']});
        if(Object.keys(result.protectedHeader).sort().join(',')!=='alg,typ'||result.protectedHeader.typ!=='galaxy-binding-response+jws'
          ||Buffer.from(result.payload).toString('utf8')!==input.challenge)throw new Error();
      }catch{throw new ServiceError('binding_proof_invalid',401);}
      const row = (await bindingRepository(db).lockChallenge([opened.id])).rows[0];
      if (!row || row.token_hash !== requestHash || Date.parse(row.expires_at) <= this.now() * 1000)
        throw new ServiceError('challenge_expired_or_unknown', 401);
      if (row.consumed_at) {
        const previous = (await bindingRepository(db).forChallenge([opened.id])).rows[0];
        if (!previous || previous.request_hash !== requestHash || previous.revoked_at)
          throw new ServiceError('challenge_consumed', 409);
        return { bindingId: previous.id, receipt: previous.receipt };
      }
      // ON CONFLICT and a row lock serialize concurrent first declarations of the same ID.
      await bindingRepository(db).declareSubject([data.subjectId, data.genesisProof.publicKeyPem, JSON.stringify(data.genesisProof)]);
      const subject = (await (this.readSubject ? this.readSubject(db, data.subjectId) : bindingRepository(db).lockSubject([data.subjectId]))).rows[0];
      if (subject.public_key !== data.genesisProof.publicKeyPem) throw new ServiceError('identity_conflict', 409);
      const bindingId = randomUUID();
      const receipt = await this.sign('binding-receipt', { bindingId, subjectId: data.subjectId,
        publicKeyFingerprint: digest(data.genesisProof.publicKeyPem), installationId: data.installationId,
        endpoint: this.endpoint, scopes: data.scopes, expiresAt: data.bindingExpiresAt,
        revokePath: `/v1/bindings/${bindingId}/revoke`, auditReference: opened.id,
        ...(data.control?{control:{deviceId:control.deviceId,keyId:control.keyId,epoch:control.epoch}}:{}) }, bindingId, data.bindingExpiresAt - this.now());
      await bindingRepository(db).insertBinding([bindingId, data.subjectId, opened.id, requestHash,
        this.endpoint, JSON.stringify(data.scopes), receipt, iso(data.bindingExpiresAt)],control);
      await bindingRepository(db).consumeChallenge([opened.id, iso(this.now())]);
      await bindingRepository(db).auditCreate([data.subjectId, bindingId, opened.id, httpRequestId]);
      return { bindingId, receipt };
    });
  }

  async get(bindingId, subjectId) {
    if (!uuid(bindingId)) throw new ServiceError('not_found', 404);
    const row = (await bindingRepository(this.db).getOwned([bindingId, subjectId])).rows[0];
    if (!row) throw new ServiceError('not_found', 404);
    return { bindingId: row.id, subjectId: row.subject_id, scopes: row.scopes,
      expiresAt: row.expires_at, state: row.revoked_at ? 'revoked' : Date.parse(row.expires_at) <= this.now() * 1000 ? 'expired' : 'active' };
  }

  async assertNotDeleted(db,subjectId) {
    if((await db.query("SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased')",[subjectId])).rows.length)
      throw new ServiceError('subject_deletion_recorded',410);
  }

  async query(actor,input={}) {
    const parsed=bindingQuerySchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_binding_query');
    return transaction(this.db,async db=>{
      const checkedAt=this.now(),authorization=await accessRepository(db).lockAuthorization(actor,this.endpoint,iso(checkedAt));
      if(!authorization?.scopes.includes('binding'))throw new ServiceError('access_denied',401);
      const rows=(await bindingRepository(db).queryOwned(actor.subjectId,this.endpoint,parsed.data)).rows;
      const items=rows.slice(0,parsed.data.limit).map(row=>({bindingId:row.id,installationId:row.installation_id,scopes:row.scopes,
        createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),
        revokedAt:row.revoked_at?new Date(row.revoked_at).toISOString():null,
        state:row.revoked_at?'revoked':Date.parse(row.expires_at)<=checkedAt*1000?'expired':'active'}));
      return bindingPageSchema.parse({subjectId:actor.subjectId,currentBindingId:actor.bindingId,checkedAt,items,
        nextAfter:rows.length>parsed.data.limit?items.at(-1).bindingId:null});
    });
  }

  // subjectId must be provided by the authentication layer, never request JSON.
  async revoke(bindingId, subjectId, requestId, httpRequestId = null, actor = null) {
    if (!uuid(bindingId) || !uuid(requestId)) throw new ServiceError('not_found', 404);
    return transaction(this.db, async db => {
      await lockSubjectControl(db,subjectId);
      const records = bindingRepository(db);
      let row, credentialScopes = null;
      if (actor) {
        if (actor.subjectId !== subjectId || !uuid(actor.bindingId) || typeof actor.credentialHash !== 'string'
          || !/^[0-9a-f]{64}$/.test(actor.credentialHash)) throw new ServiceError('access_denied', 401);
        // Lock both bindings in stable order before credentials, including cross-binding revocation.
        const locked = (await records.lockRevokeBindings([...new Set([bindingId, actor.bindingId])])).rows;
        const caller = locked.find(item => item.id === actor.bindingId);
        if (!caller || caller.subject_id !== subjectId || caller.audience !== this.endpoint || caller.revoked_at
          || Date.parse(caller.expires_at) <= this.now() * 1000) throw new ServiceError('access_denied', 401);
        const credential = await accessRepository(db).lockAuthorization(actor,this.endpoint,iso(this.now()));
        if (!credential || !credential.scopes.includes('binding')) throw new ServiceError('access_denied', 401);
        credentialScopes = credential.scopes;
        row = locked.find(item => item.id === bindingId && item.subject_id === subjectId);
      } else {
        // Trusted process entry requires an explicitly supplied administrative verifier.
        if(!this.authorizeAdministrativeRevoke||await this.authorizeAdministrativeRevoke({db,bindingId,subjectId,requestId})!==true)
          throw new ServiceError('administrative_revoke_context_required',401);
        row = (await records.lockOwned([bindingId, subjectId])).rows[0];
      }
      if (!row || row.audience !== this.endpoint) throw new ServiceError('not_found', 404);
      if (!row.revoked_at) {
        await bindingRepository(db).revoke([bindingId, iso(this.now())]);
        await bindingRepository(db).revokeCredentials([bindingId, iso(this.now())]);
        await bindingRepository(db).auditRevoke([subjectId, bindingId, requestId, httpRequestId, credentialScopes, actor?.bindingId ?? null]);
      }
      return { bindingId, state: 'revoked' };
    });
  }
}
