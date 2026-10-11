import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createGalaxyAdapter} from './galaxy.tui.ts';
import {createNativeRuntime} from '../../../packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createNativeToolServer} from '../../../packages/galaxy-edge-mcp/src/native-v2/server.mjs';
import {serviceFixture} from '../../../packages/galaxy-official/test/service-fixture.mjs';
import {createApi} from '../../../packages/galaxy-official/src/http.mjs';
import {browserScopes} from '../../../packages/galaxy-official/src/browser-client.mjs';
import {syntheticMessageTransport} from '../../native-v2/compact-app/purpose-fixture.mjs';

const require=createRequire(new URL('../../../packages/galaxy-official/package.json',import.meta.url));
const {Client,InMemoryTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);

test('stable TUI Native bridge reads actual signed messages, uses an existing responder grant, reconciles one lost reply and hides stale authority',{timeout:60000},async t=>{
 const f=await serviceFixture(browserScopes),directory=await mkdtemp(join(tmpdir(),'galaxy-tui-native-'));
 let api,runtime,server,client,adapter,page=null,onClose,drop=false,sendCalls=0;const commands=new Map(),calls=[];
 try{
  api=createApi({...f,rateLimit:1000});await new Promise(ok=>api.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+api.address().port;
  runtime=await createNativeRuntime({dataDirectory:directory,endpoint:f.bindings.endpoint,website:'https://selected.example',trustedKeys:f.bindings.trustedKeys,now:()=>f.now,
   fetch:async(url,options)=>{const path=new URL(url).pathname;if(path.endsWith('/send'))sendCalls++;const response=await fetch(base+path,options);if(drop&&path.endsWith('/send')&&response.status===200){drop=false;throw Error('synthetic_lost_reply_ack');}return response;},openBrowser:async()=>({launched:false})});
  await runtime.initialize({profile:'minimal'},{confirmed:true});await runtime.connect({confirmed:true});const subjectId=runtime.api.snapshot().subjectId;
  f.chat.requireAccountWithin=async(_tx,actor)=>assert.equal(actor.subjectId,subjectId);f.chat.transport=syntheticMessageTransport();
  const roomId=randomUUID(),grantId=randomUUID();await runtime.api.call('/v2/chat/rooms/create',{roomId,operationId:randomUUID(),title:'合成：继续原解析工作',kind:'ordinary',taskRefs:[],retentionDays:90});
  await runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-grant',{grantId,bindingId:runtime.api.snapshot().bindingId,mode:'respond',primaryResponder:false,expiresAt:f.now+3600});
  await runtime.api.call('/v2/chat/rooms/'+roomId+'/send',{clientMessageId:randomUUID(),text:'合成：已得到可用的解析片段。',replyTo:null,agentGrantId:grantId});
  server=createNativeToolServer(runtime);client=new Client({name:'synthetic-opencode-native-host',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  const unusedHostDirectory=join(directory,'unused-host-identity');
  adapter=createGalaxyAdapter(null,{dataDirectory:unusedHostDirectory,nativeTools:{call:(name,args)=>{calls.push(name);return client.callTool({name,arguments:args});}}});
  await adapter.tui({keymap:{registerLayer:({commands:entries})=>{for(const entry of entries)commands.set(entry.name,entry);return()=>{for(const entry of entries)commands.delete(entry.name);};}},
   ui:{dialog:{setSize(){},clear(){onClose?.();onClose=null;page=null;},replace(fn,cleanup){onClose?.();onClose=cleanup;page=fn();}},DialogSelect:props=>({kind:'select',...props}),DialogAlert:props=>({kind:'alert',...props}),DialogPrompt:props=>({kind:'prompt',...props})}});
  const wait=async(predicate,attempts=200)=>{for(let i=0;i<attempts&&!predicate();i++)await delay(10);assert.ok(predicate(),JSON.stringify(page));};
  const choose=async title=>{const option=page.options.find(o=>o.title.endsWith(title));assert.ok(option,title);option.onSelect();await delay(15);};
  const enter=async()=>{assert.equal(page.kind,'alert');page.onConfirm();await delay(15);};
  const viewText=()=>[page?.title,page?.message,...(page?.options??[]).flatMap(option=>[option.title,option.description])].filter(Boolean).join('\n');
  commands.get('galaxy.open').run();await wait(()=>page?.kind==='select');assert.match(viewText(),/当前工作/);
  await choose('我的与设置');await choose('身份与设备');await wait(()=>page?.kind==='select'&&viewText().includes('身份与设备 · 已连接'));
  assert.equal(page.options.some(o=>o.title.endsWith('在本机准备身份')||o.title.endsWith('创建本机身份')),false);
  await choose('当前身份与服务');await wait(()=>page?.kind==='alert'&&viewText().includes(subjectId));
  assert.match(viewText(),/当前设备已连接/);await assert.rejects(stat(unusedHostDirectory),{code:'ENOENT'});
  await enter();await wait(()=>page?.kind==='select'&&viewText().includes('身份与设备 · 已连接'));
  commands.get('galaxy.zero').run();await wait(()=>page?.kind==='select'&&page.title.includes('我的与设置'));commands.get('galaxy.zero').run();await wait(()=>page?.kind==='select'&&page.title.startsWith('✧ 银河'));
  await choose('消息');await wait(()=>page?.options?.some(o=>o.title.includes('继续原解析工作')));
  await choose('合成：继续原解析工作');await wait(()=>page?.kind==='alert'&&page.message.includes('解析片段'));
  assert.equal(page.message.includes(roomId),false);assert.equal(page.message.includes(subjectId),false);assert.equal(page.message.includes('payloadHash'),false);
  // New currently authorized content updates an open reading alert. It does
  // not require closing the alert or selecting a manual refresh action.
  await runtime.api.call('/v2/chat/rooms/'+roomId+'/send',{clientMessageId:randomUUID(),text:'合成：随后取得的当前消息。',replyTo:null,agentGrantId:grantId});
  await wait(()=>page?.kind==='alert'&&page.message.includes('随后取得的当前消息'),600);
  await enter();await wait(()=>page?.options?.some(o=>o.title.endsWith('写消息')));
  assert.equal(page.options.some(o=>o.title.endsWith('新消息')),false,'A message already displayed in the open reading alert is not offered as unread after continuing.');
  await choose('写消息');await wait(()=>page?.kind==='prompt');
  const editing=page;await runtime.api.call('/v2/chat/rooms/'+roomId+'/send',{clientMessageId:randomUUID(),text:'合成：编辑期间到达，不替换当前草稿。',replyTo:null,agentGrantId:grantId});
  await delay(5300);assert.equal(page,editing,'A new message must not replace an open editor or its draft.');
  const rowsBefore=(await f.db.query('SELECT count(*)::int n FROM chat_message_refs')).rows[0].n;
  const before=sendCalls;drop=true;page.onConfirm('合成回复：沿用片段继续原来的工作。');await wait(()=>page?.kind==='alert'&&page.message.includes('合成回复：'));
  assert.equal(sendCalls,before+1);assert.equal((await f.db.query('SELECT count(*)::int n FROM chat_message_refs')).rows[0].n,rowsBefore+1);assert.ok(calls.includes('galaxy_chat_message_status'));
  const focusedRead=page;await runtime.api.call('/v2/chat/rooms/'+roomId+'/agent-revoke',{grantId});await delay(5600);assert.equal(page,focusedRead,'Background reading must retain the current host Dialog and focus.');await enter();
  assert.ok(page.options.some(o=>o.title.endsWith('写消息')),'Composition remains possible; a new send needs an actual new permission choice.');assert.ok(page.options.some(o=>o.title.endsWith('打开完整对话')));
  assert.equal(page.options.some(o=>o.title.endsWith('刷新消息')),false);
  await runtime.connect({confirmed:true});await choose('打开完整对话');await wait(()=>page?.kind==='alert'&&page.message.includes('当前内容暂不可用'));assert.equal(page.message.includes('合成回复：'),false);assert.equal(sendCalls,before+1);
  t.diagnostic(JSON.stringify({actualMcp:true,actualNativeRuntime:true,actualSignedHttp:true,database:'PGlite',syntheticMessageTransport:true,syntheticCommunityEligibility:true,stableDialogContract:true,physicalOpenCodeUi:false,realUserAcceptance:false,modelCalls:0,replyWrites:1}));
 }finally{adapter?.close();await client?.close();await server?.close();runtime?.close();if(api?.listening){api.closeAllConnections();await new Promise(ok=>api.close(ok));}await f.db.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-tui-native-'));await rm(target,{recursive:true,force:true});}
});
