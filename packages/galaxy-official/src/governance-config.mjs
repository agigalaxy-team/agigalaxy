import { builderAssessorIdsSchema } from './shared/builders-schema.mjs';
import { auditRoleIdsSchema } from './shared/audit-schema.mjs';
import { conformanceSuitePinsSchema } from './shared/conformance-schema.mjs';
import { honorRuleSchema } from './shared/honor-schema.mjs';
import * as z from 'zod/v4';
import { readFile, stat } from 'node:fs/promises';
import { qualificationPolicySchema } from './shared/qualification-schema.mjs';
import { moderatorIdsSchema } from './shared/moderation-schema.mjs';
import { experienceReviewerSchema } from './shared/experience-review-schema.mjs';
// Keep this addition optional so an existing signed governance definition keeps
// its canonical hash. Runtime absence still means no authorized reviewers.
export const governanceConfigSchema = z.strictObject({ experienceReviewers: z.array(experienceReviewerSchema).max(128).optional(), auditReaderIds: auditRoleIdsSchema.default([]), auditReviewerIds: auditRoleIdsSchema.default([]), conformanceSuitePins: conformanceSuitePinsSchema.default([]), builderAssessorIds: builderAssessorIdsSchema.default([]), honorRules: z.array(honorRuleSchema).max(8).default([]), qualificationPolicies: z.array(qualificationPolicySchema).max(64).default([]), moderatorIds: moderatorIdsSchema.default([]) });
export async function loadGovernanceConfig(path) {
  if (!path) return governanceConfigSchema.parse({});
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536) throw new Error('Invalid governance configuration file.');
  return governanceConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
