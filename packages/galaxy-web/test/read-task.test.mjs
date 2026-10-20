import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadTaskController} from '../../../integrations/shared/read-task.mjs';

function deferred(){
 let resolve,reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}

test('the same scoped read shares its promise and only the original callbacks run',async()=>{
 const tasks=createReadTaskController('account:A'),result=deferred(),events=[];let reads=0;
 const first=tasks.run({lane:'list',key:'head'},()=>{reads++;return result.promise;},{onStart:()=>events.push('start'),onSuccess:value=>events.push(value),onSettled:()=>events.push('settled')});
 const duplicate=tasks.run({lane:'list',key:'head'},()=>{throw Error('duplicate read');},{onSuccess:()=>events.push('duplicate')});
 assert.equal(first,duplicate);await Promise.resolve();assert.equal(reads,1);assert.equal(tasks.isPending('list'),true);
 result.resolve('rows');assert.deepEqual(await first,{status:'success',value:'rows'});assert.deepEqual(events,['start','rows','settled']);assert.equal(tasks.isPending('list'),false);
});

test('switching objects aborts the old read and ignores its late error and settled callback',async()=>{
 const tasks=createReadTaskController('account:A'),old=deferred(),next=deferred(),events=[];let oldSignal;
 const first=tasks.run({lane:'detail',key:'work:A'},({signal})=>{oldSignal=signal;return old.promise;},{onSuccess:()=>events.push('old success'),onError:()=>events.push('old error'),onSettled:()=>events.push('old settled')});
 await Promise.resolve();
 const second=tasks.run({lane:'detail',key:'work:B'},()=>next.promise,{onSuccess:value=>events.push(value),onSettled:()=>events.push('new settled')});
 assert.equal(oldSignal.aborted,true);await Promise.resolve();old.reject(Error('late network failure'));
 assert.deepEqual(await first,{status:'superseded'});assert.equal(tasks.isPending('detail'),true);assert.deepEqual(events,[]);
 next.resolve('work B');assert.deepEqual(await second,{status:'success',value:'work B'});assert.deepEqual(events,['work B','new settled']);
});

test('lanes are independent and disposed scopes cannot deliver callbacks after reactivation',async()=>{
 const tasks=createReadTaskController('account:A'),list=deferred(),detail=deferred(),events=[];
 const first=tasks.run({lane:'list',key:'head'},()=>list.promise,{onSuccess:()=>events.push('old list'),onSettled:()=>events.push('old settled')});
 const second=tasks.run({lane:'detail',key:'archive:A'},()=>detail.promise,{onSuccess:()=>events.push('detail')});
 await Promise.resolve();tasks.cancel('list');detail.resolve('read');assert.equal((await second).status,'success');assert.deepEqual(events,['detail']);
 tasks.dispose();assert.equal((await tasks.run({lane:'list',key:'head'},async()=>[])).status,'superseded');
 tasks.activate();const fresh=await tasks.run({lane:'list',key:'head'},async()=>['current'],{onSuccess:()=>events.push('new list')});
 list.resolve(['stale']);assert.equal((await first).status,'superseded');assert.equal(fresh.status,'success');assert.deepEqual(events,['detail','new list']);
});

test('callback failures still settle and release the current lane',async()=>{
 const tasks=createReadTaskController('account:A'),events=[];
 const value=await tasks.run({lane:'list',key:'head'},async()=>[],{onSuccess:()=>{throw Error('render callback');},onError:()=>{events.push('error');throw Error('error callback');},onSettled:()=>events.push('settled')});
 assert.equal(value.status,'error');assert.equal(value.error.message,'error callback');assert.deepEqual(events,['error','settled']);assert.equal(tasks.isPending('list'),false);
 const again=await tasks.run({lane:'list',key:'head'},async()=>['recovered']);assert.equal(again.status,'success');
});

test('a transport abort settles the read without displaying an error',async()=>{
 const tasks=createReadTaskController('account:A'),events=[];
 const result=await tasks.run({lane:'detail',key:'archive:A'},async()=>{throw new DOMException('Host stopped reading','AbortError');},{onError:()=>events.push('error'),onSettled:()=>events.push('settled')});
 assert.equal(result.status,'superseded');assert.deepEqual(events,['settled']);assert.equal(tasks.isPending('detail'),false);
});
