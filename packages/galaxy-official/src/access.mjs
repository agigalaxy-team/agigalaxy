import { accessRepository } from './infrastructure/access-repository.mjs';
import { resourceBudgetPolicySchema,lockSubjectResourceBudget,subjectResourceUsage,enforceResourceGrowth } from './infrastructure/resource-budgets.mjs';
import { randomUUID } from 'node:crypto';
import { compactVerify, importSPKI } from 'jose';
import { transaction } from './database.mjs';
import { digest } from './shared/digest.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { verifyEnvelope } from './signed-envelope.mjs';

export class AccessService {
  constructor(dependencies) {
    const { db, endpoint, now, trustedKeys, sign } = dependencies;
    this.db = db; this.endpoint = endpoint; this.now = now;
    this.resourceBudgetPolicy=dependencies.resourceBudgetPolicy?resourceBudgetPolicySchema.parse(dependencies.resourceBudgetPolicy):null;
    this.trustedKeys = trustedKeys;
    // Legacy BindingService arguments remain supported without exporting that
    // service to every application consumer. Only this narrow signer is retained.
    this.sign = sign?.bind(dependencies);
  }

  async challenge({ bindingId, credentialHash }) {
    if (typeof bindingId !== 'string' || !/^[0-9a-f-]{36}$/.test(bindingId)
      || typeof credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(credentialHash))
      throw new ServiceError('invalid_request');
    const b = this;
    const binding = await accessRepository(this.db).binding(bindingId);
    if (!binding || binding.revoked_at || Date.parse(binding.expires_at) <= b.now() * 1000)
      throw new ServiceError('access_denied', 401);
    const id = randomUUID();
    const token = await b.sign('session-challenge', { bindingId, credentialHash, purpose: 'session',
      scopes: binding.scopes, credentialExpiresAt: Math.min(b.now() + 600, Date.parse(binding.expires_at) / 1000) }, id, 120);
    try {
      await accessRepository(this.db).insertChallenge( [id, bindingId, digest(token), credentialHash, new Date((b.now() + 120) * 1000).toISOString()]);
    } catch (error) {
      if (error.code === '23505') throw new ServiceError('credential_conflict', 409);
      throw error;
    }
    return { challenge: token };
  }

  async activate({ challenge, signature }, { httpRequestId = null } = {}) {
    const b = this;
    if (typeof challenge !== 'string' || challenge.length > 16384
      || typeof signature !== 'string' || signature.length > 24000) throw new ServiceError('invalid_request');
    let opened;
    try {
      opened = await verifyEnvelope(challenge, { type: 'session-challenge', issuer: b.endpoint,
        audience: b.endpoint, trustedKeys: b.trustedKeys, now: b.now(), maxAge: 120 });
    } catch { throw new ServiceError('access_denied', 401); }
    return transaction(this.db, async db => {
      // Same lock order as revoke: lock binding before credentials. Revocation wins subsequent authentication.
      const binding = await accessRepository(db).lockBinding(opened.data.bindingId);
      if (!binding || binding.revoked_at || Date.parse(binding.expires_at) <= b.now() * 1000)
        throw new ServiceError('access_denied', 401);
      try {
        const verified = await compactVerify(signature, await importSPKI(binding.public_key, 'Ed25519'), { algorithms: ['Ed25519'] });
        if (Object.keys(verified.protectedHeader).sort().join(',') !== 'alg,typ'
          || verified.protectedHeader.typ !== 'galaxy-session-response+jws'
          || Buffer.from(verified.payload).toString('utf8') !== challenge) throw new Error('Invalid signature');
      } catch { throw new ServiceError('access_denied', 401); }
      const row = await accessRepository(db).lockChallenge(opened.id);
      if (!row || row.challenge_hash !== digest(challenge) || row.binding_id !== binding.id
        || Date.parse(row.expires_at) <= b.now() * 1000) throw new ServiceError('access_denied', 401);
      if (!row.consumed_at) {
        await accessRepository(db).insertCredential( [row.credential_hash, binding.id, JSON.stringify(opened.data.scopes),
          new Date(opened.data.credentialExpiresAt * 1000).toISOString()]);
        await accessRepository(db).consumeChallenge(row.id, new Date(b.now() * 1000).toISOString());
        await accessRepository(db).auditSession(binding.subject_id, binding.id, row.id, httpRequestId);
      }
      return { bindingId: binding.id, expiresAt: opened.data.credentialExpiresAt, scopes: opened.data.scopes };
    });
  }

  async authenticate(token, requiredScope = 'binding') {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
      || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new ServiceError('access_denied', 401);
    const now = new Date(this.now() * 1000).toISOString();
    const row = await accessRepository(this.db).authenticate(digest(token), now);
    if (!row || row.audience !== this.endpoint || !row.scopes.includes(requiredScope))
      throw new ServiceError('access_denied', 401);
    return { subjectId: row.subject_id, bindingId: row.id, scopes: row.scopes, credentialHash: digest(token),
      deviceId:row.control?.deviceId??null,keyId:row.control?.keyId??null,controlEpoch:row.control?.epoch??0,
      authentication:Object.freeze({version:1,clientId:row.client_id,audience:row.audience,scope:requiredScope,
        bindingScopes:Object.freeze([...row.binding_scopes]),credentialScopes:Object.freeze([...row.scopes])}) };
  }

  runResourceWrite(actor,scope,options,operation){return this.runAuthorized(actor,scope,operation,{resourceWrite:true,...options});}
  async runAuthorized(actor, scope, operation, {resourceWrite=false,control=false,isolation='read committed'}={}) {
    return transaction(this.db, async db => {
      const budget=resourceWrite?this.resourceBudgetPolicy:null;
      if(budget)await lockSubjectResourceBudget(db,actor.subjectId);
      const external=this.externalAuthorization?.owns(actor)?this.externalAuthorization:null;
      const row = external ? await external.lock(db,actor)
        : await accessRepository(db).lockAuthorization(actor, this.endpoint, new Date(this.now() * 1000).toISOString());
      if (!row || !row.scopes.includes(scope)) throw new ServiceError('access_denied', 401);
      // Pass only the freshly locked public authorization data, never the token/hash.
      const before=budget&&!control?await subjectResourceUsage(db,actor.subjectId,this.now()):null;
      const result=await operation(db, Object.freeze({ callerBindingId: row.id, credentialScopes: Object.freeze([...row.scopes]),
        ...(row.control?{identityControl:Object.freeze({...row.control})}:{}) }));
      if(external)await external.record(db,actor,row,scope);
      if(before)enforceResourceGrowth(before,await subjectResourceUsage(db,actor.subjectId,this.now()),budget);
      return result;
    },{isolation});
  }
}
