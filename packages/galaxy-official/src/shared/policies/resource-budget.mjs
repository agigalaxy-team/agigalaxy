import {z} from 'zod';

// Pure policy contract shared by validation consumers and runtime loaders.
export const resourceBudgetPolicySchema=z.object({version:z.literal(1),maxPayloadBytesPerSubject:z.number().int().min(0).max(1099511627776),
  maxQueuedJobsPerSubject:z.number().int().min(1).max(100000),maxActiveExportsPerSubject:z.number().int().min(1).max(1000),
  maxActiveJobsGlobal:z.number().int().min(1).max(1000),maxActiveJobsPerSubject:z.number().int().min(1).max(1000)}).strict();
export const defaultResourceBudgetPolicy=resourceBudgetPolicySchema.parse({version:1,maxPayloadBytesPerSubject:1048576,maxQueuedJobsPerSubject:32,maxActiveExportsPerSubject:3,maxActiveJobsGlobal:4,maxActiveJobsPerSubject:1});
