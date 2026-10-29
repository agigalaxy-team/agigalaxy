import {z} from 'zod';
export const requestQuotaCategories=['anonymous','binding','query','submission','notifications','export','revocation'];
const dimensions=z.object({ip:z.number().int().min(1).max(1000000),subject:z.number().int().min(1).max(1000000),credential:z.number().int().min(1).max(1000000)}).strict();
export const requestQuotaPolicySchema=z.object({version:z.literal(1),windowMs:z.number().int().min(1000).max(60000),capacityPerCategory:z.number().int().min(3).max(100000),
  categories:z.object(Object.fromEntries(requestQuotaCategories.map(category=>[category,dimensions]))).strict()}).strict();
export const defaultRequestQuotaPolicy=requestQuotaPolicySchema.parse({version:1,windowMs:60000,capacityPerCategory:10000,categories:{
  anonymous:{ip:60,subject:60,credential:60},binding:{ip:60,subject:60,credential:60},query:{ip:600,subject:120,credential:60},
  submission:{ip:300,subject:60,credential:30},notifications:{ip:300,subject:120,credential:60},export:{ip:120,subject:30,credential:15},revocation:{ip:300,subject:120,credential:60}}});
