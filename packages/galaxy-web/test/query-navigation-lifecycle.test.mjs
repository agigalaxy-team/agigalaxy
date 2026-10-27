import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryObserver} from '@tanstack/react-query';
import {createGalaxyQueryClient} from '../src/shared/runtime/query-client.ts';

test('navigation reuses valid data and consumes a known change received while the page was inactive',async()=>{
 const client=createGalaxyQueryClient();let reads=0;
 const options={queryKey:['navigation-proof'],queryFn:async()=>++reads};
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 try{
  let observer=new QueryObserver(client,options),stop=observer.subscribe(()=>{});await settle();
  assert.equal(reads,1);stop();observer.destroy();
  observer=new QueryObserver(client,options);stop=observer.subscribe(()=>{});await settle();
  assert.equal(reads,1,'a return without a change must reuse data');stop();observer.destroy();
  await client.invalidateQueries({queryKey:options.queryKey});assert.equal(reads,1,'an inactive page must not background fetch');
  observer=new QueryObserver(client,options);stop=observer.subscribe(()=>{});await settle();
  assert.equal(reads,2,'a known inactive change must be read on return');assert.equal(observer.getCurrentResult().data,2);
  stop();observer.destroy();
 }finally{client.clear();}
});
