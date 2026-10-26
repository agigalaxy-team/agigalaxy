/** Native handlers/query builders; only database/network execution is doubled.
 * No claim of real ClickHouse execution is made by these build-time leaves.
 * Root additionally checks the native API and read-only literal rows when
 * activating the new service; that is separate from this transport double.
 */
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sql: [] as string[],
  cohort: vi.fn(async (_project: string, _filters: unknown) => [{ cohort_interval: 'Weighted Average', sum: 0, values: [], percentages: [] }]),
  flow: vi.fn(async (input: any) => {
    input.onTimezone?.('Asia/Shanghai');
    return { mode: input.mode, startEvent: input.startEvent, node_count: 0, link_count: 0, nodes: [], links: [] };
  }),
}));

// The root test package has no @openpanel/db dependency. Resolve the actual
// workspace barrel used by apps/api, rather than a nonexistent root package.
vi.mock('../../packages/db/index.ts', () => ({
  getRetentionCohortCore: state.cohort,
  getUserFlowCore: state.flow,
  resolveClientProjectId: async (input: any) => {
    if (input.inputProjectId !== input.clientProjectId) throw new Error('Project denied');
    return input.clientProjectId;
  },
  resolveDateRange: (startDate: string, endDate: string) => ({ startDate, endDate }),
  getSettingsForProject: async () => ({ timezone: 'Asia/Shanghai' }),
}));
vi.mock('../../packages/db/src/clickhouse/client', () => ({
  TABLE_NAMES: { events: 'events', cohort_events_mv: 'cohort_events_mv' },
  ch: { query: vi.fn(async ({ query }: { query: string }) => {
    state.sql.push(query);
    // Native's first query selects the Top entries, its next query computes
    // transitions. Return one controlled entry so both real SQL stages build.
    const data = query.includes('pair.1 as source') ? [] : [{ entry_event: 'entry', count: 2 }];
    return { json: async () => ({ data }) };
  }) },
  chQuery: vi.fn(async (query: string) => { state.sql.push(query); return []; }),
  formatClickhouseDate: (date: string) => date,
}));
vi.mock('../../packages/db/src/prisma-client', () => ({ db: {} }));
vi.mock('../../packages/db/src/services/organization.service', () => ({
  getSettingsForProject: async () => ({ timezone: 'Asia/Shanghai' }),
}));

import { getRetentionCohort as cohortHandler, getUserFlow as flowHandler, zRetentionCohortQuery, zUserFlowQuery } from '../../apps/api/src/controllers/insights.controller';
import { accountAnalyticsFilters } from '../../apps/api/src/utils/account-analytics-scope';
import { getRetentionCohort, getRetentionCohortCore } from '../../packages/db/src/services/retention.service';
import { SankeyService, getUserFlowCore } from '../../packages/db/src/services/sankey.service';
import { ch } from '../../packages/db/src/clickhouse/client';

const project = '11111111-1111-4111-8111-111111111111';
const accountA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const accountB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dates = { startDate: '2026-10-01 00:00:00', endDate: '2026-10-20 23:59:59' };
function reply() {
  const headers: Record<string, unknown> = {};
  const value = { headers, body: undefined as unknown, header(name: string, data: unknown) { headers[name.toLowerCase()] = data; return value; }, send(body: unknown) { value.body = body; return value; } };
  return value;
}
function request(query: unknown) { return { params: { projectId: project }, client: { type: 'read', projectId: project, organizationId: 'fixture-org' }, query }; }

it('native account handlers accept only fixed scope/UUID, preserve default body, bind project and acknowledge the exact successful scope', async () => {
  for (const bad of [
    { scope: 'all' }, { scope: ['accounts', 'accounts'] },
    { scope: 'accounts', accountId: ['a', 'b'] }, { accountId: accountA },
    { scope: 'accounts', accountId: "x' OR 1=1" },
    { scope: 'accounts', filters: [] }, { scope: 'accounts', profileId: 'visitor:1' },
  ]) {
    expect(zRetentionCohortQuery.safeParse(bad).success).toBe(false);
    expect(zUserFlowQuery.safeParse({ startEvent: 'entry', ...bad }).success).toBe(false);
  }
  const plain = reply();
  await cohortHandler(request(zRetentionCohortQuery.parse({})) as any, plain as any);
  expect(state.cohort).toHaveBeenLastCalledWith(project, []);
  expect(plain.headers).toEqual({});
  expect(plain.body).toEqual([{ cohort_interval: 'Weighted Average', sum: 0, values: [], percentages: [] }]);
  const all = reply();
  await cohortHandler(request(zRetentionCohortQuery.parse({ scope: 'accounts' })) as any, all as any);
  expect(state.cohort).toHaveBeenLastCalledWith(project, [{ id: 'galaxy-account-scope', name: 'profile_id', operator: 'startsWith', value: ['account:'] }]);
  expect(all.headers['x-galaxy-analytics-scope']).toBe('accounts');
  expect(all.headers).not.toHaveProperty('x-galaxy-analytics-account-id');
  expect(all.headers).not.toHaveProperty('x-galaxy-analytics-timezone');
  expect(all.headers.link).toBe('<https://agigalaxy.org/open-source/openpanel-public2-galaxy-accounts-20261023/source.tar.gz>; rel="source"');
  const selected = reply();
  await flowHandler(request(zUserFlowQuery.parse({ ...dates, startEvent: 'entry', scope: 'accounts', accountId: accountA.toUpperCase() })) as any, selected as any);
  expect(state.flow.mock.calls.at(-1)?.[0].accountFilters).toEqual([{ id: 'galaxy-account-scope', name: 'profile_id', operator: 'is', value: [`account:${accountA}`] }]);
  expect(selected.headers['x-galaxy-analytics-account-id']).toBe(accountA);
  expect(selected.headers['x-galaxy-analytics-timezone']).toBe('Asia/Shanghai');
  expect(selected.body).toEqual({ mode: 'after', startEvent: 'entry', node_count: 0, link_count: 0, nodes: [], links: [] });
  const denied = request(zRetentionCohortQuery.parse({ scope: 'accounts' }));
  denied.params.projectId = accountB;
  await expect(cohortHandler(denied as any, reply() as any)).rejects.toThrow('Project denied');
});

it('native cohort filters both event sets and native Sankey partitions account/session before anchors, deduplication and Top transitions', async () => {
  for (const [label, scope] of [
    ['accounts', { scope: 'accounts' as const }],
    ['account-a', { scope: 'accounts' as const, accountId: accountA }],
  ] as const) {
    const filters = accountAnalyticsFilters(scope);
    state.sql.length = 0;
    await getRetentionCohort({ projectId: project, ...dates, interval: 'week', filters });
    const cohort = state.sql[0]!;
    const predicate = scope.accountId ? `profile_id = 'account:${accountA}'` : "profile_id LIKE 'account:%'";
    expect(cohort.split(predicate)).toHaveLength(3); // entry AND return, not only final result
    expect(cohort).toContain('GROUP BY profile_id');
    expect(cohort).toContain('FROM events');
    expect(cohort).not.toContain('FROM cohort_events_mv');
    expect(cohort).not.toMatch(/profile_aliases|JOIN profiles/);

    const engine = new SankeyService(ch as any);
    for (const mode of ['after', 'between'] as const) {
      state.sql.length = 0;
      await engine.getSankey({ projectId: project, ...dates, timezone: 'Asia/Shanghai', steps: 5, mode,
        startEvent: { id: 'entry', name: 'entry', displayName: 'entry', type: 'event', segment: 'event', filters: [] },
        endEvent: { id: 'finish', name: 'finish', displayName: 'finish', type: 'event', segment: 'event', filters: [] },
        exclude: [], accountFilters: filters,
      });
      const [top, transitions] = state.sql;
      expect(top).toContain('tuple(profile_id, session_id) AS account_session_id');
      expect(top).toContain('account_session_id AS session_id');
      expect(top).toContain('GROUP BY account_session_id');
      expect(top!.split(predicate)).toHaveLength(mode === 'between' ? 4 : 3); // anchor(s) AND ordered events
      expect(top).toContain('LIMIT 3'); // retain native Top entry subset
      expect(transitions).toContain(predicate);
      expect(transitions).not.toMatch(/profile_aliases|JOIN profiles/);
    }
  }
  state.sql.length = 0;
  await getRetentionCohortCore(project);
  expect(state.sql[0]).toContain('FROM cohort_events_mv');
  expect(state.sql[0]).not.toContain("'account:%'");
  state.sql.length = 0;
  let timezone: string | undefined;
  await getUserFlowCore({ projectId: project, ...dates, startEvent: 'entry', mode: 'after', onTimezone: (zone) => { timezone = zone; } });
  expect(timezone).toBe('Asia/Shanghai');
  expect(state.sql[0]).not.toContain('account_session_id');
  expect(state.sql[0]).not.toContain("'account:%'");
});

