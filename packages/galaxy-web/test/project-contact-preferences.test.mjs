import test from 'node:test';
import assert from 'node:assert/strict';
import {saveProjectContactPreferences,sameProjectContactPreferences} from '../src/project-contact-preferences-client.mjs';

const initial={enabled:true,purposes:['conversation','collaboration'],functions:[],temporary:null};
const limited={enabled:true,purposes:['conversation'],functions:['手机文字排版'],temporary:null};
test('a lost reply is resolved from the current exact preferences without repeating the write',async()=>{
 let current={revision:4,preferences:initial},writes=0;
 const saved=await saveProjectContactPreferences({expectedRevision:4,preferences:limited,readCurrent:async()=>current,write:async input=>{writes++;assert.equal(input.expectedRevision,4);current={revision:5,preferences:input.preferences};throw Error('response lost');}});
 assert.equal(writes,1);assert.equal(saved.revision,5);assert.deepEqual(saved.preferences,limited);
});
test('a concurrent change keeps the authors selection and cannot overwrite the newer revision',async()=>{
 let writes=0;
 await assert.rejects(()=>saveProjectContactPreferences({expectedRevision:4,preferences:limited,readCurrent:async()=>({revision:5,preferences:{...initial,enabled:false}}),write:async()=>{writes++;}}),error=>{assert.equal(error.currentPreferences.revision,5);assert.equal(error.currentPreferences.preferences.enabled,false);return true;});
 assert.equal(writes,0);
});
test('a different setting after an uncertain write is reported as a conflict, not as success',async()=>{
 let reads=0,writes=0;
 await assert.rejects(()=>saveProjectContactPreferences({expectedRevision:4,preferences:limited,readCurrent:async()=>++reads===1?{revision:4,preferences:initial}:{revision:6,preferences:null},write:async()=>{writes++;throw Error('response lost');}}),error=>error.currentPreferences.revision===6);
 assert.equal(writes,1);
});
test('an unchanged server and an unreadable response preserve the actual failure for a safe retry',async()=>{
 const failure=Error('offline');let writes=0;
 await assert.rejects(()=>saveProjectContactPreferences({expectedRevision:4,preferences:limited,readCurrent:async()=>({revision:4,preferences:initial}),write:async()=>{writes++;throw failure;}}),error=>error===failure);
 assert.equal(writes,1);
});
test('a settings read failure cannot proceed to a write',async()=>{
 let writes=0;
 await assert.rejects(()=>saveProjectContactPreferences({expectedRevision:4,preferences:limited,readCurrent:async()=>{throw Error('permission revoked');},write:async()=>{writes++;}}),/permission revoked/);
 assert.equal(writes,0);
});
test('current matching settings need no new save, including inheritance and ordered purpose sets',async()=>{
 assert.equal(sameProjectContactPreferences(initial,{...initial,purposes:[...initial.purposes].reverse()}),true);
 let writes=0;
 const saved=await saveProjectContactPreferences({expectedRevision:4,preferences:null,readCurrent:async()=>({revision:5,preferences:null}),write:async()=>{writes++;}});
 assert.equal(writes,0);assert.equal(saved.revision,5);
});
