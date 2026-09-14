import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatMaintenance} from '../src/operations/chat-maintenance-v2.mjs';
test('retention does not overlap, continues independent cleanup, and resumes the same failed source page',async()=>{
  let release,calls=0,fail=true;
  const blocked=new Promise(resolve=>{release=resolve;}),pages=[],logs=[],shared=[];
  const maintenance=createChatMaintenance({transport:{available:true},chat:{async purgeExpired(){calls++;if(calls===1)await blocked;}},
    summaries:{async purgeExpired(){},async purgeInvalidSources(input){pages.push(input.after);if(fail){fail=false;throw new Error('sensitive payload never logged');}return{nextAfter:input.after?null:'00000000-0000-4000-8000-000000000001'};}},
    sharedSummaries:{async purgeExpired(){shared.push('expired');},async purgeInvalidSources(){return{nextAfter:null};}},logger:entry=>logs.push(entry)});
  const first=maintenance.tick();assert.equal(maintenance.tick(),first);assert.equal(calls,1);
  release();await first;await maintenance.tick();await maintenance.tick();
  assert.deepEqual(pages,[null,null,'00000000-0000-4000-8000-000000000001']);
  assert.equal(shared.length,3);assert.deepEqual(logs,[{event:'chat_retention_deferred',component:'personal-sources'}]);
  maintenance.quiesce();await maintenance.drain();await maintenance.tick();assert.equal(calls,3);
});
