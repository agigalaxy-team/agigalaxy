import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskPageView} from "../src/features/tasks/task-page-view.ts";

/** @returns {PromiseWithResolvers<{title:string}>} */
function deferred(){return Promise.withResolvers();}

test('leaving a task prevents its delayed private response from becoming visible',async()=>{
  const pending=deferred(),view=createTaskPageView({taskId:'original',scope:'original-binding',read:()=>pending.promise,isCurrent:()=>true});
  view.open();const reading=view.refresh('original');view.close();
  pending.resolve({title:'private original work'});
  assert.equal(await reading,false);assert.equal(view.read().task,null);
});

test('a later refresh owns the visible task even when the earlier response arrives last',async()=>{
  const first=deferred(),second=deferred();let reads=0;
  const view=createTaskPageView({taskId:'work',scope:'current-binding',read:()=>++reads===1?first.promise:second.promise,isCurrent:()=>true});
  view.open();const earlier=view.refresh('work'),later=view.refresh('work',true);
  second.resolve({title:'current work'});assert.equal(await later,true);
  first.resolve({title:'old work'});assert.equal(await earlier,false);
  assert.deepEqual(view.read().task,{title:'current work'});assert.equal(view.read().loading,false);
});

test('a current permission failure removes previously visible material',async()=>{
  let allowed=true;
  const view=createTaskPageView({taskId:'work',scope:'current-binding',read:async()=>{if(!allowed)throw Error('permission withdrawn');return{title:'private work'};},isCurrent:()=>true});
  view.open();await view.refresh('work');assert.deepEqual(view.read().task,{title:'private work'});
  allowed=false;await assert.rejects(view.refresh('work',true),/permission withdrawn/);
  assert.equal(view.read().task,null);assert.equal(view.read().loading,false);
});

test('an immediate route change discards the result before effect cleanup runs',async()=>{
  const pending=deferred();let current=true;
  const view=createTaskPageView({taskId:'work',scope:'current-binding',read:()=>pending.promise,isCurrent:()=>current});
  view.open();const reading=view.refresh('work');current=false;pending.reject(Error('old page failed'));
  assert.equal(await reading,false);assert.equal(view.read().task,null);
});
