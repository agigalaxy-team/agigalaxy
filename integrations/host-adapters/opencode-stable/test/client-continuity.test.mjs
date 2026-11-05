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

test('technical connection continues without requiring an account', async () => {
  let connected=false, completed=0;
  const calls=[], messages=[];
  const state=()=>({identity:'existing-identity',endpoint:'https://official.agigalaxy.org',connected,
    access:{kind:'service',state:connected?'ready':'disconnected'}, accountAccess:{state:'account-required'}});
  const session={version:0,owner:null,language:'zh-CN',stopMessages(){},alive(v){return v===this.version;},label(cn){return cn;},info(){},message(title,text){messages.push({title,text});},nativeTools:{
    async call(name){calls.push(name);if(name==='galaxy_native_status')return{structuredContent:state()};
      connected=true;return{structuredContent:state()};},
  }};
  createPurposeIdentity(session).identityChoice('galaxy_native_connect',{},()=>completed++);
  await new Promise(setImmediate);
  assert.equal(completed,1);
  assert.equal(calls.filter(name=>name==='galaxy_native_connect').length,1);
  assert.deepEqual(messages,[]);
});

test('connected identity offers optional account linking and is ready to continue', async () => {
  const status={identity:'existing-identity',endpoint:'https://official.agigalaxy.org',connected:true,
    access:{kind:'service',state:'ready'},accountAccess:{state:'account-required'}};
  let continued=0, options;
  const session={nativeTools:{},language:'zh-CN',onBack(){},label(cn){return cn;},native:async()=>status,
    run:async(read,done)=>done(await read()),menu(title,items){options=items;}};
  const purpose=createPurposeIdentity(session);
  purpose.identity(()=>continued++);
  await new Promise(setImmediate);
  assert.equal(continued,1);
  purpose.identity();
  await new Promise(setImmediate);
  assert.ok(options.some(item=>item[0]==='关联官网账户（按需）'));
  assert.ok(!options.some(item=>item[0]==='连接当前身份'));
});

test('linked account is not offered for linking again', async () => {
  let options;
  const status={identity:'existing-identity',endpoint:'https://official.agigalaxy.org',connected:true,
    access:{kind:'service',state:'ready'},accountAccess:{state:'ready'}};
  const session={nativeTools:{},language:'zh-CN',onBack(){},label(cn){return cn;},native:async()=>status,
    run:async(read,done)=>done(await read()),menu(title,items){options=items;}};
  createPurposeIdentity(session).identity();
  await new Promise(setImmediate);
  assert.ok(!options.some(item=>item[0]==='关联官网账户（按需）'));
});
