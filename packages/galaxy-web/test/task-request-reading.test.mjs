import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {assistanceRequestSchema} from '../../galaxy-official/src/shared/assistance-schema.mjs';
import {taskRequestV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import {TaskRequestReading,taskReadingSection,taskRequestIntro} from '../src/task-request-reading.tsx';

const legacy=()=>{
 const request=assistanceRequestSchema.parse({id:randomUUID(),caseId:randomUUID(),title:'原来的求助',
  problem:'原问题 <仍需阅读>',attemptedApproaches:['保留第一种尝试','保留第二种尝试'],scope:'只检查原先约定的范围',
  visibility:'Private',collaboration:'basic-bounty',budget:{mode:'fixed',amount:'20',unit:'测试单位'},enrollmentExpiresAt:2000000000});
 return{schemaVersion:1,taskId:request.id,caseId:request.caseId,requesterId:'original-author',state:'open',version:1,request,participations:[]};
};

test('an actual legacy request renders its problem, attempts and original help scope without rewriting source fields',()=>{
 const task=legacy(),original=structuredClone(task);
 const html=renderToStaticMarkup(React.createElement(React.Fragment,null,
  React.createElement('p',null,taskRequestIntro(task)),React.createElement(TaskRequestReading,{task})));
 for(const text of ['原问题 &lt;仍需阅读&gt;','保留第一种尝试','保留第二种尝试','只检查原先约定的范围'])assert.ok(html.includes(text));
 assert.ok(!html.includes('目前的情况'));assert.ok(!html.includes('[object Object]'));
 assert.deepEqual(task,original);
});

test('old task links display the readable original instead of empty newer collaboration or discussion panels',()=>{
 const task=legacy();
 for(const section of ['overview','collaboration','comments','apply'])assert.equal(taskReadingSection(task,section),'overview');
 assert.equal(taskReadingSection(null,'comments'),'comments');
 const empty={...task,request:{...task.request,attemptedApproaches:[]}};
 const html=renderToStaticMarkup(React.createElement(TaskRequestReading,{task:empty}));
 assert.ok(!html.includes('已经尝试过的方法'));assert.ok(html.includes(task.request.scope));
});

test('modern task reading retains its full goal, current situation and expected result',()=>{
 const request=taskRequestV2Schema.parse({operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',
  title:'当前求助标题',summary:'当前简要说明',workContext:{goal:'原工作目标',currentSituation:'当前实际情况',attemptRefs:[]},
  expectedOutcome:'希望得到的具体结果',visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:2000000000});
 const task={schemaVersion:2,taskId:request.taskId,caseId:null,requesterId:'original-author',state:'open',version:1,request,view:'public'};
 const html=renderToStaticMarkup(React.createElement(TaskRequestReading,{task}));
 for(const text of ['原工作目标','当前实际情况','希望得到的具体结果'])assert.ok(html.includes(text));
 assert.equal(taskRequestIntro(task),'当前简要说明');
 assert.equal(taskReadingSection(task,'collaboration'),'collaboration');
 assert.ok(!html.includes('历史版本求助'));
});

