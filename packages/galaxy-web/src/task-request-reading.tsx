import React,{useId} from 'react';
import type {TaskPageTask} from './task-page-view';
import type {WorkRuntime} from './work-task-types';
import {TaskRequestBackground} from './task-request-background';

export function taskRequestIntro(task:TaskPageTask):string{
 return task.schemaVersion===1?task.request.problem:task.request.summary;
}

export function taskReadingSection(task:TaskPageTask|null,requested:string):string{
 return task?.schemaVersion===1?'overview':requested;
}

function ReadingText({text}:{text:string}){return <div className="request-reading-prose">{text.split(/\n\s*\n/).filter(value=>value.trim()).map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div>;}

export function TaskRequestReading({task,includeIntro=true,runtime=null,connected=false,subjectId,navigate}:{task:TaskPageTask;includeIntro?:boolean;runtime?:WorkRuntime|null;connected?:boolean;subjectId?:string;navigate?:(path:string)=>void}){
 const sectionId=useId(),intro=taskRequestIntro(task);
 const sections=task.schemaVersion===1?[
  ...(task.request.attemptedApproaches.length?[{id:'attempts',title:'已经尝试过的方法',text:task.request.attemptedApproaches.join('\n\n')}]:[]),
  {id:'help',title:'希望获得的帮助',text:task.request.scope},
 ]:[
  ...(task.request.workContext.goal&&task.request.workContext.goal!==task.request.title&&task.request.workContext.goal!==intro?[{id:'goal',title:'想完成的事',text:task.request.workContext.goal}]:[]),
  ...(task.request.workContext.currentSituation&&task.request.workContext.currentSituation!=='未另行提供当前情况。'&&task.request.workContext.currentSituation!==intro?[{id:'background',title:'背景与已有进展',text:task.request.workContext.currentSituation}]:[]),
  ...(task.request.expectedOutcome?[{id:'outcome',title:'希望得到的结果',text:task.request.expectedOutcome}]:[]),
 ];
 const needsNavigation=sections.length>1&&intro.length+sections.reduce((size,item)=>size+item.text.length,0)>1800;
 return <article className="request-reading">
  {needsNavigation&&<nav className="request-reading-index" aria-label="求助内容定位">{includeIntro&&<a href={'#'+sectionId+'-intro'}>问题说明</a>}{sections.map(section=><a key={section.id} href={'#'+sectionId+'-'+section.id}>{section.title}</a>)}</nav>}
  {includeIntro&&<section id={sectionId+'-intro'} aria-label="问题说明"><ReadingText text={intro}/></section>}
  {sections.map(section=><section id={sectionId+'-'+section.id} key={section.id}><h2>{section.title}</h2><ReadingText text={section.text}/></section>)}
  {task.schemaVersion===2&&<TaskRequestBackground {...{task,runtime,connected,subjectId,navigate}}/>}
  {task.schemaVersion===1&&<p className="message">这是一份历史版本求助，保留当时的原始说明和条件。</p>}
 </article>;
}

