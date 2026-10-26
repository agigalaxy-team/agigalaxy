import { createHash } from 'node:crypto';
import { aiWorkCapabilities } from '../../../shared/operations-ai-work-capabilities.mjs';
import { transaction } from "../../../infrastructure/database.mjs";
import { fail, label, safeReceipt } from './support.mjs';

export async function listAuthorizedWork(operator, domain) {
  // A grant-bound autonomous execution and a manager-confirmed preparation
  // are separate capabilities. An empty or denied execution directory must
  // not decide whether this current actor can prepare a human card.
  const finish = async (
    items,
    complete,
    readExpiresAt,
    availability = 'available',
  ) => {
    const preparer = await this.authority.human(operator, {
      domain,
      purpose: 'prepare',
    });
    const availableKinds = aiWorkCapabilities(
      domain,
      preparer.businessAuthorization.permissions,
    ).preparableKinds;
    return {
      items,
      basis: {
        scope: 'owned-explicit-authorized-work',
        complete,
        availability,
      },
      humanPreparation: {
        tool: 'prepare-operation',
        availableKinds,
        requiresAuthorizedExecution: false,
        requiresHumanConfirmation: true,
        objectEligibility: 'checked-when-preparing',
      },
      checkedAt: this.now(),
      readExpiresAt: Math.min(readExpiresAt, this.now() + 30),
    };
  };
  let actor, directory;
  try {
    actor = await this.authority.human(operator, {
      domain,
      purpose: 'execution',
    });
    if (
      !actor.businessAuthorization.permissions.some((code) =>
        this.authority.supported.has(code),
      )
    )
      return finish([], false, this.now() + 30, 'not-authorized');
    directory = await this.authority.list(actor);
  } catch (error) {
    if (error.status !== 403 || error.code !== 'operations_permission_denied')
      throw error;
    return finish([], false, this.now() + 30, 'not-authorized');
  }
  const items = [];
  let readExpiresAt = this.now() + 30;
  for (const execution of directory.items) {
    if (
      execution.executorKind !== 'ai' ||
      execution.state !== 'active' ||
      !execution.hasPreparedCommand ||
      execution.domain !== domain
    )
      continue;
    try {
      const item = await this.inspectWork(actor, execution.id);
      readExpiresAt = Math.min(readExpiresAt, item.readExpiresAt);
      items.push(item);
    } catch (error) {
      if (![403, 404, 409, 410].includes(error.status)) throw error;
      items.push({
        executionId: execution.id,
        domain: execution.domain,
        target: null,
        action: null,
        available: false,
        code: 'operations_agentos_work_unavailable',
      });
    }
  }
  return finish(items, directory.items.length < 100, readExpiresAt);
}

export async function inspectWork(operator, id) {
  const stored = await this.authority.get(operator, id),
    execution = stored.execution,
    command = stored.preparedAction;
  if (!command) fail('operations_agentos_prepared_command_required');
  const actor = await this.authority.actor(id, {
    resourceIds: [command.targetId],
    caller: operator,
  });
  await this.authority.requireAction(actor, 'content.read');
  const response = await this.service('content', 'get').get(
      actor,
      command.targetKind,
      command.targetId,
    ),
    item = response.content;
  const bindings = (
    await this.db.query(
      'SELECT id,state FROM operations_p13_strategy_runs_v1 WHERE endpoint=$1 AND execution_id=$2',
      [this.endpoint, id],
    )
  ).rows;
  const reviews = (
    await this.db.query(
      "SELECT id FROM operations_agentos_commands_v1 WHERE endpoint=$1 AND execution_id=$2 AND kind='review' LIMIT 1",
      [this.endpoint, id],
    )
  ).rows;
  let priorDecisionAllowed = true;
  try {
    await transaction(this.db, (db) =>
      this.gateway.checkPriorDecision(db, actor, command),
    );
  } catch (error) {
    if (error.code !== 'operations_agentos_human_review_required') throw error;
    priorDecisionAllowed = false;
  }
  const sourceMatches =
    item.sourceState === 'available' &&
    item.version === command.input.expectedVersion &&
    item.visibility.version === command.input.expectedRevision;
  const can =
    command.input.kind === 'hide'
      ? item.capabilities?.canHide
      : item.capabilities?.canRestore;
  const temporal =
    command.input.kind === 'restore' ||
    (Number.isSafeInteger(item.maxHideSeconds) &&
      command.input.until > this.now() &&
      command.input.until <= this.now() + item.maxHideSeconds);
  const available =
    sourceMatches &&
    can === true &&
    temporal &&
    priorDecisionAllowed &&
    !bindings.length &&
    !reviews.length;
  return {
    executionId: id,
    domain: execution.domain,
    action: 'content.' + command.input.kind,
    target: {
      kind: command.targetKind,
      id: command.targetId,
      label: label(
        item.title,
        command.targetKind === 'post' ? '公开帖子' : '公开回复',
      ),
      href:
        '/admin/operations/community?tab=posts&contentKind=' +
        command.targetKind +
        '&id=' +
        command.targetId,
    },
    available,
    code: bindings.length
      ? 'operations_agentos_workflow_bound'
      : reviews.length
        ? 'operations_agentos_human_review_required'
        : !priorDecisionAllowed
          ? 'operations_agentos_human_review_required'
          : available
            ? null
            : 'operations_agentos_work_unavailable',
    strategyRunId: bindings[0]?.id ?? null,
    checkedAt: this.now(),
    readExpiresAt: Math.min(this.now() + 30, item.publishedUntil ?? this.now()),
  };
}

export async function runAuthorizedWork(actor, domain, id) {
  actor = await this.authority.human(actor, { domain, purpose: 'execution' });
  const stored = await this.authority.get(actor, id);
  if (
    stored.execution.executorKind !== 'ai' ||
    stored.execution.domain !== domain
  )
    fail('operations_agentos_domain_mismatch', 403);
  await this.authority.actor(id, { caller: actor });
  const completed = (
    await this.db.query(
      "SELECT result FROM operations_agentos_tool_calls_v1 WHERE endpoint=$1 AND execution_id=$2 AND tool='execute-prepared-command' AND state='completed' ORDER BY created_at LIMIT 1",
      [this.endpoint, id],
    )
  ).rows[0];
  if (completed?.result)
    return {
      state: 'completed',
      replayed: true,
      result: safeReceipt(completed.result),
    };
  const item = await this.inspectWork(actor, id);
  if (!item.available)
    return {
      state:
        item.code === 'operations_agentos_human_review_required' ||
        item.code === 'operations_agentos_workflow_bound'
          ? 'requires-human'
          : 'unavailable',
      ...item,
    };
  // One execution already freezes one command. A second model call must query
  // that same effect rather than manufacture another business operation ID.
  const runId = 'workbench-' + createHash('sha256').update(id).digest('hex');
  const result = await this.gateway.execute(
    {
      executionId: id,
      runId,
      callId: 'workbench-prepared-command',
      tool: 'execute-prepared-command',
      arguments: {},
    },
    { caller: actor },
  );
  return { state: 'completed', executionId: id, result: safeReceipt(result) };
}
