import assert from 'node:assert/strict';
import {writeFile,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export default{id:'galaxy.contact.actual-host.probe',tui(api){void run(api);}};
async function run(api){
 const events=[],frame=()=>new TextDecoder().decode(api.renderer.currentRenderBuffer.getRealCharBytes(true)),has=name=>api.keymap.getCommands().some(c=>c.name===name);
 const reading=value=>frame().replace(/\s+/g,' ').includes(value.replace(/\s+/g,' '));
 const dispatch=name=>assert.equal(api.keymap.dispatchCommand(name).ok,true,name),fixture=new URL(process.env.GALAXY_CONTACT_FIXTURE_URL);assert.equal(fixture.hostname,'127.0.0.1');
 const read=async path=>{const response=await fetch(new URL(path,fixture));assert.equal(response.ok,true);return response.json();};
 const report={recordedAt:new Date().toISOString(),version:api.app.version,actualInstalledOpenCodeProcess:true,actualTuiPluginApi:true,actualNativeMcp:true,actualSignedHttp:true,
  syntheticParticipants:true,syntheticMessageTransport:true,realProsody:false,realModel:false,modelPromptSubmitted:false,globalConfigurationChanged:false,physicalDesktopVisualAcceptance:false,realUserAcceptance:false,success:false,events};
 async function stage(name){await delay(200);report.stage=name;events.push({name,dialog:{open:api.ui.dialog.open,depth:api.ui.dialog.depth},terminal:{width:api.renderer.width,height:api.renderer.height,text:frame()}});await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');}
 async function wait(check,attempts=160){for(let i=0;i<attempts;i++){if(check())return;await delay(50);}assert.ok(check(),'Actual installed Contact TUI timed out at '+report.stage);}
 async function files(){let names=[];try{names=await readdir(process.env.GALAXY_DATA_DIR);}catch(error){if(error.code!=='ENOENT')throw error;}const values={};for(const name of names)values[name]=createHash('sha256').update(await readFile(join(process.env.GALAXY_DATA_DIR,name))).digest('hex');return values;}
 const original='Synthetic original work: table extraction. Do not send.',contact='Synthetic: discuss the current table extraction steps; no delivery request.',reply='Synthetic: thank you, continue discussing this example.';
 try{
  await wait(()=>api.plugins.list().find(p=>p.id==='galaxy.opencode.stable.tui')?.active);const before=await files();
  if(api.ui.dialog.open&&frame().includes('Connect a provider')){api.ui.dialog.clear();await wait(()=>!api.ui.dialog.open);}
  await stage('enter-unsent-original-work');await wait(()=>frame().includes(original),2400);
  dispatch('galaxy.open');await wait(()=>has('galaxy.choose.5'));dispatch('galaxy.choose.1');await wait(()=>frame().includes('寻找同行'));dispatch('galaxy.choose.2');await wait(()=>frame().includes('按方向查找'));dispatch('galaxy.choose.1');
  await wait(()=>has('dialog.prompt.submit')&&frame().includes('表格提取'));await stage('direction-prefilled-from-selected-work');dispatch('dialog.prompt.submit');
  await wait(()=>frame().includes('相关的人和项目')&&frame().includes('文档表格工具'));dispatch('galaxy.choose.1');
  await wait(()=>api.ui.dialog.open&&frame().includes('当前可读的工作经历'));await stage('read-current-project');
  await wait(()=>frame().includes('写联系内容'),2400);dispatch('galaxy.choose.2');await wait(()=>frame().includes('工作经历')&&frame().includes('实际尝试'));dispatch('galaxy.choose.1');
  await wait(()=>frame().includes('部分完成'));await stage('read-current-partial-experience');assert.equal(frame().includes('unrecorded'),false);await wait(()=>frame().includes('经历来源详情'),2400);
  dispatch('galaxy.zero');await wait(()=>frame().includes('写联系内容'));await stage('back-to-current-project-actions');
  dispatch('galaxy.choose.1');await wait(()=>has('dialog.prompt.submit'));await stage('write-contact');
  // A rendered prefix does not prove that the terminal has processed the full
  // input stream. Submit via actual PTY Enter only after writing has completed.
  await wait(()=>frame().includes('等待你的选择'),7200);report.beforeContact=await read('/observation');assert.equal(report.beforeContact.sendRequests,0);
  report.contactChoice=(await read('/sender/view')).choiceUrl;await stage('contact-needs-real-local-choice');
  await wait(()=>frame().includes('等待回应'),5400);report.afterContact=await read('/observation');assert.equal(report.afterContact.sendRequests,1);assert.equal(report.afterContact.counts.rooms,0);assert.equal(report.afterContact.contacts[0].events[0].note,contact);await stage('contact-sent-waiting-for-recipient');
  // A separate synthetic participant still chooses in the actual local Gate.
  // The probe does not accept, sign, submit, or create membership for them.
  report.recipientUrl=new URL('/recipient',fixture).href;await stage('recipient-response-required');await wait(()=>frame().includes('这段对话还没有可读消息'),7200);
  report.afterAcceptance=await read('/observation');assert.equal(report.afterAcceptance.responseRequests,1);assert.equal(report.afterAcceptance.contacts[0].state,'accepted');assert.equal(report.afterAcceptance.counts.rooms,1);assert.equal(report.afterAcceptance.counts.tasks,0);assert.equal(report.afterAcceptance.counts.participations,0);await stage('same-accepted-conversation');
  await wait(()=>frame().includes('写消息'),2400);dispatch('galaxy.choose.1');await wait(()=>has('dialog.prompt.submit'));await stage('write-exact-chat-message');
  await wait(()=>frame().includes('允许这段对话回复'),7200);
  report.replyChoice=(await read('/sender/view')).choiceUrl;await stage('reply-permission-needs-real-local-choice');
  await wait(()=>reading(reply),5400);report.afterMessage=await read('/observation');const mine=report.afterMessage.chat.filter(message=>message.subject_id===report.afterMessage.contacts[0].initiatorId);
  assert.equal(mine.length,1);assert.equal(mine[0].state,'accepted');await stage('same-room-message-readback');
  await wait(()=>frame().includes('写消息'),2400);dispatch('galaxy.choose.3');await wait(()=>!api.ui.dialog.open&&frame().includes(original));await stage('returned-to-original-unsent-work');
  assert.deepEqual(await files(),before);report.localFilesUnchanged=true;report.originalWorkPreserved=true;report.sameProcessCompletePath=true;report.success=true;
 }catch(error){report.failure={name:error.name,message:error.message};await stage('failed');}
 await writeFile(process.env.GALAXY_HOST_CHECK_REPORT,JSON.stringify(report,null,2)+'\n');api.keymap.dispatchCommand('app.exit');
}
