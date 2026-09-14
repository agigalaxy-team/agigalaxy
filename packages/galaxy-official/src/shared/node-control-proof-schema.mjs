import * as z from 'zod/v4';
import { builderEventSchema } from './builders-schema.mjs';
const sha=z.string().regex(/^[a-f0-9]{64}$/),subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
export const nodeControlRequestSchema=z.strictObject({builderId:z.uuid(),controlId:z.uuid()});
export const nodeControlEventSchema=builderEventSchema.options.find(option=>option.shape.kind.value==='node-control');
export const nodeControlSnapshotSchema=z.strictObject({version:z.literal(1),id:z.uuid(),builderId:z.uuid(),ownerId:subject,nodeId:subject,
  declarationId:z.uuid(),declarationHash:sha,control:nodeControlEventSchema,controlPayloadJson:z.string().min(1).max(28000),sourceEventHash:sha,
  checkedAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive(),
  authority:z.literal('registry-attested-node-authorization'),capabilityVerified:z.literal(false),endpointControlVerified:z.literal(false),
  maintenance:z.strictObject({delisted:z.boolean(),securityIssue:z.boolean()}),statusPath:z.literal('/v1/builders/node-control/export')});
export const nodeProofClaimsSchema=z.strictObject({version:z.literal(1),purpose:z.literal('node-control-portable-proof'),endpoint:z.string().max(500),
  builderId:z.uuid(),controlId:z.uuid(),ownerId:subject,nodeId:subject,declarationId:z.uuid(),declarationHash:sha,registryHash:sha,
  issuedAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive()});
const proofFields={registrySigned:z.string().min(1).max(65536),nodeSigned:z.string().min(1).max(16384),
  genesisProof:z.strictObject({version:z.literal(1),publicKeyPem:z.string().max(256),nonce:z.string().max(86)})};
export const nodeControlProofSchema=z.discriminatedUnion('version',[
  z.strictObject({version:z.literal(1),...proofFields}),
  z.strictObject({version:z.literal(2),...proofFields,signerKeyId:sha,controlEpoch:z.number().int().positive(),
    controlChain:z.strictObject({subjectId:subject,genesisProof:proofFields.genesisProof,events:z.array(z.unknown()).min(1).max(10000)})}),
]);
