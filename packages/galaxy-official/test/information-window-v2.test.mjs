import test from 'node:test';
import assert from 'node:assert/strict';
import { InformationWatchServiceV2 } from "../src/information/information-watches-v2.mjs";
import { InformationServiceV2 } from "../src/information/information-v2.mjs";
test('independent cursor scope and incomplete multi-check coverage never infer deletion', async () => {
  const source = {
      kind: 'search',
      request: { type: 'task', query: { query: 'review', limit: 1 } },
    },
    selection = { key: 'tasks', source };
  const info = new InformationServiceV2(
    { endpoint: 'https://fixture.example', now: () => 100 },
    { search: {}, honor: {} },
  );
  const actor = { subjectId: 'GUID' + 'A'.repeat(28) },
    base = info.queryId(actor, 'help', [selection]);
  assert.equal(
    info.queryId(actor, 'help', [
      {
        ...selection,
        source: {
          ...source,
          request: {
            ...source.request,
            query: {
              ...source.request.query,
              after: '00000000-0000-4000-8000-000000000001',
            },
          },
        },
      },
    ]),
    base,
  );
  let version = 'new';
  const watch = new InformationWatchServiceV2(
    { now: () => 100 },
    {
      information: {
        async source(_actor, s) {
          const n = Number(s.source.request.query.after ?? 0);
          return {
            state: 'available',
            complete: n === 6,
            nextCursor: n === 6 ? null : String(n + 1),
            sourceVersions: [{ id: 'item-' + n, version }],
          };
        },
      },
    },
  );
  const baseline = Array.from({ length: 7 }, (_, n) => ({
    id: 'item-' + n,
    version: 'old',
  }));
  const first = await watch.scanSource(actor, selection, {}, baseline);
  assert.equal(first.complete, false);
  assert.equal(first.after, '5');
  assert.deepEqual(first.changes, []);
  assert.deepEqual(first.baseline, baseline);
  const second = await watch.scanSource(
    actor,
    selection,
    { after: first.after, refs: first.refs, state: first.state },
    baseline,
  );
  assert.equal(second.complete, true);
  assert.equal(second.changes.length, 7);
  assert.equal(
    second.changes.some((c) => c.kind === 'no-longer-in-current-scope'),
    false,
  );
  version = 'old';
  const unavailable = new InformationWatchServiceV2(
    { now: () => 100 },
    {
      information: {
        async source() {
          return {
            state: 'temporarily-unavailable',
            complete: false,
            nextCursor: null,
            sourceVersions: [],
          };
        },
      },
    },
  );
  const fail = await unavailable.scanSource(
    actor,
    selection,
    { after: first.after, refs: first.refs, state: first.state },
    baseline,
  );
  assert.equal(fail.complete, false);
  assert.deepEqual(fail.baseline, baseline);
  assert.equal(
    fail.changes.some((c) => c.id),
    false,
  );
});
