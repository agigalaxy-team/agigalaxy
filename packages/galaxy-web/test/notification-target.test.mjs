import assert from 'node:assert/strict';
import test from 'node:test';
import {notificationTarget} from '../src/features/notifications/target.mjs';
import {notificationRows} from '../src/features/notifications/merge.mjs';

const room='64d57991-4c2d-46b9-81f8-2aed60668901',first='22e2f4e8-358d-4a57-8098-6c8e451d89df',last='35f51c70-1f7d-4eb0-8d77-ebef94a968cf';
test('grouped conversation notices open the latest actual message and retain original read identities',()=>{
 const items=[first,last].map((id,index)=>({id:'room-message:'+id,eventKind:'room-message',object:{type:'room',id:room,messageId:id},at:`2026-10-12T00:0${index}:00Z`,read:false}));
 const rows=notificationRows(items);
 assert.equal(rows.length,1);assert.equal(notificationTarget(rows[0]),`/app/rooms/${room}?message=${last}`);
 assert.deepEqual(rows[0].notices.map(item=>item.id),items.map(item=>item.id));
});
test('invitation navigation selects the invitation in the directory and never adds an accept action',()=>{
 assert.equal(notificationTarget({object:{type:'room-invitation',id:first,roomId:room}}),`/app/rooms?invitation=${first}`);
});
test('legacy room notices still open the room while malformed message pointers cannot become navigation',()=>{
 assert.equal(notificationTarget({object:{type:'room',id:room}}),`/app/rooms/${room}`);
 for(const messageId of ['',room+'#fragment','../other','https://example.invalid',42])assert.equal(notificationTarget({object:{type:'room',id:room,messageId}}),null);
 assert.equal(notificationTarget({object:{type:'room',id:'../other',messageId:first}}),null);
});
