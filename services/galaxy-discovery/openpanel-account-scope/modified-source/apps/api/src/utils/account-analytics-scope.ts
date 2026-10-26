// Galaxy modification 2026-10-23: fixed account scope, not a general filter API.
import type { IChartEventFilter } from '@openpanel/validation';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

export const accountAnalyticsShape = {
  scope: z.literal('accounts').optional(),
  accountId: z.string().uuid().transform((id) => id.toLowerCase()).optional(),
};

type AccountScope = { scope?: 'accounts'; accountId?: string };

export function validateAccountAnalyticsScope(input: AccountScope, ctx: z.RefinementCtx) {
  if (input.accountId && input.scope !== 'accounts') {
    ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'accountId requires scope=accounts' });
  }
}

export function accountAnalyticsFilters(input: AccountScope): IChartEventFilter[] {
  if (input.scope !== 'accounts') return [];
  return [{
    id: 'galaxy-account-scope', name: 'profile_id',
    operator: input.accountId ? 'is' : 'startsWith',
    value: [input.accountId ? `account:${input.accountId}` : 'account:'],
  }];
}

export function acknowledgeAccountAnalytics(reply: FastifyReply, input: AccountScope, timezone?: string) {
  if (input.scope !== 'accounts') return;
  reply.header('X-Galaxy-Analytics-Scope', 'accounts');
  if (input.accountId) reply.header('X-Galaxy-Analytics-Account-Id', input.accountId);
  if (timezone) reply.header('X-Galaxy-Analytics-Timezone', timezone);
  reply.header('Link', '<https://agigalaxy.org/open-source/openpanel-public2-galaxy-accounts-20261023/source.tar.gz>; rel="source"');
}
