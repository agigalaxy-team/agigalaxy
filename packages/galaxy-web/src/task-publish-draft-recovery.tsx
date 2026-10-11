import React from 'react';
import {localTaskTextView} from './task-material-client.mjs';
import type {PublishDraft} from './task-entry-types';
import type {TaskMaterialStates,TaskText,TaskTextField} from './task-material-types';
import './task-publish-draft-recovery.css';

const writingFields:[TaskTextField,string][]=[['title','想做什么？'],['summary','需要怎样的帮助？'],['goal','具体目标'],['situation','背景资料'],['expectedOutcome','期待的结果']];
const equal=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const date=(value:string|number)=>{const time=new Date(value);return Number.isFinite(time.getTime())?time.toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}):'尚未设置';};
function textParts(draft:PublishDraft|null,field:TaskTextField){
 const value=draft?.[field],ids=typeof value==='object'?value.segments.flatMap(segment=>segment.kind==='material'?[segment.materialId]:[]):[];
 return {value,bodies:draft?.materialBodies.filter(body=>ids.includes(body.materialId))??[],sources:draft?.materials.filter(material=>ids.includes(material.materialId))??[]};
}
function DraftText({value,draft,states,clock,label}:{value:TaskText|undefined;draft:PublishDraft|null;states:TaskMaterialStates;clock:number;label:string}){
 const view=localTaskTextView(value,draft?.materialBodies??[],states,clock);
 return <>{view.text.length>500?<textarea className="request-draft-text request-draft-text-full" readOnly rows={10} aria-label={label+'（完整文字，只读）'} value={view.text}/>:<p className="request-draft-text">{view.text||'未填写独立文字'}</p>}{view.state!=='available'&&<p className="request-draft-source-note">来源材料当前不可读或仍待核对，相关原文已隐藏。</p>}</>;
}
function DraftSources({draft}:{draft:PublishDraft|null}){
 if(!draft?.materials.length)return <p>未带入帖子材料。</p>;
 return <ul>{draft.materials.map(material=><li key={material.materialId}><span>{material.source.field==='title'?'帖子标题':'帖子正文'} · 使用至{date(material.expiresAt*1000)}</span><a href={`/app/community/posts/${material.source.postId}/versions/${material.source.versionId}`} target="_blank" rel="noopener noreferrer">查看准确来源</a></li>)}</ul>;
}
function DraftHelp({draft}:{draft:PublishDraft|null}){
 const choice=draft?.helpPreparation,input=choice&&typeof choice==='object'&&'input' in choice?choice.input:null;
 const selected=choice&&typeof choice==='object'&&'selected' in choice&&Array.isArray(choice.selected)?choice.selected:[];
 const keyword=typeof draft?.searchKeyword==='string'?draft.searchKeyword:input&&typeof input==='object'&&'keyword' in input&&typeof input.keyword==='string'?input.keyword:'';
 return <><p>{keyword?'查找：'+keyword:'未填写独立检索词'}</p>{draft?.searchFunctions&&<p>交流方向：{draft.searchFunctions}</p>}<p>{selected.length?`已记下 ${selected.length} 位可以进一步了解的人。`:'未记下联系人。'}</p></>;
}
type Props={current:PublishDraft;other:PublishDraft|null;currentStates:TaskMaterialStates;otherStates:TaskMaterialStates;clock:number;currentLabel?:string;otherLabel?:string;showAll?:boolean};
/** Only display controlled text through current material checks, including saved recovery copies. */
export function TaskPublishDraftComparison({current,other,currentStates,otherStates,clock,currentLabel='本页输入',otherLabel='已保存的输入',showAll=false}:Props){
 const hasText=(value:TaskText|undefined)=>typeof value==='string'?!!value.trim():!!value?.segments.length;
 const texts=writingFields.filter(([field])=>showAll?(hasText(current[field])||hasText(other?.[field])):!equal(textParts(current,field),textParts(other,field)));
 const sharing=showAll||!equal([current.visibility,current.enrollmentLocal],[other?.visibility,other?.enrollmentLocal]);
 const origin=showAll?!!(current.helpOrigin||other?.helpOrigin):!equal(current.helpOrigin??null,other?.helpOrigin??null);
 const related=showAll?!!(current.helpPreparation||other?.helpPreparation||current.searchKeyword||other?.searchKeyword||current.searchFunctions||other?.searchFunctions):!equal([current.helpPreparation,current.searchKeyword,current.searchFunctions],[other?.helpPreparation,other?.searchKeyword,other?.searchFunctions]);
 const materials=showAll?!!(current.materials.length||other?.materials.length):!equal(current.materials,other?.materials??[]);
 const restores=writingFields.filter(([field])=>!equal(current.materialRestore[field],other?.materialRestore[field]));
 function row(title:string,left:React.ReactNode,right:React.ReactNode){return <section key={title}><h3>{title}</h3><div><div><h4>{currentLabel}</h4>{left}</div><div><h4>{otherLabel}</h4>{right}</div></div></section>;}
 function originView(draft:PublishDraft|null){return draft?.helpOrigin?<p>关联了原工作{draft.helpOrigin.attemptRefs.length?`及其中 ${draft.helpOrigin.attemptRefs.length} 条已有尝试`:'。'} <a href={`/app/tasks/${draft.helpOrigin.taskId}`} target="_blank" rel="noopener noreferrer">查看原工作</a></p>:<p>未关联其他工作。</p>;}
 function scopeView(draft:PublishDraft|null){return <><p>{draft?draft.visibility==='Public'?'公开求助':draft.visibility==='Private'?'仅自己':'其他分享范围':'未选择分享范围'}</p><p>接受新回应至：{draft?date(draft.enrollmentLocal):'尚未设置'}</p></>;}
 return <div className="request-draft-comparison">
  {other===null&&<p>已保存的草稿已被清空，本页输入仍保留。</p>}
  {texts.map(([field,label])=>row(label,<DraftText value={current[field]} draft={current} states={currentStates} clock={clock} label={currentLabel+' · '+label}/>,<DraftText value={other?.[field]} draft={other} states={otherStates} clock={clock} label={otherLabel+' · '+label}/>))}
  {sharing&&row('分享范围与回应时间',scopeView(current),scopeView(other))}
  {origin&&row('关联的原工作',originView(current),originView(other))}
  {related&&row('已查找的帮助与选择',<DraftHelp draft={current}/>,<DraftHelp draft={other}/>)}
  {materials&&row('带入的来源材料',<DraftSources draft={current}/>,<DraftSources draft={other}/>)}
  {restores.map(([field,label])=>row('替换前保留的'+label,<DraftText value={current.materialRestore[field]} draft={current} states={currentStates} clock={clock} label={currentLabel+' · 替换前的'+label}/>,<DraftText value={other?.materialRestore[field]} draft={other} states={otherStates} clock={clock} label={otherLabel+' · 替换前的'+label}/>))}
  {!texts.length&&!sharing&&!origin&&!related&&!materials&&!restores.length&&<p>两份可见的写作内容相同，其他草稿信息已有变化。选择要继续使用的内容后，另一份仍会保留。</p>}
 </div>;
}
