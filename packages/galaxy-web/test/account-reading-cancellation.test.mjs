import test from 'node:test';
import assert from 'node:assert/strict';
import {createOfficialAccountClient} from '../src/official-account-client.mjs';
import {exportConversationArchive} from '../src/account-archive-file.mjs';

test('account reads pass caller cancellation through the existing request timeout',async()=>{
 const abort=new AbortController();let requestedSignal;
 const client=createOfficialAccountClient({endpoint:'https://official.example',website:'https://galaxy.example',fetch:async(_url,options)=>{
  requestedSignal=options.signal;
  return new Promise((_resolve,reject)=>{requestedSignal.addEventListener('abort',()=>reject(requestedSignal.reason),{once:true});});
 }});
 const reading=client.session({signal:abort.signal});abort.abort(new DOMException('Reading changed','AbortError'));
 await assert.rejects(reading,{name:'AbortError'});assert.equal(requestedSignal.aborted,true);
});

test('cancelled conversation reads do not request later chunks even if the old transport returns',async()=>{
 const abort=new AbortController();let finish,calls=0;
 const reading=exportConversationArchive(async()=>{calls++;return new Promise(resolve=>{finish=resolve;});},'archive-A',{signal:abort.signal});
 abort.abort();finish({archive:{id:'archive-A'},content:'first',nextSequence:1});
 await assert.rejects(reading,{name:'AbortError'});assert.equal(calls,1);
});
