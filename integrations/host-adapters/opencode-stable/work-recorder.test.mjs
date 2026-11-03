import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostLocalClient} from './bridge/host-local-client.mjs';
const executable=process.env.GALAXY_GO_TEST_BINARY;
const test=(name,fn)=>nodeTest(name,{skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},fn);
import {createOpenCodeWorkRecorder} from './work-recorder.mjs';

async function setup(t){
  const directory=await mkdtemp(join(tmpdir(),'galaxy-work-host-'));
  const closers=[];
  // Node runs after hooks in registration order. Keep shutdown and directory
  // removal in one hook so pending fact writes finish before removal.
  t.after(async()=>{for(const close of closers.reverse())await close();await rm(directory,{recursive:true,force:true});});
  const host=createHostLocalClient({dataDirectory:directory,localOnly:true,executable});
  closers.push(()=>host.close());
  await host.initialize({initializationPath:'personal-galaxy'});
  const history=host.history;
  return{directory,history,beforeCleanup:close=>closers.push(close)};
}
test('actual event shapes record foreground text and tools without opening a Galaxy menu; restart reconciles without duplicates',async t=>{
  const {history,beforeCleanup}=await setup(t),handlers=new Map(),messages=[],parts=new Map();
  const api={app:{version:'fixture'},route:{current:{name:'session',params:{sessionID:'foreground'}}},
    event:{on:(type,handler)=>{handlers.set(type,handler);return()=>handlers.delete(type);}},
    state:{session:{messages:()=>messages},part:id=>parts.get(id)||[],mcp:()=>[]},ui:{toast:()=>{}}};
  let recorder=createOpenCodeWorkRecorder(api,{history,pollMs:60000});beforeCleanup(()=>recorder.close());await recorder.ready;
  const created=Date.now()+20;
  const message={id:'user-message',sessionID:'foreground',role:'user',time:{created},model:{providerID:'fixture',modelID:'own-model'}};
  const text={id:'user-text',sessionID:'foreground',messageID:message.id,type:'text',text:'A'.repeat(3000)};
  messages.push(message);parts.set(message.id,[text]);
  handlers.get('message.updated')({id:'event-1',type:'message.updated',properties:{sessionID:'foreground',info:message}});
  handlers.get('message.part.updated')({id:'event-2',type:'message.part.updated',properties:{sessionID:'foreground',part:text,time:created}});
  const assistant={id:'assistant-message',sessionID:'foreground',role:'assistant',providerID:'fixture',modelID:'own-model',time:{created:created+1,completed:created+2}};
  const tool={id:'tool',sessionID:'foreground',messageID:assistant.id,type:'tool',tool:'synthetic-test',callID:'call',state:{status:'completed',output:'a local result',time:{start:created+1,end:created+2}}};
  messages.push(assistant);parts.set(assistant.id,[tool]);
  handlers.get('message.updated')({id:'event-3',type:'message.updated',properties:{sessionID:'foreground',info:assistant}});
  handlers.get('message.part.updated')({id:'event-4',type:'message.part.updated',properties:{sessionID:'foreground',part:tool,time:created+2}});
  handlers.get('message.updated')({id:'unrelated',type:'message.updated',properties:{sessionID:'unrelated',info:{...message,sessionID:'unrelated'}}});
  await recorder.refresh();
  const work=(await history.list()).items[0],detail=await history.get({workId:work.workId});
  assert.equal((await history.list()).items.length,1);
  assert.ok(detail.observations.some(x=>x.content?.excerpt==='A'.repeat(1200)));
  assert.ok(detail.observations.some(x=>x.kind==='tool'&&x.details.status==='completed'));
  assert.equal(work.outcome,'unknown');
  const count=detail.observations.length;
  await recorder.close();assert.equal(handlers.size,0);
  recorder=createOpenCodeWorkRecorder(api,{history,pollMs:60000});await recorder.ready;
  assert.equal((await history.get({workId:work.workId})).observations.length,count);
  await recorder.close();
});

test('an explicit archive selection backfills only that host session from real message responses',async t=>{
  const {history,beforeCleanup}=await setup(t),owner=await history.identity();
  const calls=[],captured=[];let enabled=false;
  const settings={galaxyId:owner.id,settings:{enabled:false,sessions:[]}};
  const archive={settings:async()=>({...settings,settings:{enabled,sessions:enabled?[{host:'opencode',sessionId:'finished-work'}]:[]}}),
    captureMessage:async input=>{captured.push(input);return{captured:true};}};
  const api={route:{current:{name:'home'}},client:{session:{messages:async input=>{calls.push(input);return{data:[
    {info:{id:'retained-message',sessionID:'finished-work',role:'user',time:{created:1}},parts:[{id:'body',type:'text',text:'Earlier work'}]},
    {info:{id:'other-message',sessionID:'unrelated',role:'user',time:{created:1}},parts:[]}]};}}}};
  const recorder=createOpenCodeWorkRecorder(api,{history,archive,pollMs:60000});beforeCleanup(()=>recorder.close());await recorder.ready;
  assert.deepEqual(calls,[]);
  assert.equal((await recorder.backfillArchive({galaxyId:owner.id,sessionId:'finished-work'})).reason,'not-selected');
  enabled=true;
  const result=await recorder.backfillArchive({galaxyId:owner.id,sessionId:'finished-work'});
  assert.deepEqual(calls,[{sessionID:'finished-work'}]);assert.equal(captured.length,1);
  assert.equal(captured[0].parts[0].text,'Earlier work');assert.equal(result.hostCompleteness,'not-guaranteed');
  assert.equal(result.attachmentsRead,false);assert.equal((await history.list()).items.length,0);
  await recorder.close();
});

test('history uses the real host session title and a late title revision cannot rename current work',async t=>{
 const {history,beforeCleanup}=await setup(t),handlers=new Map();let session={id:'foreground',title:'研究材料整理',time:{updated:10}};
 const api={route:{current:{name:'session',params:{sessionID:'foreground'}}},event:{on:(type,handler)=>{handlers.set(type,handler);return()=>handlers.delete(type);}},
  state:{session:{get:()=>session,messages:()=>[]},part:()=>[],mcp:()=>[]}};
 const recorder=createOpenCodeWorkRecorder(api,{history,pollMs:60000});beforeCleanup(()=>recorder.close());await recorder.ready;
 assert.equal((await history.list()).items[0].title,'研究材料整理');
 session={...session,title:'研究材料与结论草稿',time:{updated:30}};
 handlers.get('session.updated')({type:'session.updated',properties:{sessionID:'foreground',info:session}});await recorder.refresh();
 handlers.get('session.updated')({type:'session.updated',properties:{sessionID:'foreground',info:{...session,title:'迟到旧名称',time:{updated:20}}}});await recorder.refresh();
 assert.equal((await history.list()).items[0].title,'研究材料与结论草稿');
});

test('model selection is recorded as an environment fact without starting a model',async t=>{
 const {history,beforeCleanup}=await setup(t),handlers=new Map(),messages=[],parts=new Map();let prompts=0;
 const api={client:{session:{create:async()=>{prompts++;throw Error('unexpected model call');}}},route:{current:{name:'session',params:{sessionID:'foreground'}}},event:{on:(type,handler)=>{handlers.set(type,handler);return()=>handlers.delete(type);}},
  state:{session:{messages:()=>messages,status:()=>({type:'idle'})},part:id=>parts.get(id)||[],mcp:()=>[]}};
 const recorder=createOpenCodeWorkRecorder(api,{history,pollMs:60000});beforeCleanup(()=>recorder.close());await recorder.ready;
 const created=Date.now()+10,message={id:'writing-goal',sessionID:'foreground',role:'user',time:{created},model:{providerID:'own',modelID:'old-model'}};
 messages.push(message);parts.set(message.id,[{id:'body',messageID:message.id,sessionID:'foreground',type:'text',text:'Draft an outline without claiming it is approved.'}]);
 handlers.get('message.updated')({type:'message.updated',properties:{sessionID:'foreground',info:message}});
 handlers.get('session.next.model.switched')({type:'session.next.model.switched',properties:{sessionID:'foreground',timestamp:created+1,model:{providerID:'own',id:'new-model'}}});await recorder.refresh();
 const detail=await history.get({host:'opencode',sessionId:'foreground'});
 assert.equal(prompts,0);assert.ok(detail.environments.some(item=>item.facts.selectedModel==='own/new-model'));
 assert.ok(detail.work.pending);assert.ok((await history.pending({workId:detail.work.workId})).observations.length);
});

test('tool states use their own revision when host event timestamps are reused',async t=>{
  const {history,beforeCleanup}=await setup(t),handlers=new Map(),messages=[],partList=new Map(),warnings=[];
  const api={route:{current:{name:'session',params:{sessionID:'foreground'}}},
    event:{on:(type,handler)=>{handlers.set(type,handler);return()=>handlers.delete(type);}},
    state:{session:{messages:()=>messages},part:id=>partList.get(id)||[],mcp:()=>[]},
    ui:{toast:warning=>warnings.push(warning)}};
  const recorder=createOpenCodeWorkRecorder(api,{history,pollMs:60000});beforeCleanup(()=>recorder.close());await recorder.ready;
  const timestamp=Date.now()+10,info={id:'assistant-reused-time',sessionID:'foreground',role:'assistant',time:{created:timestamp}};
  const part={id:'tool-reused-time',sessionID:'foreground',messageID:info.id,type:'tool',tool:'fixture',callID:'call',state:{status:'pending'}};
  messages.push(info);partList.set(info.id,[part]);
  const send=()=>handlers.get('message.part.updated')({type:'message.part.updated',properties:{sessionID:'foreground',part,time:timestamp}});
  send();await recorder.refresh();
  part.state={status:'running',time:{start:timestamp}};send();await recorder.refresh();
  part.state={status:'error',error:'fixture error',time:{start:timestamp,end:timestamp}};send();await recorder.refresh();
  const result=await history.get({host:'opencode',sessionId:'foreground'}),states=result.observations.filter(item=>item.source?.partId===part.id).map(item=>item.details.status);
  assert.ok(states.includes('pending')&&states.includes('running')&&states.includes('error'));
  assert.equal(warnings.length,0);
});

test('unselected large attachments stay out of fact recording and tool lengths remain exact',async t=>{
  const {history,beforeCleanup}=await setup(t),owner=await history.identity(),handlers=new Map(),messages=[],parts=new Map();
  let captures=0;
  const archive={settings:async()=>({galaxyId:owner.id,settings:{enabled:false,sessions:[]}}),
    captureMessage:async()=>{captures++;return{captured:true};}};
  const api={route:{current:{name:'session',params:{sessionID:'foreground'}}},
    event:{on:(type,handler)=>{handlers.set(type,handler);return()=>handlers.delete(type);}},
    state:{session:{messages:()=>messages},part:id=>parts.get(id)||[],mcp:()=>[]},ui:{toast:()=>{}}};
  const recorder=createOpenCodeWorkRecorder(api,{history,archive,pollMs:60000});beforeCleanup(()=>recorder.close());await recorder.ready;
  const created=Date.now()+10,info={id:'large-message',sessionID:'foreground',role:'assistant',time:{created,completed:created+1}};
  const large='x'.repeat(10*1024*1024);
  messages.push(info);parts.set(info.id,[
    {id:'large-file',sessionID:'foreground',messageID:info.id,type:'file',filename:'evidence.bin',mime:'application/octet-stream',url:'data:application/octet-stream;base64,'+large},
    {id:'large-tool',sessionID:'foreground',messageID:info.id,type:'tool',tool:'fixture',callID:'call',state:{status:'completed',output:large,time:{start:created,end:created+1}}}
  ]);
  handlers.get('message.updated')({type:'message.updated',properties:{sessionID:'foreground',info}});
  await recorder.refresh();
  const detail=await history.get({host:'opencode',sessionId:'foreground',limit:200});
  const file=detail.observations.find(item=>item.source?.partId==='large-file'),tool=detail.observations.find(item=>item.source?.partId==='large-tool');
  assert.equal(file?.details?.filename,'evidence.bin');
  assert.equal(file?.details?.hostReferenceOnly,true);
  assert.equal(tool?.content?.originalLength,large.length);
  assert.equal(tool?.content?.excerpt?.length,1200);
  assert.equal(captures,0);
});
