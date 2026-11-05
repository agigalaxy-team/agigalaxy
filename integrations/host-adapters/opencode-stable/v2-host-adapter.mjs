import {runWithOwner} from 'solid-js';
import {createV2SessionAdapter} from './v2-session-adapter.mjs';
import {reviewNotificationContract} from './review-notification.mjs';

// Translate the public V2 context to the narrow interface used by the existing
// Galaxy menu. Dialogs remain owned and rendered by OpenCode.
export function createV2Host(context, diagnostics = undefined) {
 const abort=new AbortController(), slots=new Map();
 let dialogCleanup, dialogGeneration=0;
 const disposeDialog=()=>{const fn=dialogCleanup;dialogCleanup=undefined;fn?.();};
 const keymap={registerLayer(layer){
  const name=layer.mode==='modal'?'modal':'global';let slot=slots.get(name);
  if(!slot){
   const [state,update]=context.storage.memory(`galaxy-keymap-${name}`,{initial:{active:false,commands:[],bindings:[]}});
   update(draft=>{draft.active=false;draft.commands=[];draft.bindings=[];});
   // No detached Solid owner: the host then attaches its own provider owner.
   runWithOwner(null,()=>context.keymap.layer(()=>{
    const active=state.active&&(name!=='modal'||context.keymap.mode.current()==='modal');
    return {mode:'global',commands:active?state.commands:[],bindings:active?state.bindings:[]};
   }));
   slot={state,update,generation:0};slots.set(name,slot);
  }
  const binds=new Map((layer.bindings??[]).map(x=>[x.cmd,x.key]));
  const commands=layer.commands.map(command=>({id:command.name,title:command.title,description:command.desc,group:command.category,
   ...(command.namespace==='palette'?{palette:true}:{}),...(command.slashName?{slash:{name:command.slashName,aliases:command.slashAliases}}:{}),
   ...(binds.has(command.name)?{bind:binds.get(command.name)}:{}),run:()=>{if(slot.state.active&&(name!=='modal'||context.keymap.mode.current()==='modal'))command.run();}}));
  const generation=++slot.generation;
  slot.update(draft=>{draft.commands=commands;draft.bindings=[...binds.keys()];draft.active=true;});
  return ()=>{if(slot.generation!==generation)return;slot.generation++;slot.update(draft=>{draft.active=false;draft.commands=[];draft.bindings=[];});};
 }};
 const ui={toast(input){context.ui.toast.show(input);},dialog:{setSize(size){context.ui.dialog.set({size});},clear(){++dialogGeneration;context.ui.dialog.clear();disposeDialog();},replace(factory,cleanup){
  const generation=++dialogGeneration;disposeDialog();dialogCleanup=cleanup;const item=factory();let pending;
  if(item.kind==='alert')pending=context.ui.dialog.confirm({title:item.input.title,message:item.input.message}).then(confirmed=>{if(generation===dialogGeneration&&confirmed===true)item.input.onConfirm();});
  else if(item.kind==='prompt')pending=context.ui.dialog.prompt({title:item.input.title,placeholder:item.input.placeholder,value:item.input.value}).then(value=>{if(generation!==dialogGeneration)return;if(value===undefined)item.input.onCancel();else item.input.onConfirm(value);});
  else pending=context.ui.dialog.select({title:item.input.title,options:item.input.options.map(({title,description,value,disabled})=>({title,description,value,disabled}))}).then(value=>{if(generation!==dialogGeneration)return;if(value!==undefined)item.input.options.find(x=>x.value===value&&!x.disabled)?.onSelect();});
  void pending.finally(()=>{if(generation===dialogGeneration)disposeDialog();}).catch(()=>{});
 }},DialogAlert:input=>({kind:'alert',input}),DialogPrompt:input=>({kind:'prompt',input}),DialogSelect:input=>({kind:'select',input})};
 const {route,state,event,client,v2,closeData}=createV2SessionAdapter(context);
 v2.reviewReady=input=>context.client.rpc(reviewNotificationContract).ready(input,{location:context.location?{directory:context.location.directory}:undefined});
 const lifecycle={signal:abort.signal,onDispose(fn){abort.signal.addEventListener('abort',fn,{once:true});return()=>abort.signal.removeEventListener('abort',fn);}};
 return {api:{app:context.app,renderer:context.renderer,route,state,event,keymap,ui,lifecycle,client,
  v2:{...v2,diagnostics}},
  close(){abort.abort();++dialogGeneration;if(dialogCleanup)context.ui.dialog.clear();disposeDialog();closeData();for(const slot of slots.values())slot.update(draft=>{draft.active=false;draft.commands=[];draft.bindings=[];});slots.clear();}};
}
