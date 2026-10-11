import React,{useEffect,useEffectEvent,useId,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,BookOpen,Search} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {createHistoryClient,prepareHistoryQuery} from './history-client.mjs';
import {HistoryFacts,historyRoleLabel} from './history-facts';
import {useCurrentTaskMaterialTree} from './task-material-view';
import {recordErrorField} from './record-workspace-types';
import type {HistoryClient,HistoryPage,HistoryQuery,HistoryRecord,RecordRuntime} from './record-workspace-types';
import './profile-settings.css';
type Props={runtime:RecordRuntime|null;connected:boolean;subjectId?:string;targetSubjectId?:string;navigate:(path:string)=>void};
type HistoryForm={query:string;timeWindow:string;from:string;before:string};
type SessionProps=Props&{form:HistoryForm;setForm:React.Dispatch<React.SetStateAction<HistoryForm>>};
const readable=(error:unknown)=>({history_identity_changed:'身份已变化，请重新打开这份资料。',history_sources_changed_retry:'资料已有变化，正在重新读取。',invalid_history_cursor:'这页资料已更新，请重试。'} as Record<string,string>)[recordErrorField(error,'code')||recordErrorField(error,'message')]??(recordErrorField(error,'name')==='ZodError'||error instanceof RangeError?'请检查关键词和日期范围。关键词以空格分隔，最多 8 组。':'资料暂时不可读取，请稍后重试。');
const date=(record:HistoryRecord)=>{const valid=record.activityTimes.map(time=>Date.parse(time)).filter(Number.isFinite);return valid.length?new Date(Math.max(...valid)).toLocaleDateString():null;};
export function HistoryWorkspace(props:Props){
 const [form,setForm]=useState<HistoryForm>({query:'',timeWindow:'all-visible',from:'',before:''});
 const binding=props.runtime?.api.snapshot(),target=props.targetSubjectId??props.subjectId??null;
 return <HistorySession key={JSON.stringify([props.runtime?.api.endpoint,props.connected,props.subjectId,target,binding?.bindingId,binding?.generation])} {...props} form={form} setForm={setForm}/>;
}
function HistorySession({runtime,connected,subjectId,targetSubjectId,navigate,form,setForm}:SessionProps){
 const target=targetSubjectId??subjectId??null;
 const client=useMemo<HistoryClient|null>(()=>runtime&&target?createHistoryClient(runtime,{authenticated:connected,subjectId:subjectId??null,targetSubjectId:target}):null,[runtime,connected,subjectId,target]);
 const [readPage,setPage]=useState<HistoryPage|null>(null),[request,setRequest]=useState<HistoryQuery|null>(null),[selected,setSelected]=useState<string|null>(null),[busy,setBusy]=useState(!!client),[error,setError]=useState('');
 const page=useCurrentTaskMaterialTree(runtime,readPage);
 const lifecycle=useRef({epoch:0,working:false}),listScroll=useRef(0),heading=useRef<HTMLHeadingElement>(null),savedQuery=useRef<HistoryQuery|null>(null);
 const searchId=useId(),fromId=useId(),beforeId=useId(),own=!!target&&target===subjectId;
 async function requestRead(after:string|null=null,input?:HistoryQuery){
  if(!client||lifecycle.current.working||!target)return;
  const control=lifecycle.current,token=++control.epoch;control.working=true;
  try{const query=after?{...(request??prepareHistoryQuery({subjectId:target,...form})),after}:input??prepareHistoryQuery({subjectId:target,...form});
   const value=await (after?client.more(query):client.query(query));if(token!==control.epoch)return;
   savedQuery.current={...query,after:null};setRequest(savedQuery.current);
   setPage(old=>after&&!value.restarted&&old?{...value,items:[...old.items,...value.items.filter(item=>!old.items.some(existing=>existing.key===item.key))]}:value);
   if(value.restarted||!after)setSelected(old=>value.items.some(item=>item.key===old)?old:null);
  }catch(error){if(token===control.epoch){setError(readable(error));setPage(null);setSelected(null);}}
  finally{if(token===control.epoch){control.working=false;setBusy(false);}}
 }
 function read(after:string|null=null,input?:HistoryQuery){if(!client||lifecycle.current.working)return Promise.resolve();setBusy(true);setError('');return requestRead(after,input);}
 const initialRead=useEffectEvent(()=>requestRead(null,{subjectId:target!,query:'',timeWindow:{kind:'all-visible'},after:null,limit:12}));
 useEffect(()=>{const control=lifecycle.current;if(client&&target)void initialRead();return()=>{control.epoch++;control.working=false;client?.close();};},[client,target]);
 const visibleRead=useEffectEvent(()=>read(null,savedQuery.current??undefined));
 useEffect(()=>{const resume=()=>{if(document.visibilityState==='visible'&&client)void visibleRead();};document.addEventListener('visibilitychange',resume);return()=>document.removeEventListener('visibilitychange',resume);},[client]);
 const record=page?.items.find(item=>item.key===selected);
 function openRecord(key:string){listScroll.current=window.scrollY;setSelected(key);window.scrollTo({top:0,behavior:'auto'});requestAnimationFrame(()=>heading.current?.focus());}
 function back(){setSelected(null);requestAnimationFrame(()=>window.scrollTo({top:listScroll.current,behavior:'auto'}));}
 if(!target)return <section className="history-empty"><BookOpen size={32}/><h2>经历与贡献</h2><p>从个人资料查看完整经历，或使用自己的身份查看本人记录。</p><Button onClick={()=>navigate('/app/settings/identity')}>查看我的经历</Button></section>;
 if(record)return <section aria-busy={busy}><header className="history-detail-header"><button className="history-back" type="button" onClick={back}><ArrowLeft size={17}/>返回经历</button><h2 ref={heading} tabIndex={-1}>{record.title??'工作经历'}</h2>{record.summary&&<p>{record.summary}</p>}</header><HistoryFacts key={record.key} runtime={runtime} record={record} navigate={navigate}/></section>;
 return <section aria-busy={busy} className="history-workspace"><header className="history-heading"><div><h2>{own?'我的经历':'工作经历'}</h2><p>做过的事、遇到的问题，以及实际结果。</p></div></header>
  <form className="history-search" onSubmit={event=>{event.preventDefault();void read();}}>
   <label className="history-search-field" htmlFor={searchId}><span className="sr-only">搜索经历</span><Search size={17}/><Input id={searchId} maxLength={200} placeholder="搜索经历中的内容" value={form.query} onChange={event=>setForm(old=>({...old,query:event.target.value}))}/></label>
   <label><span className="sr-only">经历时间范围</span><select value={form.timeWindow} onChange={event=>setForm(old=>({...old,timeWindow:event.target.value}))}><option value="all-visible">全部时间</option><option value="90-days">近 90 天</option><option value="365-days">近一年</option><option value="custom">选择日期</option></select></label><Button type="submit" variant="outline" disabled={busy||!client}>查找</Button>
   {form.timeWindow==='custom'&&<div className="history-custom-range"><label htmlFor={fromId}>从<Input id={fromId} type="datetime-local" required value={form.from} onChange={event=>setForm(old=>({...old,from:event.target.value}))}/></label><label htmlFor={beforeId}>到<Input id={beforeId} type="datetime-local" required value={form.before} onChange={event=>setForm(old=>({...old,before:event.target.value}))}/></label></div>}
  </form>
  {busy&&!page&&<p><output>正在读取经历…</output></p>}
  {error&&<div role="alert" className="message error">{error}<Button variant="ghost" onClick={()=>read()}>重试</Button></div>}
  {page&&!page.items.length&&<div className="history-empty"><BookOpen size={32}/><h3>暂时没有可查看的经历</h3><p>{form.query?'试试其他关键词，或查看全部时间。':'已有工作会在形成记录、且允许查看时出现在这里。'}</p>{own&&<Button variant="outline" onClick={()=>navigate('/app/participate')}>看看可以参与的事情</Button>}</div>}
  <ol className="history-list">{page?.items.map(item=><li key={item.key}><button type="button" className="history-open" onClick={()=>openRecord(item.key)}><BookOpen size={20}/><div><h3>{item.title??'工作经历'}</h3>{item.summary&&<p>{item.summary}</p>}<div className="history-meta">{date(item)&&<time>{date(item)}</time>}{!!item.subjectRoles.length&&<span>{item.subjectRoles.map(historyRoleLabel).join(' · ')}</span>}{item.synthetic&&<span>合成示例</span>}</div></div><ArrowRight size={17}/></button></li>)}</ol>
  {page?.nextCursor&&<Button className="history-more" type="button" variant="outline" disabled={busy} onClick={()=>read(page.nextCursor)}>{busy?'正在读取…':'查看更多经历'}</Button>}
 </section>;
}

