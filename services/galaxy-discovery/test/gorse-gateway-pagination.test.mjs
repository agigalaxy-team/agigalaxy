import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('private Gorse pagination forwards bounded unique offset and keeps authorization closed',async t=>{
 const calls=[],key='synthetic-galaxy-gorse-gateway-key-only',nativeKey='synthetic-galaxy-gorse-native-key-only';
 const upstream=http.createServer((request,response)=>{calls.push({url:request.url,key:request.headers['x-api-key']});response.setHeader('Content-Type','application/json');response.end('[]');});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const available=http.createServer();available.listen(0,'127.0.0.1');await once(available,'listening');const port=available.address().port;await new Promise(resolve=>available.close(resolve));
 const gatewayProcess=spawn(globalThis.process.execPath,[fileURLToPath(new URL('../gorse-gateway.mjs',import.meta.url))],{env:{PATH:globalThis.process.env.PATH,PORT:String(port),GORSE_UPSTREAM:'http://127.0.0.1:'+upstream.address().port,GALAXY_GORSE_GATEWAY_KEY:key,GALAXY_GORSE_NATIVE_KEY:nativeKey},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(gatewayProcess.exitCode===null){gatewayProcess.kill();await once(gatewayProcess,'exit');}await new Promise(resolve=>upstream.close(resolve));});
 await Promise.race([once(gatewayProcess.stdout,'data'),once(gatewayProcess,'exit').then(()=>{throw new Error('Gateway startup failed');})]);
 const origin='http://127.0.0.1:'+port,profile='/api/recommend/visitor%3A11111111-1111-4111-8111-111111111111';
 for(const path of ['/api/latest?n=15&offset=0',profile+'?n=5&offset=15&category=technology','/api/latest?n=1&offset=100']){
  const response=await fetch(origin+path,{headers:{'X-API-Key':key}});assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);assert.equal(calls.at(-1).url,path);assert.equal(calls.at(-1).key,nativeKey);
 }
 const before=calls.length;
 for(const path of ['/api/latest?n=15&offset=0&offset=1','/api/latest?n=15&offset=-1','/api/latest?n=15&offset=101','/api/latest?n=15&offset=1.5','/api/latest?n=15&offset=00','/api/latest?n=0','/api/latest?n=101','/api/latest?n=15&unknown=1'])assert.equal((await fetch(origin+path,{headers:{'X-API-Key':key}})).status,404);
 assert.equal((await fetch(origin+'/api/latest?n=5&offset=0')).status,401);
 assert.equal((await fetch(origin+'/api/latest?n=5&offset=0',{headers:{'X-API-Key':'wrong'}})).status,401);
 assert.equal(calls.length,before);
});
