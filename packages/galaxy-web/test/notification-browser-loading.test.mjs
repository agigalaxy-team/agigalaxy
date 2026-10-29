import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationLoader } from '../src/features/notifications/loader.mjs';

test('notification filtering and refresh discard obsolete pages and failures without changing current inbox', async () => {
  const requests = [];
  const loader = createNotificationLoader({
    query: query => new Promise((resolve, reject) => requests.push({ query, resolve, reject })),
    options: async () => ({ revision: 1, settings: {} }),
  });
  let shown = [], failures = 0;
  const handlers = { apply: page => { shown = page.items; }, failed: () => { failures++; shown = []; } };
  const oldPage = loader.load({ unreadOnly: false, after: 'old-cursor' }, handlers);
  const newFilter = loader.load({ unreadOnly: true }, handlers);
  requests[1].resolve({ items: ['current-unread'] });
  assert.equal(await newFilter, true);
  requests[0].resolve({ items: ['old-read'] });
  assert.equal(await oldPage, false);
  assert.deepEqual(shown, ['current-unread']);

  const obsoleteFailure = loader.load({}, handlers);
  const refresh = loader.load({}, handlers);
  requests[3].resolve({ items: ['fresh'] });
  await refresh;
  requests[2].reject(new Error('obsolete network failure'));
  assert.equal(await obsoleteFailure, false);
  assert.equal(failures, 0);
  assert.deepEqual(shown, ['fresh']);

  const canceled = loader.load({}, handlers);
  loader.invalidate();
  requests[4].resolve({ items: ['after-disconnect'] });
  assert.equal(await canceled, false);
  assert.deepEqual(shown, ['fresh']);
  const failed = loader.load({}, handlers);
  requests[5].reject(new Error('current network failure'));
  await assert.rejects(failed, /current network failure/);
  assert.equal(failures, 1);
  assert.deepEqual(shown, []);
});
