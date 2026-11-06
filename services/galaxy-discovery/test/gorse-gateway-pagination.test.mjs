import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('private Gorse pagination forwards bounded unique offset and keeps authorization closed',async t=>{
 const calls=[],key='synthetic-galaxy-gorse-gateway-key-only',nativeKey='synthetic-galaxy-gorse-native-key-only';
 let blockPut,putStarted,releasePut;
 const upstream=http.createServer(async(request,response)=>{calls.push({method:request.method,url:request.url,key:request.headers['x-api-key']});if(request.method==='PUT'&&blockPut){putStarted();await blockPut;}response.setHeader('Content-Type','application/json');response.end('[]');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const available=http.createServer();available.listen(0,'127.0.0.1');await once(available,'listening');const port=available.address().port;await new Promise(resolve=>available.close(resolve));
 const gatewayProcess=spawn(globalThis.process.execPath,[fileURLToPath(new URL('../gorse-gateway.mjs',import.meta.url))],{env:{PATH:globalThis.process.env.PATH,PORT:String(port),GORSE_UPSTREAM:'http://127.0.0.1:'+upstream.address().port,GALAXY_GORSE_GATEWAY_KEY:key,GALAXY_GORSE_NATIVE_KEY:nativeKey},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{releasePut?.();if(gatewayProcess.exitCode===null){gatewayProcess.kill();await once(gatewayProcess,'exit');}await new Promise(resolve=>upstream.close(resolve));});
 await Promise.race([once(gatewayProcess.stdout,'data'),once(gatewayProcess,'exit').then(()=>{throw new Error('Gateway startup failed');})]);
 const origin='http://127.0.0.1:'+port,profile='/api/recommend/visitor%3A11111111-1111-4111-8111-111111111111';
 for(const path of ['/api/latest?n=15&offset=0',profile+'?n=5&offset=15&category=technology','/api/latest?n=1&offset=100']){
  const response=await fetch(origin+path,{headers:{'X-API-Key':key}});assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);assert.equal(calls.at(-1).url,path);assert.equal(calls.at(-1).key,nativeKey);
 }
 const relation='/account%3A11111111-1111-4111-8111-111111111111/post_22222222-2222-4222-8222-222222222222';
 for(const type of ['like','click']){
  const path='/api/feedback/'+type+relation;
  const response=await fetch(origin+path,{method:'DELETE',headers:{'X-API-Key':key}});
  assert.equal(response.status,200);assert.equal(calls.at(-1).method,'DELETE');assert.equal(calls.at(-1).url,path);assert.equal(calls.at(-1).key,nativeKey);
 }
 const before=calls.length;
 for(const path of ['/api/feedback'+relation,'/api/feedback/unknown'+relation,'/api/feedback/like'+relation+'?other=true','/api/feedback/like/account%253A11111111-1111-4111-8111-111111111111/post_22222222-2222-4222-8222-222222222222','/api/feedback/like/account%3A11111111-1111-4111-8111-111111111111/post_22222222-2222-4222-8222-222222222222/extra'])assert.equal((await fetch(origin+path,{method:'DELETE',headers:{'X-API-Key':key}})).status,404);
 assert.equal((await fetch(origin+'/api/feedback/like'+relation,{method:'DELETE'})).status,401);
 for(const path of ['/api/latest?n=15&offset=0&offset=1','/api/latest?n=15&offset=-1','/api/latest?n=15&offset=101','/api/latest?n=15&offset=1.5','/api/latest?n=15&offset=00','/api/latest?n=0','/api/latest?n=101','/api/latest?n=15&unknown=1'])assert.equal((await fetch(origin+path,{headers:{'X-API-Key':key}})).status,404);
 assert.equal((await fetch(origin+'/api/latest?n=5&offset=0')).status,401);
 assert.equal((await fetch(origin+'/api/latest?n=5&offset=0',{headers:{'X-API-Key':'wrong'}})).status,401);
 assert.equal(calls.length,before);
 // A lost caller must not let a cancellation overtake its native add.
 blockPut=new Promise(resolve=>{releasePut=resolve;});
 const started=new Promise(resolve=>{putStarted=resolve;});
 const controller=new AbortController();
 const adding=fetch(origin+'/api/feedback',{method:'PUT',headers:{'X-API-Key':key,'Content-Type':'application/json'},body:JSON.stringify([{FeedbackType:'like',UserId:'account:11111111-1111-4111-8111-111111111111',ItemId:'post_22222222-2222-4222-8222-222222222222',Value:1}]),signal:controller.signal}).catch(()=>null);
 await started;controller.abort();await adding;
 const cancelling=fetch(origin+'/api/feedback/like'+relation,{method:'DELETE',headers:{'X-API-Key':key}});
 // An unrelated request still runs while the same relation waits.
 assert.equal((await fetch(origin+'/api/health/ready',{headers:{'X-API-Key':key}})).status,200);
 assert.equal(calls.filter(call=>call.method==='DELETE').length,2);
 releasePut();assert.equal((await cancelling).status,200);
 const finalFeedback=calls.filter(call=>['PUT','DELETE'].includes(call.method));
 assert.equal(finalFeedback.at(-2).method,'PUT');assert.equal(finalFeedback.at(-1).method,'DELETE');
});
