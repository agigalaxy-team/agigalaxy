import * as z from 'zod/v4';

export const functionTagsSchema = z.array(z.string().trim().min(1).max(80)).max(16);
const purposesSchema = z.array(z.enum(['conversation', 'reuse', 'collaboration', 'recruitment'])).min(1).max(4)
  .refine(values => new Set(values).size === values.length);
export const discoveryPreferencesSchema = z.strictObject({
  enabled: z.boolean(),
  purposes: purposesSchema.default(['conversation']),
  functions: functionTagsSchema.default([]),
  temporary: z.strictObject({
    until: z.number().int().positive(),
    contact: z.enum(['welcome', 'paused']),
    purposes: purposesSchema.optional(),
    functions: functionTagsSchema.optional(),
  }).nullable().default(null),
});
export const defaultDiscoveryPreferences = Object.freeze({ enabled: false, purposes: ['conversation'], functions: [], temporary: null });
export const discoverySaveSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), preferences: discoveryPreferencesSchema });
export const discoveryQuerySchema = z.strictObject({ projectId: z.uuid(), limit: z.number().int().min(1).max(20).default(8) });
export const projectDescriptionSchema = z.strictObject({
  id: z.uuid(), kind: z.enum(['project', 'module']),
  title: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(2000),
  functions: functionTagsSchema.refine(values => values.length > 0),
  technologies: functionTagsSchema.default([]),
  sourceUrl: z.url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }).optional(),
  discoverable: z.boolean().default(false),
});

const subjectId = z.string().regex(/^GUID[0-9A-Z]{28}$/);
const differences = z.strictObject({ sourceOnlyFunctions: functionTagsSchema, candidateOnlyFunctions: functionTagsSchema,
  sourceOnlyTechnologies: functionTagsSchema, candidateOnlyTechnologies: functionTagsSchema });
const source = z.strictObject({ subjectId, projectId: z.uuid(), statementId: z.uuid(), sourceUrl: projectDescriptionSchema.shape.sourceUrl.unwrap().nullable() });
export const discoveryPageSchema = z.strictObject({
  items: z.array(z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), project: projectDescriptionSchema,
    subjectId, displayName: z.string().max(100).nullable(),
    match: z.strictObject({ method: z.literal('functional-tags-v1'), score: z.number().gt(0).max(1),
      sharedFunctions: functionTagsSchema.refine(values => values.length > 0), purposes: purposesSchema, differences }),
    classification: z.literal('self-declared'), capabilityVerified: z.literal(false), sources: z.tuple([source, source]),
  })).max(20),
  enabled: z.boolean(), method: z.literal('functional-tags-v1'), computedAt: z.number().int().positive(),
  windowLimited: z.boolean(), resultLimited: z.boolean(), capabilityVerified: z.literal(false),
});
export const discoveryPreferencesViewSchema = z.strictObject({ preferences: discoveryPreferencesSchema, revision: z.number().int().nonnegative(),
  effective: z.strictObject({ enabled: z.boolean(), purposes: purposesSchema, functions: functionTagsSchema, temporaryUntil: z.number().int().positive().nullable() }) });
