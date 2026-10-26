import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import { z } from 'zod';
import { transaction } from "../../../infrastructure/database.mjs";
import {
  workbenchActionCatalog,
  workbenchCommandSchemas,
} from "../action-catalog.mjs";
import {
  fail,
  parse,
  pick,
  safeReceipt,
  requestSchema,
  requiredActionFor,
  humanDraftConfig,
  unknownRecommendationResult,
  recommendationPolicyInput,
} from './support.mjs';
import { actionResult } from './results.mjs';

export async function recoverPrepared(operator, proposal, operationId) {
  const x = parse(requestSchema(proposal?.request), proposal?.request);
  parse(z.uuid(), operationId);
  if (
    proposal?.schemaVersion !== 1 ||
    proposal.kind !== x.kind ||
    proposal.requiredAction !== requiredActionFor(x)
  )
    fail('invalid_operations_agentos_action', 400);
  const entry = workbenchActionCatalog.find((item) => item.kind === x.kind);
  if (!entry) fail('invalid_operations_agentos_action', 400);
  // Pure recovery reads the original durable result. Losing permission for a
  // new write must not hide an owned receipt from a currently qualified reader.
  const currentRead = (actor) =>
    this.authority.human(actor, {
      domain: proposal.domain,
      action: entry.read,
      purpose: x.kind === 'private-case-message' ? 'prepare' : 'query',
    });
  const actor = await currentRead(operator),
    missing = {
      operationId,
      state: 'not-recorded',
      summary: '尚未记录本次处理。',
      receipt: null,
    };
  let result;
  if (['job-cancel', 'job-retry', 'search-retry'].includes(x.kind)) {
    const input = parse(workbenchCommandSchemas[x.kind], {
      ...proposal.command,
      operationId,
    });
    if (input.reason !== x.reason)
      fail('operations_agentos_operation_conflict');
    result = await this.service('jobActions', 'operation').operation(
      actor,
      x.kind,
      x,
      proposal.command,
      operationId,
    );
    if (!result) return missing;
  } else if (x.kind === 'ai-work-prompt-save' || x.kind === 'ai-role-command') {
    const input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      body =
        x.kind === 'ai-work-prompt-save'
          ? pick(input, [
              'operationId',
              'aiAccountId',
              'expectedRevision',
              'expectedPromptVersion',
              'prompt',
            ])
          : { ...input.command, operationId },
      kind = x.kind === 'ai-work-prompt-save' ? 'prompt-save' : x.command.kind;
    if (
      (x.kind === 'ai-work-prompt-save' &&
        (body.aiAccountId !== x.aiAccountId || body.prompt !== x.prompt)) ||
      (x.kind === 'ai-role-command' &&
        !isDeepStrictEqual(input.command, x.command))
    )
      fail('operations_agentos_operation_conflict');
    const saved = await this.service(
      'permissions',
      'delegatedManagementOperation',
    ).delegatedManagementOperation(actor, operationId, { kind, input: body });
    if (saved.state === 'not-recorded') return missing;
    result = saved.result;
  } else if (x.kind === 'public-content-batch') {
    const input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      { reason, ...metadata } = input,
      row = (
        await this.db.query(
          'SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (!row) return missing;
    if (
      row.operator_id !== actor.operatorId ||
      row.action !== 'community-content-batch-visibility' ||
      !isDeepStrictEqual(row.selection, {
        ...metadata,
        reasonDigest: createHash('sha256').update(reason).digest('hex'),
      })
    )
      fail('operations_agentos_operation_conflict');
    result = row.result;
  } else if (x.kind === 'private-case-message') {
    const input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      g = this.service('chatReports', 'assertDutyCaseWithin');
    if (this.authority.acceptsDuty?.(actor))
      await transaction(this.db, (db) =>
        g.assertDutyCaseWithin(db, actor, x.reportId),
      );
    const event = (
        await this.db.query(
          'SELECT actor_kind,operator_id,version,input FROM account_chat_governance_events_v1 WHERE id=$1 AND report_id=$2',
          [operationId, x.reportId],
        )
      ).rows[0],
      audit = (
        await this.db.query(
          "SELECT result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND action='chat-report-event'",
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (!event || !audit) return missing;
    if (
      event.actor_kind !== actor.kind ||
      event.operator_id !== actor.operatorId ||
      !isDeepStrictEqual(event.input, {
        ...input,
        reportId: x.reportId,
        messageId: x.messageId,
        kind: 'message-' + x.action,
      })
    )
      fail('operations_agentos_operation_conflict');
    result = {
      operationId,
      reportId: x.reportId,
      version: event.version,
      revision: audit.result.revision,
      replayed: true,
    };
  } else if (
    x.kind === 'ordinary-strategy-draft' ||
    x.kind === 'ordinary-strategy-publish'
  ) {
    const input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      saved = await this.service('ordinaryStrategies', 'operation').operation(
        actor,
        x.strategyId,
        operationId,
      );
    if (saved.state === 'not-recorded') return missing;
    if (
      saved.kind !==
        (x.kind === 'ordinary-strategy-draft'
          ? 'ordinary-draft'
          : 'ordinary-publish') ||
      !isDeepStrictEqual(saved.input, input)
    )
      fail('operations_agentos_operation_conflict');
    result = saved.result;
  } else if (x.kind === 'account-restriction') {
    const input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      row = (
        await this.db.query(
          'SELECT operator_id,account_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (
      input.reason !== x.reason ||
      (x.action === 'apply') !== Object.hasOwn(input, 'until') ||
      (x.action === 'apply' && input.until !== x.until)
    )
      fail('operations_agentos_operation_conflict');
    if (!row) return missing;
    if (
      row.operator_id !== actor.operatorId ||
      row.account_id !== x.targetId ||
      row.action !==
        (x.action === 'apply' ? 'restriction-set' : 'restriction-release') ||
      !isDeepStrictEqual(row.selection, input)
    )
      fail('operations_agentos_operation_conflict');
    result = row.result;
  } else if (x.kind === 'feedback-update') {
    const input = parse(workbenchCommandSchemas[x.kind], {
      ...proposal.command,
      operationId,
    });
    for (const key of ['category', 'module', 'state', 'note'])
      if (Object.hasOwn(x, key) && !isDeepStrictEqual(x[key], input[key]))
        fail('operations_agentos_operation_conflict');
    // The domain reader validates the real immutable feedback audit receipt.
    // It never reads private notes as recovery material or repeats the effect.
    const saved = await this.service('feedback', 'operation').operation(
      actor,
      x.targetId,
      operationId,
    );
    if (saved.state === 'not-recorded') return missing;
    const selection = {
      expectedRevision: input.expectedRevision,
      ...pick(input, ['category', 'module', 'state']),
      noteHash: input.note
        ? createHash('sha256').update(input.note).digest('hex')
        : null,
    };
    if (
      saved.state !== 'recorded' ||
      saved.operationId !== operationId ||
      saved.feedbackId !== x.targetId ||
      saved.action !== 'feedback-update' ||
      !isDeepStrictEqual(saved.selection, selection)
    )
      fail('operations_agentos_operation_conflict');
    result = { ...saved.result, replayed: saved.replayed === true };
  } else if (x.kind === 'recommendation-direction') {
    const input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      body = recommendationPolicyInput(input);
    if (
      input.themeKey !== x.themeKey ||
      input.direction !== x.direction ||
      input.reason !== x.reason
    )
      fail('operations_agentos_operation_conflict');
    const saved = await this.service(
        'recommendations',
        'commandResult',
      ).commandResult(actor, operationId),
      row = (
        await this.db.query(
          'SELECT operator_id,kind,revision,theme_key,request_hash,result FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=$2',
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (!row) {
      if (saved.state === 'recorded')
        fail('operations_agentos_operation_conflict');
      await currentRead(actor);
      // An attempted card's absent receipt is not proof that a delayed request
      // cannot arrive. Keep recovery read-only, rather than re-arm this card.
      return unknownRecommendationResult(operationId);
    }
    const requestHash = createHash('sha256')
      .update(canonicalize({ kind: 'policy', input: body }))
      .digest('hex');
    if (
      row.operator_id !== actor.operatorId ||
      row.kind !== 'policy-updated' ||
      row.theme_key !== x.themeKey ||
      row.request_hash !== requestHash ||
      row.revision !== input.expectedVersion + 1 ||
      saved.state !== 'recorded' ||
      saved.operationId !== operationId ||
      saved.kind !== 'policy' ||
      saved.result?.version !== row.revision ||
      saved.result?.themeKey !== x.themeKey
    )
      fail('operations_agentos_operation_conflict');
    result = { ...row.result, replayed: true };
  } else if (x.kind === 'file-access') {
    const input = parse(workbenchCommandSchemas[x.kind], {
      ...proposal.command,
      operationId,
    });
    if (
      input.action !== x.action ||
      input.reason !== x.reason ||
      (x.action === 'stop') !== Object.hasOwn(input, 'until') ||
      (x.action === 'stop' && input.until !== x.until)
    )
      fail('operations_agentos_operation_conflict');
    // The public GET intentionally omits reason and CAS. Match every frozen
    // input against the same endpoint's immutable event before using its receipt.
    const saved = await this.service('fileAccess', 'operation').operation(
        actor,
        operationId,
      ),
      row = (
        await this.db.query(
          `SELECT operator_id,kind,file_id,action,expected_version,expected_revision,reason,stopped_until,revision
    FROM operations_file_access_events_v1 WHERE endpoint=$1 AND operation_id=$2`,
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (!row) {
      if (saved.state === 'recorded')
        fail('operations_agentos_operation_conflict');
      return missing;
    }
    const until = row.stopped_until
      ? Math.floor(new Date(row.stopped_until).getTime() / 1000)
      : null;
    if (
      row.operator_id !== actor.operatorId ||
      row.kind !== x.targetKind ||
      row.file_id !== x.targetId ||
      row.action !== x.action ||
      row.expected_version !== input.expectedVersion ||
      row.expected_revision !== input.expectedRevision ||
      row.reason !== input.reason ||
      until !== (input.until ?? null) ||
      saved.state !== 'recorded' ||
      saved.revision !== row.revision
    )
      fail('operations_agentos_operation_conflict');
    result = { ...saved, replayed: true };
  } else if (x.kind === 'file-cleanup-approve') {
    const input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      row = (
        await this.db.query(
          'SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (!row) return missing;
    if (
      row.operator_id !== actor.operatorId ||
      row.action !== 'file-cleanup-approve' ||
      !isDeepStrictEqual(row.selection, {
        operationId,
        id: x.planId,
        command: input,
        resourceId: x.planId,
      })
    )
      fail('operations_agentos_operation_conflict');
    const service = this.service('fileCleanup', 'operation'),
      saved = await service.operation(actor, operationId);
    if (saved.state !== 'recorded') return missing;
    if (saved.kind !== 'approve' || saved.planId !== x.planId)
      fail('operations_agentos_operation_conflict');
    result = { ...row.result, plan: await service.plan(actor, x.planId) };
  } else if (x.kind === 'search-apply' || x.kind === 'search-restore') {
    const stored = (
      await this.db.query(
        'SELECT operator_id,kind,version_id FROM operations_search_quality_operations_v1 WHERE endpoint=$1 AND operation_id=$2',
        [this.endpoint, operationId],
      )
    ).rows[0];
    if (!stored) return missing;
    if (
      stored.operator_id !== actor.operatorId ||
      stored.kind !== (x.kind === 'search-apply' ? 'apply' : 'restore') ||
      stored.version_id !== proposal.command.versionId
    )
      fail('operations_agentos_operation_conflict');
    try {
      result = await this.service('searchQuality', 'operation').operation(
        actor,
        operationId,
      );
    } catch (error) {
      if (
        error.code === 'search_quality_operation_unavailable' &&
        error.status === 404
      )
        return missing;
      throw error;
    }
  } else if (x.kind === 'rule-publish' || x.kind === 'rule-restore') {
    const kind = x.kind === 'rule-publish' ? 'publish' : 'restore',
      row = (
        await this.db.query(
          'SELECT operator_id,policy_key,kind,input FROM operations_p14_rule_commands_v1 WHERE endpoint=$1 AND operation_id=$2',
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (!row) return missing;
    if (
      row.operator_id !== actor.operatorId ||
      row.policy_key !== x.key ||
      row.kind !== kind ||
      !isDeepStrictEqual(row.input, { ...proposal.command, operationId })
    )
      fail('operations_agentos_operation_conflict');
    result = await this.service('rules', 'operation').operation(
      actor,
      operationId,
    );
    if (result.state !== 'recorded') return missing;
  } else if (x.kind === 'strategy-control' || x.kind === 'strategy-continue') {
    const service = this.service('strategies', 'operation'),
      saved = await service.operation(actor, operationId);
    if (saved.state === 'not-recorded') return missing;
    if (saved.kind !== (x.kind === 'strategy-control' ? 'control' : 'continue'))
      fail('operations_agentos_operation_conflict');
    result = saved.result;
    if (x.kind === 'strategy-continue') {
      if (saved.result?.runId !== x.runId)
        fail('operations_agentos_operation_conflict');
      const current = await service.runDetail(actor, x.runId);
      result = { ...current, operationId };
      // A persisted human decision is not proof that the native continuation was
      // accepted. GET never calls continue or manufactures a replacement intent.
      if (current.run?.native?.awaitingHuman) {
        if (saved.continuation?.state === 'accepted') {
          await currentRead(actor);
          return {
            operationId,
            state: 'processing',
            summary: '本次决定已受理，正在读取处理进展。',
            receipt: safeReceipt(result),
          };
        }
        result = {
          ...current,
          run: { ...current.run, state: 'unknown' },
          operationId,
        };
      }
    }
  } else if (
    x.kind === 'message-draft-create' ||
    x.kind === 'message-draft-save'
  ) {
    const create = x.kind === 'message-draft-create',
      input = parse(workbenchCommandSchemas[x.kind], {
        ...proposal.command,
        operationId,
      }),
      planId = create ? operationId : x.targetId,
      saved = await this.service('messaging', 'commandResult').commandResult(
        actor,
        operationId,
      ),
      row = (
        await this.db.query(
          'SELECT operator_id,kind,input,result FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2',
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (
      !isDeepStrictEqual(input.config, humanDraftConfig(x.config)) ||
      proposal.target?.id !== planId ||
      (create && input.planId !== planId)
    )
      fail('operations_agentos_operation_conflict');
    if (!row) {
      if (saved.state === 'recorded')
        fail('operations_agentos_operation_conflict');
      return missing;
    }
    const expected = create ? input : { ...input, planId };
    if (
      row.operator_id !== actor.operatorId ||
      row.kind !== (create ? 'create' : 'save') ||
      !isDeepStrictEqual(row.input, expected) ||
      saved.state !== 'recorded' ||
      saved.operationId !== operationId ||
      saved.result?.planId !== planId ||
      saved.result?.state !== 'draft' ||
      saved.result?.version !== row.result?.plan?.version ||
      saved.result?.revision !== row.result?.plan?.revision
    )
      fail('operations_agentos_operation_conflict');
    result = { ...row.result, replayed: true };
  } else if (x.kind === 'messaging-state') {
    const row = (
      await this.db.query(
        'SELECT operator_id,kind,input,result FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2',
        [this.endpoint, operationId],
      )
    ).rows[0];
    if (!row) return missing;
    if (
      row.operator_id !== actor.operatorId ||
      row.kind !== x.action ||
      row.input?.planId !== x.targetId
    )
      fail('operations_agentos_operation_conflict');
    result = row.result;
  } else {
    const actions = {
        'content-visibility': 'community-content-visibility',
        'content-curation': 'community-content-curation',
        'section-classification': 'community-section-classify',
        'section-visibility': 'community-section-visibility',
        'resource-visibility': 'resource-visibility',
        'feedback-update': 'feedback-update',
        'file-scan-retry': 'file-retry',
        'case-resolve': 'community-report-resolve',
      },
      row = (
        await this.db.query(
          'SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2',
          [this.endpoint, operationId],
        )
      ).rows[0];
    if (!row) return missing;
    if (
      row.operator_id !== actor.operatorId ||
      row.action !== actions[x.kind] ||
      row.selection?.id !== x.targetId
    )
      fail('operations_agentos_operation_conflict');
    const selectionKind =
      x.kind === 'content-visibility'
        ? row.selection.targetKind
        : row.selection.kind;
    if (x.targetKind && selectionKind !== x.targetKind)
      fail('operations_agentos_operation_conflict');
    result = row.result;
  }
  await currentRead(actor);
  return actionResult(
    x.kind,
    result,
    operationId,
    x,
    proposal.command,
    'receipt',
  );
}
