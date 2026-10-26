import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  fail,
  count,
  restrictionTime,
  safeReceipt,
  unknownFeedbackResult,
  unknownRecommendationResult,
} from './support.mjs';

function recommendationResult(result, operationId, input, resultSource) {
  const policy = result?.policy,
    directions = new Map(
      input.beforeDirections.map((item) => [item.key, item.direction]),
    );
  directions.set(input.themeKey, input.direction);
  const expected = [...directions].map(([key, direction]) => ({
    key,
    direction,
  }));
  if (
    result?.operationId !== operationId ||
    policy?.version !== input.expectedVersion + 1 ||
    policy.enabled !== input.enabled ||
    !isDeepStrictEqual(policy.controls, input.controls) ||
    !isDeepStrictEqual(policy.directions, expected)
  ) {
    if (resultSource === 'ack') return unknownRecommendationResult(operationId);
    fail('operations_agentos_operation_conflict');
  }
  return {
    operationId,
    state: 'completed',
    summary: policy.enabled
      ? '这次主题推荐方向已保存。'
      : '这次主题推荐方向已保存，方向调控仍未启用。',
    receipt: {
      operationId,
      version: policy.version,
      themeKey: input.themeKey,
      direction: input.direction,
      enabled: policy.enabled,
      replayed: result.replayed === true,
    },
  };
}
export function actionResult(
  kind,
  result,
  operationId,
  request,
  command = null,
  resultSource = 'ack',
) {
  if (['job-cancel', 'job-retry', 'search-retry'].includes(kind)) {
    if (
      result?.jobId !== request.targetId ||
      typeof result.state !== 'string' ||
      (kind === 'search-retry' &&
        result.generation !== command.expectedGeneration) ||
      (kind !== 'search-retry' && result.queue !== request.queue)
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary:
        kind === 'job-cancel'
          ? '这次任务取消已记录。'
          : '已重新安排原失败任务；实际执行结果仍需读取。',
      receipt: { operationId, ...result },
    };
  }
  if (kind === 'ai-work-prompt-save') {
    const prompt = result?.prompt;
    if (
      result?.operationId !== operationId ||
      prompt?.aiAccountId !== request.aiAccountId ||
      prompt.revision !== command.expectedRevision + 1 ||
      prompt.promptVersion !== command.expectedPromptVersion + 1 ||
      result.delegationVersion !== command.delegationVersion
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary: '岗位工作要求已保存，新轮次采用新版本。',
      receipt: {
        operationId,
        aiAccountId: prompt.aiAccountId,
        configId: prompt.configId,
        revision: prompt.revision,
        promptVersion: prompt.promptVersion,
        delegationVersion: result.delegationVersion,
        replayed: result.replayed === true,
      },
    };
  }
  if (kind === 'ai-role-command') {
    const input = command.command,
      assignment = input.kind === 'assignment-save',
      value = assignment ? result?.assignment : result?.role;
    if (
      result?.operationId !== operationId ||
      !z.uuid().safeParse(value?.id).success ||
      value.version !== input.expectedVersion + 1 ||
      result.delegationVersion !== command.delegationVersion ||
      (assignment &&
        (value.aiAccountId !== input.aiAccountId ||
          value.roleId !== input.roleId ||
          value.enabled !== input.enabled)) ||
      (!assignment &&
        (value.subjectScope !== 'ai-only' ||
          value.name !== input.name ||
          value.enabled !== input.enabled ||
          !isDeepStrictEqual(value.permissions, input.permissions)))
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary: assignment
        ? '获准 AI 的专用角色分配已保存。'
        : '获准 AI 的专用角色已保存。',
      receipt: {
        operationId,
        delegationVersion: result.delegationVersion,
        ...(assignment
          ? {
              assignmentId: value.id,
              aiAccountId: value.aiAccountId,
              roleId: value.roleId,
            }
          : { roleId: value.id }),
        version: value.version,
        enabled: value.enabled,
        replayed: result.replayed === true,
      },
    };
  }
  if (kind === 'recommendation-direction')
    return recommendationResult(result, operationId, command, resultSource);
  if (kind === 'message-draft-create' || kind === 'message-draft-save') {
    const plan = result?.plan,
      create = kind === 'message-draft-create',
      planId = create ? command.planId : request.targetId;
    if (
      plan?.id !== planId ||
      plan.state !== 'draft' ||
      plan.version !== (create ? 1 : command.expectedVersion + 1) ||
      plan.revision !== (create ? 1 : command.expectedRevision + 1) ||
      !isDeepStrictEqual(plan.config, command.config)
    ) {
      if (resultSource === 'receipt')
        fail('operations_agentos_operation_conflict');
      return {
        operationId,
        state: 'unknown',
        summary: '消息草稿保存结果暂未核实，系统会继续查询原操作。',
        receipt: null,
      };
    }
    return {
      operationId,
      state: 'completed',
      summary: create
        ? '消息草稿已生成，事实与受众仍待人工核实。'
        : '消息草稿已保存，事实与受众仍待人工核实。',
      receipt: {
        operationId,
        planId,
        version: plan.version,
        revision: plan.revision,
        state: 'draft',
        automation: { kind: 'human-required', factsConfirmed: false },
        replayed: result.replayed === true,
      },
    };
  }
  if (kind === 'public-content-batch') {
    if (
      result?.operationId !== operationId ||
      !Array.isArray(result.items) ||
      result.items.length !== command.items.length ||
      result.items.some(
        (item, i) =>
          item.id !== command.items[i].id ||
          item.kind !== command.items[i].kind ||
          !['applied', 'rejected'].includes(item.status),
      )
    )
      fail('operations_agentos_operation_conflict');
    const applied = result.items.filter(
        (item) => item.status === 'applied',
      ).length,
      rejected = result.items.length - applied;
    return {
      operationId,
      state: applied ? 'completed' : 'failed',
      summary:
        '这批公开内容已处理 ' + applied + ' 项，未处理 ' + rejected + ' 项。',
      receipt: {
        operationId,
        counts: { applied, rejected },
        items: result.items.map((item) => ({
          kind: item.kind,
          id: item.id,
          status: item.status,
          code: item.code ?? null,
          revision: item.visibility?.version ?? null,
        })),
        replayed: result.replayed === true,
      },
    };
  }
  if (kind === 'private-case-message') {
    const selected = result?.materials?.find(
        (item) => item.messageId === request.messageId,
      ),
      revision =
        result?.messageOperation?.revision ??
        selected?.moderation?.revision ??
        result?.revision,
      version = result?.messageOperation?.reportVersion ?? result?.version,
      id = result?.messageOperation?.operationId ?? result?.operationId;
    if (
      id !== operationId ||
      (result?.reportId ?? request.reportId) !== request.reportId ||
      revision !== command.expectedRevision + 1 ||
      version !== command.expectedVersion + 1
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary: '本案所选消息处理已记录。',
      receipt: {
        operationId,
        reportId: request.reportId,
        messageId: request.messageId,
        sourceRevision: command.messageRevision,
        version,
        revision,
        action: request.action,
        ownHidden: request.action !== 'restore',
        replayed:
          result.replayed === true ||
          result.messageOperation?.replayed === true,
      },
    };
  }
  if (
    kind === 'ordinary-strategy-draft' ||
    kind === 'ordinary-strategy-publish'
  ) {
    if (
      result?.operationId !== operationId ||
      result.strategyId !== request.strategyId ||
      !z.uuid().safeParse(result.versionId).success ||
      !Number.isSafeInteger(result.version) ||
      !Number.isSafeInteger(result.revision) ||
      result.state !==
        (kind === 'ordinary-strategy-draft'
          ? 'saved'
          : 'active-for-new-matters') ||
      (request.versionId && result.versionId !== request.versionId)
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary:
        kind === 'ordinary-strategy-draft'
          ? '日常策略调整已保存为草稿。'
          : '日常策略调整已发布，仅用于新事项。',
      receipt: {
        operationId,
        strategyId: result.strategyId,
        versionId: result.versionId,
        version: result.version,
        revision: result.revision,
        state: result.state,
        replayed: result.replayed === true,
      },
    };
  }
  const receipt = safeReceipt(result);
  if (kind === 'feedback-update') {
    const feedback = resultSource === 'ack' ? result?.feedback : null,
      revision = count(
        resultSource === 'ack' ? feedback?.revision : result?.revision,
      ),
      expected = count(command?.expectedRevision);
    const unconfirmed = () => {
      if (resultSource === 'ack') return unknownFeedbackResult(operationId);
      fail('operations_agentos_operation_conflict');
    };
    if (
      expected === null ||
      expected < 1 ||
      revision !== expected + 1 ||
      result?.operationId !== operationId ||
      (resultSource === 'ack' ? feedback?.id : result?.feedbackId) !==
        request?.targetId
    )
      return unconfirmed();
    if (feedback) {
      for (const key of ['category', 'module', 'state'])
        if (Object.hasOwn(command, key) && feedback[key] !== command[key])
          return unconfirmed();
      if (
        Object.hasOwn(command, 'note') &&
        (result.history?.items?.[0]?.kind !== 'updated' ||
          result.history.items[0].note !== command.note)
      )
        return unconfirmed();
    }
    return {
      operationId,
      state: 'completed',
      summary: '这条反馈已更新。',
      receipt: {
        operationId,
        feedbackId: request.targetId,
        revision,
        replayed: receipt.replayed,
      },
    };
  }

  if (kind === 'content-curation') {
    const value = result?.content ?? result,
      version = count(result?.content?.version ?? result?.sourceVersion),
      revision = count(result?.content?.curation?.revision ?? result?.revision);
    if (
      value?.kind !== request?.targetKind ||
      value?.id !== request?.targetId ||
      version === null ||
      revision === null ||
      revision < 1 ||
      (result?.operationId !== undefined && result.operationId !== operationId)
    )
      fail('operations_agentos_operation_conflict');
    // Curation and visibility have independent revisions. An ACK's current
    // content envelope and the original durable audit result must name the same
    // curation effect, never its unrelated visibility state.
    Object.assign(receipt, { operationId, version, revision, hidden: null });
  }
  if (kind === 'file-access') {
    const stop = request?.action === 'stop';
    if (
      result?.operationId !== operationId ||
      result?.kind !== request?.targetKind ||
      result?.id !== request?.targetId ||
      result?.action !== request?.action ||
      count(result.revision) === null ||
      result.revision < 1 ||
      result.stopped !== stop ||
      (stop ? result.until !== request.until : result.until !== null)
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary: stop
        ? '已设置停止访问，截止北京时间 ' +
          restrictionTime(result.until * 1000) +
          '。'
        : '已解除这次确认的运营访问覆盖。',
      receipt: {
        operationId,
        kind: result.kind,
        id: result.id,
        action: result.action,
        revision: result.revision,
        stopped: result.stopped,
        until: result.until,
        replayed: receipt.replayed,
      },
    };
  }
  if (kind === 'account-restriction') {
    const value = result?.restriction,
      release = request?.action === 'release';
    if (
      result?.accountId !== request?.targetId ||
      result?.operationId !== operationId ||
      value?.scope !== 'community-participation' ||
      count(value.revision) === null ||
      typeof value.active !== 'boolean' ||
      (release
        ? value.until !== null || value.active !== false
        : !Number.isFinite(Date.parse(value.until)) ||
          Date.parse(value.until) !== Date.parse(request.until))
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary: release
        ? '已解除这次确认的参与限制。'
        : '已设置参与限制，截止北京时间 ' + restrictionTime(value.until) + '。',
      receipt: {
        operationId,
        accountId: result.accountId,
        revision: value.revision,
        restriction: {
          scope: value.scope,
          active: value.active,
          until: value.until,
        },
        replayed: receipt.replayed,
      },
    };
  }
  if (kind === 'file-cleanup-approve') {
    const state = result?.plan?.state,
      planId = result?.planId;
    if (
      result?.kind !== 'approve' ||
      !z.uuid().safeParse(planId).success ||
      !['queued', 'running', 'completed', 'attention', 'cancelled'].includes(
        state,
      )
    )
      fail('operations_agentos_operation_conflict');
    return {
      operationId,
      state: 'completed',
      summary:
        state === 'completed'
          ? '这份清理计划已批准，逐项处理已结束；对象移除结果可在计划中查看。'
          : state === 'attention'
            ? '这份清理计划已批准，部分对象的结果尚未确认，请查看计划。'
            : state === 'cancelled'
              ? '这份计划曾获批准，后续清理已取消。'
              : '已批准这份计划，系统会逐项核对并清理。',
      receipt: { ...receipt, planId, state },
    };
  }
  if (kind === 'rule-publish' || kind === 'rule-restore')
    return {
      operationId,
      state: receipt.publishedVersion > 0 ? 'completed' : 'unknown',
      summary:
        receipt.publishedVersion > 0
          ? kind === 'rule-publish'
            ? '这份规则已发布。'
            : '已将所选历史内容发布为新的规则版本。'
          : '正在取得规则的发布结果。',
      receipt,
    };
  if (kind === 'strategy-continue')
    return {
      operationId,
      state:
        receipt.state === 'unknown'
          ? 'unknown'
          : ['completed', 'no-action', 'blocked'].includes(receipt.state)
            ? 'completed'
            : 'processing',
      summary:
        receipt.state === 'completed'
          ? '这项处理已完成。'
          : receipt.state === 'no-action'
            ? '本次决定已记录，未执行处理。'
            : receipt.state === 'blocked'
              ? '当前条件不满足，事项已停止。'
              : receipt.state === 'unknown'
                ? '本次决定已记录，正在读取处理进展。'
                : '本次决定已记录，事项正在继续。',
      receipt,
    };
  return {
    operationId,
    state:
      receipt.phase === 'result-unknown'
        ? 'unknown'
        : receipt.phase &&
            receipt.phase !== 'applied' &&
            receipt.phase !== 'failed'
          ? 'processing'
          : receipt.phase === 'failed'
            ? 'failed'
            : 'completed',
    summary:
      kind === 'file-scan-retry'
        ? '已重新安排扫描，等待扫描结果。'
        : receipt.phase === 'applied'
          ? '搜索配置已生效。'
          : receipt.phase === 'result-unknown'
            ? '搜索配置结果暂未取得，正在查询原操作。'
            : receipt.phase && receipt.phase !== 'failed'
              ? '搜索配置正在应用。'
              : receipt.phase === 'failed'
                ? '搜索配置未生效。'
                : '本次处理已完成。',
    receipt,
  };
}
