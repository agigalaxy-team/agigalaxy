import test from 'node:test';
import assert from 'node:assert/strict';
import {GorseClient} from '../src/discovery-runtime/native-clients.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';

const visitorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',apiKey='synthetic-internal-key-'.repeat(2);
const uuid=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const key=(n,kind='post')=>kind+'_'+uuid(n);
const document=(n,topic='technology',kind='post')=>({id:key(n,kind),sourceId:uuid(n),kind,topic,version:uuid(n+1000),title:'Current public '+n});
function fixture({personal=[],latest=[],documents=[],excluded=[],readPage}={}){
 const calls=[],loads=[],queued=[],docs=new Map(documents.map(value=>[value.id,value]));
 const gorse=new GorseClient({url:'http://gorse.invalid',apiKey,fetch:async(url,options)=>{
  const target=new URL(url),mode=target.pathname==='/api/latest'?'latest':'personalized',limit=Number(target.searchParams.get('n')),offset=Number(target.searchParams.get('offset'));
  const call={mode,limit,offset,target,options};calls.push(call);
  if(readPage)return readPage(call);
  const rows=(mode==='latest'?latest:personal).slice(offset,offset+limit);
  return Response.json(mode==='latest'?rows.map(id=>({Id:id,Score:1})):rows);
 }});
 const runtime=new DiscoveryRuntime({endpoint:'https://official.invalid',gorse,now:()=>1792734675,
  source:{load:async reference=>{const id=reference.kind+'_'+reference.id;loads.push(id);return docs.get(id)??null;},view:value=>({id:value.sourceId,kind:value.kind,title:value.title,topic:value.topic,sourceVersion:value.version})},
  store:{excluded:async profileId=>{assert.equal(profileId,'visitor:'+visitorId);return new Set(excluded);},enqueue:async reference=>queued.push(reference.kind+'_'+reference.id)},
 });
 return {runtime,calls,loads,queued};
}

test('Gorse v0.5.11 page adapter preserves n/offset/category and native row count without write-back',async()=>{
 const calls=[];let body=[key(1),key(2)];
 const client=new GorseClient({url:'http://gorse.invalid',apiKey,fetch:async(url,options)=>{calls.push({url:new URL(url),options});return Response.json(body);}});
 assert.deepEqual(await client.recommend({profileId:'account:'+visitorId,mode:'personalized',topic:'technology',limit:2,offset:7}),[{id:key(1),source:'gorse-recommendation'},{id:key(2),source:'gorse-recommendation'}]);
 assert.equal(calls[0].url.pathname,'/api/recommend/'+encodeURIComponent('account:'+visitorId));
 assert.deepEqual([...calls[0].url.searchParams],[['n','2'],['offset','7'],['category','technology']]);
 body=[{Id:key(3),Score:1},{Id:key(4,'reply'),Score:0}];
 assert.deepEqual(await client.recommend({profileId:'visitor:'+visitorId,mode:'latest',limit:2,offset:9}),[{id:key(3),source:'gorse-latest'},{id:key(4,'reply'),source:'gorse-latest'}]);
 assert.equal(calls[1].url.pathname,'/api/latest');assert.deepEqual([...calls[1].url.searchParams],[['n','2'],['offset','9']]);
 body=[];assert.deepEqual(await client.recommend({profileId:'visitor:'+visitorId,mode:'latest',limit:2}),[]);assert.equal(calls[2].url.searchParams.get('offset'),'0');
 for(const invalid of [null,{},[null],[{}],[key(1),key(2),key(3)]]){body=invalid;await assert.rejects(client.recommend({profileId:'visitor:'+visitorId,mode:'personalized',limit:2}),{code:'discovery_engine_response_invalid'});}
 for(const {url,options}of calls){assert.equal(options.method,'GET');assert.equal(options.headers['X-API-Key'],apiKey);assert.equal(options.body,undefined);assert.equal(options.redirect,'error');assert.equal(url.searchParams.has('write-back-type'),false);assert.equal(url.searchParams.has('user-id'),false);}
});

test('filtered nonempty recommendations continue both native pages and latest fallback with current-source reasons',async()=>{
 const privateId=key(1),expiredId=key(2),negative=key(3),wrongTopic=key(4),personalA=key(5),hidden=key(6),personalB=key(7,'reply'),latestA=key(8);
 const personal=[privateId,expiredId,negative,wrongTopic,'not-a-public-reference',personalA,personalA,hidden,wrongTopic,personalB,privateId];
 const latest=[personalA,negative,wrongTopic,expiredId,hidden,personalB,privateId,'not-a-public-reference',personalA,latestA];
 const {runtime,calls,loads,queued}=fixture({personal,latest,documents:[document(4,'life'),document(5),document(7,'technology','reply'),document(8)],excluded:[negative]});
 const result=await runtime.recommend(null,visitorId,{limit:3,topic:'technology'});
 assert.deepEqual(result.items.map(item=>item.id),[uuid(5),uuid(7),uuid(8)]);assert.equal(result.fallback,true);assert.equal(result.mode,'personalized');
 assert.deepEqual(result.items.map(item=>item.reason),[
  {code:'recommendation-candidate',label:'公开内容推荐',candidateSource:'gorse-recommendation'},
  {code:'recommendation-candidate',label:'公开内容推荐',candidateSource:'gorse-recommendation'},
  {code:'current-new-content',label:'当前公开的新内容',candidateSource:'gorse-latest'},
 ]);
 assert.deepEqual(result.items.map(item=>item.sourceVersion),[uuid(1005),uuid(1007),uuid(1008)]);
 assert.deepEqual(calls.map(({mode,limit,offset})=>({mode,limit,offset})),[
  {mode:'personalized',limit:9,offset:0},{mode:'personalized',limit:18,offset:9},
  {mode:'latest',limit:9,offset:0},{mode:'latest',limit:18,offset:9},
 ]);
 assert.ok(calls.every(call=>call.target.searchParams.get('category')==='technology'));
 assert.equal(loads.includes(negative),false);assert.equal(loads.includes('not-a-public-reference'),false);assert.equal(loads.length,new Set(loads).size);
 assert.deepEqual(queued,[privateId,expiredId,hidden]);assert.equal(result.qualification,'current-anonymous-public-reader');assert.equal(result.readExpiresAt-result.checkedAt,15);
});

test('duplicate and excluded candidates consume the shared 100-row budget while preserving a latest fallback opportunity',async()=>{
 for(const available of [true,false]){
  const repeated=key(1),current=key(2),{runtime,calls,loads}=fixture({documents:available?[document(2)]:[],excluded:[repeated],readPage:async({mode,limit})=>Response.json(mode==='personalized'?Array(limit).fill(repeated):[{Id:current,Score:1}])});
  const result=await runtime.recommend(null,visitorId,{limit:1});
  assert.equal(result.items.length,available?1:0);assert.equal(result.fallback,true);assert.equal(calls.reduce((sum,call)=>sum+call.limit,0),100);
  assert.deepEqual(calls.filter(call=>call.mode==='personalized').map(call=>call.offset),[0,3,9,21,45,93]);
  assert.deepEqual(calls.at(-1).mode,'latest');assert.equal(calls.at(-1).limit,1);assert.deepEqual(loads,[current]);
  if(available)assert.equal(result.items[0].reason.candidateSource,'gorse-latest');
 }
 const empty=fixture();const result=await empty.runtime.recommend(null,visitorId,{limit:30});assert.deepEqual(result.items,[]);assert.equal(result.fallback,true);assert.equal(empty.calls.length,2);
});

test('latest-only reads refill without personalization and engine failures after partial results stay failures',async()=>{
 const latest=[key(1),key(2),key(3),key(4),key(5),key(6),key(7),key(8)];
 const {runtime,calls}=fixture({latest,documents:[document(7),document(8)]});
 const result=await runtime.recommend(null,visitorId,{mode:'latest',limit:2});
 assert.deepEqual(result.items.map(item=>item.id),[uuid(7),uuid(8)]);assert.equal(result.fallback,false);assert.ok(result.items.every(item=>item.reason.code==='current-new-content'));
 assert.deepEqual(calls.map(({mode,offset})=>({mode,offset})),[{mode:'latest',offset:0},{mode:'latest',offset:6}]);
 for(const failAt of ['personalized-continuation','latest-continuation','fallback','authorization']){
  const mode=failAt==='latest-continuation'?'latest':'personalized',current=key(1);let requests=0;
  const failed=fixture({documents:[document(1)],readPage:async({mode:pageMode,limit,offset})=>{
   requests++;
   if(failAt==='authorization')return new Response(null,{status:401});
   if(failAt==='fallback'&&pageMode==='latest'||failAt!=='fallback'&&offset>0)return new Response(null,{status:503});
   return Response.json(failAt==='fallback'?[current]:Array(limit).fill(current));
  }});
  await assert.rejects(failed.runtime.recommend(null,visitorId,{mode,limit:2}),{code:failAt==='authorization'?'discovery_engine_authorization_failed':'discovery_engine_failed'});
  assert.equal(requests,failAt==='authorization'?1:2);
 }
});
