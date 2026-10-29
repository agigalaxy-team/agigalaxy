import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityMenu } from '../identity-menu.mjs';
const wait=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Identity menu did not settle.');};

test('native account menu requires returning from browser and confirming locally before association',async()=>{
  let page,executed=0,canceled=0;
  const menu=createIdentityMenu({language:'zh-CN',isCurrent:()=>true,onBack(){},select:value=>{page={kind:'select',...value};},
    info:(title,message,onBack)=>{page={kind:'info',title,message,onBack};},prompt:value=>{page={kind:'prompt',...value};},
    controller:{cancel(){canceled++;},async readIdentity(method){
      if(method==='providers')return {providers:[{id:'fixture',name:'Test provider',issuer:'https://login.example.org'}]};
      if(method==='begin')return {loginId:'synthetic-login',issuer:'https://login.example.org',authorizationUrl:'https://login.example.org/authorize',expiresAt:2000000300};
      if(method==='query')return {items:[],nextAfter:null};throw new Error('Unexpected menu action.');
    },async prepareIdentity(action,input){assert.equal(action,'link');assert.equal(input.id,'synthetic-login');return {previewJson:'synthetic association',confirmation:'EXACT CONFIRM'};},
    async executeIdentity(_preview,text){assert.equal(text,'EXACT CONFIRM');executed++;return {state:'linked'};}}});
  menu.open();page.routes[1]();await wait(()=>page.kind==='select'&&page.title.includes('选择登录服务'));
  page.routes[1]();await wait(()=>page.kind==='select'&&page.title.includes('浏览器'));assert.equal(executed,0);
  page.routes[1]();await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='允许本次内容与范围'));assert.equal(executed,0);page.onBack();assert.equal(canceled,1);
  page.routes[1]();await wait(()=>page.kind==='select'&&page.options.some(o=>o.title==='允许本次内容与范围'));page.routes[1]();await wait(()=>page.kind==='info'&&page.message.includes('账户关联已更新'));assert.equal(executed,1);
});
