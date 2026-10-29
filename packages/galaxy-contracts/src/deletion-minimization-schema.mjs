import { z } from 'zod';
const ref=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),time=z.number().int().nonnegative(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const common={version:z.literal(1),id:z.uuid(),requestId:z.uuid(),endpoint:z.url(),expectedRevision:z.number().int().positive(),operatorRef:ref};
const policy={id:z.string().min(1).max(100),version:z.string().min(1).max(80),notBefore:time};
export const deletionMinimizationSchema=z.object({...common,policy:z.object({...policy,basis:z.string().min(1).max(2000)}).strict()}).strict();
export const deletionMinimizationEventSchema=z.object({...common,policy:z.object({...policy,basisHash:hash}).strict(),commandHash:hash,at:time,
  eventsMinimized:time,executionResultsCompacted:time,payloadBytesRemoved:time}).strict();
