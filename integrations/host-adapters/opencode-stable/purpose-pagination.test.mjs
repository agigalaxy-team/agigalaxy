import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurposeMenu} from './purpose-menu.mjs';

test('all twelve permitted search choices remain reachable and the last choice is reread before showing content',async()=>{
 let page,returned=0;const calls=[];
 const types=['task','capsule','history'],rows=types.map((type,t)=>Array.from({length:4},(_,i)=>({id:`synthetic-${t}-${i}`,type,title:`所选帮助 ${t*4+i+1}`,summary:`当前允许的内容 ${t*4+i+1}`})));
 const nativeTools={call:async(name,input)=>{calls.push({name,input});if(name==='galaxy_native_status')return{structuredContent:{identity:'synthetic-owner',endpoint:'https://selected.example',connection:{bindingId:'synthetic-binding',generation:1}}};
  assert.equal(name,'galaxy_search_v2_query');return{structuredContent:{items:rows[types.indexOf(input.type)]}};}};
 const menu=createPurposeMenu({nativeTools,select:p=>{page={kind:'select',...p};},prompt:p=>{page={kind:'prompt',...p};},info:(title,text,onConfirm)=>{page={kind:'alert',title,text,onConfirm};},isCurrent:()=>true,onBack(){},onReturnWork:()=>{returned++;}});
 menu.search();page.routes[1]();page.onConfirm('取得当前帮助');for(let i=0;i<20&&page.kind!=='select';i++)await new Promise(ok=>setTimeout(ok,10));
 assert.equal(page.options.some(o=>o.title==='所选帮助 8'),true);assert.equal(page.options.some(o=>o.title==='所选帮助 9'),false);page.routes[9]();
 assert.equal(page.options.some(o=>o.title==='所选帮助 12'),true);const selected=page.options.find(o=>o.title==='所选帮助 12');page.routes[selected.number]();
 for(let i=0;i<20&&!(page.kind==='alert'&&page.title==='所选帮助 12');i++)await new Promise(ok=>setTimeout(ok,10));
 assert.match(page.text,/当前允许的内容 12/);assert.equal(calls.filter(c=>c.name==='galaxy_search_v2_query'&&c.input.type==='history').length,2);
 page.onConfirm();const back=page.options.find(o=>o.title==='回到原工作');page.routes[back.number]();assert.equal(returned,1);menu.close();
});
