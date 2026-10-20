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
