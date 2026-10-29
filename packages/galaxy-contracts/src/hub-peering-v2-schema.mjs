import * as z from 'zod/v4';
import {contributionSourceRefSchema} from './contribution-sharing-v2-schema.mjs';
const id=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/),timestamp=z.int().nonnegative();
const endpoint=z.url().refine(v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.origin===v&&!u.username&&!u.password;}catch{return false;}});
const pin=z.strictObject({kid:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),publicKeyPem:z.string().min(80).max(800),notBefore:timestamp,notAfter:timestamp});
export const peeringPartySchema=z.strictObject({endpoint,hubId:id,operatorId:subject,keys:z.array(pin).min(1).max(3)});
export const peeringAgreementSchema=z.strictObject({profile:z.literal('galaxy-direct-proof/1'),id,version:z.int().min(1),
  parties:z.tuple([peeringPartySchema,peeringPartySchema]).refine(p=>p[0].endpoint<p[1].endpoint),
  sourceKinds:z.array(z.enum(['ci-proof-v2','contribution-summary'])).min(1).max(2).refine(x=>new Set(x).size===x.length),
  purpose:z.literal('help-discovery'),ratePerMinute:z.int().min(1).max(60),pageSize:z.int().min(1).max(20),expiresAt:timestamp,
  responseMaxAgeSeconds:z.int().min(1).max(300),cache:z.literal('no-response-body-retention'),route:z.literal('direct'),officialProtocolFee:z.literal(0),
  localEvaluationAuthority:z.literal('no-automatic-capability-upgrade'),rawTaskContext:z.literal('excluded'),intake:z.literal('each-party-hub-private-intake')});
export const peeringSummaryFields=['eventType','actorId','role','interventionTypes','scopeVersion','reportedOutcome','time'];
const selectedFields=z.array(z.enum(peeringSummaryFields)).min(2).max(peeringSummaryFields.length)
  .refine(f=>new Set(f).size===f.length&&f.includes('eventType')&&f.includes('actorId'));
export const peeringSourceSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('ci-proof-v2'),id,payloadHash:hash}),
  z.strictObject({kind:z.literal('contribution-summary'),source:contributionSourceRefSchema,fields:selectedFields})
]);
const base={schemaVersion:z.literal(2),id,hubId:id};
export const peeringEventSchema=z.discriminatedUnion('kind',[
  z.strictObject({...base,kind:z.literal('peer-approve'),expectedVersion:z.int().min(0),agreement:peeringAgreementSchema}),
  z.strictObject({...base,kind:z.literal('peer-exit'),agreementId:id,expectedVersion:z.int().min(1)}),
  z.strictObject({...base,kind:z.literal('source-grant'),agreementId:id,agreementVersion:z.int().min(1),source:peeringSourceSchema,
    requesterIds:z.array(subject).min(1).max(16).refine(x=>new Set(x).size===x.length),expiresAt:timestamp,
    purpose:z.literal('selected-peering-read-only'),disclosure:z.literal('exact-proof-or-selected-nonnarrative-contribution-fields'),redactionConfirmed:z.literal(true)}),
  z.strictObject({...base,kind:z.literal('source-revoke'),grantId:id})
]);
export const peeringReadSchema=z.strictObject({hubId:id,agreementId:id});
export const peeringListSchema=z.strictObject({hubId:id,kind:z.enum(['agreements','grants']),after:id.optional(),limit:z.int().min(1).max(20).default(10)});
export const peeringPreviewSchema=z.strictObject({hubId:id,agreementId:id,source:peeringSourceSchema});
export const peeringConnectionsSchema=z.strictObject({hubId:id,after:id.optional(),limit:z.int().min(1).max(20).default(10)});
export const peeringSourcesSchema=z.strictObject({hubId:id,kind:z.enum(['ci-proof-v2','case-event','task-event']),parentId:id.optional(),after:id.optional(),limit:z.int().min(1).max(20).default(10)})
 .refine(q=>q.kind==='ci-proof-v2'?!q.parentId:!!q.parentId);
export const peeringQuerySchema=z.strictObject({hubId:id,agreementId:id,queryId:id,after:z.int().nonnegative().default(0),
  recheck:z.array(id).max(20).default([])});
export const peerExchangeRequestSchema=z.strictObject({profile:z.literal('galaxy-direct-proof/1'),kind:z.literal('query'),queryId:id,
  agreementId:id,agreementHash:hash,fromHubId:id,toHubId:id,requesterId:subject,origin:endpoint,destination:endpoint,
  purpose:z.literal('help-discovery'),after:z.int().nonnegative(),recheck:z.array(id).max(20)});
export const peeringWriteSchema=z.strictObject({consentId:id,payloadJson:z.string().max(48000)});
