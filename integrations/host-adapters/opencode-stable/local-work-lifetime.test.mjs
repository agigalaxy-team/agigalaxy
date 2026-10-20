import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {initializeLocalGalaxyId,getLocalSnapshot} from '../../../packages/galaxy-core/src/application/local-operations.mjs';
import {createLocalWorkHistory} from '../../../packages/galaxy-core/src/work-history/index.mjs';
import {createGalaxyAdapter} from './galaxy.tui.ts';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function eventually(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(5);}assert.fail('The requested local dialog did not appear');}

test('late local list, detail and pagination results cannot reopen an exited or replaced OpenCode page',{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'galaxy-local-page-')),commands=new Map(),waits=[];let page=null,cleanup=null,blocked=null,adapter;
  await initializeLocalGalaxyId(directory);const owner=(await getLocalSnapshot(directory)).identity,history=createLocalWorkHistory({dataDirectory:directory});
  for(let index=0;index<7;index++)await history.recordNote({host:'opencode',sessionId:'synthetic-'+index,text:'Synthetic local note '+index,title:'本机工作 '+index,sourceKind:'user-statement'});
  const gate=fail=>{const entered=deferred(),done=deferred();blocked={entered,done,fail};waits.push(blocked);return blocked;};
  try{
    adapter=createGalaxyAdapter(null,{dataDirectory:directory,nativeTools:{call:async()=>{throw Error('no_online_call_expected');}},
      readLocalIdentity:async()=>{const waiting=blocked;if(waiting){blocked=null;waiting.entered.resolve();await waiting.done.promise;if(waiting.fail)throw Error('synthetic_read_failure');}return owner;}});
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
    for(const waiting of waits)waiting.done.resolve();await adapter?.close();
    const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('galaxy-local-page-'));
    await rm(target,{recursive:true,force:true});
  }
});
