import * as z from 'zod/v4';
import {selectedTextSchema} from './context-schema.mjs';
const safe=(max)=>selectedTextSchema.refine(s=>s.trim().length>0&&s.length<=max);
const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
const component=z.strictObject({name:safe(160),version:safe(80).nullable(),reference:safe(500).optional()});
const pair=z.strictObject({name:safe(160).nullable(),version:safe(80).nullable()});
export const configurationConditionsSchema=z.strictObject({
  model:pair,runtime:pair,environment:pair,
  tools:z.array(component).max(32),skills:z.array(component).max(32),mcp:z.array(component).max(32),
  promptPolicyVersion:safe(160).nullable(),rulesVersion:safe(160).nullable(),
  operationScope:z.array(safe(160)).max(32),inputScopeSummary:safe(1600).nullable(),
  contentFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  limitations:safe(1600),
});
const common={schemaVersion:z.literal(2),id:z.uuid(),operationId:z.uuid(),expectedVersion:z.number().int().min(0).max(1000),actorId:subject};
export const configurationEventV2Schema=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('record'),title:safe(160),summary:safe(1600),conditions:configurationConditionsSchema,
    observedAt:z.iso.datetime(),synthetic:z.boolean(),selectedFieldsOnly:z.literal(true)}),
  z.strictObject({...common,kind:z.literal('revoke'),expectedVersion:z.number().int().positive(),reason:safe(1600)})]);
export const configurationReadV2Schema=z.strictObject({id:z.uuid(),version:z.number().int().positive().optional()});
export const configurationQueryV2Schema=z.strictObject({subjectId:subject.optional(),after:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
export const configurationVersionsV2Schema=z.strictObject({id:z.uuid(),afterVersion:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(50).default(20)});
export const configurationReceiptV2Schema=z.strictObject({operationId:z.uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
