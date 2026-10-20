import test from 'node:test';
import assert from 'node:assert/strict';
import {attachCopyTarget} from './interaction-copy.mjs';
// The static resource and the Web bundle have separate module instances.
const {attachCopyTarget:attachWorkspaceCopy}=await import('./interaction-copy.mjs?workspace-renderer');

function events(){
 const listeners=new Map();
 return {addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},
  removeEventListener(type,callback){listeners.get(type)?.delete(callback);},emit(type,value={}){for(const callback of [...listeners.get(type)??[]])callback(value);}};
}
function fixture(text='first line\n  second line\n'){
 let resolve,reject;
 const pending=new Promise((yes,no)=>{resolve=yes;reject=no;}),writes=[];
 const window={...events(),location:{pathname:'/docs/native-client/0.1.15/installation/'},navigator:{clipboard:{writeText(value){writes.push(value);return pending;}}}};
 const selection={anchorNode:null,anchorOffset:0,focusNode:null,focusOffset:0,toString(){return this.anchorNode?.textContent??'';},
  removeAllRanges(){this.anchorNode=this.focusNode=null;this.anchorOffset=this.focusOffset=0;},addRange(range){if(document.acceptSelection){this.anchorNode=this.focusNode=range.content;this.focusOffset=range.content.textContent.length;}}};
 const document={...events(),defaultView:window,acceptSelection:true,hasFocus:()=>true,
  createRange(){return{content:null,selectNodeContents(content){this.content=content;}};}};
 window.getSelection=()=>selection;
 function element(value=''){
  return {ownerDocument:document,isConnected:true,textContent:value,contains(node){return node===this;},focus(){document.activeElement=this;document.emit('focusin',{target:this});}};
 }
 document.body=element();document.documentElement=element();document.activeElement=document.body;
 function target(instanceId,attach=attachCopyTarget){
  const trigger=element(),content=element(text),statuses=[];
  const connection=attach({scope:window.location.pathname,instanceId,trigger,content,onStatus:status=>statuses.push(status)});
  return{trigger,content,statuses,...connection};
 }
 function select(content){selection.anchorNode=selection.focusNode=content;selection.anchorOffset=0;selection.focusOffset=content.textContent.length;document.emit('selectionchange');}
 return {document,window,target,element,select,selection,pending,writes,resolve,reject};
}

test('one pending copy preserves exact multiline content and does not duplicate writes',async()=>{
 const f=fixture(),target=f.target('body:0');target.trigger.focus();
 try{
  const first=target.copy(),second=target.copy();assert.deepEqual(f.writes,['first line\n  second line\n']);
  f.resolve();await Promise.all([first,second]);assert.equal(target.statuses.at(-1),'copied');
 }finally{target.dispose();}
});

test('static to workspace handoff claims the exact instance among identical blocks',async()=>{
 const f=fixture('same command\n'),first=f.target('body:0'),second=f.target('body:1');
 let nextFirst,nextSecond;
 try{
  second.trigger.focus();const copy=second.copy();
  second.trigger.isConnected=second.content.isConnected=false;f.document.activeElement=f.document.body;
  second.dispose({handoff:true});
  nextFirst=f.target('body:0',attachWorkspaceCopy);assert.equal(nextFirst.statuses.at(-1),'idle');assert.equal(f.document.activeElement,f.document.body);
  nextSecond=f.target('body:1',attachWorkspaceCopy);assert.equal(f.document.activeElement,nextSecond.trigger);assert.equal(nextSecond.statuses.at(-1),'copying');
  f.resolve();await copy;assert.equal(nextSecond.statuses.at(-1),'copied');assert.equal(nextFirst.statuses.at(-1),'idle');
 }finally{first.dispose();second.dispose();nextFirst?.dispose();nextSecond?.dispose();}
});

test('clipboard refusal leaves a user’s new focus and selection untouched',async()=>{
 const f=fixture(),target=f.target('body:0'),input=f.element('my new selection');target.trigger.focus();
 try{
  const copy=target.copy();f.document.emit('pointerdown',{target:input});input.focus();f.select(input);
  f.reject(Error('denied'));await copy;
  assert.equal(f.document.activeElement,input);assert.equal(f.selection.toString(),'my new selection');assert.equal(target.statuses.at(-1),'manual');
 }finally{target.dispose();}
});

test('a changed text selection without a focus change is not overwritten',async()=>{
 const f=fixture(),target=f.target('body:0'),other=f.element('a deliberately selected sentence');target.trigger.focus();
 try{
  const copy=target.copy();f.select(other);f.reject(Error('denied'));await copy;
  assert.equal(f.selection.toString(),'a deliberately selected sentence');assert.equal(target.statuses.at(-1),'manual');
 }finally{target.dispose();}
});

test('selected feedback requires an actual exact range, including after DOM handoff',async()=>{
 const f=fixture('line one\nline two\n'),target=f.target('body:0');let next;
 target.trigger.focus();
 try{
  const copy=target.copy();f.reject(Error('denied'));await copy;
  assert.equal(target.statuses.at(-1),'selected');assert.equal(f.selection.toString(),'line one\nline two\n');
  target.trigger.isConnected=target.content.isConnected=false;f.document.activeElement=f.document.body;f.selection.removeAllRanges();target.dispose({handoff:true});
  next=f.target('body:0',attachWorkspaceCopy);assert.equal(next.statuses.at(-1),'selected');assert.equal(f.selection.anchorNode,next.content);
 }finally{target.dispose();next?.dispose();}
 const failed=fixture(),unselectable=failed.target('body:0');unselectable.trigger.focus();failed.document.acceptSelection=false;
 try{
  const copy=unselectable.copy();failed.reject(Error('denied'));await copy;assert.equal(unselectable.statuses.at(-1),'manual');
 }finally{unselectable.dispose();}
});

test('a disposed page cannot receive a late clipboard result',async()=>{
 const f=fixture(),target=f.target('body:0');target.trigger.focus();
 const copy=target.copy();target.dispose();target.trigger.isConnected=target.content.isConnected=false;
 f.window.location.pathname='/app/account';f.document.activeElement=f.document.body;
 f.reject(Error('denied'));await copy;
 assert.equal(target.statuses.at(-1),'copying');assert.equal(f.selection.toString(),'');assert.equal(f.document.activeElement,f.document.body);
});
