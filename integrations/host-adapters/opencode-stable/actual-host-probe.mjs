// Runs inside the installed OpenCode process using its actual TUI APIs.
// The launcher creates an isolated directory and disables providers and sharing.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export default {id:'galaxy.purpose.actual-host.probe',tui(api){void run(api);}};
async function run(api){
 const events=[],pluginId='galaxy.opencode.stable.tui';
 const frame=()=>new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
 const has=name=>api.keymap.getCommands().some(item=>item.name===name);
 const snapshot=name=>events.push({name,dialog:{open:api.ui.dialog.open,depth:api.ui.dialog.depth},terminal:{width:api.renderer.width,height:api.renderer.height,text:frame()}});
 const dispatch=name=>assert.equal(api.keymap.dispatchCommand(name).ok,true,name);
 async function waitFor(check,attempts=150){for(let i=0;i<attempts;i++){if(check())return;await delay(50);}assert.ok(check(),'Actual OpenCode state timed out');}
 async function open(){dispatch('galaxy.open');await waitFor(()=>has('galaxy.choose.5'));await delay(250);snapshot('purpose-home');assert.match(frame(),/当前工作/);assert.match(frame(),/找帮助/);assert.match(frame(),/消息/);assert.match(frame(),/\[4\] 我的与设置/);assert.match(frame(),/\[5\] 回到原工作/);assert.equal(frame().includes('选择语言'),false);assert.equal(frame().includes('阶段 1 / 5'),false);}
 async function files(){let names=[];try{names=await readdir(process.env.GALAXY_DATA_DIR);}catch(error){if(error.code!=='ENOENT')throw error;}
  const hashes={};for(const name of names)hashes[name]=createHash('sha256').update(await readFile(join(process.env.GALAXY_DATA_DIR,name))).digest('hex');return hashes;}
 const report={recordedAt:new Date().toISOString(),version:api.app.version,actualInstalledOpenCodeProcess:true,actualTuiPluginApi:true,syntheticIsolatedDirectory:true,globalConfigurationChanged:false,realUserAcceptance:false,physicalDesktopVisualAcceptance:false,modelPromptSubmitted:false,events,success:false};
 try{await waitFor(()=>api.plugins.list().find(p=>p.id===pluginId)?.active);const before=await files();
  if(process.env.GALAXY_HOST_CHECK_SCENARIO==='methods'){
    const original='Synthetic original work: package exports. Do not send.';
    const addition=' Then inspect the selected export.';
    const useNote='Synthetic: used the selected exports steps; current result remains partial.';
    const fixture=new URL(process.env.GALAXY_METHOD_FIXTURE_URL);
    assert.equal(fixture.hostname,'127.0.0.1');
    const observe=async()=>{const response=await fetch(new URL('/observation',fixture));assert.equal(response.ok,true);return response.json();};
    const stage=async(name)=>{await delay(200);report.stage=name;snapshot(name);await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');};
    // Installed DialogAlert has no keymap command. The actual terminal Enter
    // closes it through its real callback; the probe only observes the next menu.
    const readMethod=async(expectedVersion,name)=>{
      await waitFor(()=>api.ui.dialog.open&&frame().includes('解决方法')&&frame().includes('版本 '+expectedVersion)&&!frame().includes('阅读全文'));
      await stage(name);
      report.alertCommandNames=api.keymap.getCommands().filter(item=>item.name.startsWith('dialog.alert.')).map(c=>c.name);
      await waitFor(()=>frame().includes('阅读全文'),2400);
    };
    report.syntheticWork=true;report.actualNativeMcp=true;report.actualSignedHttp=true;
    report.nativeChoiceSurface='actual-loopback-browser-review';
    const initial=await observe();report.initialMethod=initial;
    if(api.ui.dialog.open&&frame().includes('Connect a provider')){
      snapshot('isolated-provider-dialog');api.ui.dialog.clear();await waitFor(()=>!api.ui.dialog.open);await delay(200);
    }
    await stage('enter-unsent-original-work');
    await waitFor(()=>frame().includes(original),2400);
    await open();dispatch('galaxy.choose.4');await waitFor(()=>/我的与设置/.test(frame()));
    dispatch('galaxy.choose.2');await waitFor(()=>/包导出检查方法/.test(frame()));dispatch('galaxy.choose.1');
    await readMethod(initial.current.version,'read-existing-method');
    if(initial.publicationRequests===0){
      await waitFor(()=>/修订这份方法/.test(frame()));dispatch('galaxy.choose.5');
      await waitFor(()=>/整理这份方法/.test(frame()));dispatch('galaxy.choose.1');
      await waitFor(()=>/方法内容与条件/.test(frame()));dispatch('galaxy.choose.3');
      await waitFor(()=>has('dialog.prompt.submit'));await stage('edit-prefilled-method');
      assert.match(frame(),/package exports/);await waitFor(()=>frame().includes('selected export.'),2400);
      dispatch('dialog.prompt.submit');await waitFor(()=>/整理这份方法/.test(frame()));dispatch('galaxy.choose.6');
      await waitFor(()=>/等待你的选择/.test(frame()));report.beforePublication=await observe();
      assert.equal(report.beforePublication.publicationRequests,0);await stage('publication-needs-actual-choice');
      await waitFor(()=>/方法已保存/.test(frame()),5400);report.afterPublication=await observe();
      assert.equal(report.afterPublication.publicationRequests,1);assert.equal(report.afterPublication.current.version,2);
      assert.ok(report.afterPublication.current.solutionStrategy.endsWith(addition));await stage('version-two-saved');
      dispatch('galaxy.choose.2');await readMethod(2,'read-saved-version-two');
      report.sameProcessPublication=true;
    }else{
      // A prior renderer assertion ended only the probe after the original
      // publication was acknowledged. Continue that exact readable version.
      assert.equal(initial.publicationRequests,1);assert.equal(initial.current.version,2);
      assert.ok(initial.current.solutionStrategy.endsWith(addition));assert.equal(initial.useRequests,0);
      report.resumedExistingPublication=true;report.sameProcessPublication=false;
    }
    await waitFor(()=>/记录实际应用/.test(frame()));dispatch('galaxy.choose.3');
    await waitFor(()=>/选择实际工作/.test(frame()));
    assert.equal(frame().includes('[1] 合成：当前包导出工作'),false);dispatch('galaxy.choose.1');
    await waitFor(()=>/实际采用了什么/.test(frame()));dispatch('galaxy.choose.1');
    await waitFor(()=>has('dialog.prompt.submit'));await stage('describe-actual-use');
    await waitFor(()=>frame().includes('remains partial.'),2400);dispatch('dialog.prompt.submit');
    await waitFor(()=>/保存这次记录/.test(frame()));await stage('actual-use-ready');dispatch('galaxy.choose.4');
    await waitFor(()=>/等待你的选择/.test(frame()));report.beforeUse=await observe();assert.equal(report.beforeUse.useRequests,0);
    await stage('use-needs-actual-choice');await waitFor(()=>/这次使用已记录/.test(frame()),5400);
    report.afterUse=await observe();assert.equal(report.afterUse.useRequests,1);assert.equal(report.afterUse.uses.length,1);
    assert.equal(report.afterUse.uses[0].outcome,'partial');assert.equal(report.afterUse.uses[0].note,useNote);
    assert.deepEqual(report.afterUse.uses[0].environment,{name:'Node',version:'26'});
    await stage('actual-partial-use-saved');dispatch('galaxy.choose.1');await waitFor(()=>!api.ui.dialog.open&&frame().includes(original));
    await stage('returned-to-unsent-original-work');assert.deepEqual(await files(),before);
    report.localFilesUnchanged=true;report.originalWorkPreserved=true;report.success=true;
    await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');
    api.keymap.dispatchCommand('app.exit');return;
  }
  if(process.env.GALAXY_HOST_CHECK_SCENARIO==='prompt-api'){
    report.promptApiDefinition=String(api.ui.DialogPrompt);
    let received;
    const original='Original selected help',addition=' only this source';
    api.ui.dialog.replace(()=>api.ui.DialogPrompt({title:'Synthetic original text edit',value:original,placeholder:'This is a hint only',onConfirm:value=>{received=value;api.ui.dialog.clear();},onCancel:()=>api.ui.dialog.clear()}));
    await waitFor(()=>has('dialog.prompt.submit')&&frame().includes(original));snapshot('native-prefilled-input');
    await waitFor(()=>frame().includes(addition));dispatch('dialog.prompt.submit');await waitFor(()=>received!==undefined);
    assert.equal(received,original+addition);report.editedValue=received;
    received=undefined;const lines='Earlier approach one\nEarlier approach two';
    api.ui.dialog.replace(()=>api.ui.DialogPrompt({title:'Synthetic line editing',value:lines,onConfirm:value=>{received=value;api.ui.dialog.clear();},onCancel:()=>api.ui.dialog.clear()}));
    await waitFor(()=>has('dialog.prompt.submit')&&frame().includes('Earlier approach two'));snapshot('native-prefilled-lines');dispatch('dialog.prompt.submit');await waitFor(()=>received!==undefined);
    assert.equal(received,lines);report.multilineValue=received;
    assert.deepEqual(await files(),before);report.localFilesUnchanged=true;report.success=true;
    await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');api.keymap.dispatchCommand('app.exit');return;
  }
  await open();
  dispatch('galaxy.choose.1');await waitFor(()=>/尚未接入可查询/.test(frame()));await delay(100);snapshot('help-no-config');assert.equal(frame().includes('payloadJson'),false);
  dispatch('galaxy.choose.2');await waitFor(()=>!api.ui.dialog.open);snapshot('original-work');await open();
  dispatch('galaxy.choose.4');await waitFor(()=>/我的与设置/.test(frame()));await delay(100);snapshot('settings');
  dispatch('galaxy.choose.3');await waitFor(()=>/显示语言/.test(frame()));await delay(100);snapshot('language-on-demand');
  dispatch('galaxy.exit');await waitFor(()=>!api.ui.dialog.open);await open();dispatch('galaxy.choose.5');await waitFor(()=>!api.ui.dialog.open);
  await open();assert.equal(await api.plugins.deactivate(pluginId),true);await waitFor(()=>!api.ui.dialog.open);assert.equal(api.keymap.getCommands().filter(item=>item.name.startsWith('galaxy.')).length,0);snapshot('deactivated');
  assert.equal(await api.plugins.activate(pluginId),true);await waitFor(()=>api.plugins.list().find(p=>p.id===pluginId)?.active);await open();dispatch('galaxy.choose.5');await waitFor(()=>!api.ui.dialog.open);
  assert.deepEqual(await files(),before);report.localFilesUnchanged=true;report.success=true;
 }catch(error){report.failure={name:error.name,message:error.message};snapshot('failed');}
 await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');api.keymap.dispatchCommand('app.exit');
}
