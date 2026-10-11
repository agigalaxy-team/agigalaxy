import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

const probe={id:'galaxy.native-work.actual-host.probe',tui(api){void run(api);}};
export default probe;
async function run(api){
 const events=[],frame=()=>new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true)),has=name=>api.keymap.getCommands().some(command=>command.name===name);
 const report={recordedAt:new Date().toISOString(),version:api.app.version,actualInstalledOpenCodeProcess:true,actualTuiPluginApi:true,normalPackagedNativeEntry:true,
  fixtureRuntimeInjected:false,syntheticSharedService:true,realModel:false,modelPromptSubmitted:false,globalConfigurationChanged:false,
  physicalDesktopVisualAcceptance:false,realUserAcceptance:false,success:false,events};
 async function stage(name){await delay(150);report.stage=name;events.push({name,dialog:{open:api.ui.dialog.open,depth:api.ui.dialog.depth},terminal:{width:api.renderer.width,height:api.renderer.height,text:frame()}});await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');}
 // Long links wrap inside the real 60-column Dialog. Do not concatenate the
 // dimmed original prompt outside that Dialog into the URL between its lines.
 const localConnectionUrl=()=>frame().split('\n').map(line=>line.slice(10,70)).join('').replace(/\s/g,'').match(/http:\/\/127\.0\.0\.1:\d+\/connect\/[a-f0-9-]{36}/)?.[0];
 async function wait(check,attempts=2400){for(let index=0;index<attempts;index++){if(check())return;await delay(50);}assert.ok(check(),'Installed normal Native TUI timed out at '+report.stage);}
 const dispatch=name=>assert.equal(api.keymap.dispatchCommand(name).ok,true,name),original='Synthetic original work: preserve this unsent input.',proposal='[Synthetic local] I can check the reading order against the original description. This is a help proposal only.';
 try{
  await wait(()=>api.plugins.list().find(plugin=>plugin.id==='galaxy.opencode.stable.tui')?.active);
  if(api.ui.dialog.open&&frame().includes('Connect a provider'))api.ui.dialog.clear();
  await stage('enter-original-unsent-work');await wait(()=>frame().includes(original));
  dispatch('galaxy.open');await wait(()=>has('galaxy.choose.5'));await stage('normal-purpose-menu');
  if(process.env.GALAXY_HOST_CHECK_PHASE==='scope-expansion'){
   dispatch('galaxy.choose.4');await wait(()=>frame().includes('我的与设置')&&has('galaxy.choose.1'));dispatch('galaxy.choose.1');
   await wait(()=>frame().includes('在官网继续当前身份')&&has('galaxy.choose.1'));dispatch('galaxy.choose.1');
   await stage('initial-default-six-local-link-preparing');await wait(()=>localConnectionUrl());
   report.initialConnectionUrl=localConnectionUrl();await stage('initial-default-six-website-connection');
   await wait(()=>frame().includes('本次设备授权已完成'));await stage('initial-default-six-completed');
   await wait(()=>!api.ui.dialog.open);dispatch('galaxy.open');await wait(()=>has('galaxy.choose.5'));await stage('normal-purpose-menu-after-default-six');
  }
  dispatch('galaxy.choose.1');await wait(()=>frame().includes('查找方法与协助'));dispatch('galaxy.choose.1');
  await wait(()=>frame().includes('希望得到什么帮助'));await stage('enter-search-goal');
  await wait(()=>frame().includes('可以继续查看的帮助')&&has('galaxy.choose.1'));
  await stage('current-authorized-help-list');
  const originalHelp=/\[(\d)\]\s+\[本地合成\] 原页面说明的阅读检查/.exec(frame());
  assert.ok(originalHelp,'The intended original help must be visible in the normal search list.');
  report.selectedHelpNumber=originalHelp[1];dispatch('galaxy.choose.'+originalHelp[1]);
  await wait(()=>frame().includes('需要的帮助')&&frame().includes('阅读检查'));await stage('actual-task-content');
  // The PTY supplies normal Enter and content input; this probe does not call
  // the business API, approve a Gate or submit a model prompt.
  if(process.env.GALAXY_HOST_CHECK_PHASE==='scope-expansion'){
   await wait(()=>frame().includes('在官网找相关方法')&&has('galaxy.choose.4'));dispatch('galaxy.choose.4');
   await stage('current-task-method-search-local-link-preparing');await wait(()=>localConnectionUrl());
   report.expansionConnectionUrl=localConnectionUrl();await stage('current-task-method-search-connection');
   await wait(()=>frame().includes('本次设备授权已完成'));await stage('current-task-expanded-device-completed');
   await wait(()=>!api.ui.dialog.open&&frame().includes('继续查找的方法方向'));await stage('current-task-method-search-returned-to-unsent-prompt');
   await wait(()=>!api.ui.dialog.open&&frame().includes(original)&&frame().includes('银河'));
   await stage('expanded-scope-original-unsent-input-preserved');report.originalWorkPreserved=true;report.resultAppendedToOriginalPrompt=true;
   report.scopeExpansionInSameActualHostProcess=true;report.success=true;await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');
   api.keymap.dispatchCommand('app.exit');return;
  }
  if(process.env.GALAXY_HOST_CHECK_PHASE==='read-original'){
   await wait(()=>frame().includes('我已发送的协助说明')&&has('galaxy.choose.3'));
   report.existingApplicationReadOnly=true;await stage('original-sent-help-actions');dispatch('galaxy.choose.3');
   await wait(()=>!api.ui.dialog.open&&frame().includes('help proposal only.')&&frame().includes('来源：'));
   await stage('original-sent-help-visible-in-original-input');
   // A long input scrolls in an 80x24 PTY. Normal ArrowUp input reveals its
   // beginning; do not mistake text outside the current viewport for deletion.
   await wait(()=>!api.ui.dialog.open&&frame().includes(original)&&frame().includes('银河'));
   await stage('original-unsent-input-and-help-heading-preserved');
   report.originalWorkPreserved=true;report.resultAppendedToOriginalPrompt=true;report.success=true;
   await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');api.keymap.dispatchCommand('app.exit');return;
  }
  await wait(()=>frame().includes('说明我能提供的协助')&&has('galaxy.choose.1'));dispatch('galaxy.choose.1');
  await wait(()=>frame().includes('你可以怎样协助'));report.expectedProposal=proposal;await stage('enter-help-description');
  await wait(()=>frame().includes('/review/'));
  const bases=frame().match(/http:\/\/127\.0\.0\.1:\d+\/review\//g)??[],suffixes=frame().match(/[a-f0-9]{48}/g)??[];
  assert.equal(bases.length,1);assert.equal(suffixes.length,1);report.choiceUrl=bases[0]+suffixes[0];await stage('actual-send-choice');
  await wait(()=>frame().includes('协助说明已发送'));await stage('actual-send-result');
  await wait(()=>frame().includes('带回原工作')&&has('galaxy.choose.1'));dispatch('galaxy.choose.1');
  await wait(()=>!api.ui.dialog.open&&frame().includes('Synthetic original work:')&&frame().includes('银河'));
  await stage('returned-content-and-original-unsent-input');
  assert.equal(frame().includes('help proposal only.'),true,'The complete authored proposal must reach the original prompt.');
  report.originalWorkPreserved=true;report.resultAppendedToOriginalPrompt=true;report.sameProcessTaskActionReturned=true;report.success=true;
 }catch(error){report.failure={name:error.name,message:error.message};await stage('failed');}
 await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');api.keymap.dispatchCommand('app.exit');
}
