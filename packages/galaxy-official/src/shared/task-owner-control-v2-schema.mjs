import * as z from 'zod/v4';
import {taskEnvelopeV2Schema} from './task-schema-v2.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive();
export const taskOwnerControlPrepareV2Schema=z.strictObject({taskId:z.uuid(),operationId:z.uuid(),
  kind:z.enum(['cancel','close','stop-enrollment']),reason:z.string().trim().min(1).max(1500),terminationIntent:z.literal('terminate-task').optional()});
export const taskOwnerControlRequestV2Schema=z.strictObject({consentId:z.uuid(),payloadJson:z.string().min(1).max(20000)});
// Retain the ordinary Task event bytes and original receipt contract. A reading
// permit is never a valid authorization for this separate control operation.
export const taskOwnerControlEnvelopeV2Schema=taskEnvelopeV2Schema.refine(value=>['cancel','close','stop-enrollment'].includes(value.event.kind));
const effects={historyRetained:z.literal(true),materialAccessChanged:z.literal(false),
  completeTaskAccessGranted:z.literal(false),settlementExecuted:z.literal(false)};
export const taskOwnerControlPreviewV2Schema=z.strictObject({taskId:z.uuid(),operationId:z.uuid(),kind:z.enum(['cancel','close','stop-enrollment']),
  expectedTaskVersion:positive,payloadJson:z.string(),payloadHash:hash,expiresAt:positive,
  authorization:z.strictObject({action:z.literal('assistance.publish'),objectId:z.uuid(),visibility:z.literal('Private'),
    viewers:z.array(z.never()).length(0),purpose:z.literal('operational'),recipient:z.string(),
    fields:z.tuple([z.literal('taskId'),z.literal('event')]),bindingId:z.uuid(),deviceId:z.uuid(),controlEpoch:positive}),
  source:z.strictObject({eventId:z.uuid(),version:positive,payloadHash:hash,expiresAt:positive}),...effects});
export const taskOwnerControlResultV2Schema=z.strictObject({taskId:z.uuid(),eventId:z.uuid(),version:positive,
  state:z.enum(['canceled','closed','enrollment-stopped']),payloadHash:hash,authority:z.literal('accepted-operation-only'),
  currentAccessGranted:z.literal(false),...effects});
