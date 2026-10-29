import * as z from 'zod/v4';

export const githubReference = z.strictObject({
  provider: z.literal('github-actions'), owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
  repository: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
  runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), attempt: z.number().int().min(1).max(10000),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
