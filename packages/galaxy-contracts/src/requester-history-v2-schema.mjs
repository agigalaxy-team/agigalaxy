import {z} from 'zod/v4';
export const requesterHistoryV2Schema=z.strictObject({subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/).optional(),
  after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)});
export const requesterHistoryFactsV2Schema=z.strictObject({rootEventId:z.uuid(),after:z.uuid().optional(),limit:z.number().int().min(1).max(20).default(8)});
