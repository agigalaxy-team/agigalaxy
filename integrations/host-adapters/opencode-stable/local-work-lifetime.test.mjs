import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {createHostLocalClient} from './bridge/host-local-client.mjs';
const executable=process.env.GALAXY_GO_TEST_BINARY;
import {createGalaxyAdapter} from './galaxy.tui.ts';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function eventually(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(5);}assert.fail('The requested local dialog did not appear');}

test('late local list, detail and pagination results cannot reopen an exited or replaced OpenCode page',{timeout:30000,skip:!executable&&'Set GALAXY_GO_TEST_BINARY to the development Go executable'},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-local-page-')),commands=new Map(),waits=[];let page=null,cleanup=null,blocked=null,adapter;
  const host=createHostLocalClient({dataDirectory:directory,localOnly:true,executable});
  await host.initialize({initializationPath:'personal-galaxy'});const history=host.history;
  for(let index=0;index<7;index++){const text='Synthetic local note '+index;await history.observe({host:'opencode',sessionId:'synthetic-'+index,sourceId:'statement',kind:'claim',title:'本机工作 '+index,source:{kind:'user-statement'},content:{excerpt:text,originalLength:text.length,retained:'full'},details:{statementOnly:true}});}
  const gate=fail=>{const entered=deferred(),done=deferred();blocked={entered,done,fail};waits.push(blocked);return blocked;};
  try{
    const guarded=method=>async input=>{const waiting=blocked;if(waiting){blocked=null;waiting.entered.resolve();await waiting.done.promise;if(waiting.fail)throw Error('synthetic_read_failure');}return history[method](input);};const persistence={...host,history:{...history,list:guarded('list'),get:guarded('get')}};
    adapter=createGalaxyAdapter(null,{dataDirectory:directory,hostPersistence:persistence,nativeTools:{call:async()=>{throw Error('no_online_call_expected');}}});
    await adapter.tui({keymap:{registerLayer:({commands:entries})=>{for(const command of entries)commands.set(command.name,command);return()=>{for(const command of entries)if(commands.get(command.name)===command)commands.delete(command.name);};}},
      ui:{dialog:{setSize(){},clear(){const old=cleanup;cleanup=null;page=null;old?.();},replace(render,onClose){const old=cleanup;cleanup=onClose;old?.();page=render();}},DialogSelect:props=>({kind:'select',...props}),DialogAlert:props=>({kind:'alert',...props}),DialogPrompt:props=>({kind:'prompt',...props})}});
    const open=async()=>{commands.get('galaxy.open').run();await eventually(()=>page?.kind==='select'&&page.options.some(option=>option.value==='8'));};
    const choose=async value=>{const option=page?.options?.find(item=>item.value===value);assert.ok(option,'missing option '+value);option.onSelect();await turn();await delay(1);};
    const settle=async waiting=>{waiting.done.resolve();await history.list();await turn();await turn();};

    for(const fail of [false,true]){
      await open();const waiting=gate(fail);await choose('8');await waiting.entered.promise;
      assert.equal(page.kind,'alert');commands.get('galaxy.exit').run();assert.equal(page,null);
      await settle(waiting);assert.equal(page,null,'neither late success nor late failure may reopen the dismissed dialog');
    }
    await open();await choose('8');await eventually(()=>page?.kind==='select'&&page.options.some(option=>option.value==='n'));
    const next=gate(false);await choose('n');await next.entered.promise;commands.get('galaxy.exit').run();await settle(next);assert.equal(page,null);

    await open();await choose('8');await eventually(()=>page?.kind==='select'&&page.options.some(option=>option.value==='1'));
    const details=gate(false);await choose('1');await details.entered.promise;await open();const replacement=page;
    await settle(details);assert.equal(page,replacement,'a detail read may not replace a new console page');
  }finally{
    for(const waiting of waits)waiting.done.resolve();await adapter?.close();await host.close();
    const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-local-page-'));
    await rm(target,{recursive:true,force:true});
  }
});
