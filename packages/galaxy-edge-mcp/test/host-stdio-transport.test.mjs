import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createJsonRpcStdio} from '../src/native-v2/host-adapters/json-rpc-stdio.mjs';

async function fixture(body,run){
  const directory=await mkdtemp(join(tmpdir(),'galaxy-host-rpc-')),file=join(directory,'fixture.mjs');
  try{await writeFile(file,body);await run(file);}finally{
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+'/')||resolve(directory).startsWith(resolve(tmpdir())+'\\'));
    await rm(directory,{recursive:true,force:true});
  }
}
test('real stdio subprocess keeps text literal, handles split response frames and shared shutdown',async()=>{
  await fixture("import readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return; const response=JSON.stringify({id:m.id,result:{literal:m.params.text}})+'\\n';process.stdout.write(response.slice(0,7));setTimeout(()=>process.stdout.write(response.slice(7)),5);});",async file=>{
    const rpc=createJsonRpcStdio({command:process.execPath,args:[file],requestTimeoutMs:1000,closeTimeoutMs:100});
    const text='`$(do not execute); "secret-like literal"';assert.equal((await rpc.request('echo',{text})).literal,text);
    const first=rpc.close();assert.equal(first,rpc.close());await first;
    await assert.rejects(rpc.request('echo',{text}),/disconnected/);
  });
});
for(const payload of ['null','x'.repeat(300)])test('invalid or oversized real host frame is rejected and owned process released: '+payload.slice(0,4),async()=>{
  await fixture("process.stdin.on('data',()=>process.stdout.write("+JSON.stringify(payload+'\n')+"));",async file=>{
    const rpc=createJsonRpcStdio({command:process.execPath,args:[file],maxFrameBytes:100,requestTimeoutMs:1000,closeTimeoutMs:100});
    await assert.rejects(rpc.request('invalid'),/host_protocol_invalid|host_frame_too_large/);await rpc.close();
  });
});
