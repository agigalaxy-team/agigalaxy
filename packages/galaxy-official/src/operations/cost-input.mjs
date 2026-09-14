import { z } from 'zod';

const common = {
  currency:z.string().regex(/^[A-Z]{3}$/), kind:z.enum(['billing-export','operator-estimate']),
  amount:z.number().nonnegative(), periodStart:z.iso.datetime(), periodEnd:z.iso.datetime(), observedAt:z.iso.datetime(),
};

// Keep existing budgeted inputs readable. Version 2 can report actual costs
// before an operator has selected a budget, and records the queried scope
// without exposing cloud account or resource identifiers.
export const costInputSchema = z.discriminatedUnion('version', [
  z.object({ version:z.literal(1), ...common, budget:z.number().nonnegative() }).strict(),
  z.object({ version:z.literal(2), ...common, budget:z.number().nonnegative().nullable(),
    scope:z.object({ dimension:z.enum(['compartmentId','resourceId']), count:z.number().int().min(1).max(100),
      sha256:z.string().regex(/^[a-f0-9]{64}$/), attribution:z.literal('unallocated') }).strict(),
  }).strict(),
]).refine(value => Date.parse(value.periodStart)<Date.parse(value.periodEnd),'Invalid cost period');
