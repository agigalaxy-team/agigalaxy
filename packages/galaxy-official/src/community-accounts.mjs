import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './shared/service-error.mjs';
import {lockControllerMappingsWithin} from './controller-mapping-lock.mjs';

const iso = seconds => new Date(seconds * 1000).toISOString();
const linkInput = z.strictObject({ subjectId: z.string().min(1).max(128), linkId: z.uuid(),
  endpoint: z.url(), issuer: z.url(), externalSubject: z.string().min(1).max(255),
  verifiedAt: z.number().int().nonnegative(), verificationMethod: z.enum(['email','external-account']) });

// Called only by the server's verified OIDC callback + signed Galaxy association.
// No HTTP endpoint accepts these verification facts from a caller.
export class CommunityAccountRegistry {
  constructor(access, providers = []) {
    this.access = access;
    this.providers = new Set(providers.map(provider => {
      const d = provider.describe(); return JSON.stringify([d.issuer, d.clientId]);
    }));
  }
  async linkVerifiedWithin(db, input) {
    const parsed = linkInput.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_account_verification');
    const data = parsed.data;
    if (data.endpoint !== this.access.endpoint || data.verifiedAt > this.access.now()) throw new ServiceError('invalid_account_verification');
    // Mapping writes take the subject key before account upsert/row locks.
    // Multiple subjects sharing one account therefore never acquire each
    // other's controller key while holding that account row.
    await lockControllerMappingsWithin(db,this.access.endpoint,[data.subjectId],{exclusive:true});
    const link = (await db.query(`SELECT * FROM external_identity_links WHERE id=$1 AND subject_id=$2 AND endpoint=$3
      AND issuer=$4 AND external_subject=$5 AND revoked_at IS NULL`,
    [data.linkId, data.subjectId, data.endpoint, data.issuer, data.externalSubject])).rows[0];
    if (!link || !this.providers.has(JSON.stringify([link.issuer, link.client_id]))) throw new ServiceError('identity_provider_unavailable', 409);
    const account = (await db.query(`INSERT INTO community_accounts(id,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(endpoint,issuer,external_subject)
      DO UPDATE SET verified_at=EXCLUDED.verified_at,verification_method=EXCLUDED.verification_method RETURNING id`,
    [randomUUID(), data.endpoint, data.issuer, data.externalSubject, data.verificationMethod, iso(data.verifiedAt)])).rows[0];
    await db.query(`INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(identity_link_id) DO NOTHING`,
    [data.linkId, account.id, data.subjectId, iso(this.access.now())]);
    return { accountId: account.id, accountVerified: true, galaxyAuthorization: false };
  }
  async resolveWithin(db, actor, { lock = false } = {}) {
    // The first still-active, configured association is stable across tokens/devices.
    // A removed provider or explicit unlink does not authorize further public writes.
    const rows = (await db.query(`SELECT a.*,l.client_id FROM community_accounts a
      JOIN community_account_links g ON g.account_id=a.id JOIN external_identity_links l ON l.id=g.identity_link_id
      WHERE g.subject_id=$1 AND l.revoked_at IS NULL AND a.endpoint=$2 ORDER BY a.created_at,a.id`,
    [actor.subjectId, this.access.endpoint])).rows;
    const found = rows.find(row => this.providers.has(JSON.stringify([row.issuer, row.client_id])));
    if (!found) throw new ServiceError('account_verification_required', 403);
    return lock ? (await db.query('SELECT * FROM community_accounts WHERE id=$1 FOR UPDATE', [found.id])).rows[0] : found;
  }
  async recordInteractionWithin(db, { subjectId, counterpartyId, sourceId, sourceKind }) {
    // Internal accepted interaction hook, never a self-reported account-upgrade API.
    if (subjectId === counterpartyId || !z.uuid().safeParse(sourceId).success
      || !['accepted-participation','accepted-delivery','moderator-confirmed-interaction'].includes(sourceKind)) return;
    let account;
    try { account = await this.resolveWithin(db, { subjectId }); }
    catch (error) { if (error.code === 'account_verification_required') return; throw error; }
    const own = (await db.query('SELECT 1 FROM community_account_links WHERE account_id=$1 AND subject_id=$2 LIMIT 1',
      [account.id, counterpartyId])).rows.length;
    if (own) return;
    await db.query(`INSERT INTO community_interactions(account_id,source_id,source_kind,counterparty_id,created_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,source_id) DO NOTHING`,
    [account.id, sourceId, sourceKind, counterpartyId, iso(this.access.now())]);
  }
}
