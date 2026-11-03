import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createChildRPC} from './child-rpc.mjs';
import {createGoRuntimeBridge} from './go-runtime.mjs';

// Real child processes exercising transport lifecycle, not a Go/host acceptance
// fixture. Each new process must be discovered before tools can be called.
const source=`
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
let discovered=false;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 const name=m.params?.name??m.method;
 if(name==='crash'){appendFileSync(process.argv[3],'crash\\n');process.exit(9);}
 if(name==='invalid'){process.stdout.write('null\\n');return;}
 if(name==='wait')return;
 if(m.method==='server/discover'){discovered=true;reply({supportedVersions:['2026-07-28']});return;}
 if(m.method==='tools/call'&&!discovered){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32600}})+'\\n');return;}
 if(name==='choices'){
  const step=Number(m.params.requestState??0);
  if(step<24){reply({resultType:'input_required',requestState:String(step+1),inputRequests:{choice:{method:'elicitation/create',params:{mode:'form',message:'Choose',requestedSchema:{}}}}});return;}
 }
 reply({content:[{type:'text',text:JSON.stringify({name,pid:process.pid})}]});
});
`;

test('a failed process is not replayed; a new connection rediscovers and supports continued user choices',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-child-lifecycle-')),previous=process.cwd(),log=join(directory,'actions.log');
 await writeFile(join(directory,'native'),source);
 process.chdir(directory);
 const bridge=createGoRuntimeBridge({executable:process.execPath,configPath:log,onInputRequest:async()=>({action:'accept',content:{confirm:true}})});
 t.after(async()=>{await bridge.close();process.chdir(previous);await rm(directory,{recursive:true,force:true});});
 const first=JSON.parse((await bridge.call('read')).content[0].text);
 await assert.rejects(bridge.call('crash'),/native_bridge_process_exited/);
 // No timer or automatic retry starts another process or repeats the action.
 assert.equal(await readFile(log,'utf8'),'crash\n');
 const next=JSON.parse((await bridge.call('read')).content[0].text);
 assert.notEqual(next.pid,first.pid);
 assert.equal(await readFile(log,'utf8'),'crash\n');
 assert.equal(JSON.parse((await bridge.call('choices')).content[0].text).name,'choices');
 const waiting=bridge.call('wait');const rejected=assert.rejects(waiting,/native_bridge_closed/);
 await bridge.close();await rejected;
 await assert.rejects(bridge.call('read'),/native_bridge_closed/);
});

test('shared private RPC reconnects only for a later request; cancellation does not spawn',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'galaxy-private-lifecycle-')),script=join(directory,'private.cjs');
 await writeFile(script,source);
 const rpc=createChildRPC({executable:process.execPath,command:script});
 t.after(async()=>{await rpc.close();await rm(directory,{recursive:true,force:true});});
 const controller=new AbortController();controller.abort();
 await assert.rejects(rpc.request('read',{}, {signal:controller.signal}),/native_bridge_cancelled/);
 const first=rpc.connect();await rpc.request('read');
 const closed=once(first,'close');first.kill();await closed;
 const next=await rpc.request('read');assert.notEqual(JSON.parse(next.content[0].text).pid,first.pid);
 await assert.rejects(rpc.request('read',{}, {connection:first}),/native_bridge_connection_changed/);
 await assert.rejects(rpc.request('invalid'),/native_bridge_protocol_invalid/);
});
