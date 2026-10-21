import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readdir,readFile,writeFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createRuntimeLogger,consoleRuntimeLogger,runtimeLogConfiguration,runtimeLogEvent } from '../src/operations/runtime-log.mjs';
import { createOperationalMetrics } from '../src/operations/metrics.mjs';

test('actual JSONL rotation compresses, caps archives and survives restart without touching adjacent files',async()=>{
  assert.deepEqual(runtimeLogEvent({event:'builder_probe_job',state:'reachable',endpoint:'private-endpoint-value'}),{event:'builder_probe_job',state:'reachable'});
  const directory=await mkdtemp(join(tmpdir(),'galaxy-runtime-log-'));
  try{
    const logger=await createRuntimeLogger({component:'api',directory,rotateBytes:1024,maxFiles:2});
    const own=join(directory,'api-primary'),keep=join(own,'keep.txt');await writeFile(keep,'unrelated');
    for(let count=0;count<300;count++)logger.write({event:'expired_exports_removed',count,body:{password:'do-not-log'},authorization:'do-not-log'});
    await logger.close();assert.ok(logger.status().rotations>2);
    let files=await readdir(own);assert.equal(files.filter(name=>name.endsWith('.gz')).length,2);
    const records=[];
    for(const file of files.filter(name=>name.endsWith('.jsonl')||name.endsWith('.gz'))){
      const bytes=await readFile(join(own,file)),text=(file.endsWith('.gz')?gunzipSync(bytes):bytes).toString();
      assert.doesNotMatch(text,/do-not-log|authorization|password/);
      for(const line of text.trim().split('\n').filter(Boolean))records.push(JSON.parse(line));
      if(process.platform!=='win32')assert.equal((await stat(join(own,file))).mode&0o077,0);
    }
    assert.ok(records.every(row=>row.component==='api'&&Number.isFinite(Date.parse(row.time))));
    assert.ok(Math.min(...records.map(row=>row.count))>0);assert.equal(Math.max(...records.map(row=>row.count)),299);
    const resumed=await createRuntimeLogger({component:'api',directory,rotateBytes:1024,maxFiles:2});
    resumed.write({event:'expired_exports_removed',count:300});await resumed.close();
    files=await readdir(own);assert.equal(files.filter(name=>name.endsWith('.gz')).length,2);
    assert.equal(await readFile(keep,'utf8'),'unrelated');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('blocked log sink bounds buffering and exposes dropped events without raw fallback output',async()=>{
  let pending,blocked=true;const lines=[],fallback=[];
  const sink=new Writable({write(chunk,_encoding,callback){lines.push(chunk.toString());if(blocked)pending=callback;else callback();}});
  const logger=consoleRuntimeLogger('api',{destination:sink,maxBufferedBytes:1024,fallback:{write:line=>fallback.push(line)}});
  for(let i=0;i<30;i++)logger.write({status:500,code:'private_token_value',body:'private_token_value',request:{cookie:'private_token_value'}});
  assert.ok(logger.status().droppedRecords>0);assert.ok(sink.writableLength<=1024);
  assert.equal(fallback.length,1);assert.doesNotMatch(lines.join('')+fallback.join(''),/private_token_value/);
  blocked=false;pending();sink.end();await finished(sink);await logger.close();
});

test('write failure reaches runtime metrics and never serializes the original error',async()=>{
  const fallback=[];
  const sink=new Writable({write(_chunk,_encoding,callback){callback(new Error('private-disk-path-and-secret'));}});
  const logger=consoleRuntimeLogger('worker',{destination:sink,fallback:{write:line=>fallback.push(line)}});
  const closed=once(sink,'close').catch(()=>{});logger.write({event:'evidence_job_failed'});await closed;
  const metrics=createOperationalMetrics({component:'worker',defaultMetrics:false,logStatus:logger.status});
  const text=await metrics.render();
  assert.match(text,/galaxy_runtime_log_ready\{component="worker"\} 0/);
  assert.match(text,/kind="writeFailures"[^\n]* 1/);
  assert.doesNotMatch(fallback.join('')+text,/private-disk-path-and-secret/);
  await logger.close();
  assert.throws(()=>runtimeLogConfiguration({GALAXY_RUNTIME_LOG_DIRECTORY:'relative'}));
});

test('shared sink preserves release/environment, supports a strict Native formatter and rejects a broken formatter',async()=>{
  const lines=[],sink=new Writable({write(chunk,_encoding,done){lines.push(chunk.toString());done();}});
  const logger=consoleRuntimeLogger('native',{destination:sink,release:'0.1.17',environment:'local',
    eventFormatter:input=>({event:input.event==='native_ready'?'native_ready':'runtime_event_rejected',stage:'startup'})});
  logger.write({event:'native_ready',body:'private-tool-input'});logger.updateContext({release:'0.1.18'});
  logger.write({event:'native_ready'});await logger.close();sink.end();await finished(sink);
  const records=lines.map(line=>JSON.parse(line));
  assert.deepEqual(records.map(row=>row.release),['0.1.17','0.1.18']);
  assert.ok(records.every(row=>row.environment==='local'&&row.component==='native'&&row.event==='native_ready'));
  assert.doesNotMatch(lines.join(''),/private-tool-input/);
  const fallback=[],broken=consoleRuntimeLogger('api',{destination:new Writable({write(_chunk,_encoding,done){done();}}),
    eventFormatter:()=>null,fallback:{write:line=>fallback.push(line)}});
  broken.write({password:'private-password'});assert.equal(broken.status().droppedRecords,1);
  assert.doesNotMatch(fallback.join(''),/private-password/);await broken.close();
});
