import assert from 'node:assert/strict';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const probe={id:'galaxy.native-install.actual-host.probe',tui(api){void run(api);}};
export default probe;
async function run(api){
 const events=[],frame=()=>new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true)),has=name=>api.keymap.getCommands().some(command=>command.name===name);
 const report={recordedAt:new Date().toISOString(),version:api.app.version,actualInstalledOpenCodeProcess:true,actualTuiPluginApi:true,normalPackagedNativeEntry:true,
  fixtureRuntimeInjected:false,realPublicServiceConfiguration:true,onlineAccountConnected:false,realModel:false,modelPromptSubmitted:false,globalConfigurationChanged:false,
  physicalDesktopVisualAcceptance:false,realUserAcceptance:false,success:false,events};
 async function stage(name){await delay(150);report.stage=name;events.push({name,dialog:{open:api.ui.dialog.open,depth:api.ui.dialog.depth},terminal:{width:api.renderer.width,height:api.renderer.height,text:frame()}});await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');}
 async function wait(check,attempts=160){for(let i=0;i<attempts;i++){if(check())return;await delay(50);}assert.ok(check(),'Installed normal Native TUI timed out at '+report.stage);}
 const dispatch=name=>assert.equal(api.keymap.dispatchCommand(name).ok,true,name),original='Synthetic current work: keep this unsent input.';
 try{
  await wait(()=>api.plugins.list().find(plugin=>plugin.id==='galaxy.opencode.stable.tui')?.active);
  if(api.ui.dialog.open&&frame().includes('Connect a provider')){api.ui.dialog.clear();await wait(()=>!api.ui.dialog.open);}
  await stage('enter-original-unsent-work');await wait(()=>frame().includes(original),2400);
  dispatch('galaxy.open');await wait(()=>has('galaxy.choose.5'));await stage('normal-purpose-menu');
  dispatch('galaxy.choose.4');await wait(()=>frame().includes('我的与设置'));dispatch('galaxy.choose.1');
  // The current normal installer prepares the synthetic local identity in its
  // single installation choice. Loading the host must preserve that identity.
  await wait(()=>frame().includes('尚未连接')&&frame().includes('连接当前身份'),2400);await stage('installed-local-identity-disconnected');
  const identity=JSON.parse(await readFile(join(process.env.GALAXY_DATA_DIR,'galaxy-id.json'),'utf8'));report.identity=identity.id;
  assert.match(identity.id,/^GUID/);assert.equal(frame().includes('尚未连接'),true);
  report.localFiles=await readdir(process.env.GALAXY_DATA_DIR);assert.equal(report.localFiles.includes('connection-binding.json'),false);
  dispatch('galaxy.choose.3');await wait(()=>!api.ui.dialog.open&&frame().includes(original));await stage('returned-to-original-unsent-work');
  report.originalWorkPreserved=true;report.sameProcessCompleteLocalPath=true;report.success=true;
 }catch(error){report.failure={name:error.name,message:error.message};await stage('failed');}
 await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');api.keymap.dispatchCommand('app.exit');
}
