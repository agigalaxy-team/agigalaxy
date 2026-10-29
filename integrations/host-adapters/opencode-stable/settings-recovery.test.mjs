import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {tsImport} from 'tsx/esm/api';

test('uninitialized identity menu exposes recovery without creating a new GUID', async () => {
  const {createSettingsPages} = await tsImport('./tui-session/settings.ts', import.meta.url);
  const calls=[];let page,initialized=0,historyReads=0,opened='';
  const url='http://127.0.0.1:31459/identity-recovery/'+ 'a'.repeat(48);
  const nativeTools={call:async(name,input)=>{calls.push({name,input});
    if(name==='galaxy_native_status')return{structuredContent:{identity:null,connected:false,endpoint:'https://synthetic.invalid'}};
    if(name==='galaxy_identity_recovery')return{structuredContent:{state:'user-choice-needs-browser',url}};
    throw Error('unexpected Native operation');},openLink:async value=>{opened=value;}};
  const session={activeLanguage:'zh-CN',nativeTools,connectionGeneration:0,closed:false,purposeMenu:null,connectionController:null,
    workRecorder:{history:{identity:async()=>{historyReads++;return null;}}},showQuickInitialize:()=>{initialized++;},
    showSelect:value=>{page={kind:'select',...value};},showInfo:(title,text,onConfirm)=>{page={kind:'alert',title,text,onConfirm};},
    showPrompt:()=>{},returnToWork:()=>{},currentWorkContext:async()=>null};
  const settings=createSettingsPages(session);settings.showSettings(()=>{});
  page.routes[1]();
  for(let i=0;i<100&&!(page.kind==='select'&&page.title.includes('身份与设备'));i++)await delay(10);
  assert.match(page.title,/身份与设备/);assert.equal(initialized,0);assert.equal(historyReads,0);
  assert.ok(page.options.some(row=>row.title==='在本机准备身份'));
  const recovery=page.options.find(row=>row.title==='使用恢复码找回原身份');assert.ok(recovery);
  page.routes[recovery.number]();
  for(let i=0;i<100&&!opened;i++)await delay(10);
  assert.equal(opened,url);assert.equal(initialized,0);assert.ok(calls.some(call=>call.name==='galaxy_identity_recovery'&&call.input.action==='recover'));
  assert.equal(calls.some(call=>call.name==='galaxy_native_initialize'),false);
  session.purposeMenu.close();
});
