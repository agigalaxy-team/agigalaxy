import { randomUUID } from 'node:crypto';
import { compactVerify, importSPKI } from 'jose';
import { z } from 'zod';
import { digest } from './shared/digest.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { currentControlKey } from './infrastructure/identity-control-repository.mjs';

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const idInput = z.strictObject({ id: z.uuid() });
const parse = (schema, input) => { const result = schema.safeParse(input); if (!result.success) throw new ServiceError('invalid_request'); return result.data; };
const unavailable = () => new ServiceError('identity_login_unavailable', 409);
const iso = value => new Date(value * 1000).toISOString();

async function audit(db, actor, authorization, id, action) {
  const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
    context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,
    binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,'binding',b.id,$4,$3,
    b.scopes,$5::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes
    FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$6 AND b.subject_id=$1 RETURNING sequence`,
  [actor.subjectId, action, id, actor.httpRequestId ?? null, JSON.stringify(authorization.credentialScopes), authorization.callerBindingId]);
  if (result.rows.length !== 1) throw new Error('Identity audit context unavailable.');
}

// OIDC identifies an external account. Only the existing Galaxy key can approve
// its association. Neither a callback nor this association creates an API grant.
export class IdentityLinkService {
  #pending = new Map();
  #providers;
  constructor(access, providers = [], {accountRegistry} = {}) {
    this.access = access;
    this.accountRegistry=accountRegistry;
    this.#providers = new Map(providers.map(provider => [provider.describe().id, provider]));
    if (this.#providers.size !== providers.length || providers.length > 8) throw new Error('Invalid identity providers.');
    for (const provider of providers) {
      const description = provider.describe();
      if (!identifier.safeParse(description.id).success || description.redirectUri !== `${access.endpoint}/v1/identity/callback/${description.id}`)
        throw new Error('Identity provider callback must match this endpoint.');
    }
  }
  #purge() {
    for (const [id, login] of this.#pending) if (login.expiresAt <= this.access.now()) {
      if (login.preview) login.provider.cancel(login.preview);
      this.#pending.delete(id);
    }
  }
  #owned(actor, id) {
    this.#purge();
    const login = this.#pending.get(id);
    if (!login || login.subjectId !== actor.subjectId || login.bindingId !== actor.bindingId) throw unavailable();
    return login;
  }
  async providers(actor) {
    return this.access.runAuthorized(actor, 'binding', async () => ({ endpoint: this.access.endpoint,
      providers: [...this.#providers.values()].map(provider => provider.describe()), galaxyAuthorization: false }));
  }
  async begin(actor, input) {
    const { providerId } = parse(z.strictObject({ providerId: identifier }), input);
    const provider = this.#providers.get(providerId);
    if (!provider) throw new ServiceError('identity_provider_unavailable', 404);
    let id;
    try {
      return await this.access.runAuthorized(actor, 'binding', async () => {
        this.#purge();
        if (this.#pending.size >= 2048 || [...this.#pending.values()].filter(login => login.subjectId === actor.subjectId).length >= 4)
          throw new ServiceError('identity_login_limit', 429);
        id = randomUUID();
        const login = { provider, subjectId: actor.subjectId, bindingId: actor.bindingId, state: 'preparing', expiresAt: this.access.now() + 300 };
        this.#pending.set(id, login);
        login.preview = await provider.begin();
        login.stateHash = digest(new URL(login.preview.authorizationUrl).searchParams.get('state'));
        login.expiresAt = login.preview.expiresAt;
        login.state = 'awaiting-login';
        return { ...login.preview, loginId: id, subjectId: actor.subjectId, bindingId: actor.bindingId,
          endpoint: this.access.endpoint, galaxyAuthorization: false };
      });
    } catch (error) { if (id) { const login = this.#pending.get(id); if (login?.preview) provider.cancel(login.preview); this.#pending.delete(id); } throw error; }
  }
  async callback(providerId, returnedUrl) {
    this.#purge();
    const url = new URL(returnedUrl), state = url.searchParams.get('state');
    if (!state || state.length > 256 || url.searchParams.getAll('state').length !== 1) throw unavailable();
    const entry = [...this.#pending.entries()].find(([, login]) => login.provider.describe().id === providerId && login.stateHash === digest(state));
    if (!entry || entry[1].state !== 'awaiting-login') throw unavailable();
    const [id, login] = entry;
    login.state = 'exchanging';
    try {
      const identity = await login.provider.complete(login.preview, returnedUrl);
      login.accountVerification=identity.accountVerification;
      const binding = (await this.access.db.query(`SELECT id FROM bindings WHERE id=$1 AND subject_id=$2 AND audience=$3
        AND revoked_at IS NULL AND expires_at>$4`, [login.bindingId, login.subjectId, this.access.endpoint, iso(this.access.now())])).rows[0];
      if (!binding || this.#pending.get(id) !== login || login.state !== 'exchanging' || identity.expiresAt <= this.access.now()) throw unavailable();
      login.intent = Object.freeze({ version: 1, id, action: 'identity.link', subjectId: login.subjectId, bindingId: login.bindingId,
        endpoint: this.access.endpoint, providerId, issuer: identity.issuer, externalSubject: identity.externalSubject, clientId: identity.clientId,
        authentication: identity.authentication, verifiedAt: identity.verifiedAt, issuedAt: this.access.now(), expiresAt: identity.expiresAt,
        galaxyAuthorization: false });
      login.payloadJson = JSON.stringify(login.intent);
      login.state = 'awaiting-local-signature';
      return { state: login.state, message: 'Return to your Galaxy host to review and sign the account association.', galaxyAuthorization: false };
    } catch { if (this.#pending.get(id) === login) login.state = 'failed'; throw new ServiceError('identity_login_failed', 401); }
  }
  async status(actor, input) {
    const { id } = parse(idInput, input);
    return this.access.runAuthorized(actor, 'binding', async db => {
      const login = this.#owned(actor, id);
      const prior = (await db.query('SELECT revoked_at FROM external_identity_links WHERE id=$1 AND subject_id=$2 AND endpoint=$3',
        [id, actor.subjectId, this.access.endpoint])).rows[0];
      const state = prior ? prior.revoked_at ? 'revoked' : 'linked' : login.state;
      return { id, state, expiresAt: login.expiresAt, galaxyAuthorization: false,
        ...(['awaiting-local-signature','linked'].includes(state) ? { intent: login.intent, payloadJson: login.payloadJson } : {}) };
    });
  }
  async cancel(actor, input) {
    const { id } = parse(idInput, input);
    return this.access.runAuthorized(actor, 'binding', async () => {
      const login = this.#owned(actor, id);
      login.state = 'canceled'; login.provider.cancel(login.preview); this.#pending.delete(id);
      return { id, state: 'canceled' };
    });
  }
  async confirm(actor, input) {
    const { id, signed } = parse(z.strictObject({ id: z.uuid(), signed: z.string().min(1).max(16384) }), input);
    try {
      return await this.access.runResourceWrite(actor, 'binding', {}, async (db, authorization) => {
        const control=authorization.identityControl??await currentControlKey(db,actor.subjectId,{scope:'binding'});
        let payloadJson;
        try {
          const verified = await compactVerify(signed, await importSPKI(control.publicKey, 'Ed25519'), { algorithms: ['Ed25519'] });
          if (Object.keys(verified.protectedHeader).sort().join(',') !== 'alg,typ' || verified.protectedHeader.typ !== 'galaxy-identity-link+jws') throw new Error();
          payloadJson = Buffer.from(verified.payload).toString('utf8');
        } catch { throw new ServiceError('identity_signature_invalid', 401); }
        const prior = (await db.query('SELECT * FROM external_identity_links WHERE id=$1', [id])).rows[0];
        if (prior) {
          if (prior.subject_id !== actor.subjectId || prior.binding_id !== actor.bindingId || prior.endpoint !== this.access.endpoint || prior.payload_text !== payloadJson)
            throw new ServiceError('identity_link_conflict', 409);
          return { id, state: prior.revoked_at ? 'revoked' : 'linked', galaxyAuthorization: false };
        }
        const login = this.#owned(actor, id);
        if (login.state !== 'awaiting-local-signature' || login.payloadJson !== payloadJson || login.intent.expiresAt <= this.access.now()) throw unavailable();
        const intent = login.intent;
        await db.query(`INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,
          payload_text,payload_hash,signature,created_at,signer_key_id,control_epoch,control_event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, actor.subjectId, actor.bindingId, this.access.endpoint, intent.providerId, intent.issuer, intent.externalSubject, intent.clientId,
          payloadJson, digest(payloadJson), signed, iso(this.access.now()),control.keyId,control.epoch,control.chainHead]);
        if(login.accountVerification?.method==='email'&&login.accountVerification.verified===true&&this.accountRegistry)
          await this.accountRegistry.linkVerifiedWithin(db,{subjectId:actor.subjectId,linkId:id,endpoint:this.access.endpoint,
            issuer:intent.issuer,externalSubject:intent.externalSubject,verifiedAt:intent.verifiedAt,verificationMethod:'email'});
        await audit(db, actor, authorization, id, 'identity.link');
        // Keep the short-lived intent until expiry, so transaction rollback and
        // uncertain HTTP outcomes can retry the exact signed association.
        return { id, state: 'linked', galaxyAuthorization: false };
      });
    } catch (error) { if (error.code === '23505') throw new ServiceError('identity_link_conflict', 409); throw error; }
  }
  async query(actor, input = {}) {
    const { id, after, limit } = parse(z.strictObject({ id: z.uuid().optional(), after: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(50) }), input);
    return this.access.runAuthorized(actor, 'binding', async db => {
      const rows = (await db.query(`SELECT l.*,b.revoked_at AS binding_revoked_at,b.expires_at AS binding_expires_at
        FROM external_identity_links l JOIN bindings b ON b.id=l.binding_id WHERE l.subject_id=$1 AND l.endpoint=$2
        AND ($3::uuid IS NULL OR l.id>$3) AND ($5::uuid IS NULL OR l.id=$5) ORDER BY l.id LIMIT $4`, [actor.subjectId, this.access.endpoint, after ?? null, limit + 1, id ?? null])).rows;
      const items = rows.slice(0, limit).map(row => {
        const provider = this.#providers.get(row.provider_id)?.describe();
        return { id: row.id, subjectId: row.subject_id, bindingId: row.binding_id, endpoint: row.endpoint,
          providerId: row.provider_id, issuer: row.issuer, externalSubject: row.external_subject, clientId: row.client_id,
          createdAt: new Date(row.created_at).toISOString(), revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
          state: row.revoked_at ? 'revoked' : row.binding_revoked_at || Date.parse(row.binding_expires_at) <= this.access.now() * 1000 ? 'binding-inactive'
            : provider?.issuer !== row.issuer || provider?.clientId !== row.client_id ? 'provider-unavailable' : 'linked', galaxyAuthorization: false };
      });
      return { subjectId: actor.subjectId, endpoint: this.access.endpoint, items, nextAfter: rows.length > limit ? items.at(-1).id : null };
    }, { isolation: 'repeatable read' });
  }
  async revoke(actor, input) {
    const { id } = parse(idInput, input);
    return this.access.runAuthorized(actor, 'binding', async (db, authorization) => {
      const row = (await db.query('SELECT * FROM external_identity_links WHERE id=$1 AND subject_id=$2 AND endpoint=$3 FOR UPDATE',
        [id, actor.subjectId, this.access.endpoint])).rows[0];
      if (!row) throw new ServiceError('not_found', 404);
      if (!row.revoked_at) {
        await db.query('UPDATE external_identity_links SET revoked_at=$2 WHERE id=$1', [id, iso(this.access.now())]);
        await audit(db, actor, authorization, id, 'identity.unlink');
      }
      return { id, state: 'revoked', galaxyAuthorization: false };
    });
  }
}
