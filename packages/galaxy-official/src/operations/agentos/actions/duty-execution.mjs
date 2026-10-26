import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { transaction } from "../../../infrastructure/database.mjs";
import { aiActionDefinition } from '../../../shared/operations-ai-action-registry.mjs';
import { fail, parse, requestSchema, requiredActionFor } from './support.mjs';

export async function dutyReceipt(actor, stored) {
  const proposal = stored.proposal,
    operationId = stored.operation_id,
    result = await this.recoverPrepared(actor, proposal, operationId);
  // recoverPrepared reads immutable domain receipts; a model/tool ACK alone
  // never supplies the completed business state used by the task dashboard.
  const effectState =
    result.state === 'completed'
      ? 'completed'
      : result.state === 'failed'
        ? 'failed'
        : 'unknown';
  const value = {
    ...result,
    operationId,
    effectState,
    target: proposal.target,
    basis:
      effectState === 'completed'
        ? 'persisted-domain-operation-receipt'
        : 'original-operation-query',
  };
  await this.db.query(
    'UPDATE operations_ai_duty_operations_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2',
    [
      this.endpoint,
      operationId,
      effectState,
      JSON.stringify(value),
      new Date(this.now() * 1000),
    ],
  );
  return value;
}

export async function executeDutyOperation({
  actor,
  operationId,
  arguments: input,
  authorizeOperation,
  reconcile = false,
} = {}) {
  if (
    !this.authority.acceptsDuty(actor) ||
    typeof authorizeOperation !== 'function'
  )
    fail('operations_ai_duty_operation_denied', 403);
  parse(z.uuid(), operationId);
  const request = parse(requestSchema(input), input),
    permission = requiredActionFor(request),
    definition = aiActionDefinition(permission);
  if (!this.dutyKinds.has(request.kind))
    fail('operations_agentos_action_not_connected', 503);
  if (!definition?.autonomous || definition.humanOnly)
    return {
      operationId,
      state: 'waiting-human',
      effectState: 'not-started',
      code: 'operations_agentos_human_review_required',
      basis: 'fixed-human-condition',
    };
  if (!this.dutyActionReady(permission))
    return {
      operationId,
      state: 'waiting-human',
      effectState: 'not-started',
      code: 'operations_agentos_action_not_connected',
      basis: 'handler-not-connected',
    };
  const prior = (
    await this.db.query(
      'SELECT * FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2',
      [this.endpoint, operationId],
    )
  ).rows[0];
  if (prior) {
    if (
      prior.task_id !== actor.taskId ||
      prior.ai_account_id !== actor.aiAccountId ||
      !isDeepStrictEqual(prior.request, request)
    )
      fail('operations_agentos_operation_conflict');
    return this.dutyReceipt(actor, prior);
  }
  if (reconcile)
    return {
      operationId,
      state: 'unknown',
      effectState: 'unknown',
      code: 'operations_agentos_original_operation_not_recorded',
      basis: 'original-operation-query',
    };
  const proposal = await this.prepareFor(actor, actor.domain, request, {
      operationId,
    }),
    targetId = proposal.target.id;
  const verify = async (db, operation) => {
    const approved = await authorizeOperation(db, operation);
    if (approved?.allowed !== true || !approved.grantId || !approved.strategyId)
      fail('operations_ai_duty_operation_denied', 403);
    if (request.kind === 'public-content-batch') {
      await this.qualifyDutyBatchImpactWithin(
        db,
        operation.actor,
        request,
        approved,
      );
      for (const item of request.items) {
        const current = await authorizeOperation(db, {
          ...operation,
          targetId: item.id,
        });
        if (
          current?.allowed !== true ||
          ['grantId', 'grantVersion', 'strategyId', 'strategyVersionId'].some(
            (key) => current[key] !== approved[key],
          )
        )
          fail('operations_agentos_human_review_required', 409);
      }
    }
    await this.qualifyDutyTargetWithin(db, {
      ...operation,
      grantId: approved.grantId,
    });
    return approved;
  };
  const bound = await this.authority.bindDutyOperation(
      actor,
      { permission, operationId, targetId, request, command: proposal.command },
      { authorizeOperation: verify },
    ),
    binding = this.authority.dutyMetadata(bound),
    frozen = {
      schemaVersion: 1,
      kind: proposal.kind,
      domain: proposal.domain,
      request: proposal.request,
      command: proposal.command,
      target: { kind: proposal.target.kind, id: proposal.target.id },
      requiredAction: proposal.requiredAction,
      decisionSource: 'approved-automatic-plan',
    };
  const stored = await transaction(this.db, async (db) => {
    await db.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,734912487))',
      [this.endpoint + ':' + operationId],
    );
    const row = (
      await db.query(
        'SELECT * FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2',
        [this.endpoint, operationId],
      )
    ).rows[0];
    if (row) return { row, existing: true };
    return {
      row: (
        await db.query(
          `INSERT INTO operations_ai_duty_operations_v1(operation_id,endpoint,task_id,ai_account_id,kind,request,proposal,binding,state,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dispatching',$9,$9) RETURNING *`,
          [
            operationId,
            this.endpoint,
            actor.taskId,
            actor.aiAccountId,
            request.kind,
            JSON.stringify(request),
            JSON.stringify(frozen),
            JSON.stringify(binding),
            new Date(this.now() * 1000),
          ],
        )
      ).rows[0],
      existing: false,
    };
  });
  if (
    !isDeepStrictEqual(stored.row.request, request) ||
    stored.row.task_id !== actor.taskId
  )
    fail('operations_agentos_operation_conflict');
  if (stored.existing) return this.dutyReceipt(actor, stored.row);
  try {
    await this.executePrepared(bound, proposal, {
      operationId,
      authorize: () => bound,
    });
    return await this.dutyReceipt(actor, stored.row);
  } catch (error) {
    await this.db.query(
      "UPDATE operations_ai_duty_operations_v1 SET state='unknown',updated_at=$3 WHERE endpoint=$1 AND operation_id=$2",
      [this.endpoint, operationId, new Date(this.now() * 1000)],
    );
    if (error.code === 'operations_agentos_human_review_required')
      return {
        operationId,
        state: 'waiting-human',
        effectState: 'unknown',
        code: error.code,
        basis: 'current-human-condition',
      };
    throw error;
  }
}
