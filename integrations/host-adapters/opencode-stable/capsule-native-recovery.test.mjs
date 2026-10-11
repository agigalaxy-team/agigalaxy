import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createNativeCapsuleMenu} from './capsule-native-menu.mjs';

test('an uncertain method save offers the original read, never another editable submission',async()=>{
 let page,returned=0,prepared=0,executed=0;
 const originalHandle='synthetic-original-operation',reads=[];
 const method={schemaVersion:2,title:'已选方法',version:1,problemPattern:'当前问题',solutionStrategy:'原文方法',
  applicableScope:'当前模块',environment:{name:'Node',version:'24'},tools:[],skills:[],mcpRefs:[],
  verificationMethod:'原说明',limitations:['原限制'],capabilityId:'software-debugging',license:'MIT'};
 const source={caseId:'synthetic-current-work',title:'当前工作',summary:'现有内容'};
 const result={id:'synthetic-result',version:1,actorId:'synthetic-owner',provenance:'native-v2',reportedOutcome:'succeeded',
  summary:'原结果',origin:{kind:'attempt',id:'synthetic-attempt',version:1}};
 const menu=createNativeCapsuleMenu({
  isCurrent:()=>true,onBack(){},onReturnWork:()=>{returned++;},readWorkContext:async()=>({caseId:source.caseId}),
  select:value=>{page={kind:'select',...value};},prompt:value=>{page={kind:'prompt',...value};},
  info:(title,message,onConfirm)=>{page={kind:'alert',title,message,onConfirm};},
  call:async(name,input)=>{
   if(name==='galaxy_capsule_v2_read')return{capsuleId:'synthetic-method',versionId:'synthetic-v1',version:method,ownerControl:true};
   if(name==='galaxy_capsule_v2_versions')return{items:[{versionId:'synthetic-v1',disclosure:{visibility:'Private',viewers:[]}}]};
   if(name==='galaxy_capsule_work_sources')return{items:[source]};
   if(name==='galaxy_capsule_work_read')return{subjectId:'synthetic-owner',results:[result],attempts:[{id:'synthetic-attempt',version:1,actorId:'synthetic-owner'}]};
   if(name==='galaxy_capsule_work_prepare'){prepared++;return{handle:originalHandle,action:'publish',payloadJson:JSON.stringify({...method,version:2})};}
   if(name==='galaxy_capsule_work_execute'){executed++;assert.equal(input.handle,originalHandle);throw Error('synthetic_connection_lost_after_write');}
   if(name==='galaxy_capsule_work_status'){reads.push(input.handle);return{state:'acknowledged',currentReadPermissionConfirmed:false};}
   assert.fail(name);
  },
 });
 const wait=async predicate=>{for(let i=0;i<100&&!predicate();i++)await delay(5);assert.ok(predicate(),page?.title);};
 const choose=title=>{const option=page.options.find(row=>row.title===title);assert.ok(option,title);page.routes[option.number]();};
 menu.open('synthetic-method','synthetic-v1');await wait(()=>page?.kind==='alert'&&page.message.includes('原文方法'));
 page.onConfirm();choose('修订这份方法');await wait(()=>page?.title==='整理这份方法');
 const originalSave=page.routes[page.options.find(row=>row.title==='保存方法').number];
 choose('保存方法');await wait(()=>page?.title==='结果尚未确认');
 assert.equal(page.options.some(row=>/保存|编辑/.test(row.title)),false);
 originalSave();await delay(10);assert.equal(prepared,1);assert.equal(executed,1);
 choose('重试读取结果');await wait(()=>page?.kind==='alert'&&page.message.includes('原操作已完成'));
 assert.deepEqual(reads,[originalHandle]);assert.equal(prepared,1);assert.equal(executed,1);
 assert.equal(page.message.includes(originalHandle),false);page.onConfirm();assert.equal(returned,1);menu.close();
});

test('continue after the real choice resumes the prepared original once and serializes repeated clicks',async()=>{
 let page,returned=0,executions=0,active=0,maxActive=0,finish;
 const handles=[],original='synthetic-existing-prepared';
 const menu=createNativeCapsuleMenu({isCurrent:()=>true,onBack(){},onReturnWork:()=>{returned++;},
  select:value=>{page={kind:'select',...value};},prompt(){assert.fail('no editing for this prepared original');},
  info:(title,message,onConfirm)=>{page={kind:'alert',title,message,onConfirm};},
  call:async(name,input)=>{
   if(name==='galaxy_capsule_v2_query')return{items:[]};
   if(name==='galaxy_capsule_work_pending')return{items:[{handle:original,action:'publish',state:'prepared',title:'原方法保存'}]};
   assert.equal(name,'galaxy_capsule_work_execute');handles.push(input.handle);executions++;active++;maxActive=Math.max(active,maxActive);
   try{
    if(executions===1)return{state:'user-choice-needs-browser',url:'http://127.0.0.1:12345/review/'+ 'a'.repeat(48),expiresAt:Date.now()+300000};
    return await new Promise(resolve=>{finish=()=>resolve({state:'acknowledged',receipt:{capsuleId:'synthetic-method',versionId:'synthetic-version-two'}});});
   }finally{active--;}
  },
 });
 const wait=async predicate=>{for(let i=0;i<100&&!predicate();i++)await delay(5);assert.ok(predicate(),page?.title);};
 const choose=title=>{const option=page.options.find(row=>row.title===title);assert.ok(option,title);page.routes[option.number]();};
 menu.home();await wait(()=>page?.kind==='select');choose('尚待接续');await wait(()=>page.options?.some(row=>row.title==='原方法保存'));
 choose('原方法保存');await wait(()=>page?.title==='等待你的选择');assert.equal(executions,1);
 const continueOriginal=page.onConfirm;continueOriginal();assert.equal(executions,2);continueOriginal();await wait(()=>finish!==undefined);
 assert.equal(executions,2);assert.equal(maxActive,1);assert.deepEqual(handles,[original,original]);
 finish();await wait(()=>page?.title.startsWith('方法已保存'));continueOriginal();await delay(10);assert.equal(executions,2);
 choose('回到原工作');assert.equal(returned,1);menu.close();
});

test('continue while the automatic original read is in flight cannot start another execution',async()=>{
 let page,executions=0,finish;
 const original='synthetic-polling-original',handles=[];
 const menu=createNativeCapsuleMenu({isCurrent:()=>true,onBack(){},onReturnWork(){},
  select:value=>{page={kind:'select',...value};},prompt(){assert.fail('original continuation has no editor');},
  info:(title,message,onConfirm)=>{page={kind:'alert',title,message,onConfirm};},
  call:async(name,input)=>{
   if(name==='galaxy_capsule_v2_query')return{items:[]};
   if(name==='galaxy_capsule_work_pending')return{items:[{handle:original,action:'publish',state:'prepared',title:'原方法保存'}]};
   assert.equal(name,'galaxy_capsule_work_execute');handles.push(input.handle);executions++;
   if(executions===1)return{state:'user-choice-needs-browser',url:'http://127.0.0.1:12345/review/'+ 'b'.repeat(48),expiresAt:Date.now()+300000};
   return new Promise(resolve=>{finish=()=>resolve({state:'acknowledged',receipt:{capsuleId:'synthetic-method',versionId:'synthetic-version-two'}});});
  },
 });
 const wait=async(predicate,attempts=100)=>{for(let i=0;i<attempts&&!predicate();i++)await delay(5);assert.ok(predicate(),page?.title);};
 const choose=title=>{const option=page.options.find(row=>row.title===title);assert.ok(option,title);page.routes[option.number]();};
 menu.home();await wait(()=>page?.kind==='select');choose('尚待接续');await wait(()=>page.options?.some(row=>row.title==='原方法保存'));
 choose('原方法保存');await wait(()=>page?.title==='等待你的选择');
 const continueOriginal=page.onConfirm;await wait(()=>finish!==undefined,500);assert.equal(executions,2);
 continueOriginal();continueOriginal();assert.equal(executions,2);assert.deepEqual(handles,[original,original]);
 finish();await wait(()=>page?.title.startsWith('方法已保存'));assert.equal(executions,2);menu.close();
});
