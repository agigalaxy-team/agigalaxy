import assert from 'node:assert/strict';
import test from 'node:test';
import {leaseNotificationItems,currentNotificationItems} from '../src/features/notifications/read-lease.mjs';
import {mergeNotificationItems} from '../src/features/notifications/merge.mjs';

test('source expiry and read expiry bound each notification independently',()=>{
 const now=Date.parse('2026-10-12T00:00:00Z'),end=now+1000;
 const items=leaseNotificationItems([{id:'source',sourceExpiresAt:new Date(end).toISOString()},{id:'read',readExpiresAt:(now+2000)/1000},{id:'legacy'}],now,now);
 assert.deepEqual(currentNotificationItems(items,end).map(item=>item.id),['read','legacy']);
 assert.deepEqual(currentNotificationItems(items,now+2000).map(item=>item.id),['legacy']);
 assert.deepEqual(currentNotificationItems(items,now+60000),[]);
});
test('pagination does not renew content obtained by an earlier permission check',()=>{
 const earlier=leaseNotificationItems([{id:'older'}],0,0),next=leaseNotificationItems([{id:'next'}],50000,50000);
 const page=mergeNotificationItems(earlier,next);
 assert.deepEqual(currentNotificationItems(page,60000).map(item=>item.id),['next']);
 assert.equal(earlier[0].readUntil,60000);
});
test('slow responses, malformed deadlines and already withdrawn sources never become visible again',()=>{
 assert.deepEqual(leaseNotificationItems([{id:'slow'}],0,60000),[]);
 assert.deepEqual(leaseNotificationItems([{id:'bad',sourceExpiresAt:'invalid'},{id:'expired',sourceExpiresAt:'1970-01-01T00:00:00Z'}],1,1),[]);
});
