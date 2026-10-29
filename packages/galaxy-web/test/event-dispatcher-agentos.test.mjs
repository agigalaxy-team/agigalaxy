import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryObserver} from '@tanstack/react-query';
import {createGalaxyQueryClient,galaxyQueryKey} from '../src/shared/runtime/query-client.ts';
import {createGalaxyEventDispatcher} from '../src/shared/runtime/event-dispatcher.ts';

test('typed changes are delivered without waiting for unrelated active refetches',async()=>{
 const client=createGalaxyQueryClient(),scope={endpoint:'https://events.invalid',identity:'operator',surface:'admin'},events=[];
 let resolveSlow,reads=0;const slow=new Promise(resolve=>{resolveSlow=resolve;});
 const observer=new QueryObserver(client,{queryKey:galaxyQueryKey(scope,'agentos','history'),queryFn:()=>++reads===1?Promise.resolve('existing'):slow});
 const stop=observer.subscribe(()=>{});await new Promise(resolve=>setImmediate(resolve));
 const dispatcher=createGalaxyEventDispatcher(client,scope,undefined,'0',{onChange:event=>events.push(event)});
 try{
  await dispatcher.dispatch({type:'change',cursor:'1',module:'agentos',entity:'conversation-operation',objectId:'turn-1',parentId:'conversation-1',turnId:'turn-1'});
  await dispatcher.dispatch({type:'change',cursor:'2',module:'agentos',entity:'conversation-card',objectId:'card-1',parentId:'conversation-1',turnId:'turn-1'});
  assert.equal(events.length,2);assert.equal(events[1].turnId,'turn-1');assert.equal(observer.getCurrentResult().data,'existing');
 }finally{resolveSlow('updated');await client.cancelQueries();stop();observer.destroy();client.clear();}
});

test('replay gap signals resync while access reset still clears the projection',async()=>{
 const client=createGalaxyQueryClient(),scope={endpoint:'https://events.invalid',identity:'operator',surface:'admin'},key=galaxyQueryKey(scope,'agentos','history'),resync=[],reset=[];
 client.setQueryData(key,'retained');const dispatcher=createGalaxyEventDispatcher(client,scope,modules=>reset.push(modules),'0',{onResync:modules=>resync.push(modules)});
 await dispatcher.dispatch({type:'reset',cursor:'1',modules:['agentos'],reason:'replay-gap'});
 assert.deepEqual(resync,[['agentos']]);assert.equal(client.getQueryData(key),'retained');assert.deepEqual(reset,[]);
 await dispatcher.dispatch({type:'reset',cursor:'2',modules:['agentos'],reason:'access-changed'});
 assert.equal(client.getQueryData(key),undefined);assert.deepEqual(reset,[['agentos']]);client.clear();
});
