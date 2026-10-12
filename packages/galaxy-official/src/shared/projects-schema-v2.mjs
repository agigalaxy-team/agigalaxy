import * as z from 'zod/v4';
import { projectDescriptionSchema, discoveryPreferencesSchema } from './discovery-schema.mjs';

const subjectId = z.string().regex(/^GUID[0-9A-Z]{28}$/);
// Unknown document extensions survive patching; they remain uninterpreted data,
// bounded by the signed envelope limit, never role or permission switches.
export const projectDocumentV2Schema = projectDescriptionSchema.omit({id:true}).extend({
  participantKind: z.enum(['human','agent','team','tool','organization','service','unknown']).default('unknown'),
}).loose().refine(value=>Object.keys(value).every(key=>key.length<=120&&key!=='@policy'));
const projectPatchV2Schema=z.looseObject({
  kind:projectDescriptionSchema.shape.kind.optional(),title:projectDescriptionSchema.shape.title.optional(),
  summary:projectDescriptionSchema.shape.summary.optional(),functions:projectDescriptionSchema.shape.functions.optional(),
  technologies:projectDescriptionSchema.shape.technologies.unwrap().optional(),
  sourceUrl:projectDescriptionSchema.shape.sourceUrl.nullable().optional(),discoverable:z.boolean().optional(),
  participantKind:z.enum(['human','agent','team','tool','organization','service','unknown']).optional(),
}).refine(value=>Object.keys(value).length>0&&Object.keys(value).every(key=>key.length<=120&&key!=='@policy'));
const common = { operationId:z.uuid(), projectId:z.uuid(), expectedRevision:z.number().int().nonnegative() };
export const projectEventV2Schema = z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('create'),document:projectDocumentV2Schema,
    sourceStatementId:z.uuid().optional()}),
  z.strictObject({...common,kind:z.literal('revise'),patch:projectPatchV2Schema}),
  z.strictObject({...common,kind:z.enum(['grant-role','revoke-role']),subjectId,role:z.enum(['editor','representative'])}),
  z.strictObject({...common,kind:z.literal('offer-transfer'),transferId:z.uuid(),toSubjectId:subjectId}),
  z.strictObject({...common,kind:z.enum(['accept-transfer','cancel-transfer']),transferId:z.uuid()}),
  z.strictObject({...common,kind:z.enum(['archive','restore'])}),
]);
export const projectEnvelopeV2Schema = z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(2).max(16000)});
export const projectPreferenceV2Schema = z.strictObject({expectedRevision:z.number().int().nonnegative(),
  preferences:discoveryPreferencesSchema.nullable()});

export const projectDirectoryQueryV2Schema = z.strictObject({
  query:z.string().trim().max(200).default(''),
  kind:z.enum(['project','module']).optional(),
  purpose:z.enum(['conversation','reuse','collaboration','recruitment']).optional(),
  limit:z.number().int().min(1).max(20).default(20),
  after:z.string().min(1).max(2048).nullable().default(null),
});
export const projectPortfolioQueryV2Schema = z.strictObject({
  ownerId:subjectId,
  limit:z.number().int().min(1).max(20).default(20),
  after:z.string().min(1).max(2048).nullable().default(null),
});
