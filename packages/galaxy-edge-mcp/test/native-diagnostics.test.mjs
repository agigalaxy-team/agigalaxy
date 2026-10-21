import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {consoleRuntimeLogger} from '../../galaxy-official/src/operations/runtime-log.mjs';
import {createNativeDiagnosticReporter,nativeDiagnosticFields,registerDiagnosticTool,safeNativeError} from '../src/native-v2/diagnostics.mjs';

function capture(){
  const lines=[];
  const destination=new Writable({write(chunk,_encoding,done){lines.push(String(chunk));done();}});
  const sink=consoleRuntimeLogger('native',{destination,eventFormatter:nativeDiagnosticFields,release:'fixture',environment:'test'});
  return {reporter:createNativeDiagnosticReporter(sink),records:()=>lines.flatMap(line=>line.trim().split('\n').filter(Boolean).map(value=>JSON.parse(value)))};
}

test('Native diagnostics retain shipped source locations and discard private error/argument data',()=>{
  const secret='synthetic-private-value';
  const error=Object.assign(new TypeError('prompt '+secret),{code:secret,token:secret,path:'C:/private/'+secret});
  error.stack='TypeError: '+secret+'\n    at '+secret+' (C:/private/'+secret+'/packages/galaxy-edge-mcp/src/native-v2/runtime.mjs:18:4)'
    +'\n    at request (https://example.invalid/private/'+secret+'?code='+secret+':20:9)'
    +'\n    at run (C:/private/'+secret+'/message.txt:1:1)\n    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)';
  error.cause=error;
  const fields=nativeDiagnosticFields({event:'native_tool',stage:'tool',outcome:'failed',tool:'galaxy_'+secret,
    requestId:secret,upstreamRequestId:secret,arguments:{text:secret},body:secret,cookie:secret,error});
  assert.equal(fields.errorCode,'native_operation_failed');
  assert.equal(fields.errorName,'TypeError');
  assert.deepEqual(fields.stackFrames,[{file:'packages/galaxy-edge-mcp/src/native-v2/runtime.mjs',line:18,column:4},{file:'node:internal/process/task_queues',line:103,column:5}]);
  assert.ok(!JSON.stringify(fields).includes(secret));
  assert.equal(fields.tool,undefined);
  assert.equal(safeNativeError(Error('native_bridge_response_unknown')).errorCode,'native_bridge_response_unknown');
});

test('real Pino output correlates nested work and never serializes results or input values',async()=>{
  const {reporter,records}=capture();registerDiagnosticTool('galaxy_native_status');
  const original={privateBody:'synthetic-private-result'};
  const returned=await reporter.run('tool',async()=>{
    await reporter.run('http',async()=>{reporter.emit({event:'native_http',stage:'http',outcome:'succeeded',status:200,
      upstreamRequestId:'12345678-1234-4234-8234-123456789012',body:'synthetic-private-input'});});
    return original;
  },{event:'native_tool',tool:'galaxy_native_status'});
  assert.equal(returned,original);
  const emitted=records();
  assert.ok(emitted.length>=4);
  assert.equal(new Set(emitted.map(value=>value.requestId)).size,1);
  assert.match(emitted[0].requestId,/^[0-9a-f-]{36}$/);
  assert.equal(emitted[0].tool,'galaxy_native_status');
  assert.ok(emitted.some(value=>value.upstreamRequestId==='12345678-1234-4234-8234-123456789012'));
  assert.ok(emitted.some(value=>value.durationMs>=0));
  assert.ok(!JSON.stringify(emitted).includes('synthetic-private'));
  await reporter.close();
});

test('failed diagnostics do not alter original errors, values or deferred operation ordering',async()=>{
  const reporter=createNativeDiagnosticReporter({write(){throw Error('sink unavailable');},error(){throw Error('sink unavailable');},status:()=>({ready:false}),close:async()=>{}});
  let observed=false;
  const value={ok:true},task=reporter.run('tool',()=>{observed=true;return value;},{event:'native_tool'});
  assert.equal(observed,false);
  assert.equal(await task,value);
  const original=Error('native_identity_required');
  await assert.rejects(reporter.run('tool',()=>{throw original;},{event:'native_tool'}),error=>error===original);
});

test('Native bursts are bounded without retaining rejected event payloads',async()=>{
  const {reporter,records}=capture();
  for(let n=0;n<200;n++)reporter.emit({event:'native_runtime',stage:'runtime',outcome:'started',arguments:{text:'discard-this-body'}});
  assert.ok(records().length<=128);
  assert.ok(reporter.status().rateLimitedRecords>=72);
  assert.ok(!JSON.stringify(records()).includes('discard-this-body'));
  await reporter.close();
});
