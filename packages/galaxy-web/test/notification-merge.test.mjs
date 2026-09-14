import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeNotificationItems} from '../src/notification-merge.mjs';

test('preserves page order and removes duplicate notification IDs', () => {
  const a = [{id:'n1', title:'first'}, {id:'n2', title:'second'}];
  const merged = mergeNotificationItems(a, [{id:'n2', title:'updated', read:true}, {id:'n3', title:'third'}]);
  assert.deepEqual(merged, [{id:'n1', title:'first'}, {id:'n2', title:'updated', read:true}, {id:'n3', title:'third'}]);
});

test('ignores malformed entries without creating an unaddressable item', () => {
  assert.deepEqual(mergeNotificationItems([], [null, {}, {id:'n1'}]), [{id:'n1'}]);
});
