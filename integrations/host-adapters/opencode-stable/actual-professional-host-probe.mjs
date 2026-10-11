import assert from 'node:assert/strict';
import {writeFile,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export default{id:'galaxy.professional.actual-host.probe',tui(api){void run(api);}};
async function run(api){
 const events=[],frame=()=>new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
 // Read only the visible Dialog columns. The unsent host input remains behind
 // it and can otherwise interrupt a wrapped sentence in the flat frame text.
 const visible=()=>{const text=frame();if(!api.ui.dialog.open)return text;const lines=text.split('\n'),header=lines.find(line=>/^\s+\S.*\sesc\s*$/.test(line)),inset=header?.match(/^\s*/)?.[0].length??0;return lines.map(line=>line.slice(inset,api.renderer.width-inset)).join('\n');};
 const reading=value=>visible().replace(/\s+/g,' ').includes(value.replace(/\s+/g,' ')),has=name=>api.keymap.getCommands().some(c=>c.name===name);
 const dispatch=name=>assert.equal(api.keymap.dispatchCommand(name).ok,true,name),fixture=new URL(process.env.GALAXY_PROFESSIONAL_FIXTURE_URL);assert.equal(fixture.hostname,'127.0.0.1');
 const read=async()=>{const response=await fetch(new URL('/observation?kind=builder',fixture));assert.equal(response.ok,true);return response.json();};
 const report={recordedAt:new Date().toISOString(),version:api.app.version,actualInstalledOpenCodeProcess:true,actualTuiPluginApi:true,actualNativeMcp:false,actualSignedHttp:true,
  syntheticWorkAndCi:true,realProvider:false,realModel:false,modelPromptSubmitted:false,globalConfigurationChanged:false,physicalDesktopVisualAcceptance:false,realUserAcceptance:false,success:false,events};
 async function stage(name){await delay(150);report.stage=name;events.push({name,dialog:{open:api.ui.dialog.open,depth:api.ui.dialog.depth},terminal:{width:api.renderer.width,height:api.renderer.height,text:frame()}});await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');}
 async function wait(check,attempts=240){for(let i=0;i<attempts;i++){if(check())return;await delay(50);}assert.ok(check(),'Actual installed professional TUI timed out at '+report.stage);}
 async function files(){let names=[];try{names=await readdir(process.env.GALAXY_DATA_DIR);}catch(error){if(error.code!=='ENOENT')throw error;}const values={};for(const name of names)values[name]=createHash('sha256').update(await readFile(join(process.env.GALAXY_DATA_DIR,name))).digest('hex');return values;}
 const original='Synthetic original work: node participation. Do not send.',note='Synthetic: this node contributed to the selected step only.';
 try{
  assert.equal(process.env.GALAXY_PROFESSIONAL_KIND,'builder');
  await wait(()=>api.plugins.list().find(p=>p.id==='galaxy.opencode.stable.tui')?.active);const beforeFiles=await files();
  if(api.ui.dialog.open&&frame().includes('Connect a provider')){api.ui.dialog.clear();await wait(()=>!api.ui.dialog.open);}
  await stage('enter-unsent-original-work');await wait(()=>reading(original),2400);
  dispatch('galaxy.open');await wait(()=>reading('我的与设置'));dispatch('galaxy.choose.4');await wait(()=>reading('连接与设备'));dispatch('galaxy.choose.6');await wait(()=>reading('连接与专业入口'));await stage('read-professional-connection');
  dispatch('galaxy.choose.8');await wait(()=>reading('浏览目录'));dispatch('galaxy.choose.1');await wait(()=>reading('登记类型'));dispatch('galaxy.choose.1');await wait(()=>reading('合成本机节点'));await stage('read-current-node-directory');assert.equal(reading('unknown'),false);
  dispatch('galaxy.choose.1');await wait(()=>reading('以Node身份关联任务证据'));dispatch('galaxy.choose.1');await wait(()=>reading('节点参与示例工作'));dispatch('galaxy.choose.1');await wait(()=>reading('运行 19'));await stage('select-current-ci-source');
  dispatch('galaxy.choose.1');await wait(()=>reading('使用所选来源'));dispatch('galaxy.choose.1');await wait(()=>has('dialog.prompt.submit')&&reading('这次节点实际参与了什么'));await stage('write-node-participation');
  // Text and Enter are supplied through the actual PTY. The probe never
  // submits while the terminal may still be processing a prefix of that text.
  await wait(()=>reading('保存这次节点参与'),2400);await stage('read-complete-node-preview');
  await wait(()=>reading('部分完成')&&reading('运行 19'),2400);await stage('read-exact-result-and-ci-before-submit');
  await wait(()=>reading('保存参与说明'),2400);
  report.beforeSubmission=await read();assert.equal(report.beforeSubmission.current.nodeWorkEvidence.items.length,0);await stage('exact-node-choice-before-submit');
  dispatch('galaxy.choose.1');await wait(()=>reading('已记录这次内容'));report.afterSubmission=await read();
  assert.equal(report.afterSubmission.current.nodeWorkEvidence.items.length,1);const saved=report.afterSubmission.current.nodeWorkEvidence.items[0];
  assert.equal(saved.summary,note);assert.equal(saved.state,'current');assert.equal(saved.source.reportedOutcome,'partial');assert.equal(saved.source.proofs.length,1);assert.equal(saved.executionAttributionVerified,false);assert.equal(saved.capabilityVerified,false);
  assert.equal(report.afterSubmission.bridgeCalls.filter(m=>m==='executeBuilder').length,1);await stage('one-node-participation-saved');
  await wait(()=>reading('以Node身份关联任务证据'),2400);dispatch('galaxy.choose.4');await wait(()=>reading(note));assert.equal(reading('这次工作的原结果：部分完成'),true);await stage('read-saved-participation-and-result');
  await wait(()=>reading('以Node身份关联任务证据'),2400);dispatch('galaxy.choose.2');await wait(()=>!api.ui.dialog.open&&reading(original));await stage('returned-to-original-unsent-work');
  assert.deepEqual(await files(),beforeFiles);report.localIdentityFilesUnchanged=true;report.originalWorkPreserved=true;report.afterReturn=await read();assert.equal(report.afterReturn.current.nodeWorkEvidence.items.length,1);assert.equal(report.afterReturn.bridgeCalls.filter(m=>m==='executeBuilder').length,1);
  report.sameProcessCompletePath=true;report.success=true;
 }catch(error){report.failure={name:error.name,message:error.message};await stage('failed');}
 await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');api.keymap.dispatchCommand('app.exit');
}
