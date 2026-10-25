import {agentOsQueryAccess} from '../../shared/operations-agentos-query-access.mjs';

// This is capability discovery for one already-bound duty task. It performs
// no business inspection, fetches no prompt body and invents no business count.
export async function taskSummaryWithin(service, db, reference) {
  const row = await service.taskWithin(db, reference.id);
  const actor = await service.authorizeTaskWithin(db, row);
  const permissions = service.authority?.permissions;
  const managementConnected = typeof permissions?.managementCapabilitiesWithin === 'function';
  const managementCapabilities = managementConnected
    ? await permissions.managementCapabilitiesWithin(db, {actor})
    : null;
  return {
    tool: 'current-summary',
    availability: 'available',
    basis: 'capability-discovery-not-business-inspection',
    inspectionChecked: false,
    taskVersionBasis: 'persisted-task-snapshot-with-current-authority',
    task: {
      taskId: row.id,
      aiAccountId: row.ai_account_id,
      domain: row.domain,
      source: row.source,
      mode: row.mode,
      state: row.state,
      planId: row.config_id,
      configRevision: row.config_revision,
      planVersion: row.plan_version,
      promptVersion: row.prompt_version,
      delegationVersion: row.delegation_version,
      roleVersion: actor.businessAuthorization.version ?? null,
    },
    queryAccess: agentOsQueryAccess(actor.businessAuthorization.permissions),
    managementCapabilities,
    managementAvailability: managementConnected ? 'available' : 'not-configured',
    ...service.stamp(),
  };
}
