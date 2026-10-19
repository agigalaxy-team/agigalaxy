import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeLocalGalaxyId} from '../../../packages/galaxy-core/src/application/local-operations.mjs';
import {createLocalWorkHistory} from '../../../packages/galaxy-core/src/work-history/index.mjs';
import {createOpenCodeWorkRecorder} from './work-recorder.mjs';
import {createOpenCodeWorkSummarizer} from './work-summarizer.mjs';
import {setTimeout as delay} from 'node:timers/promises';

async function setup(t){
  const directory=await mkdtemp(join(tmpdir(),'galaxy-work-host-'));
  const closers=[];
  // Node runs after hooks in registration order. Keep shutdown and directory
  // removal in one hook so pending summary/fact writes finish before removal.
  t.after(async()=>{for(const close of closers.reverse())await close();await rm(directory,{recursive:true,force:true});});
  await initializeLocalGalaxyId(directory);
  const history=createLocalWorkHistory({dataDirectory:directory});
  return{directory,history,beforeCleanup:close=>closers.push(close)};
}
async function eventually(predicate){for(let i=0;i<100;i++){if(await predicate())return;await delay(10);}assert.fail('Asynchronous host processing did not finish');}

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

test('the SDK model call actually saves an incremental sourced summary; model failure leaves facts pending',async t=>{
  const {history,beforeCleanup}=await setup(t);
  const first=await history.recordNote({host:'opencode',sessionId:'original',sourceId:'statement',text:'We drafted a report, but have not reviewed the conclusions.'});
  let calls=0,createInput,promptInput;
  const sdk={create:async input=>{createInput=input;return{data:{id:'summary-child'}};},
    prompt:async input=>{calls++;promptInput=input;return{data:{info:{id:'generated-message'},parts:[{type:'text',text:JSON.stringify({title:'Report draft',summary:'A draft exists; conclusions remain unreviewed.',outcome:'partial'})}]}};},
    update:async()=>({data:{}}),abort:async()=>({data:{}})};
  let summarizer=createOpenCodeWorkSummarizer({client:{session:sdk}},history,{delayMs:0});beforeCleanup(()=>summarizer.close());
  summarizer.schedule({galaxyId:first.galaxyId,workId:first.workId,sessionId:'original',model:{providerID:'fixture',modelID:'user-selected'}});
  await eventually(async()=>!(await history.get({workId:first.workId})).work.pending);
  assert.equal(calls,1);
  assert.deepEqual(createInput.permission,[{permission:'*',pattern:'*',action:'deny'}]);
  assert.equal(promptInput.sessionID,'summary-child');
  assert.equal(promptInput.model.modelID,'user-selected');
  assert.equal(promptInput.format,undefined,'the tool-denied child does not request host tool-based structured output');
  assert.deepEqual(JSON.parse(promptInput.parts[0].text.split('\n').at(-1)).outputSchema.required,['title','summary','outcome']);
  const summary=(await history.get({workId:first.workId})).summaries[0];
  assert.equal(summary.execution.messageId,'generated-message');
  assert.equal(summary.sourceKind,'user-model');
  await summarizer.close();
  await history.recordNote({host:'opencode',sessionId:'original',sourceId:'new-material',text:'A later unresolved question.'});
  summarizer=createOpenCodeWorkSummarizer({client:{session:{...sdk,prompt:async()=>{throw Error('fixture provider unavailable');}}}},history,{delayMs:0});
  summarizer.schedule({galaxyId:first.galaxyId,workId:first.workId,sessionId:'original',model:{providerID:'fixture',modelID:'user-selected'}});
  await eventually(async()=>(await history.pending({workId:first.workId})).processing.state==='failed');
  assert.equal((await history.pending({workId:first.workId})).observations.length,1);
  assert.equal((await history.get({workId:first.workId})).summaries.length,1);
  await summarizer.close();
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

test('a temporary model failure resumes automatically without another menu action',async t=>{
 const {history,beforeCleanup}=await setup(t),work=await history.recordNote({host:'opencode',sessionId:'original',text:'We compared two outlines; neither has been approved.'});
 let calls=0;const archived=[];
 const api={client:{session:{create:async()=>({data:{id:'summary-'+calls}}),prompt:async()=>{
  if(++calls===1)throw Error('synthetic temporary provider failure');
  return{data:{info:{id:'recovered-summary'},parts:[{type:'text',text:JSON.stringify({title:'Outline comparison',summary:'Two outlines were compared. Approval remains unknown.',outcome:'unknown'})}]}};
 },update:async input=>{archived.push(input.sessionID);return{data:{}};}}}};
 const summarizer=createOpenCodeWorkSummarizer(api,history,{delayMs:0,retryDelaysMs:[10,20]});beforeCleanup(()=>summarizer.close());
 summarizer.schedule({galaxyId:work.galaxyId,workId:work.workId,sessionId:'original',model:{providerID:'own',modelID:'configured'}});
 await eventually(async()=>!(await history.get({workId:work.workId})).work.pending);
 assert.equal(calls,2);assert.equal((await history.get({workId:work.workId})).work.outcome,'unknown');assert.equal(archived.length,2);
});

test('the same failed material has a finite retry budget; a model switch resumes its retained work',async t=>{
 const {history,beforeCleanup}=await setup(t),work=await history.recordNote({host:'opencode',sessionId:'original',text:'A result still needs review.'});
 let calls=0;
 const sdk={create:async()=>({data:{id:'child-'+calls}}),prompt:async input=>{
  calls++;if(input.model.modelID==='unavailable')throw Error('synthetic unavailable provider');
  return{data:{info:{},parts:[{type:'text',text:JSON.stringify({title:'Pending review',summary:'The reported result remains unreviewed.',outcome:'unknown'})}]}};
 },update:async()=>({data:{}})};
 const summarizer=createOpenCodeWorkSummarizer({client:{session:sdk}},history,{delayMs:0,retryDelaysMs:[5,10]});beforeCleanup(()=>summarizer.close());
 const request={galaxyId:work.galaxyId,workId:work.workId,sessionId:'original',model:{providerID:'own',modelID:'unavailable'}};
 summarizer.schedule(request);await eventually(()=>calls===3);await delay(25);
 for(let i=0;i<5;i++){summarizer.schedule(request);await delay(5);}
 assert.equal(calls,3,'Idle reconciliation does not spend model requests indefinitely.');assert.equal((await history.pending({workId:work.workId})).observations.length,1);
 summarizer.schedule({...request,model:{providerID:'own',modelID:'restored'}},{modelChanged:true});
 await eventually(async()=>!(await history.get({workId:work.workId})).work.pending);assert.equal(calls,4);
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

test('the actual SDK model-switch ModelRef.id becomes prompt.modelID without a manual summary action',async t=>{
 const {history,beforeCleanup}=await setup(t),handlers=new Map(),messages=[],parts=new Map(),prompts=[];
 const sdk={create:async()=>({data:{id:'summary-child'}}),prompt:async input=>{prompts.push(input);return{data:{info:{},parts:[{type:'text',text:JSON.stringify({title:'Current writing',summary:'The writing goal is recorded; the result remains unknown.',outcome:'unknown'})}]}};},update:async()=>({data:{}})};
 const api={client:{session:sdk},route:{current:{name:'session',params:{sessionID:'foreground'}}},event:{on:(type,handler)=>{handlers.set(type,handler);return()=>handlers.delete(type);}},
  state:{session:{messages:()=>messages,status:()=>({type:'idle'})},part:id=>parts.get(id)||[],mcp:()=>[]}};
 const recorder=createOpenCodeWorkRecorder(api,{history,pollMs:60000});beforeCleanup(()=>recorder.close());await recorder.ready;
 const created=Date.now()+10,message={id:'writing-goal',sessionID:'foreground',role:'user',time:{created},model:{providerID:'own',modelID:'old-model'}};
 messages.push(message);parts.set(message.id,[{id:'body',messageID:message.id,sessionID:'foreground',type:'text',text:'Draft an outline without claiming it is approved.'}]);
 handlers.get('message.updated')({type:'message.updated',properties:{sessionID:'foreground',info:message}});
 handlers.get('session.next.model.switched')({type:'session.next.model.switched',properties:{sessionID:'foreground',timestamp:created+1,model:{providerID:'own',id:'new-model'}}});await recorder.refresh();
 for(let i=0;i<300&&!prompts.length;i++)await delay(10);
 assert.equal(prompts.length,1);assert.deepEqual(prompts[0].model,{providerID:'own',modelID:'new-model'});
});
