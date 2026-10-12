import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryAtomicUpdate} from './memory-atomic-update.mjs';

test('memory fixture compares and commits synchronously, retaining both updates during delayed completion',async()=>{
 const values=new Map([['count',0]]);let release,entered;
 const started=new Promise(resolve=>{entered=resolve;}),delayed=new Promise(resolve=>{release=resolve;});
 const update=memoryAtomicUpdate(values,async(_key,value)=>{if(value===1){entered();await delayed;}});
 const first=update('count',value=>value+1);await started;assert.equal(await update('count',value=>value+1),2);release();assert.equal(await first,1);assert.equal(values.get('count'),2);
});

test('throwing or asynchronous fixture updater leaves original data intact',async()=>{
 const values=new Map([['draft',{text:'Original'}]]),update=memoryAtomicUpdate(values);
 await assert.rejects(update('draft',value=>{value.text='Changed';throw Error('aborted');}),/aborted/);
 await assert.rejects(update('draft',async()=>({text:'Late'})),/local_update_async_callback/);assert.deepEqual(values.get('draft'),{text:'Original'});
});
