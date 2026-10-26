import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceFixture } from './service-fixture.mjs';
import { builderDeclaration } from './builders-workflow.mjs';
import { createApi } from '../src/http.mjs';
import { createBuilderFlow } from "../src/clients/flows/builder.mjs";
import { createConnectionClient } from "../src/clients/connection.mjs";
import { createSessionMemory } from "../src/infrastructure/session-memory.mjs";
import { createLocalBuilderJournal } from "../src/clients/local/builder-journal.mjs";

test('durable Builder retries survive restart and new bindings while retaining one exact event',async t=>{
  const scopes=['binding','consent','builders'],f=await serviceFixture(scopes),directory=await mkdtemp(join(tmpdir(),'galaxy-builder-retry-'));
  const api=createApi({...f,rateLimit:200});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${api.address().port}`,endpoint=f.access.endpoint;
  const sessions=createSessionMemory({now:()=>f.now,isCurrent:async()=>true});
  t.after(async()=>{sessions.close();api.closeAllConnections();await new Promise(resolve=>api.close(resolve));await f.db.close();await rm(directory,{recursive:true,force:true});});
  // Synthetic public identity matches the fixture signer; no key or token is stored.
  await writeFile(join(directory,'galaxy-id.json'),JSON.stringify(f.genesis));
  await writeFile(join(directory,'galaxy-local-state.json'),JSON.stringify({integration:{},cases:[]}));
  sessions.adopt({endpoint,subjectId:f.actor.subjectId,bindingId:f.actor.bindingId,scopes,expiresAt:f.now+600,bindingExpiresAt:f.now+900,takeCredential:()=>f.credential});
  let failure=null,writes=0;
  const send=async(url,input)=>{
    const path=new URL(url).pathname;
    if(failure==='before-event'&&path==='/v1/builders/events'){failure=null;throw new Error('Synthetic connection dropped before event');}
    const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(input.credential?{Authorization:`Bearer ${input.credential}`}:{})},body:input.bodyJson,signal:input.signal});
    const result=await response.json();if(!response.ok)throw new Error(result.error??'Synthetic request failed');
    if(path==='/v1/builders/events'){writes++;if(failure==='after-event'){failure=null;throw new Error('Synthetic lost acknowledgement');}}
    return result;
  };
  const journal=()=>createLocalBuilderJournal({directory,dataDirectory:directory,endpoint});
  const flow=()=>createBuilderFlow({endpoint,sessions,now:()=>f.now,consentSend:send,builderSend:send,journal:journal(),signIntent:f.signForTest});
  const input={kind:'declare',declaration:builderDeclaration('worker',f.actor.subjectId),visibility:'Public'};
  let host=flow(),preview=await host.prepare(input);failure='after-event';
  await assert.rejects(host.execute(preview,preview.confirmation),/lost acknowledgement/);
  assert.equal((await journal().get(preview.eventId)).status,'unknown');await assert.rejects(journal().forget(preview.eventId),/Reconcile/);
  host=flow();assert.equal((await host.list()).items.length,1);
  assert.equal((await host.reconcile(preview.eventId)).state,'acknowledged');await assert.rejects(host.prepareRetry(preview.eventId),/acknowledged/);
  assert.equal(writes,1);await journal().mark(preview.eventId,f.actor.subjectId,'unknown');assert.equal((await journal().get(preview.eventId)).status,'acknowledged');
  await host.forget(preview.eventId);assert.equal((await host.list()).items.length,0);

  preview=await host.prepare(input);failure='before-event';await assert.rejects(host.execute(preview,preview.confirmation),/before event/);
  host=flow();const retry=await host.prepareRetry(preview.eventId);
  assert.equal(retry.eventId,preview.eventId);assert.equal(retry.payloadJson,preview.payloadJson);assert.equal(retry.intentJson,preview.intentJson);
  await host.execute(retry,retry.confirmation);assert.equal((await host.reconcile(preview.eventId)).state,'acknowledged');

  // The same local identity can renew Consent on a new binding, without changing the event.
  preview=await host.prepare(input);failure='before-event';await assert.rejects(host.execute(preview,preview.confirmation));
  const connection=createConnectionClient({endpoint,trustedKeys:f.bindings.trustedKeys,now:()=>f.now,send,sign:f.signForTest,assertCurrent:async()=>true});
  const connect=connection.prepare({subjectId:f.genesis.id,genesisProof:f.genesis.genesisProof,installationId:randomUUID(),scopes});
  sessions.adopt(await connection.execute(connect,connect.confirmation));host=flow();
  const renewed=await host.prepareRetry(preview.eventId);
  assert.equal(renewed.payloadJson,preview.payloadJson);assert.notEqual(JSON.parse(renewed.intentJson).bindingId,JSON.parse(preview.intentJson).bindingId);
  assert.equal((await journal().get(preview.eventId)).intents.length,2);
  // An old in-flight request may win after the absence check. The new attempt
  // then conflicts, and reconciliation recognizes the previously saved Consent.
  await f.builders.publish(f.actor,{consentId:JSON.parse(preview.intentJson).id,payloadJson:preview.payloadJson});
  await assert.rejects(host.execute(renewed,renewed.confirmation));
  assert.equal((await host.reconcile(preview.eventId)).state,'acknowledged');
  assert.equal((await f.db.query('SELECT id FROM builder_events WHERE id=$1',[preview.eventId])).rows.length,1);
  const stored=await readFile(join(directory,'galaxy-local-state.json'),'utf8');assert.equal(stored.includes(f.credential),false);assert.equal(stored.includes('PRIVATE KEY'),false);
  assert.equal((await f.db.query("SELECT id FROM builder_events WHERE subject_id=$1 AND kind='declare'",[f.actor.subjectId])).rows.length,3);
});
