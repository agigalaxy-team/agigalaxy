import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createGalaxyAdapter} from './galaxy.tui.ts';
import {a2aPurposeFixture} from '../../native-v2/a2a-purpose-fixture.mjs';
import {chromium} from 'playwright';

test('current /galaxy existing-service entry uses a selected v2 work and prepared content; actual local choice dispatches once, returning closes Dialog',{timeout:60000},async()=>{
 const x=await a2aPurposeFixture();let adapter,browser,page=null,onClose,choice=null,prompts=0;const commands=new Map();
 try{browser=await chromium.launch({headless:true});
  adapter=createGalaxyAdapter(null,{nativeTools:{call:x.raw,openLink:async url=>{choice=await browser.newPage();await choice.goto(url);}},readWorkContext:async()=>({caseId:x.primary.caseId,
   a2a:{peerId:x.peer.id,attemptId:x.primary.attemptId,attemptVersion:1,text:JSON.stringify({operation:'sum',values:[19,23]})}})});
  await adapter.tui({keymap:{registerLayer:({commands:entries})=>{for(const e of entries)commands.set(e.name,e);return()=>{for(const e of entries)commands.delete(e.name);};}},
   ui:{dialog:{setSize(){},clear(){onClose?.();onClose=null;page=null;},replace(fn,cleanup){onClose?.();onClose=cleanup;page=fn();}},DialogSelect:p=>({kind:'select',...p}),DialogAlert:p=>({kind:'alert',...p}),DialogPrompt:p=>{prompts++;return{kind:'prompt',...p};}}});
  const wait=async fn=>{for(let i=0;i<800&&!fn();i++)await delay(10);assert.ok(fn(),JSON.stringify(page));};
  const choose=async title=>{const o=page?.options?.find(o=>o.title.endsWith(title));assert.ok(o,title+' in '+page?.title);o.onSelect();await delay(30);};
  commands.get('galaxy.open').run();await wait(()=>page?.kind==='select');await choose('我的与设置');await choose('交给已有服务处理');await wait(()=>page?.options?.some(o=>o.title.endsWith(x.peer.name)));await choose(x.peer.name);await wait(()=>page?.options?.some(o=>o.title.endsWith('将当前内容交给这项服务')));
  await choose('将当前内容交给这项服务');await wait(()=>page?.options?.some(o=>o.title.endsWith('选择发送')));
  assert.equal(prompts,0,'The already selected current work and host-prepared content require no repeated question, internal ID or JSON entry.');assert.match(page.title,/19.*23/s);assert.equal(page.title.includes(x.primary.caseId),false);assert.equal(page.title.includes('payloadJson'),false);assert.equal((await x.processPeer.observations()).starts,0);
  await choose('选择发送');await wait(()=>choice&&page?.title==='等待你的选择');assert.equal((await x.processPeer.observations()).starts,0);
  await choice.getByRole('button',{name:'允许本次操作',exact:true}).click();await wait(()=>page?.kind==='select'&&page.title.includes('42'));assert.equal((await x.processPeer.observations()).starts,1);assert.equal(x.state.resultWrites,0);
  await choose('回到原工作');await wait(()=>page===null);assert.equal((await x.processPeer.observations()).starts,1);assert.equal(x.state.resultWrites,0);
 }finally{await adapter?.close();await browser?.close();await x.close();}
});
