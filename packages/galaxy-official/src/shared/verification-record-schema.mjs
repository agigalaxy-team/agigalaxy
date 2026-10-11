import * as z from 'zod/v4';

const text = z.string().trim().min(1).max(4000);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const subject = z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const evidenceVersionRef = z.strictObject({id:z.uuid(),version});
export const verificationTargetSchema = evidenceVersionRef.extend({type:z.enum(['attempt','intervention','result'])});
const common = {
  id:z.uuid(),operationId:z.uuid(),expectedVersion:z.number().int().nonnegative().max(999),
  caseId:z.uuid(),reportedBy:subject,taskId:z.uuid().nullable().optional(),participationId:z.uuid().nullable().optional(),
  participationScopeVersion:version.optional(),reason:text.optional(),synthetic:z.boolean()
};
export const evidenceReferenceRecordSchema = z.strictObject({
  ...common,kind:z.literal('evidence'),
  evidenceType:z.enum(['self-assertion','counterparty-confirmation','git-commit','pull-request','issue','ci-result','test-result',
    'build-result','artifact-hash','signed-statement','organization-record','credential','external-platform-record','production-metric','payment-proof','capsule-reuse']),
  source:z.strictObject({originSystem:z.string().trim().min(1).max(120),externalStableId:z.string().trim().min(1).max(1000),
    contentVersion:z.string().trim().min(1).max(240),contentHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    uri:z.url().max(2048).optional(),originalAt:z.iso.datetime(),issuer:text,owner:text.optional()}),
  observedAt:z.iso.datetime(),reportedSourceState:z.enum(['available','unreachable','removed','unknown']),
  summary:text,expiresAt:z.iso.datetime().nullable().optional()
});
export const verificationRecordSchema = z.strictObject({
  ...common,kind:z.literal('verification'),target:verificationTargetSchema,scopeVersion:version,
  method:z.enum(['participant-feedback','requester-acceptance','local-test','unit-test','integration-test','build','ci-report',
    'benchmark','peer-review','human-review','agent-verifier','production-validation','enterprise-attestation','external-system']),
  scope:text,conditions:z.record(z.string().min(1).max(80),z.union([z.string().max(2000),z.number(),z.boolean()])).refine(x=>Object.keys(x).length<=30),
  observation:z.enum(['passed','failed','inconclusive','accepted','partially-accepted','rejected','comment']),
  summary:text,evidenceRefs:z.array(evidenceVersionRef).max(50),
  relationship:z.enum(['same-controller','counterparty','independent','unknown']),observedAt:z.iso.datetime(),
  expiresAt:z.iso.datetime().nullable().optional()
});
export const verificationRevocationSchema = z.strictObject({...common,kind:z.literal('revoke'),
  objectType:z.enum(['evidence','verification']),reason:text});
export const verificationEventSchema=z.discriminatedUnion('kind',[evidenceReferenceRecordSchema,verificationRecordSchema,verificationRevocationSchema]);
export const evidenceStatusQuerySchema=z.strictObject({refs:z.array(z.strictObject({type:z.enum(['evidence','verification','proof','ci-proof-v2']),
  id:z.uuid(),version:version.optional()})).max(100)});

// Exact accepted operation metadata is independent of current material access.
// An absent retained row does not establish that an operation never occurred.
export const verificationOperationReceiptQuerySchema=z.strictObject({type:z.enum(['evidence','verification']),
  id:z.uuid(),operationId:z.uuid(),payloadHash:z.string().regex(/^[0-9a-f]{64}$/)});
const receiptCommon={...verificationOperationReceiptQuerySchema.shape,authority:z.literal('accepted-operation-only'),
  audience:z.literal('owner-only'),currentAccessGranted:z.literal(false),contentReturned:z.literal(false),
  sourceAccessChecked:z.literal(false)};
export const verificationOperationReceiptResultSchema=z.discriminatedUnion('state',[
  z.strictObject({...receiptCommon,state:z.literal('acknowledged'),receipt:z.strictObject({
    ...verificationOperationReceiptQuerySchema.shape,version,acceptedAt:z.iso.datetime()})}),
  z.strictObject({...receiptCommon,state:z.literal('absent'),absenceMeaning:z.literal('no-retained-owner-operation')}),
  z.strictObject({...receiptCommon,state:z.literal('conflict'),reason:z.literal('original-operation-mismatch')})
]).superRefine((value,ctx)=>{if(value.state==='acknowledged'&&['type','id','operationId','payloadHash'].some(key=>value[key]!==value.receipt[key]))
  ctx.addIssue({code:'custom',message:'Original verification operation receipt mismatch'});});
