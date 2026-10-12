import React,{useEffect,useEffectEvent,useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {useGovernanceDraft} from './governance-presentation';
import {discoveryPreferencesSchema} from '../../galaxy-official/src/shared/discovery-schema.mjs';
import {saveProjectContactPreferences,sameProjectContactPreferences} from './project-contact-preferences-client.mjs';
import {object,projectErrorText} from './project-workspace-types';
import type {DiscoveryPreferences,DiscoveryPurpose,PreferencesView,ProjectPreferencesView,ProjectRuntime,ProjectView} from './project-workspace-types';
import './project-contact-preferences.css';

const purposes:readonly [DiscoveryPurpose,string,string][]=[
 ['conversation','交流想法','围绕作品内容、创作过程或问题聊一聊'],
 ['reuse','了解可复用内容','讨论已有内容或方法的使用'],
 ['collaboration','一起参与','讨论共同创作或协作'],
 ['recruitment','了解持续角色需求','讨论已有招募或长期参与的角色'],
];
type Draft={mode:'inherit'|'custom'|'off';purposes:DiscoveryPurpose[];functions:string[];keepTemporary:boolean;expectedRevision:number};
type Attempt={preferences:DiscoveryPreferences|null;expectedRevision:number};
type Props={runtime:ProjectRuntime;subjectId:string;project:ProjectView;global:PreferencesView;saved:ProjectPreferencesView;onSaved:(value:ProjectPreferencesView)=>void;onBack:()=>void};
function initialDraft(saved:ProjectPreferencesView,global:PreferencesView,project:ProjectView):Draft {
 const prefs=saved.preferences??global.preferences;
 return {mode:saved.preferences===null?'inherit':prefs.enabled?'custom':'off',purposes:[...prefs.purposes],functions:prefs.functions.length?[...prefs.functions]:[...(project.document?.functions??[])],keepTemporary:true,expectedRevision:saved.revision};
}
function isDraft(value:unknown):value is Draft {
 if(!object(value)||!['inherit','custom','off'].includes(String(value.mode))||typeof value.keepTemporary!=='boolean'||!Number.isInteger(value.expectedRevision)||Number(value.expectedRevision)<0)return false;
 return Array.isArray(value.functions)&&value.functions.every(item=>typeof item==='string')&&Array.isArray(value.purposes)&&value.purposes.every(item=>purposes.some(([id])=>id===item));
}
function preferencesDescription(value:DiscoveryPreferences|null){
 if(value===null)return '沿用你的长期联系设置';
 if(!value.enabled)return '这份作品暂不接收新联系';
 return purposes.filter(([id])=>value.purposes.includes(id)).map(([,label])=>label).join('、')+'；'+(value.functions.length?'话题：'+value.functions.join('、'):'采用作品里介绍的方向');
}
export function ProjectContactPreferences({runtime,subjectId,project,global,saved,onSaved,onBack}:Props){
 const initial=useMemo(()=>initialDraft(saved,global,project),[saved,global,project]);
 const draft=useGovernanceDraft<Draft,Attempt>(runtime,subjectId,true,'project-contact-preferences:v1:'+JSON.stringify([runtime.api.endpoint,project.projectId]),initial);
 const lease=useMemo(()=>runtime.receiptStatus.captureLease(),[runtime]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[current,setCurrent]=useState<ProjectPreferencesView|null>(null),[now]=useState(()=>Date.now());
 const control=useRef({alive:true,working:false});
 useEffect(()=>{const state=control.current;state.alive=true;return()=>{state.alive=false;};},[]);
 const value=isDraft(draft.value)?draft.value:null,base=saved.preferences??global.preferences;
 const directions=[...new Set([...(project.document?.functions??[]),...(value?.functions??[])])];
 const temporary=saved.preferences?.temporary;
 const activeTemporary=temporary&&temporary.until*1000>now?temporary:null;
 async function readCurrent():Promise<ProjectPreferencesView>{
  lease.assertCurrent();
  const readable:ProjectView=await runtime.api.call('/v2/projects/'+project.projectId,undefined,{method:'GET',authenticated:true});lease.assertCurrent();
  if(!readable.document||!readable.permissions.manage)throw Error('当前身份已不能更改这份作品的联系设置。原选择仍保存在本机。');
  const result:ProjectPreferencesView=await runtime.api.call('/v2/projects/'+project.projectId+'/preferences/read',{}, {authenticated:true});lease.assertCurrent();return result;
 }
 async function settle(result:ProjectPreferencesView){
  await draft.settle(async locator=>sameProjectContactPreferences(locator.preferences,result.preferences)&&result.revision>=locator.expectedRevision?{state:'acknowledged'}:{state:'unknown'});
  if(control.current.alive){setError('');onSaved(result);}
 }
 const recover=useEffectEvent(async()=>{
  if(!draft.attempt||control.current.working)return;
  control.current.working=true;
  try{const result=await readCurrent();if(sameProjectContactPreferences(result.preferences,draft.attempt.preferences)&&result.revision>=draft.attempt.expectedRevision)await settle(result);}
  catch{if(control.current.alive)setError('上次保存结果暂未核对完成，原选择仍保留。可以重新保存，系统会先检查当前设置。');}
  finally{control.current.working=false;}
 });
 useEffect(()=>{if(draft.ready&&draft.attempt)void recover();},[draft.ready,draft.attempt]);
 async function save(){
  if(!value||control.current.working)return;
  control.current.working=true;setBusy(true);setError('');
  try{
   const snapshot=await draft.snapshot();if(!isDraft(snapshot.value))throw Error('这份本机选择暂时无法读取，请保留原内容。');
   const input=snapshot.value;
   if(input.mode==='custom'&&(!input.purposes.length||!input.functions.length))throw Error('请选择至少一个交流目的和一个话题。');
   const preferences=input.mode==='inherit'?null:discoveryPreferencesSchema.parse({...base,enabled:input.mode==='custom',purposes:input.purposes.length?input.purposes:base.purposes,functions:input.functions,temporary:input.keepTemporary?saved.preferences?.temporary??null:null});
   await draft.attach({preferences,expectedRevision:input.expectedRevision},snapshot.revision);
   const result=await saveProjectContactPreferences({readCurrent,write:async(request:{expectedRevision:number;preferences:DiscoveryPreferences|null})=>{lease.assertCurrent();const next:ProjectPreferencesView=await runtime.api.call('/v2/projects/'+project.projectId+'/preferences/save',request,{authenticated:true});lease.assertCurrent();return next;},expectedRevision:input.expectedRevision,preferences});
   await settle(result);
  }catch(reason){if(control.current.alive){if(object(reason)&&object(reason.currentPreferences))setCurrent(reason.currentPreferences as ProjectPreferencesView);setError(projectErrorText(reason).match(/[\u3400-\u9fff]/)?projectErrorText(reason):'联系设置暂未保存成功，你的选择仍保留。请重新保存。');}}
  finally{control.current.working=false;if(control.current.alive)setBusy(false);}
 }
 return <section className="project-contact-preferences project-editor"><header><p className="eyebrow">这份作品的联系范围</p><h2>{project.document?.title}</h2><p>选择愿意聊的内容。作品介绍照常按原来的阅读范围展示。</p></header>
  {!draft.ready&&<output>正在读取保存的选择…</output>}
  {draft.ready&&!value&&<p role="alert">本机保存的选择暂时无法读取，请保留原内容后重新打开。</p>}
  {value&&<form onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy||!draft.ready} className="project-contact-modes"><legend>怎样接收这份作品的联系</legend>{([['inherit','沿用我的长期设置'],['custom','为这份作品选择交流范围'],['off','暂不接收这份作品的新联系']] as const).map(([id,label])=><label className="check-label" key={id}><input type="radio" name="project-contact-mode" checked={value.mode===id} onChange={()=>draft.change({mode:id})}/>{label}</label>)}</fieldset>
   {value.mode==='inherit'&&<p className="project-contact-current">{preferencesDescription(global.preferences)}</p>}
   {value.mode==='custom'&&<div className="project-contact-choices"><fieldset disabled={busy||!draft.ready}><legend>愿意怎样交流</legend>{purposes.map(([id,label,meaning])=><label className="project-contact-choice" key={id}><input type="checkbox" checked={value.purposes.includes(id)} onChange={event=>draft.change({purposes:event.target.checked?[...value.purposes,id]:value.purposes.filter(item=>item!==id)})}/><span>{label}<small>{meaning}</small></span></label>)}</fieldset><fieldset disabled={busy||!draft.ready}><legend>愿意聊哪些话题</legend>{directions.map(topic=><label className="check-label" key={topic}><input type="checkbox" checked={value.functions.includes(topic)} onChange={event=>draft.change({functions:event.target.checked?[...value.functions,topic]:value.functions.filter(item=>item!==topic)})}/>{topic}</label>)}<p className="record-meta">话题来自这份作品的介绍；读者会在联系前看到所选范围。</p></fieldset></div>}
   {!global.preferences.enabled&&value.mode!=='off'&&<p className="project-contact-current">你的长期联系设置目前关闭。这里可以先保存作品范围，当前仍不会开放新联系。</p>}
   {activeTemporary&&value.mode!=='inherit'&&<label className="project-contact-temporary"><input type="checkbox" checked={value.keepTemporary} disabled={busy||!draft.ready} onChange={event=>draft.change({keepTemporary:event.target.checked})}/><span>保留这份作品现有的临时设置，至 {new Date(activeTemporary.until*1000).toLocaleString('zh-CN')}<small>{activeTemporary.contact==='paused'?'在这段时间暂停新联系。':'这段时间使用临时交流范围。'}{activeTemporary.purposes?' 目的：'+purposes.filter(([id])=>activeTemporary.purposes!.includes(id)).map(([,label])=>label).join('、')+'。':''}{activeTemporary.functions?.length?' 话题：'+activeTemporary.functions.join('、')+'。':''}</small></span></label>}
   {current&&<div className="project-contact-conflict" role="alert"><p>现在保存的设置：{preferencesDescription(current.preferences)}</p><div className="button-row"><Button type="button" variant="outline" disabled={busy} onClick={()=>{draft.change(initialDraft(current,global,project));setCurrent(null);setError('');}}>采用现在的设置</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>{draft.change({expectedRevision:current.revision});setCurrent(null);setError('');}}>继续编辑我的选择</Button></div></div>}
   {error&&<p className="message error" role="alert">{error}</p>}{draft.status&&<p className="record-meta"><output>{draft.status}</output></p>}
   <div className="button-row"><Button type="submit" disabled={busy||!draft.ready||!!current||value.mode==='custom'&&(!value.purposes.length||!value.functions.length)}>{busy?'正在保存…':'保存联系范围'}</Button><button type="button" className="text-link" disabled={busy} onClick={onBack}>返回作品介绍</button></div>
  </form>}
 </section>;
}
