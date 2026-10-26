import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import React,{useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import type {z} from 'zod/v4';
import {Button} from '@/components/ui/button';
import {MemberAvatar,memberName,useMemberNames} from "../../shared/people/conversation-ui";
import {useChoiceViewLease,type ChoiceViewLease} from "../../shared/operations/choice-retained-operations";
import type {configurationEventV2Schema} from "../../../../galaxy-official/src/shared/configuration-v2-schema.mjs";
import type {CapsuleAuthorRuntime,CapsuleSourceItem} from "../capsules/capsule-authoring-types";
import "../capsules/capsule-authoring.css";

type Props={runtime:CapsuleAuthorRuntime;subjectId:string;busy:boolean;selected:CapsuleSourceItem[];onChange:(items:CapsuleSourceItem[])=>void;onlyOwn?:boolean;single?:boolean};
type ConfigurationRecord=Extract<z.infer<typeof configurationEventV2Schema>,{kind:'record'}>;
type ConfigurationView={id:string;version:number;subjectId:string;sourceStatus:string;record:ConfigurationRecord|null};
type ReadableConfiguration=ConfigurationView&{record:ConfigurationRecord};
const key=(item:CapsuleSourceItem)=>item.ref.kind+':'+item.ref.id+':'+item.ref.version;
const viewKey=(item:ConfigurationView)=>item.id+':'+item.version;
const dedupe=(items:ConfigurationView[])=>[...new Map(items.map(item=>[viewKey(item),item])).values()];
const readable=(item:ConfigurationView):item is ReadableConfiguration=>item.record!==null;
const selectionKey=(items:CapsuleSourceItem[])=>items.filter(item=>item.ref.kind==='configuration').map(key).sort().join('|');

export function ConfigurationPicker(props:Props){
 const view=useChoiceViewLease(props.runtime,props.subjectId);
 return view.lease?<ConfigurationChoiceList key={view.key} {...props} lease={view.lease}/>:null;
}
function ConfigurationChoiceList({runtime,subjectId,busy,selected,onChange,onlyOwn=false,single=false,lease}:Props&{lease:ChoiceViewLease}){
 const [open,setOpen]=useState(false),[items,setItems]=useState<ConfigurationView[]>([]),[next,setNext]=useState<string|null>(null),[versions,setVersions]=useState<ConfigurationView[]>([]),[versionNext,setVersionNext]=useState<number|null>(null),[objectId,setObjectId]=useState(''),[restored,setRestored]=useState<ConfigurationView[]>([]),[loaded,setLoaded]=useState(false),[readingQuery,setReadingQuery]=useState(false),[readingVersions,setReadingVersions]=useState(false),[error,setError]=useState('');
 const reading=readingQuery||readingVersions,epoch=useRef(0),queryTicket=useRef(0),versionTicket=useRef(0),selectedTicket=useRef(0),pages=useRef(1),latest=useRef({open,busy,selected,versions,next,reading}),checkboxPrefix=useId();
 useLayoutEffect(()=>{latest.current={open,busy,selected,versions,next,reading};},[open,busy,selected,versions,next,reading]);
 const selectedConfigurations=selected.filter(item=>item.ref.kind==='configuration'),selectedKey=selectionKey(selected);
 const current=useCallback((token:number)=>{if(token!==epoch.current)return false;try{lease.assertCurrent();return true;}catch{return false;}},[lease]);
 const call=useCallback(async<T,>(path:string,input:Record<string,unknown>):Promise<T>=>{
  const token=epoch.current;if(!current(token))throw Error('来源页面已关闭。');
  const value:T=await runtime.api.call('/v2/configurations/'+path,input);
  if(!current(token))throw Error('来源页面已关闭。');return value;
 },[runtime,current]);
 const readSelected=useCallback(async()=>{
  const token=epoch.current,ticket=++selectedTicket.current,refs=latest.current.selected.filter(item=>item.ref.kind==='configuration'),expected=selectionKey(refs);
  if(!current(token))return;
  const results=await Promise.allSettled(refs.map(item=>call<ConfigurationView>('read',{id:item.ref.id,version:item.ref.version})));
  if(!current(token)||ticket!==selectedTicket.current||selectionKey(latest.current.selected)!==expected)return;
  setRestored(results.flatMap(result=>result.status==='fulfilled'&&readable(result.value)?[result.value]:[]));
 },[call,current]);
 const load=useCallback(async(more=false)=>{
  const token=epoch.current,ticket=++queryTicket.current;if(!current(token))return;setReadingQuery(true);
  try{
   let after=more?latest.current.next:null,following:string|null=null;const values:ConfigurationView[]=[],seen=new Set<string>();
   if(more&&!after)return;
   for(let page=0;page<(more?1:pages.current);page++){
    const value=await call<{items:ConfigurationView[];nextAfter:string|null}>('query',{...(onlyOwn?{subjectId}:{}),limit:20,...(after?{after}:{})});if(!current(token)||ticket!==queryTicket.current)return;
    values.push(...value.items);following=value.nextAfter??null;if(!following)break;if(seen.has(following))throw Error('配置列表暂时无法继续读取。');seen.add(following);after=following;
   }
   const versionsAtStart=versionTicket.current,refreshedVersions=await Promise.allSettled(latest.current.versions.map(view=>call<ConfigurationView>('read',{id:view.id,version:view.version})));
   if(!current(token)||ticket!==queryTicket.current)return;
   if(versionsAtStart===versionTicket.current)setVersions(refreshedVersions.flatMap(value=>value.status==='fulfilled'&&readable(value.value)?[value.value]:[]));
   setItems(previous=>dedupe(more?[...previous,...values]:values));setNext(following);setLoaded(true);setError('');if(more)pages.current++;
   await readSelected();
  }catch{if(current(token)&&ticket===queryTicket.current){setItems([]);setNext(null);setVersions([]);setVersionNext(null);setRestored([]);setLoaded(false);setError('这些配置当前无法读取。选定版本仍保留，可以重新核对或明确移除。');}}
  finally{if(current(token)&&ticket===queryTicket.current)setReadingQuery(false);}
 },[call,current,onlyOwn,subjectId,readSelected]);
 const loadVersions=useCallback(async(id:string,afterVersion=0)=>{
  const token=epoch.current,ticket=++versionTicket.current;if(!current(token))return;setReadingVersions(true);
  try{const value=await call<{items:ConfigurationView[];nextAfterVersion:number|null}>('versions',{id,afterVersion,limit:20});if(!current(token)||ticket!==versionTicket.current)return;setObjectId(id);setVersions(previous=>dedupe(afterVersion?[...previous,...value.items]:value.items));setVersionNext(value.nextAfterVersion);setError('');}
  catch{if(current(token)&&ticket===versionTicket.current){setVersions([]);setVersionNext(null);setError('其他版本目前无法读取，原选择仍保留。');}}
  finally{if(current(token)&&ticket===versionTicket.current)setReadingVersions(false);}
 },[call,current]);
 useEffect(()=>{const viewEpoch=epoch;viewEpoch.current++;return()=>{viewEpoch.current++;};},[]);
 useEffect(()=>{const timer=window.setTimeout(()=>void readSelected(),0);return()=>window.clearTimeout(timer);},[selectedKey,readSelected]);
 useEffect(()=>{if(!open)return;const timer=window.setTimeout(()=>{if(!latest.current.reading)void load();},0);return()=>window.clearTimeout(timer);},[open,load]);
 useEffect(()=>{const refresh=()=>{if(document.hidden||latest.current.busy||latest.current.reading)return;if(latest.current.open)void load();else void readSelected();};const timer=window.setInterval(refresh,15000);document.addEventListener('visibilitychange',refresh);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[load,readSelected]);
 const available=dedupe([...items,...versions,...restored]).filter(readable).filter(item=>!onlyOwn||item.subjectId===subjectId),names=useMemberNames(runtime,subjectId,true,available.map(item=>item.subjectId));
 function choose(view:ReadableConfiguration,chosen:boolean){
  const item:CapsuleSourceItem={ref:{kind:'configuration',id:view.id,version:view.version},authorId:view.subjectId,label:view.record.title,view},rest=selected.filter(other=>key(other)!==key(item));
  onChange(chosen?[...(single?rest.filter(other=>other.ref.kind!=='configuration'):rest),item]:rest);
 }
 return <ReadingDetails mode="inline" className="configuration-source-picker" onOpenChange={isOpen=>setOpen(isOpen)}>
  <ReadingSummary>{single?'关联这次的运行配置（可选）':'关联用过的配置（可选）'}{selectedConfigurations.length?' · 已选 '+selectedConfigurations.length+' 项':''}</ReadingSummary>
  <p className="source-reading-note">{single?'选择当时已经登记的配置版本，帮助读者理解条件。没有配置记录也可以继续。':'这里只引用选定配置记录。关联本身不证明已经安装或实际执行。'}</p>
  {reading&&!loaded&&<p><output>正在读取配置内容…</output></p>}
  {error&&<p role="alert" className="message error">{error}<Button type="button" variant="ghost" disabled={busy||reading} onClick={()=>void load()}>重新读取</Button></p>}
  {loaded&&!available.length&&<p className="source-reading-note">当前没有可选配置，可以继续。</p>}
  <div className="configuration-picker-list">{available.map(view=>{const inputId=checkboxPrefix+'-'+viewKey(view);return <article className="configuration-choice" key={viewKey(view)}>
   <label htmlFor={inputId} aria-labelledby={inputId+'-title '+inputId+'-version'}><input id={inputId} type="checkbox" disabled={busy} checked={selectedConfigurations.some(item=>item.ref.id===view.id&&item.ref.version===view.version)} onChange={event=>choose(view,event.target.checked)}/><span><strong id={inputId+'-title'}>{view.record.title}</strong><small id={inputId+'-version'}>第 {view.version} 版 · {view.sourceStatus==='historical-version'?'当时的历史条件':'当前记录'}</small></span></label>
   <p className="reading-prose">{view.record.summary}</p><p className="method-source-person"><MemberAvatar subjectId={view.subjectId}/>{memberName(view.subjectId,subjectId,names[view.subjectId]??undefined)}</p>
   <Button type="button" variant="ghost" disabled={busy||reading} onClick={()=>void loadVersions(view.id)}>查看其他版本</Button>
  </article>;})}</div>
  {next&&<Button type="button" variant="ghost" disabled={busy||reading} onClick={()=>void load(true)}>更多配置</Button>}
  {versionNext&&<Button type="button" variant="ghost" disabled={busy||reading} onClick={()=>void loadVersions(objectId,versionNext)}>更早版本</Button>}
  {selectedConfigurations.filter(item=>!available.some(view=>view.id===item.ref.id&&view.version===item.ref.version)).map(item=><div className="configuration-choice" key={key(item)}><p>已选运行条件 · 第 {item.ref.version} 版</p><p className="source-reading-note">这一版本现在无法读取，准确引用仍保留。</p><Button type="button" variant="ghost" disabled={busy} onClick={()=>onChange(selected.filter(other=>key(other)!==key(item)))}>移除这一条引用</Button><ReadingDetails className="source-reference-details"><ReadingSummary>准确版本</ReadingSummary><code>{item.ref.id}</code></ReadingDetails></div>)}
 </ReadingDetails>;
}
