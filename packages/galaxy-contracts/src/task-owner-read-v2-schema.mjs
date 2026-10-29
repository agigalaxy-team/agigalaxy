import * as z from 'zod/v4';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const expiry = z.number().int().positive();
// A bounded disclosure per request, not a product limit on Task participation.
export const taskOwnerReadPrepareV2Schema = z.strictObject({
  taskId: z.uuid(), operationId: z.uuid(), eventIds: z.array(z.uuid()).min(1).max(32).optional(),
});
export const taskOwnerReadDescriptorV2Schema = z.strictObject({
  version: z.literal(1), operationId: z.uuid(), taskId: z.uuid(), taskVersion: z.number().int().positive(),
  bindingId: z.uuid(), deviceId: z.uuid(), controlEpoch: z.number().int().positive(),
  eventRefs: z.array(z.strictObject({eventId: z.uuid(), version: z.number().int().positive(), payloadHash: hash})).min(1).max(33),
  expiresAt: expiry,
});
export const taskOwnerReadRequestV2Schema = z.strictObject({consentId: z.uuid(), payloadJson: z.string().min(1).max(20000)});
const guarantees = {
  projection: z.literal('currently-authorized-authored-events'), completeTaskSnapshot: z.literal(false),
  contextAccessGranted: z.literal(false), referenceAccessGranted: z.literal(false), taskWriteGranted: z.literal(false),
};
export const taskOwnerReadPreviewV2Schema = z.strictObject({
  taskId: z.uuid(), latestTaskVersion: z.number().int().positive(), ...guarantees,
  payloadJson: z.string(), payloadHash: hash, expiresAt: expiry,
  events: z.array(z.strictObject({eventId: z.uuid(), version: z.number().int().positive(), kind: z.string(),
    payloadHash: hash, createdAt: z.string(), readExpiresAt: expiry})).min(1).max(33),
});
export const taskOwnerReadResultV2Schema = z.strictObject({
  taskId: z.uuid(), latestTaskVersion: z.number().int().positive(), ...guarantees,
  events: z.array(z.strictObject({eventId: z.uuid(), version: z.number().int().positive(), kind: z.string(),
    payloadHash: hash, payloadJson: z.string()})).min(1).max(33),
});
