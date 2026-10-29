import { builderAssessorIdsSchema } from "./builders-schema.mjs";
import { auditRoleIdsSchema } from "./audit-schema.mjs";
import { conformanceSuitePinsSchema } from "./conformance-schema.mjs";
import { honorRuleSchema } from "./honor-schema.mjs";
import * as z from 'zod/v4';
import { qualificationPolicySchema } from "./qualification-schema.mjs";
import { moderatorIdsSchema } from "./moderation-schema.mjs";
import { experienceReviewerSchema } from "./experience-review-schema.mjs";
// Keep this addition optional so an existing signed governance definition keeps
// its canonical hash. Runtime absence still means no authorized reviewers.
export const governanceConfigSchema = z.strictObject({ experienceReviewers: z.array(experienceReviewerSchema).max(128).optional(), auditReaderIds: auditRoleIdsSchema.default([]), auditReviewerIds: auditRoleIdsSchema.default([]), conformanceSuitePins: conformanceSuitePinsSchema.default([]), builderAssessorIds: builderAssessorIdsSchema.default([]), honorRules: z.array(honorRuleSchema).max(8).default([]), qualificationPolicies: z.array(qualificationPolicySchema).max(64).default([]), moderatorIds: moderatorIdsSchema.default([]) });
