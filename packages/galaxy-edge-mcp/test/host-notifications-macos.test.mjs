import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createMacOSNotificationChannel } from '../src/native-v2/notifications/macos-user-notifications.mjs';
import { createHostNotificationRuntime } from '../src/native-v2/notifications/runtime.mjs';
import { buildMacOSNotificationHelper } from '../src/native-v2/notifications/macos-helper/build.mjs';

const command='/Applications/GalaxyNotifications.app/Contents/MacOS/GalaxyNotifications';
const processFixture=fileURLToPath(new URL('./host-notifications-macos-process-fixture.mjs',import.meta.url));
async function childFixture(scenario='authorized',options={}){
 const directory=await mkdtemp(join(tmpdir(),'galaxy-macos-notifications-')),recordPath=join(directory,'protocol.jsonl'),children=[];
 const calls=[];
 const channel=createMacOSNotificationChannel({command,platform:'darwin',checkExecutable:async()=>{},
  spawnProcess:(executable,args,config)=>{
   calls.push({executable,args,config});
   const child=spawn(process.execPath,[processFixture,scenario,recordPath],config);children.push(child);return child;
  },...options});
 const events=async()=>{try{return(await readFile(recordPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
 const close=async()=>{try{await channel.close();assert.equal(children.every(child=>child.exitCode!==null||child.signalCode!==null),true);}
  finally{const path=resolve(directory),root=resolve(tmpdir()),inside=relative(root,path);
   assert.equal(!isAbsolute(inside)&&inside!==''&&!inside.startsWith('..')&&path.startsWith(root),true);
   await rm(path,{recursive:true,force:true});}};
 return{channel,calls,children,events,close};
}

test('macOS channel is inert until explicit use, defaults to foreground and rejects non-bundled commands',async()=>{
 let spawns=0,inspections=0;
 for(const options of [{platform:'win32',command},{platform:'darwin',command:null}]){
  const channel=createMacOSNotificationChannel({...options,spawnProcess:()=>{spawns++;},checkExecutable:async()=>{inspections++;}});
  assert.equal(channel.kind,'macos-user-notifications');assert.equal((await channel.capabilities()).available,false);
  assert.equal((await channel.show({promptId:randomUUID(),eventCount:1})).state,'unavailable');await channel.close();
 }
 assert.equal(spawns,0);assert.equal(inspections,0);
 for(const invalid of ['osascript','/usr/bin/osascript','/Applications/Foreign.app/Contents/MacOS/GalaxyNotifications'])
  assert.throws(()=>createMacOSNotificationChannel({command:invalid}),/bundled_command/);
});

test('macOS capability child only probes existing authorization, with fixed shell-free args and no notification',async()=>{
 const f=await childFixture();try{
  const capability=await f.channel.capabilities();
  assert.equal(capability.available,true);assert.equal(capability.permission,'authorized');assert.equal(capability.displayEvidence,'none');
  assert.deepEqual((await f.events())[0],{version:1,mode:'probe'});
  assert.equal((await f.events()).some(event=>event.mode==='permission'||event.mode==='show'),false);
  assert.equal(f.calls[0].executable,command);assert.deepEqual(f.calls[0].args,['--stdio-v1']);
  assert.equal(f.calls[0].config.shell,false);assert.equal(f.calls[0].config.windowsHide,true);
 }finally{await f.close();}
});

test('macOS denied, not-determined and disabled alerts keep foreground fallback without asking permission',async()=>{
 for(const scenario of ['denied','not-determined','alerts-disabled']){
  const f=await childFixture(scenario);try{
   assert.equal((await f.channel.capabilities()).available,false);
   const result=await f.channel.show({promptId:randomUUID(),eventCount:1});
   assert.equal(result.state,'unavailable');assert.equal(result.displayed,false);
   assert.equal((await f.events()).some(event=>event.mode==='permission'||event.event==='recall'),false);
  }finally{await f.close();}
 }
});

test('macOS OS permission request has a separate explicit protocol mode and cannot cross an invalid local choice',async()=>{
 const f=await childFixture();try{
  assert.equal((await f.channel.requestPermission({isCurrent:()=>false})).available,false);
  assert.equal(f.children.length,0);
  assert.equal((await f.channel.requestPermission()).available,true);
  assert.deepEqual((await f.events())[0],{version:1,mode:'permission'});
  assert.equal((await f.events()).some(event=>event.mode==='show'),false);
 }finally{await f.close();}
});

test('macOS add acceptance stays unknown and recall is limited to this original request ID',async()=>{
 const f=await childFixture();try{
  const promptId=randomUUID(),result=await f.channel.show({promptId,eventCount:2});
  assert.equal(result.state,'unknown');assert.equal(result.systemAccepted,true);assert.equal(result.promptId,promptId);
  assert.equal(result.displayed,false);assert.equal(result.humanReadChanged,false);assert.equal(result.agentCursorChanged,false);
  assert.equal(result.foregroundFallbackRequired,true);
  const recalled=await f.channel.withdraw(promptId);
  assert.equal(recalled.systemRecall,'requested-original-id');assert.equal(recalled.observedAbsence,true);assert.equal(recalled.ownedProcessClosed,true);
  assert.deepEqual((await f.events()).filter(event=>event.event==='recall'),[{event:'recall',notificationId:promptId}]);
  assert.equal((await f.events()).filter(event=>event.mode==='show').length,1);
 }finally{await f.close();}
});

test('macOS asynchronous recall requested does not assert an observed absence or a system display',async()=>{
 const f=await childFixture('recall-pending');try{
  const promptId=randomUUID();await f.channel.show({promptId,eventCount:1});
  const recalled=await f.channel.withdraw(promptId);
  assert.equal(recalled.systemRecall,'requested-original-id');assert.equal(recalled.observedAbsence,false);
  assert.equal(recalled.displayed,false);assert.equal(recalled.humanReadChanged,false);
 }finally{await f.close();}
});

test('macOS accepted unknown remains owned for later source withdrawal and never marks presentation',async()=>{
 const f=await childFixture(),subjectId='GUID'+'A'.repeat(28),deliveryClientId=randomUUID();
 const lease={subjectId,endpoint:'https://official.example.org',bindingId:randomUUID(),generation:1};
 let current=true,presented=0;const values=new Map();
 const id='room-message:'+randomUUID(),inbox={
  query:async()=>({items:current?[{id,interruptiveEligible:true,quiet:false,read:false,presented:false,object:{type:'room',id:randomUUID()}}]:[]}),
  claim:async input=>({id:input.id,claimed:current,claimId:input.claimId,leaseUntil:new Date(Date.now()+30000).toISOString()}),
  presented:async()=>{presented++;throw Error('unknown acceptance must not assert display');},
 };
 const runtime=createHostNotificationRuntime({inbox,channel:f.channel,getLease:()=>lease,deliveryClientId,
  store:{get:async key=>structuredClone(values.get(key)),update:async(key,mutate)=>{
   const result=mutate(structuredClone(values.get(key)));values.set(key,structuredClone(result));return result;
  }}});
 try{
  assert.equal((await runtime.check()).state,'disabled');assert.equal(f.children.length,0);
  await runtime.enable({}, {confirmed:true});
  assert.equal((await runtime.check()).state,'foreground-fallback');assert.equal(presented,0);
  const prompt=(await runtime.status()).prompts[0];assert.equal(prompt.state,'unknown');assert.equal(prompt.presentationAcknowledged,false);
  current=false;assert.equal((await runtime.check()).state,'no-new-items');
  assert.equal(f.children[0].exitCode!==null||f.children[0].signalCode!==null,true);
  assert.equal((await f.events()).filter(event=>event.event==='recall').length,1);assert.equal(presented,0);
 }finally{await runtime.dispose();await f.close();}
});

test('macOS binding loss or close while executable inspection waits starts zero helpers and reserves at most 64',async()=>{
 let release;const blocked=new Promise(resolve=>{release=resolve;}),f=await childFixture('authorized',{checkExecutable:()=>blocked});
 try{
  const pending=Array.from({length:64},()=>f.channel.show({promptId:randomUUID(),eventCount:1}));
  assert.equal((await f.channel.show({promptId:randomUUID(),eventCount:1})).reason,'notification_process_capacity');
  await f.channel.close();release();const results=await Promise.all(pending);
  assert.equal(results.every(result=>result.displayed===false),true);assert.equal(f.children.length,0);
 }finally{release();await f.close();}
 const late=await childFixture('authorized',{checkExecutable:async()=>{},});try{
  assert.equal((await late.channel.show({promptId:randomUUID(),eventCount:1},{isCurrent:()=>false})).reason,'notification_cancelled');
  assert.equal(late.children.length,0);
 }finally{await late.close();}
});

test('macOS invalid protocol, foreign bundle/identifier and timed-out child never become display evidence',async()=>{
 for(const scenario of ['bad-json','wrong-bundle','wrong-id','hang']){
  const f=await childFixture(scenario,{timeoutMs:scenario==='hang'?200:3000,shutdownGraceMs:200});try{
   const result=await f.channel.show({promptId:randomUUID(),eventCount:1});
   assert.equal(result.displayed,false);assert.notEqual(result.systemAccepted,true);
  }finally{await f.close();}
 }
});

test('macOS protocol closed and live child errors are not process exit; close drains the owned child',async()=>{
 const f=await childFixture('delayed-exit',{shutdownGraceMs:1000});try{
  const promptId=randomUUID();await f.channel.show({promptId,eventCount:1});
  const started=Date.now();f.children[0].emit('error',Error('synthetic live child I/O fault'));
  await f.channel.close();assert.equal(Date.now()-started>=150,true);
  assert.equal(f.children[0].exitCode!==null||f.children[0].signalCode!==null,true);
 }finally{await f.close();}
});

test('macOS helper developer build rejects wrong platform/existing output and keeps fixed args; fake compiler is only a contract double',async()=>{
 let executions=0;await assert.rejects(buildMacOSNotificationHelper({destination:'/tmp/unwritten',platform:'win32',executeFile:async()=>{executions++;}}),/build_host_required/);
 assert.equal(executions,0);
 const parent=await mkdtemp(join(tmpdir(),'galaxy-macos-build-')),destination=join(parent,'new-output');
 try{
  const report=await buildMacOSNotificationHelper({destination,platform:'darwin',executeFile:async(executable,args,options)=>{
   executions++;assert.equal(executable,'/usr/bin/xcrun');assert.deepEqual(args.slice(0,9),
    ['--sdk','macosx','swiftc','-swift-version','5','-O','-framework','AppKit','-framework']);
   assert.equal(args[9],'UserNotifications');assert.equal(options.shell,false);
   assert.equal(args.at(-2),'-o');assert.equal(args.at(-1),join(destination,'GalaxyNotifications.app','Contents','MacOS','GalaxyNotifications'));
   await writeFile(args.at(-1),'synthetic compiler output, not a macOS binary',{flag:'wx'});
  }});
  assert.equal(report.signed,false);assert.equal(report.notarized,false);assert.equal(report.installed,false);assert.equal(report.launched,false);
  assert.equal(report.notificationShown,false);assert.equal(executions,1);
  await assert.rejects(buildMacOSNotificationHelper({destination,platform:'darwin',executeFile:async()=>{executions++;}}),/EEXIST/);
  assert.equal(executions,1);
  const partial=join(parent,'partial');
  await assert.rejects(buildMacOSNotificationHelper({destination:partial,platform:'darwin',executeFile:async()=>{throw Error('synthetic SDK unavailable');}}),/SDK unavailable/);
  assert.equal((await readFile(join(partial,'GalaxyNotifications.app','Contents','Info.plist'),'utf8')).includes('org.galaxy.local-notifications'),true);
  await assert.rejects(readFile(join(partial,'build-report.json')),/ENOENT/);
 }finally{
  const inside=relative(resolve(tmpdir()),resolve(parent));assert.equal(!isAbsolute(inside)&&inside!==''&&!inside.startsWith('..'),true);
  await rm(parent,{recursive:true,force:true});
 }
});

test('macOS bundle source uses app-owned exact recall and fixed generic content without provisional/background/push actions',async()=>{
 const source=await readFile(new URL('../src/native-v2/notifications/macos-helper/GalaxyNotifications.swift',import.meta.url),'utf8');
 const plist=await readFile(new URL('../src/native-v2/notifications/macos-helper/Info.plist',import.meta.url),'utf8');
 assert.equal(source.includes('Bundle.main.bundleIdentifier == expectedBundle'),true);
 assert.equal(source.includes('removePendingNotificationRequests(withIdentifiers: [id])'),true);
 assert.equal(source.includes('removeDeliveredNotifications(withIdentifiers: [id])'),true);
 assert.equal(/center\.removeAll|\.provisional|registerForRemote|display notification|osascript|URL\(/.test(source),false);
 assert.equal(source.includes('requestAuthorization(options: [.alert])'),true);
 assert.equal(source.includes('mode == "permission" && settings.authorizationStatus == .notDetermined'),true);
 assert.equal(source.includes('if addPending { return }'),true);
 assert.equal(plist.includes('org.galaxy.local-notifications'),true);
});
