import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurposeMenu} from './purpose-menu.mjs';

test('publishing connects the explicitly chosen original identity and resumes one exact website handoff',async()=>{
 let page,identity=null,connected=false,initializeAllowed=false,connectAllowed=false,completed=false,returned=0;
 const calls=[],origin={host:'synthetic-current-host',workRef:'synthetic-original-work'},handoffId='synthetic-handoff',navigationId='synthetic-navigation',initializePath='/review/'+'a'.repeat(48),connectPath='/review/'+'b'.repeat(48);
 const tools={call:async(name,input)=>{
  calls.push({name,input});
  if(name==='galaxy_native_status')return{structuredContent:{identity,connected,endpoint:'https://selected.invalid',connection:connected?{bindingId:'original-binding',generation:1}:null}};
  if(name==='galaxy_native_initialize'){
   assert.deepEqual(input,{profile:'minimal'});
   if(!initializeAllowed)return{structuredContent:{state:'user-choice-needs-browser',url:'http://127.0.0.1:31234'+initializePath}};
   identity='original-synthetic-identity';return{structuredContent:{identity,localOnly:true}};
  }
  if(name==='galaxy_native_connect'){
   assert.deepEqual(input,{});
   if(!connectAllowed)return{structuredContent:{state:'user-choice-needs-browser',url:'http://127.0.0.1:31234'+connectPath}};
   connected=true;return{structuredContent:{connected:true}};
  }
  if(name==='galaxy_identity_web_connect'){
   if(!connected)return{isError:true,structuredContent:{error:'native_connection_choice_required'}};
   assert.deepEqual(input.object,{kind:'publish'});assert.deepEqual(input.origin,origin);
   return{structuredContent:{state:'opened',handoffId,navigationId,transportAvailable:true,url:'http://127.0.0.1:31234/connect/'+handoffId}};
  }
  assert.equal(name,'galaxy_identity_web_connect_status');assert.deepEqual(input,{handoffId});
  return{structuredContent:{state:completed?'completed':'opened',handoffId,navigationId,transportAvailable:true,deviceAuthorizationVerified:completed}};
 }};
 const menu=createPurposeMenu({nativeTools:tools,select:value=>{page={kind:'select',...value};},prompt(){throw Error('No internal object or confirmation input is required.');},info:(title,text,onConfirm)=>{page={kind:'alert',title,text,onConfirm};},isCurrent:()=>true,onBack(){},onReturnWork:()=>{returned++;},readWorkContext:async()=>({origin})});
 const wait=async check=>{for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(check());};
 const choose=title=>{const selected=page.options.find(row=>row.title===title);assert.ok(selected,title);page.routes[selected.number]();};
 try{
  menu.publish();await wait(()=>page.kind==='select');assert.match(page.title,/尚未准备/);choose('在本机准备身份');
  await wait(()=>page.kind==='alert'&&page.text.includes(initializePath));page.onConfirm();await wait(()=>calls.filter(row=>row.name==='galaxy_native_initialize').length===2);
  initializeAllowed=true;page.onConfirm();await wait(()=>page.kind==='select'&&page.options.some(row=>row.title==='连接当前身份'));
  choose('连接当前身份');await wait(()=>page.kind==='alert'&&page.text.includes(connectPath));connectAllowed=true;page.onConfirm();
  await wait(()=>page.kind==='alert'&&page.text.includes('/connect/'+handoffId));
  const handoffs=calls.filter(row=>row.name==='galaxy_identity_web_connect');assert.equal(handoffs.length,2);assert.equal(handoffs[0].input.requestId,handoffs[1].input.requestId,'The original publish intent resumes after the explicitly chosen connection.');
  assert.equal(calls.some(row=>row.name==='galaxy_open'),false,'Opening a URL cannot substitute for device identity continuation.');
  completed=true;page.onConfirm();await wait(()=>page.text.includes('本次设备授权已完成'));page.onConfirm();assert.equal(returned,1);
  assert.equal(calls.filter(row=>row.name==='galaxy_identity_web_connect').length,2,'Reading progress does not prepare another handoff.');
 }finally{menu.close();}
});

test('current Task method continuation uses the existing search intent, preserves original work and requests only the method scope in addition to the default website scopes',async()=>{
 let page,returned=null,completed=false;const calls=[],taskId='a1a425d2-60d4-448c-883b-7d5b3a4e6a19',query='reading order',origin={host:'synthetic-current-host',workRef:'private unsent input'};
 const handoffId='4e1ab219-cdca-4594-badf-637a2023b8d1',task={taskId,schemaVersion:2,version:1,requesterId:'other-owner',enrollmentOpen:false,
  request:{title:'Current reading work',summary:'Use the original page to inspect reading order.',workContext:{goal:'Read original content'}}};
 const tools={call:async(name,input)=>{calls.push({name,input});
  if(name==='galaxy_native_status')return{structuredContent:{identity:'current-owner',connected:true,endpoint:'https://selected.invalid',website:'https://website.invalid',connection:{bindingId:'same-binding',generation:1}}};
  if(name==='galaxy_search_v2_query')return{structuredContent:{items:input.type==='task'?[{id:taskId,type:'task',title:task.request.title}]:[]}};
  if(name==='galaxy_task_v2_get')return{structuredContent:task};
  if(name==='galaxy_identity_web_connect')return{structuredContent:{handoffId,navigationId:'original-navigation',state:'opened',transportAvailable:true,url:'http://127.0.0.1:31234/connect/'+handoffId}};
  assert.equal(name,'galaxy_identity_web_connect_status');return{structuredContent:{state:completed?'completed':'opened',transportAvailable:true,deviceAuthorizationVerified:completed}};
 }};
 const menu=createPurposeMenu({nativeTools:tools,select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},info:(title,text,onConfirm)=>{page={kind:'alert',title,text,onConfirm};},
  isCurrent:()=>true,onBack(){},onReturnWork:value=>{returned=value;},readWorkContext:async()=>({query:'a different host goal',origin})});
 const wait=async check=>{for(let index=0;index<100&&!check();index++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(check(),JSON.stringify(page));};
 const choose=title=>{const selected=page.options.find(row=>row.title===title);assert.ok(selected,title);page.routes[selected.number]();};
 try{
  menu.search();choose('查找方法与协助');await wait(()=>page.kind==='prompt');page.onConfirm(query);
  await wait(()=>page.kind==='select'&&page.options.some(row=>row.title===task.request.title));choose(task.request.title);
  await wait(()=>page.kind==='alert'&&page.text.includes(task.request.summary));page.onConfirm();
  await wait(()=>page.kind==='select'&&page.options.some(row=>row.title==='在官网找相关方法'));choose('在官网找相关方法');
  await wait(()=>page.kind==='alert'&&page.text.includes('/connect/'+handoffId));
  const connect=calls.find(row=>row.name==='galaxy_identity_web_connect');assert.deepEqual(connect.input.object,{kind:'task',id:taskId});assert.deepEqual(connect.input.origin,origin);
  assert.deepEqual(connect.input.continueWith,{kind:'method-search',query});assert.deepEqual(connect.input.scopes,['binding','consent','case-teaser','history','assistance','context','capsules']);
  completed=true;page.onConfirm();await wait(()=>page.text.includes('本次设备授权已完成'));page.onConfirm();await wait(()=>returned!==null);
  assert.ok(returned.content.includes(task.request.summary));assert.ok(returned.content.includes(query));
  const source=new URL(returned.sourceUrl);assert.equal(source.pathname,'/app/search');assert.equal(source.searchParams.get('q'),query);assert.equal(source.searchParams.get('sourceTask'),taskId);
  assert.equal(source.searchParams.get('returnTo'),'/app/tasks/'+taskId+'?section=collaboration');assert.equal(source.href.includes(origin.workRef),false);
  assert.equal(calls.filter(row=>row.name==='galaxy_identity_web_connect').length,1);
 }finally{menu.close();}
});
