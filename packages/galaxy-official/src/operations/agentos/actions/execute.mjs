import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  workbenchActionCatalog,
  workbenchCommandSchemas,
} from "../action-catalog.mjs";
import {
  fail,
  parse,
  requestSchema,
  requiredActionFor,
  humanDraftConfig,
  unknownFeedbackResult,
  unknownRecommendationResult,
  recommendationPolicyInput,
} from './support.mjs';
import { actionResult } from './results.mjs';

export async function executePrepared(
  operator,
  proposal,
  { authorize, operationId } = {},
) {
  const x = parse(requestSchema(proposal?.request), proposal?.request);
  if (proposal?.schemaVersion !== 1 || proposal.kind !== x.kind)
    fail('invalid_operations_agentos_action', 400);
  const input = parse(workbenchCommandSchemas[x.kind], {
      ...proposal.command,
      operationId: parse(z.uuid(), operationId),
    }),
    entry = workbenchActionCatalog.find((item) => item.kind === x.kind);
  const expectedAction = requiredActionFor(x);
  if (
    !entry ||
    proposal.requiredAction !== expectedAction ||
    typeof authorize !== 'function'
  )
    fail('operations_authorization_unavailable', 503);
  for (const key of [
    'reason',
    'category',
    'module',
    'state',
    'note',
    'resolution',
    'summary',
    'restrictionAction',
    'hideUntil',
    'topic',
    'pinned',
    'featured',
    'tagIds',
    'strategyId',
    'parameterEdits',
    'mode',
    'enabled',
  ])
    if (
      Object.hasOwn(x, key) &&
      JSON.stringify(x[key]) !== JSON.stringify(input[key])
    )
      fail('invalid_operations_agentos_action', 400);
  if (
    (x.kind === 'public-content-batch' &&
      (!isDeepStrictEqual(
        x.items,
        input.items.map((item) => ({ kind: item.kind, id: item.id })),
      ) ||
        input.kind !== x.action)) ||
    (x.kind === 'private-case-message' && input.action !== x.action)
  )
    fail('invalid_operations_agentos_action', 400);
  if (
    ([
      'content-visibility',
      'section-visibility',
      'resource-visibility',
      'strategy-control',
    ].includes(x.kind) &&
      input.kind !== x.action) ||
    (Object.hasOwn(x, 'until') && input.until !== x.until) ||
    (['search-restore', 'rule-restore', 'ordinary-strategy-publish'].includes(
      x.kind,
    ) &&
      input.versionId !== x.versionId)
  )
    fail('invalid_operations_agentos_action', 400);
  if (
    x.kind === 'account-restriction' &&
    (x.action === 'apply') !== Object.hasOwn(input, 'until')
  )
    fail('invalid_operations_agentos_action', 400);
  if (
    x.kind === 'file-access' &&
    (input.action !== x.action ||
      (x.action === 'stop') !== Object.hasOwn(input, 'until'))
  )
    fail('invalid_operations_agentos_action', 400);
  if (
    x.kind === 'recommendation-direction' &&
    (input.themeKey !== x.themeKey || input.direction !== x.direction)
  )
    fail('invalid_operations_agentos_action', 400);
  if (
    ['message-draft-create', 'message-draft-save'].includes(x.kind) &&
    (!isDeepStrictEqual(input.config, humanDraftConfig(x.config)) ||
      proposal.target?.kind !== 'message-plan' ||
      proposal.target.id !==
        (x.kind === 'message-draft-create' ? operationId : x.targetId) ||
      (x.kind === 'message-draft-create' && input.planId !== operationId))
  )
    fail('invalid_operations_agentos_action', 400);
  const actor = await this.authority.human(operator, {
      domain: proposal.domain,
      action: expectedAction,
      authorize,
      purpose: this.authority.acceptsDuty?.(operator) ? null : 'prepare',
    }),
    // Services recheck a service actor on their own transaction connection.
    // An identity callback must not start a second PG lease inside that check.
    fresh = ({ db } = {}) =>
      this.authority.acceptsDuty?.(actor)
        ? actor
        : this.human(actor, 'workbench.read', { authorize, db });
  let result;
  if (['job-cancel', 'job-retry', 'search-retry'].includes(x.kind))
    result = await this.service('jobActions', 'command').command(
      actor,
      x.kind,
      x,
      input,
      { authorize: fresh },
    );
  else if (x.kind === 'ai-work-prompt-save') {
    if (
      this.authority.acceptsDuty?.(actor) ||
      input.aiAccountId !== x.aiAccountId ||
      input.prompt !== x.prompt ||
      proposal.target?.kind !== 'ai-work-prompt' ||
      proposal.target.id !== x.aiAccountId
    )
      fail('invalid_operations_agentos_action', 400);
    const { delegationVersion, ...body } = input;
    result = await this.service(
      'permissions',
      'delegatedPromptSave',
    ).delegatedPromptSave(actor, body, {
      expectedDelegationVersion: delegationVersion,
    });
  } else if (x.kind === 'ai-role-command') {
    if (
      this.authority.acceptsDuty?.(actor) ||
      !isDeepStrictEqual(input.command, x.command)
    )
      fail('invalid_operations_agentos_action', 400);
    result = await this.service(
      'permissions',
      'delegatedRoleSave',
    ).delegatedRoleSave(
      actor,
      { ...input.command, operationId },
      { expectedDelegationVersion: input.delegationVersion },
    );
  } else if (x.kind === 'public-content-batch')
    result = await this.service('content', 'batch').batch(actor, input);
  else if (x.kind === 'private-case-message')
    result = await this.service(
      'chatReports',
      'operatorMessageVisibility',
    ).operatorMessageVisibility(
      actor,
      { reportId: x.reportId, messageId: x.messageId },
      input,
      { authorize: fresh },
    );
  else if (x.kind === 'content-visibility')
    result = await this.service('content', 'visibility').visibility(
      actor,
      x.targetKind,
      x.targetId,
      input,
    );
  else if (x.kind === 'content-curation')
    result = await this.service('content', 'curate').curate(
      actor,
      x.targetKind,
      x.targetId,
      input,
    );
  else if (x.kind === 'section-classification')
    result = await this.service('community', 'classify').classify(
      actor,
      x.targetId,
      input,
    );
  else if (x.kind === 'section-visibility')
    result = await this.service(
      'community',
      'sectionVisibility',
    ).sectionVisibility(actor, x.targetId, input);
  else if (x.kind === 'resource-visibility')
    result = await this.service('resources', 'visibility').visibility(
      actor,
      x.targetKind,
      x.targetId,
      input,
    );
  else if (x.kind === 'account-restriction') {
    try {
      const method = x.action === 'apply' ? 'restrict' : 'releaseRestriction';
      result = await this.service('accounts', method)[method](
        actor,
        x.targetId,
        input,
      );
    } catch (error) {
      if (error?.code === 'account_restriction_changed')
        fail('operations_agentos_restriction_changed');
      if (error?.code === 'invalid_restriction_expiry')
        fail('operations_agentos_restriction_deadline', 400);
      throw error;
    }
  } else if (x.kind === 'feedback-update') {
    const service = this.service('feedback', 'event');
    try {
      result = await service.event(actor, x.targetId, input);
    } catch (error) {
      // event() commits before its detail read. A later denial, missing source
      // or transport failure cannot prove that this exact effect did not occur.
      if (
        [
          'invalid_feedback_request',
          'feedback_revision_conflict',
          'feedback_no_change',
        ].includes(error?.code)
      )
        throw error;
      return unknownFeedbackResult(operationId);
    }
  } else if (x.kind === 'file-scan-retry') {
    if (input.kind !== 'scan') fail('invalid_operations_agentos_action', 400);
    result = await this.service('files', 'retry').retry(
      actor,
      x.targetKind,
      x.targetId,
      input,
      { authorize: fresh },
    );
  } else if (x.kind === 'file-access') {
    try {
      result = await this.service('fileAccess', 'change').change(
        actor,
        x.targetKind,
        x.targetId,
        input,
        { authorize: fresh },
      );
    } catch (error) {
      // change() commits its immutable event before its own final authorization
      // and detail read. A later denial/read error is not proof of no effect.
      // Only these closed, transaction-rejecting input/CAS cases are definite.
      if (
        [
          'invalid_operations_request',
          'business_admin_operation_conflict',
          'operations_file_changed',
          'operations_file_access_changed',
          'operations_file_access_until',
          'operations_file_access_unavailable',
          'operations_file_access_restore_unavailable',
        ].includes(error?.code)
      )
        throw error;
      return {
        operationId,
        state: 'unknown',
        summary: '本次处理结果暂时无法读取，系统会继续查询。',
        receipt: null,
      };
    }
  } else if (x.kind === 'file-cleanup-approve')
    result = await this.service('fileCleanup', 'approve').approve(
      actor,
      x.planId,
      input,
      { authorize: fresh },
    );
  else if (x.kind === 'case-resolve')
    result = await this.service('community', 'resolve').resolve(
      actor,
      x.targetId,
      input,
    );
  else if (
    x.kind === 'ordinary-strategy-draft' ||
    x.kind === 'ordinary-strategy-publish'
  )
    result = await this.service('ordinaryStrategies', 'command').command(
      actor,
      x.kind === 'ordinary-strategy-draft' ? 'draft' : 'publish',
      input,
    );
  else if (x.kind === 'message-draft-create')
    result = await this.service('messaging', 'create').create(
      actor,
      { operationId, config: input.config },
      { authorize: fresh, planId: operationId },
    );
  else if (x.kind === 'message-draft-save')
    result = await this.service('messaging', 'save').save(
      actor,
      x.targetId,
      input,
      { authorize: fresh },
    );
  else if (x.kind === 'messaging-state')
    result = await this.service('messaging', 'action').action(
      actor,
      x.targetId,
      x.action,
      input,
      { authorize: fresh },
    );
  else if (x.kind === 'strategy-control')
    result = await this.service('strategies', 'control').control(actor, input, {
      authorize: fresh,
    });
  else if (x.kind === 'strategy-continue')
    result = await this.service('strategies', 'continue').continue(
      actor,
      x.runId,
      input,
      { authorize: fresh },
    );
  else if (x.kind === 'rule-publish' || x.kind === 'rule-restore')
    result = await this.service(
      'rules',
      x.kind === 'rule-publish' ? 'publish' : 'restore',
    )[x.kind === 'rule-publish' ? 'publish' : 'restore'](actor, x.key, input, {
      authorize: fresh,
    });
  else if (x.kind === 'recommendation-direction') {
    try {
      result = await this.service('recommendations', 'savePolicy').savePolicy(
        actor,
        recommendationPolicyInput(input),
        {
          authorize: fresh,
          expectedTheme: {
            key: input.themeKey,
            expectedVersion: input.themeVersion,
            enabled: input.themeEnabled,
          },
        },
      );
    } catch (error) {
      if (
        [
          'invalid_recommendation_request',
          'recommendation_policy_changed',
          'recommendation_theme_changed',
          'recommendation_theme_unavailable',
          'recommendation_operation_conflict',
        ].includes(error?.code)
      )
        throw error;
      return unknownRecommendationResult(operationId);
    }
  } else
    result = await this.service('searchQuality', 'command').command(
      actor,
      x.kind === 'search-apply' ? 'apply' : 'restore',
      input,
      { authorize: fresh },
    );
  // The domain call has returned and may already have committed. A failed
  // final authorization cannot turn that effect into an unexecuted command.
  // Keep only the original ID so current authority can recover its receipt.
  try {
    await this.human(actor, expectedAction, { authorize });
  } catch {
    return {
      operationId,
      state: 'unknown',
      summary: '本次处理结果暂时无法读取，系统会继续查询。',
      receipt: null,
    };
  }
  return actionResult(x.kind, result, operationId, x, proposal.command);
}
