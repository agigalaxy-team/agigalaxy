import {z} from 'zod/v4';
export const honorQueryV2Schema=z.strictObject({ruleId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),ruleVersion:z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/),
  subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/),after:z.string().regex(/^[a-f0-9]{64}$/).optional(),limit:z.number().int().min(1).max(20).default(8),
  expectedFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),includeSimulation:z.boolean().default(false)});
