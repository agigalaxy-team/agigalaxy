import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi } from '../src/http.mjs';
import { ServiceError } from '../src/shared/service-error.mjs';
import { searchQuerySchema } from '../src/shared/search-schema.mjs';

test('typed search page size and query bounds are uniform while history filters retain their original rules',()=>{
  for(const type of ['case','history','proof','capsule']){
    assert.equal(searchQuerySchema.parse({type,query:{}}).query.limit,8);
    assert.ok(searchQuerySchema.safeParse({type,query:{limit:20}}).success);
    for(const query of [{limit:21},{limit:0},{offset:5000},{query:'a'.repeat(201)}])assert.equal(searchQuerySchema.safeParse({type,query}).success,false);
  }
  assert.equal(searchQuerySchema.safeParse({type:'case',query:{createdFrom:'2026-09-10T00:00:00Z',createdBefore:'2026-09-01T00:00:00Z'}}).success,false);
});
test('continuation budget spans typed and legacy queries, isolates subjects, and preserves first pages and revocation',async()=>{
  let now=0,reads=0;
  const a='GUID'+'0'.repeat(28),b='GUID'+'1'.repeat(28),id=randomUUID();
  const read=async()=>{reads++;return {items:[],nextCursor:null};};
  const server=createApi({rateLimit:200,searchPageLimit:2,quotaNow:()=>now,
    bindings:{endpoint:'https://paging.example.org',revoke:async()=>({revoked:true})},
    access:{authenticate:async token=>{if(!['a1','a2','b'].includes(token))throw new ServiceError('access_denied',401);return {subjectId:token==='b'?b:a,bindingId:id};}},
    history:{query:read},search:{query:read},capsules:{query:read,uses:read}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const send=async(path,input,token)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(input)});
    const result={status:response.status,retry:response.headers.get('retry-after'),category:response.headers.get('x-galaxy-quota-category'),body:await response.json()};return result;};
  try{
    assert.equal((await send('/v1/search/query',{type:'proof',query:{after:id}},'a1')).status,200);
    assert.equal((await send('/v1/history/query',{after:randomUUID()},'a2')).status,200);
    const blocked=await send('/v1/capsules/query',{after:randomUUID()},'a2');
    assert.equal(blocked.status,429);assert.equal(blocked.retry,'60');assert.equal(blocked.category,'search-pagination');assert.equal(reads,2);
    assert.equal((await send('/v1/search/query',{type:'history',query:{}},'a1')).status,200);
    assert.equal((await send('/v1/bindings/'+id+'/revoke',{},'a1')).status,200);
    assert.equal((await send('/v1/search/query',{type:'case',query:{after:id}},'b')).status,200);
    assert.equal((await send('/v1/search/query',{type:'proof',query:{after:id}})).status,200);
    assert.equal((await send('/v1/capsules/query',{after:id})).status,200);
    assert.equal((await send('/v1/history/query',{after:id})).status,429);
    // Neither credential rotation, source type nor arbitrary cursor IDs reset a subject's budget.
    assert.equal((await send('/v1/search/query',{type:'capsule',query:{after:randomUUID()}},'a1')).status,429);
    now=60000;assert.equal((await send('/v1/history/query',{after:id},'a1')).status,200);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
