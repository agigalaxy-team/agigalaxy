import * as z from 'zod/v4';
import { transaction } from './database.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { recordTaskCommentAudit } from './infrastructure/task-comment-v2-audit.mjs';
import {
  taskCommentV2Schema,
  commentQueryV2Schema,
  commentReceiptV2Schema,
  commentRulePolicySchema,
  defaultCommentRulePolicy,
} from './shared/task-comment-v2-schema.mjs';

export const commentDay = 86400;
export const commentStamp = (n) => new Date(n * 1000).toISOString();
export function parseCommentInput(text, schema) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 30000)
      throw new Error();
    return schema.parse(JSON.parse(text));
  } catch {
    throw new ServiceError('invalid_comment_payload');
  }
}
const unavailable = (e) =>
  e instanceof ServiceError && [403, 404].includes(e.status);
export function commentFingerprints(body) {
  const normal = body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const links = [];
  for (const raw of normal.match(/https?:\/\/[^\s<>]+/g) ?? [])
    try {
      const url = new URL(raw.replace(/[.,，。)）]+$/g, ''));
      url.hash = '';
      links.push(digest(url.toString()));
    } catch {}
  return {
    text: digest(normal),
    links: [...new Set(links)],
    mentions: (
      normal.match(/@(?:guid[0-9a-z]{28}|[\p{L}\p{N}_-]{2,64})/gu) ?? []
    ).length,
  };
}

export class TaskCommentServiceV2 {
  constructor(
    access,
    consents,
    tasks,
    {
      accounts,
      publicWrites,
      inbox = null,
      rulePolicy = defaultCommentRulePolicy,
    } = {},
  ) {
    Object.assign(this, {
      access,
      consents,
      tasks,
      accounts,
      publicWrites,
      inbox,
    });
    this.rulePolicy = commentRulePolicySchema.parse(rulePolicy);
  }
  grant(db, row) {
    return this.consents.require(db, {
      id: row.consent_id,
      subjectId: row.subject_id,
      objectId: row.id,
      payloadJson: row.payload_text,
      action: 'comment.publish',
      recipient: this.access.endpoint,
    });
  }
  async row(db, id, { lock = false } = {}) {
    return (
      await db.query(
        `SELECT * FROM task_comments_v2 WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0];
  }
  event(db, id) {
    return db
      .query('SELECT * FROM task_comment_events_v2 WHERE id=$1', [id])
      .then((r) => r.rows[0]);
  }
  async heldWithin(db, row, revision = row.revision) {
    return (
      await db.query(
        'SELECT id,pause_until FROM comment_reports_v2 WHERE comment_id=$1 AND comment_revision=$2 AND pause_until>$3 ORDER BY id',
        [row.id, revision, commentStamp(this.access.now())],
      )
    ).rows;
  }
  async sourceWithin(db, actor, row, revision = row.revision) {
    const task = await this.tasks.requireTaskWithin(db, actor, row.task_id);
    if (Date.parse(row.expires_at) <= this.access.now() * 1000)
      throw new ServiceError('comment_expired', 403);
    const source = (
      await db.query(
        'SELECT * FROM task_comment_events_v2 WHERE comment_id=$1 AND revision=$2',
        [row.id, revision],
      )
    ).rows[0];
    if (!source?.payload_text || source.erased_at)
      throw new ServiceError('comment_source_erased', 403);
    const grant = await this.grant(db, source);
    if (
      !canReadProjection(grant, {
        viewerId: actor?.subjectId ?? null,
        now: this.access.now(),
      })
    )
      throw new ServiceError('comment_permission_unavailable', 403);
    return { task, source, grant, payload: JSON.parse(source.payload_text) };
  }
  async readWithin(db, actor, id, { revision = null, review = false } = {}) {
    const row = await this.row(db, id);
    if (!row) throw new ServiceError('not_found', 404);
    await this.tasks.requireTaskWithin(db, actor, row.task_id);
    const requested = revision ?? row.revision,
      own = actor?.subjectId === row.subject_id;
    // Old versions are not a hidden-body archive for other readers. A scoped
    // review is a service-internal call after exact report/role authorization.
    if (requested !== row.revision && !own && !review)
      throw new ServiceError('comment_version_unavailable', 404);
    let state =
      row.state === 'retracted'
        ? 'retracted'
        : requested === row.revision
          ? row.review_state
          : 'historical';
    const held = await this.heldWithin(db, row, requested);
    if (held.length) state = 'governance-hidden';
    let source = null;
    try {
      source = await this.sourceWithin(db, actor, row, requested);
    } catch (e) {
      if (!unavailable(e)) throw e;
      state = e.code.replaceAll('_', '-');
    }
    const contentAllowed =
      source &&
      row.state !== 'retracted' &&
      (review ||
        own ||
        !['pending-review', 'rejected', 'governance-hidden'].includes(state));
    if (
      actor &&
      this.inbox &&
      !own &&
      !review &&
      (await this.inbox.isBlockedWithin(db, actor.subjectId, row.subject_id))
    )
      state = 'blocked';
    const content =
      contentAllowed && state !== 'blocked'
        ? (source.payload.body ?? null)
        : null;
    let reply = null;
    if (row.reply_to_id) {
      reply = {
        id: row.reply_to_id,
        revision: row.reply_to_revision,
        body: null,
        state: 'unavailable',
      };
      const parent = await this.row(db, row.reply_to_id);
      if (
        parent &&
        parent.revision === row.reply_to_revision &&
        parent.state === 'active' &&
        !['pending-review', 'rejected'].includes(parent.review_state) &&
        !(await this.heldWithin(db, parent)).length
      ) {
        try {
          const p = await this.sourceWithin(db, actor, parent);
          if (
            !this.inbox ||
            !actor ||
            !(await this.inbox.isBlockedWithin(
              db,
              actor.subjectId,
              parent.subject_id,
            ))
          )
            reply = {
              ...reply,
              body: p.payload.body?.slice(0, 240) ?? null,
              state: 'visible',
            };
        } catch (e) {
          if (!unavailable(e)) throw e;
        }
      }
    }
    return {
      commentId: id,
      taskId: row.task_id,
      authorId: row.subject_id,
      revision: requested,
      currentRevision: row.revision,
      state:
        content && ['clear', 'approved'].includes(state) ? 'visible' : state,
      body: content,
      replyTo: reply,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      ...(own || review
        ? {
            rule: { version: row.rule_version, reasons: row.rule_reasons },
            activeRestrictions: held.map((h) => ({
              reportId: h.id,
              until: new Date(h.pause_until).toISOString(),
            })),
          }
        : {}),
      canEdit:
        own &&
        row.state === 'active' &&
        !!source &&
        Date.parse(row.created_at) + commentDay * 1000 >
          this.access.now() * 1000,
      canCorrect: own && row.state === 'active' && !!source,
      canRetract: own && row.state === 'active',
      taskStateChanged: false,
      participationCreated: false,
      capabilityVerified: false,
      authority: 'current-authorized-comment-view',
    };
  }
  async inspectRules(db, account, row, body) {
    const policy = this.rulePolicy,
      fp = commentFingerprints(body),
      reasons = [];
    const rows = (
      await db.query(
        `SELECT c.id,c.task_id,e.text_fingerprint,e.link_fingerprints FROM task_comments_v2 c
   JOIN task_comment_events_v2 e ON e.comment_id=c.id WHERE c.account_id=$1 AND c.id<>$2 AND e.created_at>$3 AND e.erased_at IS NULL AND e.text_fingerprint IS NOT NULL`,
        [
          account.id,
          row.id,
          commentStamp(this.access.now() - policy.duplicateWindowSeconds),
        ],
      )
    ).rows;
    if (
      new Set(
        rows.filter((x) => x.text_fingerprint === fp.text).map((x) => x.id),
      ).size +
        1 >=
      policy.duplicateThreshold
    )
      reasons.push('repeated-normalized-content');
    if (
      fp.links.some(
        (link) =>
          new Set([
            ...rows
              .filter((x) => x.link_fingerprints.includes(link))
              .map((x) => x.task_id),
            row.task_id,
          ]).size >= policy.linkTaskThreshold,
      )
    )
      reasons.push('repeated-link-across-tasks');
    if (fp.mentions > policy.maxMentions) reasons.push('bulk-mentions');
    if (
      row.revision &&
      (row.review_state === 'rejected' ||
        (await this.heldWithin(db, row)).length)
    )
      reasons.push('changed-after-moderation');
    return {
      fingerprints: fp,
      reasons,
      state: reasons.length ? 'pending-review' : 'clear',
    };
  }
  async replay(db, actor, input, consentId, payloadJson) {
    const p = await this.event(db, input.id);
    if (!p) return null;
    if (
      p.subject_id !== actor.subjectId ||
      p.comment_id !== input.commentId ||
      p.task_id !== input.taskId ||
      p.consent_id !== consentId ||
      p.payload_hash !== digest(payloadJson)
    )
      throw new ServiceError('comment_conflict', 409);
    return {
      commentId: p.comment_id,
      operationId: p.id,
      revision: p.revision,
      acknowledged: true,
      taskStateChanged: false,
      authority: 'accepted-event-only; recheck-current-view',
    };
  }
  async submit(actor, inputEnvelope) {
    const { consentId, payloadJson } = inputEnvelope,
      p = parseCommentInput(payloadJson, taskCommentV2Schema);
    return this.access.runResourceWrite(
      actor,
      'assistance',
      { control: p.kind === 'retract' },
      async (db, authorization) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'comment-operation:' + p.id,
        ]);
        const old = await this.replay(db, actor, p, consentId, payloadJson);
        if (old) return old;
        // Match Task writes: Task before Account. A shared Task lock keeps the
        // authorized root stable without changing any work state.
        const task =
            p.kind === 'retract'
              ? null
              : await this.tasks.requireTaskWithin(db, actor, p.taskId);
        let account;
        if (p.kind !== 'retract') {
          if (!this.accounts || !this.publicWrites)
            throw new ServiceError('comment_account_service_unavailable', 503);
          account = await this.accounts.resolveWithin(db, actor, {
            lock: true,
          });
        }
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'comment-object:' + p.commentId,
        ]);
        let row = await this.row(db, p.commentId, { lock: true });
        if (p.kind === 'create') {
          if (row || p.expectedRevision !== 0)
            throw new ServiceError('comment_revision_conflict', 409);
          row = {
            id: p.commentId,
            task_id: p.taskId,
            subject_id: actor.subjectId,
            revision: 0,
            created_at: commentStamp(this.access.now()),
            expires_at: commentStamp(this.access.now() + 90 * commentDay),
          };
        } else {
          if (
            !row ||
            row.subject_id !== actor.subjectId ||
            row.task_id !== p.taskId
          )
            throw new ServiceError('not_found', 404);
          if (row.revision !== p.expectedRevision)
            throw new ServiceError('comment_revision_conflict', 409);
          if (row.state === 'retracted')
            throw new ServiceError('comment_retracted', 409);
        }
        const revision = row.revision + 1;
        if (revision > this.rulePolicy.maxVersions && p.kind !== 'retract')
          throw new ServiceError('comment_revision_limit', 413);
        const eventRow = {
            id: p.id,
            subject_id: actor.subjectId,
            consent_id: consentId,
            payload_text: payloadJson,
          },
          grant = await this.grant(db, eventRow);
        if (p.kind === 'retract') {
          if (grant.visibility !== 'Private' || grant.viewers.length)
            throw new ServiceError('comment_retraction_private', 403);
        } else {
          if (grant.currentVisibility?.deletionPending)
            throw new ServiceError('comment_author_deletion_pending', 403);
          if (Date.parse(row.expires_at) <= this.access.now() * 1000)
            throw new ServiceError('comment_expired', 403);
          if (
            p.kind === 'edit' &&
            Date.parse(row.created_at) + commentDay * 1000 <=
              this.access.now() * 1000
          )
            throw new ServiceError('comment_edit_window_closed', 409);
          if (
            account.restricted_until &&
            Date.parse(account.restricted_until) > this.access.now() * 1000
          )
            throw new ServiceError('community_restricted', 403);
          const expected = task.rootGrant.visibility;
          if (
            grant.visibility !== expected ||
            (expected === 'Private' &&
              grant.viewers.some(
                (id) =>
                  !canReadProjection(task.rootGrant, {
                    viewerId: id,
                    now: this.access.now(),
                  }),
              ))
          )
            throw new ServiceError('comment_visibility_mismatch', 403);
          if (p.kind === 'create' && p.replyTo) {
            const parent = await this.readWithin(db, actor, p.replyTo.id);
            if (
              parent.taskId !== p.taskId ||
              parent.revision !== p.replyTo.revision ||
              !parent.body
            )
              throw new ServiceError('comment_reply_unavailable', 409);
          }
        }
        const checks =
          p.kind === 'retract'
            ? {
                reasons: row.rule_reasons ?? [],
                state: row.review_state ?? 'clear',
                fingerprints: { text: null, links: [] },
              }
            : await this.inspectRules(db, account, row, p.body);
        let quota = null;
        if (p.kind === 'create' && task.rootGrant.visibility === 'Public')
          quota = await this.publicWrites.consumeWithin(db, actor, {
            kind: 'comment',
            operationId: p.id,
            payloadHash: digest(payloadJson),
            taskId: p.taskId,
          });
        if (p.kind === 'create')
          await db.query(
            `INSERT INTO task_comments_v2(id,task_id,subject_id,account_id,revision,current_event_id,reply_to_id,reply_to_revision,rule_version,rule_reasons,review_state,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              p.commentId,
              p.taskId,
              actor.subjectId,
              account.id,
              revision,
              p.id,
              p.replyTo?.id ?? null,
              p.replyTo?.revision ?? null,
              this.rulePolicy.version,
              JSON.stringify(checks.reasons),
              checks.state,
              row.created_at,
              row.expires_at,
            ],
          );
        else
          await db.query(
            `UPDATE task_comments_v2 SET revision=$2,current_event_id=$3,state=$4,review_state=$5,rule_version=$6,rule_reasons=$7,review_event_id=NULL WHERE id=$1`,
            [
              p.commentId,
              revision,
              p.id,
              p.kind === 'retract' ? 'retracted' : 'active',
              checks.state,
              this.rulePolicy.version,
              JSON.stringify(checks.reasons),
            ],
          );
        await db.query(
          `INSERT INTO task_comment_events_v2(id,comment_id,task_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,text_fingerprint,link_fingerprints,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            p.id,
            p.commentId,
            p.taskId,
            actor.subjectId,
            revision,
            p.kind,
            consentId,
            payloadJson,
            digest(payloadJson),
            checks.fingerprints.text,
            JSON.stringify(checks.fingerprints.links),
            commentStamp(this.access.now()),
          ],
        );
        await recordTaskCommentAudit(db, actor, authorization, {
          id: p.id,
          action: 'comment.' + p.kind,
        });
        return {
          commentId: p.commentId,
          operationId: p.id,
          revision,
          state:
            p.kind === 'retract'
              ? 'retracted'
              : checks.state === 'clear'
                ? 'visible'
                : checks.state,
          rule: { version: this.rulePolicy.version, reasons: checks.reasons },
          quota,
          taskStateChanged: false,
          participationCreated: false,
        };
      },
    );
  }
  get(actor, id) {
    if (!z.uuid().safeParse(id).success)
      throw new ServiceError('not_found', 404);
    return actor
      ? this.access.runAuthorized(actor, 'assistance', (db) =>
          this.readWithin(db, actor, id),
        )
      : transaction(this.access.db, (db) => this.readWithin(db, null, id));
  }
  query(actor, input) {
    const p = commentQueryV2Schema.safeParse(input);
    if (!p.success) throw new ServiceError('invalid_comment_query');
    const q = p.data;
    const run = async (db) => {
      await this.tasks.requireTaskWithin(db, actor, q.taskId);
      const candidates = (
        await db.query(
          `SELECT id FROM task_comments_v2 WHERE task_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 200`,
          [q.taskId, q.after ?? null],
        )
      ).rows;
      const items = [];
      let after = null;
      for (const c of candidates) {
        after = c.id;
        const v = await this.readWithin(db, actor, c.id);
        if (
          !q.query ||
          v.body?.toLocaleLowerCase().includes(q.query.toLocaleLowerCase())
        )
          items.push(v);
        if (items.length === q.limit) break;
      }
      return {
        items,
        nextAfter:
          items.length === q.limit || candidates.length === 200 ? after : null,
        authority: 'current-task-comments',
        taskStateChanged: false,
      };
    };
    return actor
      ? this.access.runAuthorized(actor, 'assistance', run)
      : transaction(this.access.db, run);
  }
  receipt(actor, input) {
    const parsed = commentReceiptV2Schema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_comment_receipt');
    const q = parsed.data;
    return this.access.runAuthorized(actor, 'assistance', async (db) => {
      const row = await this.event(db, q.operationId);
      if (!row || row.subject_id !== actor.subjectId)
        return { state: 'absent', operationId: q.operationId };
      return {
        state: row.payload_hash === q.payloadHash ? 'acknowledged' : 'conflict',
        operationId: q.operationId,
        ...(row.payload_hash === q.payloadHash
          ? {
              commentId: row.comment_id,
              revision: row.revision,
              consentId: row.consent_id,
            }
          : {}),
        authority: 'accepted-event-only; not-current-content',
      };
    });
  }
}
