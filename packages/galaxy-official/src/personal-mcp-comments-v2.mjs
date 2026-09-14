import * as z from 'zod/v4';
import {
  commentQueryV2Schema,
  commentReceiptV2Schema,
} from './shared/task-comment-v2-schema.mjs';
export function commentToolDefinitions(services, actor) {
  if (!services.comments || !services.commentGovernance) return {};
  const tool = (scope, inputSchema, description, run, write = false) => ({
    scope,
    inputSchema,
    description,
    run,
    write,
  });
  const signed = {
    consentId: z.uuid(),
    payloadJson: z.string().min(1).max(30000),
  };
  return {
    galaxy_comments_query: tool(
      'assistance',
      commentQueryV2Schema,
      'Read current Task comments. Comments clarify a Task but do not accept a delivery, enroll a participant or verify capability. Removed or held source text is unavailable; valid links/prices are not automatically advertisements.',
      (x) => services.comments.query(actor, x),
    ),
    galaxy_comment_get: tool(
      'assistance',
      z.strictObject({ commentId: z.uuid() }),
      'Read the current exact comment revision and permitted actions before proposing a reply, edit, correction or report.',
      (x) => services.comments.get(actor, x.commentId),
    ),
    galaxy_comment_submit: tool(
      'assistance',
      z.strictObject(signed),
      'Submit an explicitly user-reviewed and locally signed comment.publish create/edit/correct/retract. Verified Account and shared public comment quota are checked by the service. Never infer an acceptance from thanks or automatically publish a draft.',
      (x) => services.comments.submit(actor, x),
      true,
    ),
    galaxy_comment_receipt: tool(
      'assistance',
      commentReceiptV2Schema,
      'Query the original operation ID/hash before any retry. Historical acknowledgement is not current visibility.',
      (x) => services.comments.receipt(actor, x),
    ),
    galaxy_comment_governance_config: tool(
      'moderation',
      z.strictObject({}),
      'Read configured handler IDs. Empty configuration means a private request can be recorded but no official response or ruling is promised.',
      () => services.commentGovernance.config(actor),
    ),
    galaxy_comment_governance_query: tool(
      'moderation',
      z.strictObject({
        commentId: z.uuid().optional(),
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(30).default(10),
      }),
      'Read currently authorized private report/appeal records; reporting alone cannot punish an Account or decide capability.',
      (x) => services.commentGovernance.query(actor, x),
    ),
    galaxy_comment_report: tool(
      'moderation',
      z.strictObject(signed),
      'Submit one explicit signed moderation.publish report/review request naming the actual comment revision and selected handler viewers. Do not attach a whole chat or copy unrelated private evidence.',
      (x) => services.commentGovernance.report(actor, x),
      true,
    ),
    galaxy_comment_governance_event: tool(
      'moderation',
      z.strictObject({ reportId: z.uuid(), ...signed }),
      'Submit an explicit signed supplement/appeal/withdraw-report; pause/resolve/resume additionally require configured independent operator authority. A report count never supplies that authority and resolution does not implicitly resume a pause.',
      ({ reportId, ...x }) =>
        services.commentGovernance.event(actor, reportId, x),
      true,
    ),
    galaxy_comment_governance_receipt: tool(
      'moderation',
      commentReceiptV2Schema,
      'Reconcile the exact original private governance operation before retry. Do not create a replacement ID for a missing acknowledgement.',
      (x) => services.commentGovernance.receipt(actor, x),
    ),
  };
}
