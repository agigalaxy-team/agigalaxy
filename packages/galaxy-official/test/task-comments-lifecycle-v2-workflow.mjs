import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyTaskCommentsV2 } from './task-comments-v2-workflow.mjs';
import { approveFixtureDeletion } from './deletion-execute-workflow.mjs';
import { executeDeletion } from '../src/operations/deletion-execute.mjs';
import { cleanupProductV2Retention } from '../src/operations/lifecycle-retention-v2.mjs';

export async function verifyTaskCommentLifecycleV2(options = {}) {
  return verifyTaskCommentsV2({
    ...options,
    afterWorkflow: async ({
      f,
      owner,
      comments,
      clock,
      comment,
      reply,
      privateComment,
      report,
      admin,
    }) => {
      const worker = options.workerDatabase ?? f.db,
        datasets = [
          'task-comments-v2',
          'task-comment-events-v2',
          'comment-report-receipts-v2',
          'comment-governance-events-v2',
        ];
      const ticket = await f.dataExport.create(f.actor, {
        id: randomUUID(),
        datasets,
      });
      let page = await f.dataExport.page(f.actor, {
        id: ticket.id,
        dataset: 'task-comment-events-v2',
      });
      assert.ok(
        page.items.some(
          (x) =>
            x.comment_id === privateComment.commentId &&
            x.payload_text.includes('受限澄清'),
        ),
      );
      assert.ok(page.items.every((x) => x.subject_id === f.actor.subjectId));
      // Only this synthetic comment is aged; current login/Consent timestamps remain
      // valid, isolating fixed comment TTL from unrelated authentication expiry.
      await admin.query(
        "UPDATE task_comments_v2 SET created_at=$2::timestamptz-interval '90 days',expires_at=$2 WHERE id=$1",
        [
          privateComment.commentId,
          new Date((clock.now - 1) * 1000).toISOString(),
        ],
      );
      page = await f.dataExport.page(f.actor, {
        id: ticket.id,
        dataset: 'task-comment-events-v2',
      });
      assert.equal(
        page.items.find((x) => x.comment_id === privateComment.commentId)
          .payload_text,
        '',
      );
      assert.equal(
        (await comments.get(f.actor, privateComment.commentId)).body,
        null,
      );
      const swept = await cleanupProductV2Retention(worker, {
        now: () => clock.now,
      });
      assert.equal(swept.removed.expiredCommentBodies, 1);
      const expired = (
        await admin.query(
          'SELECT payload_text,text_fingerprint,link_fingerprints,erased_at,payload_hash FROM task_comment_events_v2 WHERE comment_id=$1',
          [privateComment.commentId],
        )
      ).rows[0];
      assert.equal(expired.payload_text, '');
      assert.equal(expired.text_fingerprint, null);
      assert.deepEqual(expired.link_fingerprints, []);
      assert.ok(expired.erased_at);
      assert.match(expired.payload_hash, /^[a-f0-9]{64}$/);
      assert.equal(
        (
          await admin.query('SELECT id FROM comment_reports_v2 WHERE id=$1', [
            report.id,
          ])
        ).rows.length,
        1,
        'closed case is not removed before closure + 180 days',
      );
      const independent = (
        await admin.query('SELECT * FROM task_comment_events_v2 WHERE id=$1', [
          reply.id,
        ])
      ).rows[0];
      const command = await approveFixtureDeletion(f, admin, {
        auditUntil: clock.now + 180 * 86400,
      });
      const deletion = await executeDeletion(admin, command, {
        now: () => clock.now,
      });
      assert.ok(deletion.physicalDeletionPerformed);
      const retained = (
        await admin.query('SELECT * FROM task_comments_v2 WHERE id=$1', [
          comment.commentId,
        ])
      ).rows[0];
      assert.ok(retained);
      assert.equal(retained.state, 'retracted');
      assert.equal(retained.account_id, null);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM task_comment_events_v2 WHERE subject_id=$1 AND payload_text<>''",
            [f.actor.subjectId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM comment_governance_events_v2 WHERE subject_id=$1 AND payload_text<>''",
            [f.actor.subjectId],
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(
        (
          await admin.query(
            'SELECT * FROM task_comment_events_v2 WHERE id=$1',
            [reply.id],
          )
        ).rows[0],
        independent,
      );
      assert.equal(
        (await comments.get(owner.actor, reply.commentId)).body,
        reply.body,
      );
      assert.equal(
        (await comments.get(owner.actor, reply.commentId)).replyTo.body,
        null,
      );
      const closed = (
        await cleanupProductV2Retention(worker, {
          now: () => clock.now + 180 * 86400 + 1,
        })
      ).removed;
      assert.equal(closed.closedGovernanceCases, 1);
      assert.equal(
        (
          await admin.query('SELECT id FROM comment_reports_v2 WHERE id=$1', [
            report.id,
          ])
        ).rows.length,
        0,
      );
    },
  });
}
