import {z} from 'zod';

// Provider pairing IDs are opaque values, never identities or URL segments.
// Preserve the exact bounded printable value; do not trim or normalize it.
export const operationsToolCallIdSchema=z.string().min(1).max(200)
 .refine(value=>!(/[^\x21-\x7E]/u).test(value));
