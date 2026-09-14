import * as z from 'zod/v4';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { canReadProjection } from './domain/consent-policy.mjs';
import { moderatorIdsSchema } from './shared/moderation-schema.mjs';
import {
  commentReportV2Schema,
  commentModerationV2Schema,
  commentReceiptV2Schema,
} from './shared/task-comment-v2-schema.mjs';
import {
  parseCommentInput,
  commentDay,
  commentStamp,
} from './task-comments-v2.mjs';
import { recordTaskCommentAudit } from './infrastructure/task-comment-v2-audit.mjs';

const absent = (e) =>
  e instanceof ServiceError && [403, 404].includes(e.status);
export class CommentGovernanceServiceV2 {
  constructor(
    access,
    consents,
    comments,
    { moderatorIds = [], accounts = null } = {},
  ) {
    Object.assign(this, { access, consents, comments, accounts });
    this.moderatorIds = moderatorIdsSchema.parse(moderatorIds);
  }
  config(actor) {
    return this.access.runAuthorized(actor, 'moderation', async () => ({
      moderatorIds: [...this.moderatorIds],
      canModerate: this.moderatorIds.includes(actor.subjectId),
      reportTargets: ['task-comment'],
      configured: this.moderatorIds.length > 0,
      guaranteesResponse: false,
      automaticAccountRestriction: false,
    }));
  }
  grant(db, row) {
    return this.consents.require(db, {
      id: row.consent_id,
      subjectId: row.subject_id,
      objectId: row.id,
      payloadJson: row.payload_text,
      action: 'moderation.publish',
      recipient: this.access.endpoint,
    });
  }
  privateRecipients(grant, actorId, allowed) {
    if (
      grant.visibility !== 'Private' ||
      grant.viewers.some((id) => id !== actorId && !allowed.includes(id))
    )
      throw new ServiceError('comment_report_audience_mismatch', 403);
  }
  async load(db, id, lock = false) {
    return (
      await db.query(
        `SELECT r.*,c.task_id,c.subject_id author_id,t.requester_id FROM comment_reports_v2 r JOIN task_comments_v2 c ON c.id=r.comment_id JOIN task_requests t ON t.id=c.task_id WHERE r.id=$1${lock ? ' FOR UPDATE OF r' : ''}`,
        [id],
      )
    ).rows[0];
  }
  async parties(db, row) {
    const ids = (
      await db.query(
        "SELECT subject_id FROM task_participations WHERE task_id=$1 AND snapshot->>'confirmedAt' IS NOT NULL",
        [row.task_id],
      )
    ).rows.map((x) => x.subject_id);
    return [
      ...new Set([row.reporter_id, row.author_id, row.requester_id, ...ids]),
    ];
  }
  async independent(db, actor, row) {
    if (!this.moderatorIds.includes(actor.subjectId)) return false;
    const parties = await this.parties(db, row);
    if (parties.includes(actor.subjectId)) return false;
    // Known shared Account cannot multiply independent administrators. Unknown
    // control relationships stay unknown, not a proof of real-world independence.
    if (this.accounts) {
      let a;
      try {
        a = await this.accounts.resolveWithin(db, actor);
      } catch (e) {
        if (e.code !== 'account_verification_required') throw e;
      }
      if (
        a &&
        (
          await db.query(
            'SELECT 1 FROM community_account_links WHERE account_id=$1 AND subject_id=ANY($2::text[]) LIMIT 1',
            [a.id, parties],
          )
        ).rows.length
      )
        return false;
    }
    return true;
  }
  async readableEvents(db, actor, id) {
    const rows = (
        await db.query(
          'SELECT e.* FROM comment_governance_events_v2 e JOIN comment_reports_v2 r ON r.id=e.report_id WHERE report_id=$1 AND (r.closed_at IS NULL OR r.closed_at>$2) ORDER BY e.version',
          [id, commentStamp(this.access.now() - 180 * commentDay)],
        )
      ).rows,
      items = [];
    for (const row of rows)
      if (row.payload_text && !row.erased_at)
        try {
          const grant = await this.grant(db, row);
          if (
            canReadProjection(grant, {
              viewerId: actor.subjectId,
              now: this.access.now(),
            })
          )
            items.push({
              eventId: row.id,
              authorId: row.subject_id,
              version: row.version,
              at: new Date(row.created_at).toISOString(),
              ...JSON.parse(row.payload_text),
            });
        } catch (e) {
          if (!absent(e)) throw e;
        }
    return items;
  }
  async requireVisible(db, actor, row) {
    if (!row) throw new ServiceError('not_found', 404);
    const parties = await this.parties(db, row),
      events = await this.readableEvents(db, actor, row.id);
    if (!parties.includes(actor.subjectId) && !events.length)
      throw new ServiceError('not_found', 404);
    return { parties, events };
  }
  async accepted(db, actor, id, consentId, payloadJson) {
    const p = (
      await db.query('SELECT * FROM comment_governance_events_v2 WHERE id=$1', [
        id,
      ])
    ).rows[0];
    if (!p) return null;
    if (
      p.subject_id !== actor.subjectId ||
      p.consent_id !== consentId ||
      p.payload_hash !== digest(payloadJson)
    )
      throw new ServiceError('comment_governance_conflict', 409);
    return {
      reportId: p.report_id,
      eventId: p.id,
      version: p.version,
      acknowledged: true,
      authority: 'accepted-event-only; not-current-decision',
    };
  }
  async save(
    db,
    actor,
    authorization,
    { id, reportId, kind, version, consentId, payloadJson },
  ) {
    await db.query(
      `INSERT INTO comment_governance_events_v2(id,report_id,subject_id,version,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        reportId,
        actor.subjectId,
        version,
        kind,
        consentId,
        payloadJson,
        digest(payloadJson),
        commentStamp(this.access.now()),
      ],
    );
    await recordTaskCommentAudit(db, actor, authorization, {
      id,
      governance: true,
      action: 'comment.moderation.' + kind,
    });
  }
  report(actor, { consentId, payloadJson }) {
    const p = parseCommentInput(payloadJson, commentReportV2Schema);
    return this.access.runResourceWrite(
      actor,
      'moderation',
      {},
      async (db, authorization) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'comment-governance:' + p.id,
        ]);
        const prior = await this.accepted(
          db,
          actor,
          p.id,
          consentId,
          payloadJson,
        );
        if (prior) return prior;
        const first = await this.comments.row(db, p.target.id);
        if (!first) throw new ServiceError('not_found', 404);
        await this.comments.tasks.requireTaskWithin(db, actor, first.task_id);
        const source = await this.comments.row(db, p.target.id, { lock: true });
        const current = await this.comments.readWithin(db, actor, source.id);
        if (source.revision !== p.target.revision)
          throw new ServiceError('comment_report_version_conflict', 409);
        if (!current.body && actor.subjectId !== source.subject_id)
          throw new ServiceError('comment_report_source_unavailable', 403);
        // Authors may request review of their held content; that is not a fabricated
        // accusation by another person and does not create any restriction.
        const row = {
            id: p.id,
            subject_id: actor.subjectId,
            consent_id: consentId,
            payload_text: payloadJson,
          },
          grant = await this.grant(db, row);
        this.privateRecipients(grant, actor.subjectId, this.moderatorIds);
        if (grant.currentVisibility?.deletionPending)
          throw new ServiceError('comment_report_author_deletion_pending', 403);
        const count = Number(
          (
            await db.query(
              'SELECT count(*) FROM comment_reports_v2 WHERE comment_id=$1 AND reporter_id=$2',
              [source.id, actor.subjectId],
            )
          ).rows[0].count,
        );
        if (count >= 3) throw new ServiceError('comment_report_limit', 429);
        await db.query(
          'INSERT INTO comment_reports_v2(id,comment_id,comment_revision,reporter_id,subject_id,created_at) VALUES($1,$2,$3,$4,$4,$5)',
          [
            p.id,
            source.id,
            p.target.revision,
            actor.subjectId,
            commentStamp(this.access.now()),
          ],
        );
        await this.save(db, actor, authorization, {
          id: p.id,
          reportId: p.id,
          kind: 'report',
          version: 1,
          consentId,
          payloadJson,
        });
        return {
          reportId: p.id,
          eventId: p.id,
          version: 1,
          state: 'received',
          handlingState: grant.viewers.some(
            (id) => this.moderatorIds.includes(id) && id !== actor.subjectId,
          )
            ? 'awaiting-independent-handler'
            : 'awaiting-authorized-handler',
          contentDisposition: 'unchanged',
          restrictionCreated: false,
          capabilityVerdict: 'not-decided',
        };
      },
    );
  }
  event(actor, id, { consentId, payloadJson }) {
    const p = parseCommentInput(payloadJson, commentModerationV2Schema);
    if (p.reportId !== id)
      throw new ServiceError('comment_report_target_mismatch');
    return this.access.runResourceWrite(
      actor,
      'moderation',
      { control: ['withdraw-report', 'resume'].includes(p.kind) },
      async (db, authorization) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'comment-governance:' + p.id,
        ]);
        const prior = await this.accepted(
          db,
          actor,
          p.id,
          consentId,
          payloadJson,
        );
        if (prior) return prior;
        const first = await this.load(db, id);
        if (!first) throw new ServiceError('not_found', 404);
        // Match comment submission's Task -> Comment lock order. A case party may
        // still appeal after losing Task access, so lock metadata without widening it.
        await db.query('SELECT id FROM task_requests WHERE id=$1 FOR SHARE', [
          first.task_id,
        ]);
        const comment = await this.comments.row(db, first.comment_id, {
            lock: true,
          }),
          row = await this.load(db, id, true),
          { parties, events } = await this.requireVisible(db, actor, row);
        if (p.expectedVersion !== row.version)
          throw new ServiceError('comment_governance_version_conflict', 409);
        const decision = ['pause', 'resume', 'resolve'].includes(p.kind),
          independent = await this.independent(db, actor, row);
        if (
          decision &&
          (!independent ||
            !events.some((e) =>
              ['report', 'supplement', 'appeal'].includes(e.kind ?? 'report'),
            ))
        )
          throw new ServiceError('comment_independent_handler_required', 403);
        if (!decision && !parties.includes(actor.subjectId))
          throw new ServiceError('comment_party_required', 403);
        if (p.kind === 'withdraw-report' && row.reporter_id !== actor.subjectId)
          throw new ServiceError('comment_reporter_required', 403);
        const grant = await this.grant(db, {
          id: p.id,
          subject_id: actor.subjectId,
          consent_id: consentId,
          payload_text: payloadJson,
        });
        this.privateRecipients(
          grant,
          actor.subjectId,
          decision ? [...this.moderatorIds, ...parties] : this.moderatorIds,
        );
        if (
          decision &&
          [row.reporter_id, row.author_id].some(
            (party) =>
              party !== actor.subjectId && !grant.viewers.includes(party),
          )
        )
          throw new ServiceError('comment_decision_notice_required', 403);
        let state = row.state,
          closed = row.closed_at,
          pause = row.pause_until,
          appeals = row.appeal_count;
        if (p.kind === 'pause') {
          if (
            p.until <= this.access.now() ||
            p.until > this.access.now() + 7 * commentDay
          )
            throw new ServiceError('comment_pause_expiry', 409);
          await this.comments.sourceWithin(
            db,
            actor,
            comment,
            row.comment_revision,
          );
          pause = commentStamp(p.until);
        }
        if (p.kind === 'resume') {
          if (!row.pause_until)
            throw new ServiceError('comment_pause_not_present', 409);
          pause = null;
        }
        if (p.kind === 'resolve') {
          if (row.state === 'resolved' || row.state === 'withdrawn')
            throw new ServiceError('comment_governance_transition', 409);
          if (p.reviewDisposition !== 'unchanged') {
            if (comment.revision !== row.comment_revision)
              throw new ServiceError('comment_review_stale', 409);
            // No granting access on a moderator's behalf; expired or withdrawn source
            // cannot be made readable by a favorable decision.
            await this.comments.sourceWithin(
              db,
              actor,
              comment,
              row.comment_revision,
            );
          }
          state = 'resolved';
          closed = commentStamp(this.access.now());
        }
        if (p.kind === 'appeal') {
          if (row.state !== 'resolved' || appeals >= 3)
            throw new ServiceError('comment_governance_transition', 409);
          state = 'appealed';
          closed = null;
          appeals++;
        }
        if (p.kind === 'withdraw-report') {
          if (row.state === 'withdrawn')
            throw new ServiceError('comment_governance_transition', 409);
          state = 'withdrawn';
          closed = commentStamp(this.access.now());
        }
        const version = row.version + 1;
        if (version > 100 && !['withdraw-report', 'resume'].includes(p.kind))
          throw new ServiceError('comment_governance_event_limit', 413);
        await this.save(db, actor, authorization, {
          id: p.id,
          reportId: id,
          kind: p.kind,
          version,
          consentId,
          payloadJson,
        });
        await db.query(
          'UPDATE comment_reports_v2 SET version=$2,state=$3,pause_until=$4,closed_at=$5,appeal_count=$6,pause_event_id=$7,decision_event_id=$8 WHERE id=$1',
          [
            id,
            version,
            state,
            pause,
            closed,
            appeals,
            p.kind === 'pause'
              ? p.id
              : p.kind === 'resume'
                ? null
                : row.pause_event_id,
            p.kind === 'resolve' ? p.id : row.decision_event_id,
          ],
        );
        if (p.kind === 'resolve' && p.reviewDisposition !== 'unchanged')
          await db.query(
            'UPDATE task_comments_v2 SET review_state=$2,review_event_id=$3 WHERE id=$1',
            [
              comment.id,
              p.reviewDisposition === 'approve' ? 'approved' : 'rejected',
              p.id,
            ],
          );
        return {
          reportId: id,
          eventId: p.id,
          version,
          state,
          pauseUntil: pause ? new Date(pause).toISOString() : null,
          contentDisposition:
            p.kind === 'pause'
              ? 'temporarily-hidden'
              : p.kind === 'resume'
                ? 'recheck-other-holds-and-source'
                : 'separate-source-and-review-state',
          taskStateChanged: false,
          capabilityVerdict: 'not-decided',
        };
      },
    );
  }
  async readWithin(db, actor, id) {
    const row = await this.load(db, id),
      { events, parties } = await this.requireVisible(db, actor, row),
      independent = await this.independent(db, actor, row),
      canModerate =
        independent &&
        events.some((e) =>
          ['report', 'supplement', 'appeal'].includes(e.kind ?? 'report'),
        );
    let source = null;
    const comment = await this.comments.row(db, row.comment_id);
    // Review capability applies only to the reported version and only after
    // independent role + a current authorized report, never arbitrary old bodies.
    if (canModerate)
      try {
        source = await this.comments.readWithin(db, actor, comment.id, {
          revision: row.comment_revision,
          review: true,
        });
      } catch (e) {
        if (!absent(e)) throw e;
      }
    return {
      reportId: id,
      target: {
        type: 'task-comment',
        id: row.comment_id,
        revision: row.comment_revision,
      },
      taskId: row.task_id,
      version: row.version,
      state: row.state,
      pauseUntil: row.pause_until
        ? new Date(row.pause_until).toISOString()
        : null,
      closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
      handlingState:
        events.length && this.moderatorIds.length
          ? 'awaiting-or-recorded-handler'
          : 'awaiting-authorized-handler',
      canModerate,
      canReviewSource: !!source?.body,
      source,
      events,
      canAppeal:
        parties.includes(actor.subjectId) &&
        row.state === 'resolved' &&
        row.appeal_count < 3,
      canSupplement: parties.includes(actor.subjectId),
      canWithdrawReport:
        row.reporter_id === actor.subjectId && row.state !== 'withdrawn',
      decisionRecipients: [
        ...new Set([
          ...this.moderatorIds,
          row.reporter_id,
          row.author_id,
          row.requester_id,
        ]),
      ].filter((x) => x !== actor.subjectId),
      authority: 'configured-operator-process',
      independence: 'not-a-proof-of-real-world-control',
      capabilityVerdict: 'not-decided',
      automaticAccountRestriction: false,
    };
  }
  get(actor, id) {
    if (!z.uuid().safeParse(id).success)
      throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'moderation', (db) =>
      this.readWithin(db, actor, id),
    );
  }
  query(actor, input = {}) {
    const parsed = z
      .strictObject({
        commentId: z.uuid().optional(),
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(30).default(10),
      })
      .safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_comment_report_query');
    const q = parsed.data;
    return this.access.runAuthorized(actor, 'moderation', async (db) => {
      const rows = (
        await db.query(
          `SELECT r.id FROM comment_reports_v2 r JOIN task_comments_v2 c ON c.id=r.comment_id JOIN task_requests t ON t.id=c.task_id
    WHERE ($1::uuid IS NULL OR r.comment_id=$1) AND ($2::uuid IS NULL OR r.id>$2) AND
    (r.reporter_id=$3 OR c.subject_id=$3 OR t.requester_id=$3 OR EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=t.id AND p.subject_id=$3 AND p.snapshot->>'confirmedAt' IS NOT NULL)
     OR EXISTS(SELECT 1 FROM comment_governance_events_v2 e JOIN consents s ON s.id=e.consent_id WHERE e.report_id=r.id AND s.intent->'viewers' ? $3))
    ORDER BY r.id LIMIT 200`,
          [q.commentId ?? null, q.after ?? null, actor.subjectId],
        )
      ).rows;
      const items = [];
      for (const r of rows) {
        try {
          items.push(await this.readWithin(db, actor, r.id));
        } catch (e) {
          if (!absent(e)) throw e;
        }
        if (items.length === q.limit) break;
      }
      return {
        items,
        nextAfter: items.length === q.limit ? items.at(-1).reportId : null,
        scanTruncated: rows.length === 200 && items.length < q.limit,
      };
    });
  }
  receipt(actor, input) {
    const p = commentReceiptV2Schema.safeParse(input);
    if (!p.success) throw new ServiceError('invalid_comment_receipt');
    return this.access.runAuthorized(actor, 'moderation', async (db) => {
      const row = (
        await db.query(
          'SELECT * FROM comment_governance_events_v2 WHERE id=$1 AND subject_id=$2',
          [p.data.operationId, actor.subjectId],
        )
      ).rows[0];
      return !row
        ? { state: 'absent' }
        : {
            state:
              row.payload_hash === p.data.payloadHash
                ? 'acknowledged'
                : 'conflict',
            ...(row.payload_hash === p.data.payloadHash
              ? {
                  reportId: row.report_id,
                  version: row.version,
                  consentId: row.consent_id,
                }
              : {}),
            authority: 'accepted-event-only',
          };
    });
  }
}
