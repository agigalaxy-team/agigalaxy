import {
  workbenchPrepareSchemas,
  workbenchCommandSchemas,
  workbenchActionToolSchema,
  workbenchEmptyArgumentsSchema,
  workbenchRunArgumentsSchema,
} from "./action-catalog.mjs";
import { aiActionDefinition } from "../../shared/operations-ai-action-registry.mjs";
import { fail, parse } from "./actions/support.mjs";
import { prepareFor } from "./actions/prepare.mjs";
import { executePrepared } from "./actions/execute.mjs";
import { recoverPrepared } from "./actions/recover.mjs";
import {
  assertPriorDutyDecisionWithin,
  qualifyDutyTargetWithin,
  qualifyDutyBatchImpactWithin,
} from "./actions/duty-qualification.mjs";
import {
  dutyReceipt,
  executeDutyOperation,
} from "./actions/duty-execution.mjs";
import {
  listAuthorizedWork,
  inspectWork,
  runAuthorizedWork,
} from "./actions/authorized-work.mjs";

// This adapter does not mint an executor or grant. Model tools can discover an
// already authorized task or prepare a typed human operation. Execution uses
// the stored human card or the exact grant-bound duty command.
export class OperationsAgentOsActionTools {
  constructor({
    conversations,
    authority,
    gateway,
    services = {},
    now = authority.now,
  }) {
    Object.assign(this, {
      conversations,
      authority,
      gateway,
      services,
      now,
      db: authority.db,
      endpoint: authority.endpoint,
    });
    this.dutyKinds = new Set([
      'job-cancel',
      'job-retry',
      'search-retry',
      'content-visibility',
      'content-curation',
      'public-content-batch',
      'private-case-message',
      'section-classification',
      'section-visibility',
      'resource-visibility',
      'account-restriction',
      'feedback-update',
      'file-scan-retry',
      'file-access',
      'case-resolve',
      'recommendation-direction',
      'search-apply',
      'search-restore',
      'ordinary-strategy-draft',
      'ordinary-strategy-publish',
      'message-draft-create',
      'message-draft-save',
      'messaging-state',
    ]);
    authority.dutyActionReady = (permission) =>
      this.dutyActionReady(permission);
  }
  enableDutyKind(kind) {
    if (!workbenchPrepareSchemas[kind] || !workbenchCommandSchemas[kind])
      fail('operations_agentos_action_not_connected', 503);
    this.dutyKinds.add(kind);
  }
  dutyActionReady(permission) {
    const definition = aiActionDefinition(permission);
    if (definition?.query) return true;
    if (definition?.purposeBoundRead)
      return definition.handler.methods.every(
        (method) =>
          typeof this.services[definition.handler.service]?.[method] ===
          'function',
      );
    if (
      ['ai-role-delegation', 'ai-prompt-delegation'].includes(definition?.kind)
    )
      return definition.handler.methods.every(
        (method) => typeof this.services.permissions?.[method] === 'function',
      );
    if (!definition?.autonomous || !this.dutyKinds.has(definition.kind))
      return false;
    return (
      definition.handler?.methods.every(
        (method) =>
          typeof this.services[definition.handler.service]?.[method] ===
          'function',
      ) === true
    );
  }
  service(name, method) {
    const service = this.services[name];
    if (typeof service?.[method] !== 'function')
      fail('operations_agentos_action_not_connected', 503);
    return service;
  }
  async human(operator, action, { authorize = null, db } = {}) {
    if (this.authority.acceptsDuty?.(operator))
      return this.authority.human(operator, { action, authorize, db });
    return this.authority.human(operator, {
      action,
      authorize,
      db,
      purpose: 'prepare',
    });
  }
  async prepareFor(...args) {
    return prepareFor.call(this, ...args);
  }
  async executePrepared(...args) {
    return executePrepared.call(this, ...args);
  }
  async assertPriorDutyDecisionWithin(...args) {
    return assertPriorDutyDecisionWithin.call(this, ...args);
  }
  async qualifyDutyTargetWithin(...args) {
    return qualifyDutyTargetWithin.call(this, ...args);
  }
  async qualifyDutyBatchImpactWithin(...args) {
    return qualifyDutyBatchImpactWithin.call(this, ...args);
  }
  async dutyReceipt(...args) {
    return dutyReceipt.call(this, ...args);
  }
  async executeDutyOperation(...args) {
    return executeDutyOperation.call(this, ...args);
  }
  async recoverPrepared(...args) {
    return recoverPrepared.call(this, ...args);
  }
  async listAuthorizedWork(...args) {
    return listAuthorizedWork.call(this, ...args);
  }
  async inspectWork(...args) {
    return inspectWork.call(this, ...args);
  }
  async runAuthorizedWork(...args) {
    return runAuthorizedWork.call(this, ...args);
  }
  async execute(input) {
    const x = parse(workbenchActionToolSchema, input),
      { row, actor } = await this.conversations.current(x.conversationId);
    if (row.session_id !== x.sessionId)
      fail('operations_agentos_scope_denied', 403);
    let result;
    if (x.tool === 'list-authorized-work') {
      parse(workbenchEmptyArgumentsSchema, x.arguments);
      result = await this.listAuthorizedWork(actor, row.domain);
    } else if (x.tool === 'run-authorized-work') {
      const args = parse(workbenchRunArgumentsSchema, x.arguments);
      result = await this.runAuthorizedWork(
        actor,
        row.domain,
        args.executionId,
      );
    } else
      result = {
        state: 'prepared',
        proposal: await this.prepareFor(actor, row.domain, x.arguments),
      };
    await this.conversations.current(row.id);
    return result;
  }
}
