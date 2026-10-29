import {z} from 'zod';
import {ServiceError} from './service-error.mjs';

export const accountFeedbackDataIntentSchema=z.strictObject({operationId:z.uuid()});
export const accountFeedbackDataIdSchema=z.uuid();
const sequence=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value=>BigInt(value)<=9223372036854775807n);
export const accountFeedbackDataPageSchema=z.strictObject({after:sequence.optional(),limit:z.number().int().min(1).max(50).default(50)});
export function parseAccountFeedbackData(schema,input){const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_account_feedback_data_request',400);return result.data;}
