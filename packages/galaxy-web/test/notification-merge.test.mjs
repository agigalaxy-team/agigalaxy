import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeNotificationItems,notificationRows,markNotificationRowRead} from '../src/notification-merge.mjs';

test('preserves page order and removes duplicate notification IDs', () => {
  const a = [{id:'n1', title:'first'}, {id:'n2', title:'second'}];
  const merged = mergeNotificationItems(a, [{id:'n2', title:'updated', read:true}, {id:'n3', title:'third'}]);
  assert.deepEqual(merged, [{id:'n1', title:'first'}, {id:'n2', title:'updated', read:true}, {id:'n3', title:'third'}]);
});

test('ignores malformed entries without creating an unaddressable item', () => {
  assert.deepEqual(mergeNotificationItems([], [null, {}, {id:'n1'}]), [{id:'n1'}]);
});

test('conversation grouping keeps every original read id without merging invitations or separate conversations',()=>{
  const source=[{id:'a',eventKind:'room-message',object:{type:'room',id:'one'},at:'2026-10-10T06:00:00Z',read:true},
    {id:'b',eventKind:'room-message',object:{type:'room',id:'one'},at:'2026-10-10T06:02:00Z',read:false},
    {id:'c',eventKind:'room-invitation',object:{type:'room',id:'one'},at:'2026-10-10T06:01:00Z',read:false},
    {id:'d',eventKind:'room-message',object:{type:'room',id:'two'},at:'2026-10-10T06:00:00Z',read:false}];
  const rows=notificationRows(source);assert.equal(rows.length,3);assert.equal(rows[0].read,false);assert.deepEqual(rows[0].notices.map(item=>item.id),['a','b']);assert.equal(rows[1].id,'c');assert.equal(source[0].read,true);
});

test('opening a conversation marks older paged notices, preserving newer messages and other rooms',async()=>{
 const notice=(id,room,at)=>({id,read:false,eventKind:'room-message',object:{type:'room',id:room},at:'2026-10-10T06:0'+at+':00Z'}),writes=[];
 const selected=notice('selected','one',3),visibleSameSecond=notice('visible-same-second','one',3),client={query:async({after})=>after?{items:[notice('old','one',1),notice('new','one',4),notice('arrived-after-click-same-second','one',3)],nextAfter:null}:{items:[selected,visibleSameSecond,notice('other','two',2)],nextAfter:'next'},markRead:async item=>writes.push(item.id)};
 await markNotificationRowRead(client,{...selected,notices:[selected,visibleSameSecond]});assert.deepEqual(writes,['selected','visible-same-second','old']);
});
