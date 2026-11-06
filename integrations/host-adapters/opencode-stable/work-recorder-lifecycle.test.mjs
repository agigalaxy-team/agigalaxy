import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOpenCodeWorkRecorder} from './work-recorder.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(){
 const handlers=new Map(),messages=[],saved=[];
 const history={identity:async()=>({id:'owner'}),beginCapture:async()=>({galaxyId:'owner',sessionId:'session',startedAt:new Date(Date.now()-1000).toISOString()}),observeEnvironment:async()=>{},observe:async value=>{saved.push(value);return {};}};
 const api={route:{current:{name:'session',params:{sessionID:'session'}}},event:{on:(name,fn)=>{handlers.set(name,fn);return()=>handlers.delete(name);}},state:{session:{messages:()=>messages,get:()=>({id:'session'})},part:()=>[],mcp:()=>[]},v2:{synchronizedMessages:async()=>messages,reviewReady:async()=>({accepted:true})}};
 return {handlers,messages,saved,history,api};
}

test('closing drains an already observed idle fact without late review notification',async()=>{
 const f=fixture(),started=deferred(),held=deferred();let notices=0;
 f.api.v2.reviewReady=async()=>{notices++;};
 const observe=f.history.observe;f.history.observe=async value=>{if(value.sourceId==='session-status'){started.resolve();await held.promise;}return observe(value);};
 const recorder=createOpenCodeWorkRecorder(f.api,{history:f.history,pollMs:60000});await recorder.ready;
 f.messages.push({id:'user',sessionID:'session',role:'user',time:{created:Date.now()+1}});
 f.handlers.get('session.idle')({properties:{sessionID:'session'}});await started.promise;
 const closing=recorder.close();held.resolve();await closing;
 assert.ok(f.saved.some(value=>value.sourceId==='session-status'));assert.equal(notices,0);
});

test('closing while archive identity is pending prevents the late completion notification',async()=>{
 const f=fixture(),started=deferred(),held=deferred();let hold=false,notices=0;
 f.history.identity=async()=>{if(hold){started.resolve();await held.promise;}return {id:'owner'};};
 const observe=f.history.observe;f.history.observe=async value=>{const result=await observe(value);if(value.sourceId==='message:assistant')hold=true;return result;};
 const recorder=createOpenCodeWorkRecorder(f.api,{history:f.history,pollMs:60000,onSessionComplete:async()=>{notices++;}});await recorder.ready;
 const at=Date.now()+1;f.messages.push({id:'assistant',sessionID:'session',role:'assistant',time:{created:at,completed:at+1}});
 f.handlers.get('message.updated')({properties:{sessionID:'session'}});await started.promise;
 const closing=recorder.close();held.resolve();await closing;
 assert.ok(f.saved.some(value=>value.sourceId==='message:assistant'));assert.equal(notices,0);
});
