import test from 'node:test';
import assert from 'node:assert/strict';
import {applyNotificationChanges,saveNotificationSelection,notificationSettingsSatisfied} from '../src/notification-settings-model.mjs';
import {createNotificationLoader} from '../src/notification-loader.mjs';
const roomA='00000000-0000-4000-8000-000000000001',roomB='00000000-0000-4000-8000-000000000002';
const personA='GUID'+'A'.repeat(28),personB='GUID'+'B'.repeat(28);
const options={rooms:true,tasks:true,mutedRoomIds:[roomA],blockedSubjectIds:[personA],roomBlocks:[{roomId:roomB,subjectId:personB}]};

test('one local choice preserves other-device people, room choices and existing room restrictions',()=>{
 const current={...options,mutedRoomIds:[roomA,roomB],blockedSubjectIds:[personA,personB]};
 const saved=applyNotificationChanges(current,{tasks:false,mutedRooms:{[roomA]:false},blockedPeople:{[personA]:false}});
 assert.equal(saved.tasks,false);assert.equal(saved.rooms,true);assert.deepEqual(saved.mutedRoomIds,[roomB]);assert.deepEqual(saved.blockedSubjectIds,[personB]);assert.deepEqual(saved.roomBlocks,options.roomBlocks);
});

test('lost save response is resolved from current state without another conditional write',async()=>{
 let current={revision:4,settings:options},writes=0;const desired=applyNotificationChanges(options,{rooms:false});
 const client={options:async()=>structuredClone(current),saveOptions:async input=>{writes++;assert.equal(input.expectedRevision,4);current={revision:5,settings:input.settings};throw Error('response_lost');}};
 const result=await saveNotificationSelection(client,{expectedRevision:4,settings:desired});
 assert.equal(result.matchedCurrent,true);assert.equal(result.revision,5);assert.equal(writes,1);
});

test('unknown failure followed by a new device change keeps user input and does not overwrite current settings',async()=>{
 let reads=0,writes=0;
 const desired=applyNotificationChanges(options,{rooms:false});
 const client={options:async()=>++reads===1?{revision:4,settings:options}:{revision:5,settings:applyNotificationChanges(options,{tasks:false})},saveOptions:async()=>{writes++;throw Error('lost_before_save');}};
 await assert.rejects(saveNotificationSelection(client,{expectedRevision:4,settings:desired}),error=>error.code==='inbox_options_conflict'&&error.current.settings.tasks===false);
 assert.equal(writes,1);
});

test('background restore only reads the selected state and does not send when it is unsatisfied',async()=>{
 let writes=0;const client={options:async()=>({revision:4,settings:options}),saveOptions:async()=>{writes++;}};
 assert.equal(await saveNotificationSelection(client,{expectedRevision:4,settings:applyNotificationChanges(options,{rooms:false})},{allowWrite:false}),null);
 assert.equal(writes,0);
});

test('lease change during a read prevents a write or a claimed saved result',async()=>{
 let live=true,writes=0;
 const client={options:async()=>{live=false;return{revision:4,settings:options};},saveOptions:async()=>{writes++;}};
 await assert.rejects(saveNotificationSelection(client,{expectedRevision:4,settings:options},{check:()=>{if(!live)throw Error('identity_changed');}}),/identity_changed/);assert.equal(writes,0);
});

test('same choices in a different array order match current state; a lower revision cannot resolve an attempt',()=>{
 const attempt={expectedRevision:5,settings:{...options,mutedRoomIds:[roomA,roomB]}};
 assert.equal(notificationSettingsSatisfied({revision:6,settings:{...options,mutedRoomIds:[roomB,roomA]}},attempt),true);
 assert.equal(notificationSettingsSatisfied({revision:4,settings:attempt.settings},attempt),false);
});

test('current chosen settings resolve a lost response even when another device changes an unrelated choice',()=>{
 const changes={rooms:false},attempt={expectedRevision:4,changes,settings:applyNotificationChanges(options,changes)};
 const current={revision:6,settings:applyNotificationChanges(options,{rooms:false,tasks:false})};
 assert.equal(notificationSettingsSatisfied(current,attempt),true);
 assert.equal(notificationSettingsSatisfied({revision:6,settings:options},attempt),false);
});

test('background refresh reads all already expanded pages and omits expired items',async()=>{
 const calls=[];const client={query:async query=>{calls.push(query);return query.after?{items:[{id:'three'}],nextAfter:null,lastCheckedAt:'new'}:{items:[{id:'one'}],nextAfter:'page2',lastCheckedAt:'new'};},options:async()=>({revision:1,settings:options})};
 let shown;const loader=createNotificationLoader(client);
 await loader.load({unreadOnly:false},{pages:2,apply:page=>{shown=page;},failed:()=>assert.fail('unexpected failure')});
 assert.deepEqual(shown.items.map(item=>item.id),['one','three']);assert.equal(shown.nextAfter,null);assert.equal(calls.length,2);assert.equal(calls[1].unreadOnly,false);
});
