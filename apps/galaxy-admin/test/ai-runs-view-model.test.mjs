import assert from 'node:assert/strict';
import test from 'node:test';
import {aiDuration,aiRecordedNumber,aiRunDetailPath,aiRunDomainLabel,aiRunsHref,aiRunsLocation,aiRunsPath,aiRunStateLabel,aiRunTime,aiRunTrigger,aiSpanInterval,aiSpanRows,aiTimelineRange} from '../src/lib/ai-runs-view-model.ts';

const stamp='2026-10-23T01:00:00.000Z';
function span(id,parent,start,end,trace='trace_1'){return {spanId:id,parentSpanId:parent,traceId:trace,name:id,state:'OK',startTime:new Date(Date.parse(stamp)+start).toISOString(),endTime:new Date(Date.parse(stamp)+end).toISOString(),durationMs:end-start,tokens:{input:null,output:null,total:null},input:{state:'not-recorded',value:null},output:{state:'not-recorded',value:null}};}

test('global native run queries use only supported metadata filters and keep non-UUID native run IDs',()=>{
 const location=aiRunsLocation({run:'run_native-1042',span:'a123',trace:'trace_1',page:'12',domain:'governance',state:'PAUSED',view:'io',query:'private text',operatorId:'foreign',limit:'500'});
 const url=new URL(aiRunsPath(location),'https://admin.invalid');
 assert.deepEqual([...url.searchParams.keys()].sort(),['domain','limit','page','state']);assert.equal(url.searchParams.get('limit'),'25');assert.equal(url.searchParams.get('page'),'12');assert.equal(location.run,'run_native-1042');
 assert.equal(aiRunDetailPath(location.run),'/v1/operations/agentos/runs/run_native-1042');
 assert.equal(aiRunDetailPath('../executions'),null);assert.equal(aiRunDetailPath('run?input=secret'),null);
 const invalid=aiRunsLocation({run:'https://else.invalid',page:'100001',domain:'private-chat-body',state:'SUCCESS',span:'old',trace:'old'});
 assert.equal(invalid.run,'');assert.equal(invalid.span,'');assert.equal(invalid.trace,'');assert.equal(invalid.page,1);assert.equal(invalid.domain,'');assert.equal(invalid.state,'');
});

test('run and step tabs preserve the same selected run, exact trace, filters and page context',()=>{
 const location=aiRunsLocation({run:'run_one',span:'same_span',trace:'trace_a',page:'3',domain:'maintenance',state:'ERROR'});
 const next=aiRunsLocation(Object.fromEntries(new URL(aiRunsHref(location,{view:'feedback'}),'https://admin.invalid').searchParams));
 assert.deepEqual(next,{...location,view:'feedback'});
 const closed=aiRunsLocation(Object.fromEntries(new URL(aiRunsHref(next,{run:'',span:'',trace:''}),'https://admin.invalid').searchParams));
 assert.equal(closed.page,3);assert.equal(closed.domain,'maintenance');assert.equal(closed.state,'ERROR');assert.equal(closed.run,'');
});

test('unknown native metrics stay unknown while an explicitly recorded zero remains zero',()=>{
 assert.equal(aiRecordedNumber(null),'未记录');assert.equal(aiRecordedNumber(undefined),'未记录');assert.equal(aiRecordedNumber(Number.NaN),'未记录');assert.equal(aiRecordedNumber(0),'0');
 assert.equal(aiDuration(null),'未记录');assert.equal(aiDuration(-1),'未记录');assert.equal(aiDuration(0),'0 ms');assert.equal(aiDuration(8600),'8.6 s');assert.equal(aiDuration(400),'400 ms');
 assert.equal(aiRunTime(null),'未记录');assert.equal(aiRunTime('not-a-time'),'未记录');assert.equal(aiRunStateLabel(null),'未记录');assert.equal(aiRunDomainLabel(null),'未记录');
});

test('span hierarchy stays trace-specific, includes missing parents and retains cyclic records without recursion loops',()=>{
 const a=span('parent',null,0,8600),b=span('child','parent',200,600),c=span('child','parent',1000,1200,'trace_2'),d=span('cycle_a','cycle_b',3000,3100),e=span('cycle_b','cycle_a',3000,3100);
 const rows=aiSpanRows([b,c,a,d,e,a]);
 assert.equal(rows.length,5);assert.deepEqual(rows.slice(0,2).map(item=>[item.span.spanId,item.depth]),[['parent',0],['child',1]]);
 const orphan=rows.find(row=>row.span.traceId==='trace_2');assert.equal(orphan.orphan,true);assert.equal(orphan.depth,0);
 assert.equal(new Set(rows.map(row=>row.key)).size,5);
});

test('timeline positions use actual start and end timestamps, never invented end times from a duration label',()=>{
 const root=span('root',null,0,8600),last=span('last','root',8000,8400),range=aiTimelineRange([root,last]),interval=aiSpanInterval(last,range);
 assert.deepEqual(range,{start:Date.parse(stamp),end:Date.parse(stamp)+8600});assert.equal(interval.startMs,8000);assert.equal(interval.endMs,8400);assert.ok(Math.abs(interval.width-400/8600*100)<1e-9);
 assert.equal(aiSpanInterval({...last,durationMs:9999},range).endMs,8400);
 assert.equal(aiSpanInterval({...last,endTime:null},range),null);assert.equal(aiSpanInterval({...last,endTime:stamp},range),null);assert.equal(aiTimelineRange([{...root,startTime:null}]),null);
});

test('automatic and assisted sources come from the actual executor binding without inventing an operator or role',()=>{
 assert.equal(aiRunTrigger({executor:null,role:'administrator'}),'未记录');
 assert.equal(aiRunTrigger({executor:{kind:'ai',mode:'automatic',onBehalfOf:null,grantId:'actual-grant'}}),'系统自动');
 assert.equal(aiRunTrigger({executor:{kind:'program',mode:'assisted',onBehalfOf:'actual-manager',grantId:'actual-grant'}}),'人员代办');
 assert.equal(aiRunStateLabel('COMPLETED'),'已完成');assert.equal(aiRunStateLabel('PAUSED'),'已暂停');
});
