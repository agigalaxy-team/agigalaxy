import { z } from 'zod';
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ServiceError } from "../shared/service-error.mjs";
import {p14QuotaCounts} from "../operations/rules/quota.mjs";

const DAY = 86400;
const iso = seconds => new Date(seconds * 1000).toISOString();
export const defaultCommunityPolicy = Object.freeze({ version: 'community-quota/1',
  new: Object.freeze({ task: 2, comment: 20, invitation: 5 }),
  normal: Object.freeze({ task: 10, comment: 100, invitation: 20 }),
  promotionDays: 7, invitationCooldownDays: 7 });
const limits = z.strictObject({ task: z.number().int().positive(), comment: z.number().int().positive(), invitation: z.number().int().positive() });
const policySchema = z.strictObject({ version: z.string().min(1).max(80), new: limits, normal: limits,
  promotionDays: z.number().int().min(1).max(365), invitationCooldownDays: z.number().int().min(1).max(365) });
const operationSchema = z.strictObject({ kind: z.enum(['task','recruitment','comment','invitation']), operationId: z.uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/), taskId: z.uuid().optional(), roomId: z.uuid().optional(), contactId: z.uuid().optional(), recruitmentId:z.uuid().optional(), recipientId: z.string().min(1).max(128).optional() })
  .refine(input => [input.taskId, input.roomId, input.contactId,input.recruitmentId].filter(Boolean).length <= 1)
  .refine(input => (input.kind==='recruitment')===Boolean(input.recruitmentId));

export async function loadCommunityPolicy(path) {
  if (!path) return policySchema.parse(defaultCommunityPolicy);
  if (!isAbsolute(path)) throw new Error('Absolute community policy path required');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid community policy file');
  return policySchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export class PublicWriteService {
  constructor(access, accounts, policy = defaultCommunityPolicy) {
    this.access = access; this.accounts = accounts; this.policy = policySchema.parse(policy);
  }
  async tierWithin(db, account, now) {
    if (account.tier_override) return account.tier_override;
    if (Date.parse(account.created_at) + this.policy.promotionDays * DAY * 1000 > now * 1000) return 'new';
    const realInteraction = (await db.query('SELECT 1 FROM community_interactions WHERE account_id=$1 AND invalidated_at IS NULL LIMIT 1', [account.id])).rows.length;
    return realInteraction ? 'normal' : 'new';
  }
  async quotaWithin(db, account, kind, now) {
    const day = iso(now).slice(0, 10), tier = await this.tierWithin(db, account, now);
    const used = Number((await db.query('SELECT used FROM community_daily_usage WHERE account_id=$1 AND day=$2 AND category=$3',
      [account.id, day, kind])).rows[0]?.used ?? 0);
    const limit = this.policy[tier][kind];
    return { category: kind, ...(kind==='task'?{covers:['task-publication','recruitment-publication']}:{}), ...p14QuotaCounts(limit,used), tier,
      resetAt: iso((Math.floor(now / DAY) + 1) * DAY), policyVersion: this.policy.version };
  }
  async status(actor) {
    return this.accounts.runAuthorized(actor, 'binding', async db => {
      let account;
      try { account = await this.accounts.resolveWithin(db, actor); }
      catch (error) { if (error.code === 'account_verification_required') return { accountVerified: false, quotas: [], reason: error.code }; throw error; }
      const now = this.access.now();
      const quotas = [];
      for (const kind of ['task','comment','invitation']) quotas.push(await this.quotaWithin(db, account, kind, now));
      return { accountId: account.id, accountVerified: true,
        restriction: account.restricted_until && Date.parse(account.restricted_until) > now * 1000
          ? { until: new Date(account.restricted_until).toISOString(), reason: account.restriction_reason } : null,
        quotas };
    });
  }
  async consumeWithin(db, actor, input) {
    const parsed = operationSchema.safeParse(input);
    if (!parsed.success || parsed.data.kind === 'invitation' && (!parsed.data.recipientId || !(parsed.data.taskId || parsed.data.roomId || parsed.data.contactId)))
      throw new ServiceError('invalid_public_write');
    const op = parsed.data, now = this.access.now(),category=op.kind==='recruitment'?'task':op.kind;
    const accountActor=actor.kind==='official-account',actorRef=accountActor?'account:'+actor.accountId:actor.subjectId;
    // Same account lock covers quota check, insertion and the caller's business write.
    // Caller must already be in its authorized transaction; rollback refunds a failed operation.
    const account = await this.accounts.resolveWithin(db, actor, { lock: true });
    const prior = (await db.query('SELECT * FROM community_write_receipts WHERE account_id=$1 AND category=$2 AND operation_id=$3',
      [account.id, category, op.operationId])).rows[0];
    if (prior) {
      if (prior.actor_ref!==actorRef || prior.payload_hash !== op.payloadHash || prior.task_id !== (op.taskId ?? null) || prior.room_id !== (op.roomId ?? null) || prior.contact_id !== (op.contactId ?? null) || prior.recruitment_id !== (op.recruitmentId ?? null) || prior.recipient_id !== (op.recipientId ?? null))
        throw new ServiceError('public_write_conflict', 409);
      return this.quotaWithin(db, account, category, now);
    }
    if (account.restricted_until && Date.parse(account.restricted_until) > now * 1000)
      throw Object.assign(new ServiceError('community_restricted', 403), { restrictionReason: account.restriction_reason,
        retryAfterSeconds: Math.ceil(Date.parse(account.restricted_until) / 1000 - now) });
    if (op.kind === 'invitation') {
      const pending = (await db.query(`SELECT created_at FROM community_write_receipts WHERE account_id=$1 AND category='invitation'
        AND recipient_id=$2 AND responded_at IS NULL AND created_at>$3 ORDER BY created_at DESC LIMIT 1`,
      [account.id, op.recipientId, iso(now - this.policy.invitationCooldownDays * DAY)])).rows[0];
      if (pending) throw Object.assign(new ServiceError('invitation_cooldown', 429), {
        retryAfterSeconds: Math.ceil(Date.parse(pending.created_at) / 1000 + this.policy.invitationCooldownDays * DAY - now) });
    }
    const quota = await this.quotaWithin(db, account, category, now);
    if (quota.remaining === 0) throw Object.assign(new ServiceError('community_quota_exceeded', 429), { quota,
      retryAfterSeconds: Math.ceil(Date.parse(quota.resetAt) / 1000 - now) });
    await db.query(`INSERT INTO community_write_receipts(account_id,operation_id,category,subject_id,payload_hash,task_id,recipient_id,created_at,room_id,contact_id,recruitment_id,actor_ref,actor_kind)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [account.id, op.operationId, category, accountActor?null:actor.subjectId, op.payloadHash, op.taskId ?? null, op.recipientId ?? null, iso(now), op.roomId ?? null, op.contactId ?? null,op.recruitmentId??null,actorRef,accountActor?'official-account':'identity']);
    await db.query(`INSERT INTO community_daily_usage(account_id,day,category,used) VALUES($1,$2,$3,1)
      ON CONFLICT(account_id,day,category) DO UPDATE SET used=community_daily_usage.used+1`, [account.id, iso(now).slice(0,10), category]);
    return { ...quota, used: quota.used + 1, remaining: quota.remaining - 1 };
  }
  async markInvitationRespondedWithin(db, { taskId, roomId, contactId, recipientId }) {
    if ([taskId, roomId, contactId].filter(Boolean).length !== 1) throw new ServiceError('invalid_public_write');
    const column = contactId ? 'contact_id' : roomId ? 'room_id' : 'task_id';
    await db.query(`UPDATE community_write_receipts SET responded_at=$3 WHERE ${column}=$1 AND recipient_id=$2
      AND category='invitation' AND responded_at IS NULL`, [contactId ?? roomId ?? taskId, recipientId, iso(this.access.now())]);
  }
}
