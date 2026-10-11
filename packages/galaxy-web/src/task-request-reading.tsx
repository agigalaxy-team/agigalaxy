import React from 'react';
import type {TaskPageTask} from './task-page-view';

export function taskRequestIntro(task:TaskPageTask):string{
 return task.schemaVersion===1?task.request.problem:task.request.summary;
}

export function taskReadingSection(task:TaskPageTask|null,requested:string):string{
 return task?.schemaVersion===1?'overview':requested;
}

export function TaskRequestReading({task}:{task:TaskPageTask}){
 if(task.schemaVersion===1)return <>
  {task.request.attemptedApproaches.length>0&&<section><h2>已经尝试过的方法</h2><ul>{task.request.attemptedApproaches.map((approach,index)=><li key={index}>{approach}</li>)}</ul></section>}
  <section><h2>希望获得的帮助</h2><p>{task.request.scope}</p></section>
  <p className="message">这是一份历史版本求助，保留当时的原始说明和条件。</p>
 </>;
 const request=task.request;
 return <>
  {request.workContext.goal&&request.workContext.goal!==request.title&&<section><h2>想完成的事</h2><p>{request.workContext.goal}</p></section>}
  {request.workContext.currentSituation&&request.workContext.currentSituation!=='未另行提供当前情况。'&&<section><h2>目前的情况</h2><p>{request.workContext.currentSituation}</p></section>}
  {request.expectedOutcome&&<section><h2>希望得到的结果</h2><p>{request.expectedOutcome}</p></section>}
 </>;
}

