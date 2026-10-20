import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('./galaxy-auth.js',import.meta.url),'utf8');
function fixture(){
 const callbacks=new Map();let timer=0,replayed=0;
 const window={setTimeout(callback){callbacks.set(++timer,callback);return timer;},clearTimeout(id){callbacks.delete(id);}},navigator={onLine:true};
 const context={window,navigator,document:{addEventListener(){}}};runInNewContext(source,context);
 const form={dataset:{},attributes:{},value:'retained input',disabledChoice:true,checkValidity:()=>true,
  setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},requestSubmit(){replayed++;}};
 const status={hidden:true,dataset:{}},progress={hidden:true},message={dataset:{pending:'pending',offline:'offline',delayed:'delayed',reconnected:'reconnected'}};
 const controller=context.createAuthenticationSubmission({forms:[form],status,progress,message});
 return{controller,form,status,progress,message,callbacks,navigator,replayed:()=>replayed};
}
test('going offline while authentication is pending clears waiting feedback without replaying or deciding its result',()=>{
 const f=fixture();let prevented=false;
 f.controller.submit({currentTarget:f.form,defaultPrevented:false,preventDefault(){prevented=true;}});
 assert.equal(prevented,false);assert.equal(f.callbacks.size,1);assert.equal(f.form.attributes['aria-busy'],'true');
 f.navigator.onLine=false;f.controller.offline();
 assert.equal(f.callbacks.size,0);assert.equal(f.status.dataset.state,'offline');assert.equal(f.progress.hidden,true);assert.equal(f.form.dataset.submitting,undefined);
 assert.equal(f.form.value,'retained input');assert.equal(f.form.disabledChoice,true);
 f.navigator.onLine=true;f.controller.online();assert.equal(f.status.dataset.state,'reconnected');assert.equal(f.replayed(),0);
});
test('a page lifecycle reset removes the old wait before another explicit submission',()=>{
 const f=fixture(),event={currentTarget:f.form,defaultPrevented:false,preventDefault(){}};
 f.controller.submit(event);f.controller.reset();assert.equal(f.callbacks.size,0);assert.equal(f.status.hidden,true);
 f.controller.submit(event);assert.equal(f.callbacks.size,1);assert.equal(f.status.dataset.state,'pending');assert.equal(f.form.value,'retained input');
 f.controller.reset();
});
test('shared header search stays outside authentication submission and field enhancement',()=>{
 const ready=[],listeners=new Map(),windowListeners=new Map(),timers=new Map();let timer=0;
 const authenticationForm={dataset:{},attributes:{},checkValidity:()=>true,
  addEventListener(type,listener){listeners.set(type,listener);},
  setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];}};
 const searchForm={dataset:{},attributes:{},addEventListener(){throw new Error('Authentication must not bind shared search.');}};
 const area={querySelectorAll(selector){return selector==='form'?[authenticationForm]:[];}};
 const status={hidden:true,dataset:{}},progress={hidden:true},message={dataset:{pending:'pending'}};
 const document={addEventListener(type,listener){if(type==='DOMContentLoaded')ready.push(listener);},
  querySelector(selector){return selector==='.auth-form-area'?area:null;},
  getElementById(id){return {'auth-submit-status':status,'auth-progress':progress,'auth-submit-message':message}[id]??null;},
  get forms(){throw new Error('Authentication must not enumerate all page forms.');}};
 const window={addEventListener(type,listener){windowListeners.set(type,listener);},
  setTimeout(listener){timers.set(++timer,listener);return timer;},clearTimeout(id){timers.delete(id);}};
 runInNewContext(source,{document,window,navigator:{onLine:true}});
 ready[0]();
 assert.equal(typeof listeners.get('submit'),'function');
 assert.equal(searchForm.dataset.submitting,undefined);
 listeners.get('submit')({currentTarget:authenticationForm,defaultPrevented:false,preventDefault(){}});
 assert.equal(authenticationForm.attributes['aria-busy'],'true');assert.equal(status.hidden,false);
 windowListeners.get('pagehide')();
 assert.equal(status.hidden,true);assert.equal(timers.size,0);assert.deepEqual(searchForm.attributes,{});
});
