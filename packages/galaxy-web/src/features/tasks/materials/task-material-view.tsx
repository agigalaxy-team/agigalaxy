import React,{useEffect,useMemo,useSyncExternalStore} from "react";
import {definitiveReadFailure} from '../../../shared/reading/read-failure';
import {withholdTaskMaterialProjection,withholdTaskMaterialTree,taskMaterialProjectionNodes,taskMaterialProjectionId,taskMaterialProjectionKey} from "./task-material-client.mjs";
import type {WorkRuntime} from "../work-task-types";
import type {z} from "zod/v4";
import type {contributionProjectionReadSchema} from "../../../../../galaxy-contracts/src/contribution-sharing-v2-schema.mjs";
import {object} from "../../projects/contracts";

type Runtime={api:Pick<WorkRuntime['api'],'call'|'snapshot'>}&Partial<Pick<WorkRuntime,'taskDraftScope'>>;
type TaskProjection={taskId?:string;_webTaskScope?:string;_webTaskRead?:z.infer<typeof contributionProjectionReadSchema>;request?:{title?:unknown};textView?:{fields?:Record<string,{state?:string}>;title?:{state?:string}}};
const projection=(value:unknown):TaskProjection=>object(value)?value:{};
const seconds=()=>Math.floor(Date.now()/1000);
const pending=new WeakMap<Runtime,Map<string,Promise<unknown>>>();
function read(runtime:Runtime,node:TaskProjection,scope:string):Promise<unknown>{
 let requests=pending.get(runtime);if(!requests){requests=new Map();pending.set(runtime,requests);}
 const key=scope+':'+taskMaterialProjectionKey(node),existing=requests.get(key);if(existing)return existing;
 const request:Promise<unknown>=node._webTaskRead
  ?runtime.api.call('/v2/contributions/read',node._webTaskRead,{authenticated:!!runtime.api.snapshot()}).then((value:unknown)=>object(value)?value.projection:null)
  :runtime.api.call('/v2/tasks/'+encodeURIComponent(taskMaterialProjectionId(node)),null,{method:'GET',authenticated:!!runtime.api.snapshot()});
 requests.set(key,request);void request.finally(()=>{if(requests.get(key)===request)requests.delete(key);}).catch(()=>{});return request;
}
function currentStore<T>(runtime:Runtime|null|undefined,input:T,scope:string,tree:boolean){
 const nodes:TaskProjection[]=tree?taskMaterialProjectionNodes(input):projection(input).textView?.fields?[projection(input)]:[];
 const listeners=new Set<()=>void>();let active=false,epoch=0,checking=false;
 let current:Map<string,unknown>|null=null,all=!nodes.every(node=>node._webTaskScope===scope),gap=false;
 const sameScope=()=>!runtime?.taskDraftScope||scope===runtime.taskDraftScope().key;
 const render=():T|null=>{
  if(!sameScope()||nodes.some(node=>node._webTaskScope&&node._webTaskScope!==scope))return null;
  if(!nodes.length)return input;
  if(tree)return withholdTaskMaterialTree(input,seconds(),{all,current});
  const id=projection(input).taskId,latest=id?current?.get(id):null;
  return withholdTaskMaterialProjection(latest??input,seconds(),{all:all||!!current&&!latest});
 };
 let snapshot=render();
 const update=()=>{snapshot=render();for(const listener of listeners)listener();};
 const suspend=()=>{epoch++;checking=false;update();};
 const needsRefresh=()=>all||gap||nodes.some(node=>{const key=taskMaterialProjectionKey(node),selected=current?.has(key)?current.get(key):node;const view=projection(selected).textView as {materials?:Array<{status?:string;availableUntil?:number}>}|undefined;return view?.materials?.some(item=>item.status==='available'&&Number.isSafeInteger(item.availableUntil)&&item.availableUntil!<=seconds())??false;});
 const refresh=async()=>{
  if(!active||!runtime||!sameScope()||checking||document.hidden||navigator.onLine===false)return;
  const token=++epoch;checking=true;let transient=false;
  const targets=new Map<string,TaskProjection>();for(const node of nodes){const key=taskMaterialProjectionKey(node);if(typeof key==='string')targets.set(key,node);}
  const entries=await Promise.all([...targets].map(async ([key,target])=>{
   try{const value=await read(runtime,target,scope),node=projection(value);return [key,node._webTaskScope===scope&&(target._webTaskRead?!!node.textView:node.taskId===taskMaterialProjectionId(target))?value:null] as const;}
   catch(reason){if(!definitiveReadFailure(reason))transient=true;return [key,definitiveReadFailure(reason)?null:current?.has(key)?current.get(key):all?null:target] as const;}
  }));
  if(!active||token!==epoch||!sameScope())return;
  checking=false;all=false;gap=transient;current=new Map(entries);update();
 };
 return{
  read:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  open(){
   active=true;if(!nodes.length)return()=>{active=false;};
   const visible=()=>{if(document.hidden)suspend();else if(needsRefresh())void refresh();};
   const offline=()=>{gap=true;suspend();},online=()=>{if(needsRefresh())void refresh();};
   if(document.hidden||navigator.onLine===false){if(navigator.onLine===false)gap=true;suspend();}else if(needsRefresh())void refresh();
   const tick=setInterval(update,1000),timer=setInterval(()=>{if(needsRefresh())void refresh();},15000);
   document.addEventListener('visibilitychange',visible);window.addEventListener('online',online);window.addEventListener('offline',offline);
   return()=>{active=false;epoch++;clearInterval(tick);clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',online);window.removeEventListener('offline',offline);};
  },
 };
}
function useCurrent<T>(runtime:Runtime|null|undefined,value:T,tree:boolean):T|null{
 const scope=runtime?.taskDraftScope?.().key??'';
 const store=useMemo(()=>currentStore(runtime,value,scope,tree),[runtime,value,scope,tree]);
 const current=useSyncExternalStore(store.subscribe,store.read,store.read);useEffect(()=>store.open(),[store]);return current;
}
export function useCurrentTaskProjection<T>(runtime:Runtime|null|undefined,task:T):T|null{return useCurrent(runtime,task,false);}
export function useCurrentTaskMaterialTree<T>(runtime:Runtime|null|undefined,value:T):T|null{return useCurrent(runtime,value,true);}
export function taskViewTitle(value:unknown,fallback='任务'){
 const task=projection(value);return task.textView?.fields?.title?.state==='unavailable'?'来源标题当前不可用':typeof task.request?.title==='string'&&task.request.title?task.request.title:fallback;
}
export function TaskMaterialNotice({task}:{task:unknown}){
 const view=projection(task).textView;if(!view?.fields)return null;
 const unavailable=Object.values(view.fields).some(field=>field.state!=='available');
 return <p className="muted task-material-notice">{unavailable?'部分来源材料当前不可用，已停止展示；独立说明仍保留。':'所选来源材料按当前权限展示，撤回或到期后相应文字会停止展示。'}</p>;
}
export function TaskCurrentCard<T>({runtime,task,children}:{runtime:Runtime|null|undefined;task:T;children:(value:T)=>React.ReactNode}){
 const current=useCurrentTaskProjection(runtime,task);return <>{current?children(current):<output className="message">正在核对当前身份可读的任务。</output>}</>;
}
export function TaskCurrentTitle({runtime,task,fallback='任务'}:{runtime:Runtime|null|undefined;task:unknown;fallback?:string}){
 const current=useCurrentTaskProjection(runtime,task);return <>{current?taskViewTitle(current,fallback):'正在核对当前任务'}</>;
}
export function TaskCurrentSourceItem<T>({runtime,item,children}:{runtime:Runtime|null|undefined;item:T;children:(value:T)=>React.ReactNode}){
 const current=useCurrentTaskMaterialTree(runtime,item);return <>{current?children(current):<output>正在核对当前身份可读的来源。</output>}</>;
}
export function TaskDerivedTitle({runtime,source,taskId,fallback='关联任务'}:{runtime:Runtime|null|undefined;source:unknown;taskId?:string;fallback?:string}){
 const input=useMemo(()=>{if(!object(source)||!taskId)return source;const value={...source,taskId};if(source._webTaskScope)Object.defineProperty(value,'_webTaskScope',{value:source._webTaskScope});return value;},[source,taskId]);
 const current=useCurrentTaskMaterialTree(runtime,input);return <>{object(current)&&typeof current.title==='string'&&current.title?current.title:fallback}</>;
}
