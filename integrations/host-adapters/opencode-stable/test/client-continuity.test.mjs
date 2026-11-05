import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurposeIdentity } from '../purpose/identity.mjs';
import { unwrap } from '../purpose/presentation.mjs';

test('old and structured MCP errors keep the same actual cause for the Agent', () => {
  for (const result of [
    {isError:true,content:[{type:'text',text:'{"error":"native_connection_selection_changed"}'}]},
    {isError:true,structuredContent:{error:'native_connection_selection_changed'},content:[{type:'text',text:'连接需要处理。'}]},
  ]) assert.throws(() => unwrap(result), /native_connection_selection_changed/);
});

test('a completed official connection follows the same identity without repeating connect', async () => {
  let connected=false, pendingTick, completed=0;
  const calls=[], messages=[];
  const originalTimer=globalThis.setTimeout;
  globalThis.setTimeout=callback=>{pendingTick=callback;return{unref(){}}};
  try {
    const state=()=>({identity:'existing-identity',endpoint:'https://official.agigalaxy.org',connected,
      officialAccount:{state:connected?'linked':'unavailable'},
      connectionChoice:{revision:connected?2:0,enabled:connected,deviceId:connected?'first-device':undefined},
      ...(connected?{connectionOperation:{state:'finished',identity:'existing-identity',endpoint:'https://official.agigalaxy.org'}}:{})});
    const session={version:0,owner:null,language:'zh-CN',stopMessages(){},alive(v){return v===this.version;},label(cn){return cn;},info(){},message(title,text){messages.push({title,text});},nativeTools:{
      async call(name){calls.push(name);if(name==='galaxy_native_status')return{structuredContent:state()};
        connected=true;return{structuredContent:{state:'user-choice-needs-browser',url:'http://127.0.0.1:56789/review/'+'a'.repeat(48)}};},
      async openLink(){},
    }};
    createPurposeIdentity(session).identityChoice('galaxy_native_connect',{},()=>completed++);
    await new Promise(setImmediate);await pendingTick();await new Promise(setImmediate);
    assert.equal(completed,1);
    assert.equal(calls.filter(name=>name==='galaxy_native_connect').length,1);
    assert.deepEqual(messages,[]);
  } finally {globalThis.setTimeout=originalTimer;}
});
