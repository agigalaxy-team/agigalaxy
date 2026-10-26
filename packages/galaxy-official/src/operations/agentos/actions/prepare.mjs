import { workbenchActionCatalog } from "../action-catalog.mjs";
import { fail, parse, requestSchema } from './support.mjs';

import { prepareJobs } from './prepare-jobs.mjs';
import { prepareAiPrompt, prepareAiRole } from './prepare-delegation.mjs';
import {
  prepareAccountRestriction,
  prepareFeedback,
} from './prepare-account-feedback.mjs';
import {
  prepareContentBatch,
  preparePrivateMessage,
  prepareContent,
  prepareSection,
  prepareResource,
  prepareCase,
} from './prepare-community.mjs';
import {
  prepareFileScan,
  prepareFileAccess,
  prepareFileCleanup,
} from './prepare-files.mjs';
import {
  prepareOrdinaryStrategy,
  prepareStrategyControl,
  prepareStrategyContinuation,
} from './prepare-strategies.mjs';
import {
  prepareMessageDraft,
  prepareMessagingState,
} from './prepare-messaging.mjs';
import { prepareRules } from './prepare-rules.mjs';
import { prepareRecommendation, prepareSearch } from './prepare-discovery.mjs';

const preparers = {
  'job-cancel': prepareJobs,
  'job-retry': prepareJobs,
  'search-retry': prepareJobs,
  'ai-work-prompt-save': prepareAiPrompt,
  'ai-role-command': prepareAiRole,
  'account-restriction': prepareAccountRestriction,
  'public-content-batch': prepareContentBatch,
  'private-case-message': preparePrivateMessage,
  'content-visibility': prepareContent,
  'content-curation': prepareContent,
  'section-classification': prepareSection,
  'section-visibility': prepareSection,
  'resource-visibility': prepareResource,
  'feedback-update': prepareFeedback,
  'file-scan-retry': prepareFileScan,
  'file-access': prepareFileAccess,
  'file-cleanup-approve': prepareFileCleanup,
  'case-resolve': prepareCase,
  'ordinary-strategy-draft': prepareOrdinaryStrategy,
  'ordinary-strategy-publish': prepareOrdinaryStrategy,
  'message-draft-create': prepareMessageDraft,
  'message-draft-save': prepareMessageDraft,
  'messaging-state': prepareMessagingState,
  'strategy-control': prepareStrategyControl,
  'strategy-continue': prepareStrategyContinuation,
  'rule-publish': prepareRules,
  'rule-restore': prepareRules,
  'recommendation-direction': prepareRecommendation,
  'search-apply': prepareSearch,
  'search-restore': prepareSearch,
};

export async function prepareFor(
  operator,
  domain,
  input,
  { publicReference, operationId } = {},
) {
  const request = parse(requestSchema(input), input),
    entry = workbenchActionCatalog.find((item) => item.kind === request.kind);
  if (
    publicReference !== undefined &&
    !['content-visibility', 'content-curation'].includes(request.kind)
  )
    fail('invalid_operations_agentos_request', 400);
  if (!entry) fail('operations_agentos_action_unavailable', 403);
  operator = await this.authority.human(operator, {
    domain,
    purpose: 'prepare',
  });
  const actor = await this.human(operator, entry.read),
    x = request;
  let readExpiresAt = this.now() + 30;
  const deadline = (until, maximum, sourceUntil = null) => {
    if (
      !Number.isSafeInteger(maximum) ||
      until <= this.now() ||
      until > this.now() + maximum ||
      (sourceUntil !== null && until > sourceUntil)
    )
      fail('operations_hide_expiry');
    return new Date(until * 1000).toISOString();
  };
  const expiry = (value) => {
    if (Number.isSafeInteger(value))
      readExpiresAt = Math.min(readExpiresAt, value);
  };
  const visibilityCommand = (view, sourceVersion, action) => ({
    kind: action,
    expectedVersion: sourceVersion,
    expectedVisibilityVersion: view.visibility.version,
    ...(x.until === undefined ? {} : { until: x.until }),
    reason: x.reason,
  });
  const prepare = preparers[x.kind];
  if (!prepare) fail('operations_agentos_action_unavailable', 403);
  const { target, title, requiredAction, command, review, impact, basis } =
    await prepare.call(this, {
      actor,
      x,
      operationId,
      publicReference,
      expiry,
      deadline,
      visibilityCommand,
    });
  await this.human(actor, requiredAction);
  if (readExpiresAt <= this.now()) fail('operations_source_unavailable');
  return {
    schemaVersion: 1,
    kind: x.kind,
    domain,
    request,
    command,
    target,
    title,
    impact,
    basis,
    requiredAction,
    checkedAt: this.now(),
    readExpiresAt,
    decisionSource: 'human-required',
    ...(review ? { review } : {}),
    ...(publicReference === undefined
      ? {}
      : { publicReference: { ...publicReference } }),
  };
}
