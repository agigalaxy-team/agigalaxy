import test from 'node:test';
import assert from 'node:assert/strict';
import {setWorkArchiveSelection} from './work-archive-choice.mjs';

const work={galaxyId:'owner',host:'opencode',sessionId:'current-work'};
test('a work choice preserves other currently enabled selections and the latest retention',async()=>{
 let input;
 const archive={settings:async()=>({galaxyId:'owner',settings:{enabled:true,sessions:[{host:'opencode',sessionId:'chosen-elsewhere'}],autoCleanAfterDays:30}}),configure:async value=>{input=value;}};
 await setWorkArchiveSelection(archive,{...work,enabled:true});
 assert.deepEqual(input,{galaxyId:'owner',enabled:true,sessions:[{host:'opencode',sessionId:'chosen-elsewhere'},{host:'opencode',sessionId:'current-work'}],autoCleanAfterDays:30});
});
test('selecting one work never resumes other paused conversation scopes',async()=>{
 let input;
 const archive={settings:async()=>({galaxyId:'owner',settings:{enabled:false,sessions:[{host:'opencode',sessionId:'paused-work'},{host:'opencode',sessionId:'current-work'}],autoCleanAfterDays:null}}),configure:async value=>{input=value;}};
 await setWorkArchiveSelection(archive,{...work,enabled:true});
 assert.deepEqual(input.sessions,[{host:'opencode',sessionId:'current-work'}]);
 assert.equal(input.enabled,true);
});
test('stopping one work preserves another work and does not restart a globally paused selection',async()=>{
 let input;
 const archive={settings:async()=>({galaxyId:'owner',settings:{enabled:false,sessions:[{host:'opencode',sessionId:'other-work'},{host:'opencode',sessionId:'current-work'}],autoCleanAfterDays:7}}),configure:async value=>{input=value;}};
 await setWorkArchiveSelection(archive,{...work,enabled:false});
 assert.deepEqual(input.sessions,[{host:'opencode',sessionId:'other-work'}]);
 assert.equal(input.enabled,false);
});
test('an owner change cannot write the prior work selection',async()=>{
 const archive={settings:async()=>({galaxyId:'another-owner'}),configure:async()=>assert.fail('Changed owner must not be configured.')};
 await assert.rejects(setWorkArchiveSelection(archive,{...work,enabled:true}),/local_identity_changed/);
});
