import { z } from 'zod';
import { defaultResourceBudgetPolicy, resourceBudgetPolicySchema } from '../src/infrastructure/resource-budgets.mjs';
import { defaultRequestQuotaPolicy, requestQuotaPolicySchema } from '../src/adapters/http/request-quotas.mjs';
import { governanceConfigSchema } from "../src/governance/governance-config.mjs";
import { parseNetworkProfile } from "../src/network/network-profile.mjs";
import { identityConfigurationSchema } from "../src/identity/config.mjs";

const text = max => z.string().trim().min(1).max(max).refine(value => !/[\p{Cc}\uFEFF]/u.test(value));
const stageSettings = z.strictObject({
  operator: text(200).optional(), operatorRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/).optional(),
  region: text(100).optional(), requestQuotaPolicy: requestQuotaPolicySchema.optional(),
  resourceBudgetPolicy: resourceBudgetPolicySchema.optional(), searchIndexEnabled: z.boolean().optional()
});
const settingsSchema = z.strictObject({ version: z.literal(1), stages: z.strictObject({
  local: stageSettings.optional(), integration: stageSettings.optional(), pilot: stageSettings.optional()
}) });

export function parseRuntimeSettings(input = { version: 1, stages: {} }) {
  return settingsSchema.parse(input);
}

// EnvironmentFile uses shell-like quoting but does not expand variables.
// Values are single-line; only double quote and backslash need escaping here.
export function environmentFile(values) {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\p{Cc}\uFEFF]/u.test(value))
      throw new Error('Invalid environment template value');
    const encoded = /^[A-Za-z0-9_./:@%+-]+$/.test(value) ? value : '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    return `${key}=${encoded}`;
  }).join('\n') + '\n';
}

export function runtimePolicyFiles(stage, input = {}) {
  if (!['local', 'integration', 'pilot'].includes(stage)) throw new Error('Known environment required');
  const settings = stageSettings.parse(input);
  const configurationDirectory = `/var/lib/galaxy/config/${stage}`;
  const files = {
    'request-quotas.json': settings.requestQuotaPolicy ?? structuredClone(defaultRequestQuotaPolicy),
    'resource-budgets.json': settings.resourceBudgetPolicy ?? structuredClone(defaultResourceBudgetPolicy),
    'governance.json': governanceConfigSchema.parse({}),
    'network-profile.json': parseNetworkProfile({ networkType: 'official', displayName: `Galaxy ${stage}` }),
    'identity.json': identityConfigurationSchema.parse({ version: 1, providers: [] })
  };
  return { configurationDirectory, settings, files,
    common: { GALAXY_RESOURCE_BUDGET_FILE: `${configurationDirectory}/resource-budgets.json` },
    api: { GALAXY_REQUEST_QUOTA_FILE: `${configurationDirectory}/request-quotas.json`,
      GALAXY_GOVERNANCE_CONFIG: `${configurationDirectory}/governance.json`,
      GALAXY_NETWORK_PROFILE_FILE: `${configurationDirectory}/network-profile.json`,
      GALAXY_IDENTITY_CONFIG_FILE: `${configurationDirectory}/identity.json` },
    decision: { operatorConfigured: Boolean(settings.operator && settings.operatorRef),
      requestQuotaBasis: settings.requestQuotaPolicy ? 'supplied-configuration' : 'existing-development-default',
      resourceBudgetBasis: settings.resourceBudgetPolicy ? 'supplied-configuration' : 'existing-development-default',
      productionBudgetAccepted: false, searchIndex: settings.searchIndexEnabled === undefined ? 'unconfigured' : settings.searchIndexEnabled,
      identityProviders: 0, personalMcpConfigured: false, governanceRoles: 0,
      retirementConfigured: false, incidentConfigured: false, activated: false }
  };
}
