/** One in-memory copy operation survives replacement of static guide content
 * by the workspace. Both renderers import this source; neither owns a cache. */
const sharedKey=Symbol.for('galaxy.copy-interaction');
const documents=globalThis[sharedKey]??=new WeakMap();

/** @typedef {'idle'|'copying'|'copied'|'selected'|'manual'} CopyStatus */
export const copyStatusText={idle:'',copying:'正在复制…',copied:'已复制',selected:'已选中，请复制',manual:'请选中文字复制'};

function backgroundFocus(document){
 return !document.activeElement||document.activeElement===document.body||document.activeElement===document.documentElement;
}
function selectionPosition(document){
 const selection=document.defaultView?.getSelection();
 return selection?[selection.anchorNode,selection.anchorOffset,selection.focusNode,selection.focusOffset]:[];
}
function samePosition(a,b){return a.length===b.length&&a.every((value,index)=>value===b[index]);}
function coordinator(document){
 let shared=documents.get(document);if(shared)return shared;
 const window=document.defaultView;
 shared={targets:new Map(),active:null,watching:false};
 const move=()=>{
  const active=shared.active;if(!active)return;active.moved=true;
  if(active.handoff&&!active.target.trigger.isConnected){shared.active=null;shared.stop();}
 };
 const focus=event=>{const active=shared.active;if(active&&event.target!==active.target.trigger&&!backgroundFocus(document))move();};
 const pointer=event=>{if(shared.active&&!shared.active.target.trigger.contains(event.target))move();};
 const keyboard=event=>{if(shared.active?.target.trigger===event.target&&['Enter',' '].includes(event.key))return;move();};
 const selected=()=>{
  const active=shared.active;if(!active||!active.target.trigger.isConnected||!active.target.content.isConnected)return;
  const position=selectionPosition(document);
  if(!samePosition(position,active.selection))move();
 };
 const reset=()=>{
  shared.active=null;shared.stop();
  for(const target of shared.targets.values())target.onStatus('idle');
 };
 shared.start=()=>{
  if(shared.watching)return;shared.watching=true;
  document.addEventListener('focusin',focus,true);
  document.addEventListener('pointerdown',pointer,true);
  document.addEventListener('keydown',keyboard,true);
  document.addEventListener('selectionchange',selected);
  window?.addEventListener('pagehide',reset);
  window?.addEventListener('popstate',reset);
 };
 shared.stop=()=>{
  if(!shared.watching)return;shared.watching=false;
  document.removeEventListener('focusin',focus,true);
  document.removeEventListener('pointerdown',pointer,true);
  document.removeEventListener('keydown',keyboard,true);
  document.removeEventListener('selectionchange',selected);
  window?.removeEventListener('pagehide',reset);
  window?.removeEventListener('popstate',reset);
 };
 documents.set(document,shared);return shared;
}
function current(shared,operation){
 return shared.active===operation&&operation.target.trigger.ownerDocument.defaultView?.location.pathname===operation.scope;
}
function selectOriginal(shared,operation){
 const {target}=operation,document=target.trigger.ownerDocument;
 if(!current(shared,operation)||operation.moved||!target.content.isConnected||document.hasFocus?.()===false)return false;
 if(!samePosition(selectionPosition(document),operation.selection)){operation.moved=true;return false;}
 const selection=document.defaultView?.getSelection();if(!selection||!operation.exactText)return false;
 try{
  const range=document.createRange();range.selectNodeContents(target.content);
  selection.removeAllRanges();selection.addRange(range);
  operation.selection=selectionPosition(document);
  return selection.toString()===operation.exactText;
 }catch{return false;}
}
function publish(shared,operation,status){
 if(!current(shared,operation))return;
 operation.status=status;operation.target.onStatus(status);
}

/** @param {{scope:string,instanceId:string,trigger:HTMLButtonElement,content:HTMLElement,onStatus?:(status:CopyStatus)=>void}} input */
export function attachCopyTarget({scope,instanceId,trigger,content,onStatus=()=>{}}){
 const document=trigger.ownerDocument,shared=coordinator(document);
 const key=JSON.stringify([scope,instanceId]),target={trigger,content,onStatus};
 shared.targets.set(key,target);
 const active=shared.active;
 if(active&&active.key===key&&active.exactText===(content.textContent??'')&&current(shared,active)){
  const replaced=active.target!==target;
  active.target=target;
  active.handoff=false;
  // DOM replacement may collapse the old range. It is not a user selection.
  active.selection=selectionPosition(document);
  if(replaced&&active.restoreFocus&&!active.moved&&backgroundFocus(document)&&document.hasFocus?.()!==false){
   trigger.focus({preventScroll:true});active.selection=selectionPosition(document);
  }
  if(active.copyFailed)publish(shared,active,selectOriginal(shared,active)?'selected':'manual');
  else onStatus(active.status);
 }else onStatus('idle');
 let disposed=false;
 async function copy(){
  if(disposed||!trigger.isConnected||document.defaultView?.location.pathname!==scope)return;
  if(shared.active?.key===key&&shared.active.status==='copying')return shared.active.promise;
  const operation={key,scope,target,exactText:content.textContent??'',status:'copying',copyFailed:false,moved:false,
   restoreFocus:document.activeElement===trigger,selection:selectionPosition(document),promise:null};
  shared.active=operation;shared.start();onStatus('copying');
  operation.promise=(async()=>{
   try{
    const clipboard=document.defaultView?.navigator.clipboard;
    if(!clipboard?.writeText)throw Error('clipboard_unavailable');
    await clipboard.writeText(operation.exactText);
    publish(shared,operation,'copied');
   }catch{
    if(!current(shared,operation))return;
    operation.copyFailed=true;
    publish(shared,operation,selectOriginal(shared,operation)?'selected':'manual');
   }
  })();
  return operation.promise;
 }
 function dispose({handoff=false}={}){
  if(disposed)return;disposed=true;
  if(shared.targets.get(key)===target)shared.targets.delete(key);
  if(shared.active?.target===target){
   if(handoff)shared.active.handoff=true;
   else{shared.active=null;shared.stop();}
  }
  if(!shared.targets.size&&!shared.active)documents.delete(document);
 }
 return {copy,dispose};
}
