import * as z from 'zod/v4';

const id=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),time=z.int().nonnegative();
const text=z.string().trim().min(1).max(1500);
export const hubPermissions=['approved-proof-query','member-updates'];
const scopes=z.array(z.enum(hubPermissions)).min(1).max(hubPermissions.length).refine(x=>new Set(x).size===x.length);
// A test claim carries an actual report reference. Its current validity is read
// from BuilderService; this authored text cannot itself certify execution.
const clause=z.strictObject({text,status:z.enum(['declared','reported-tested','unknown']),asOf:time,
  reportRef:z.strictObject({eventId:id,payloadHash:hash,action:z.string().min(1).max(80)}).optional()})
  .refine(x=>x.status!=='reported-tested'||!!x.reportRef);
export const hubCharterSchema=z.strictObject({profile:z.literal('galaxy-hub-charter/1'),name:z.string().trim().min(1).max(160),
  scope:clause,constituency:clause,operator:clause,governance:clause,memberBenefits:clause,commercialModel:clause,
  evidenceSources:clause,strengthMapping:clause,membershipPolicy:clause,workerPolicy:clause,
  visibility:clause,retention:clause,residency:clause,training:clause,qualification:clause,honor:clause,reputation:clause,
  bridgeMapping:clause,conformance:clause,exportPolicy:clause,exitPolicy:clause,successMetrics:clause,
  offeredScopes:scopes,intake:z.strictObject({kind:z.literal('hub-private-intake'),responseTargetDays:z.int().min(1).max(90)}),
  routing:z.strictObject({direct:z.literal(true),relay:z.literal('not-enabled'),officialProtocolFee:z.literal(0)}),
  pilot:z.strictObject({classification:z.enum(['operator-declared-network','controlled-reference-pilot']),synthetic:z.boolean()})});
const base={schemaVersion:z.literal(2),id,hubId:id};
export const hubEventSchema=z.discriminatedUnion('kind',[
  z.strictObject({...base,kind:z.literal('charter'),expectedVersion:z.int().min(0),declarationId:id,declarationHash:hash,charter:hubCharterSchema}),
  z.strictObject({...base,kind:z.literal('invite'),membershipId:id,memberId:subject,expectedVersion:z.literal(0),charterVersion:z.int().min(1),scopes,expiresAt:time}),
  z.strictObject({...base,kind:z.enum(['accept','decline','exit','remove']),membershipId:id,expectedVersion:z.int().min(1),
    charterVersion:z.int().min(1),acceptedScopes:scopes.optional()}),
  z.strictObject({...base,kind:z.enum(['suspend','resume']),expectedVersion:z.int().min(1)}),
  z.strictObject({...base,kind:z.literal('intake-open'),threadId:id,title:z.string().trim().min(1).max(160),text:z.string().trim().min(1).max(6000)}),
  z.strictObject({...base,kind:z.enum(['intake-reply','intake-close']),threadId:id,expectedVersion:z.int().min(1),text:z.string().trim().min(1).max(6000)})
]);
export const hubReadSchema=z.strictObject({hubId:id,version:z.int().min(1).optional()});
export const hubQuerySchema=z.strictObject({view:z.enum(['public','owned','joined']).default('public'),after:id.optional(),limit:z.int().min(1).max(50).default(20)});
export const hubMembershipQuerySchema=z.strictObject({hubId:id,after:id.optional(),limit:z.int().min(1).max(50).default(20)});
export const hubReceiptSchema=z.strictObject({operationId:id,payloadHash:hash});
export const hubIntakeQuerySchema=z.strictObject({hubId:id,threadId:id.optional(),after:id.optional(),limit:z.int().min(1).max(50).default(20)});

export function parseHub(schema,input){const r=schema.safeParse(input);return r.success?r.data:null;}
