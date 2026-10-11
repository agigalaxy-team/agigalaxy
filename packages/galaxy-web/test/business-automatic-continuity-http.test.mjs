import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from '../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs';
import {getContributionClient} from '../src/contribution-client.mjs';

async function fixture(t){const f=await privacyConsumerFixture();t.after(()=>f.close());return f;}
async function contribution(f){
 const subjectId=f.original.subjectId,id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,expectedVersion:0,
  actorId:subjectId,localRef:randomUUID(),title:'本次隔离贡献',summary:'私有正文不应随贡献公开',synthetic:true,source:{kind:'local',reference:randomUUID()}};
 await f.runtime.api.call('/v2/cases/events',await f.runtime.api.authorizePayload(root,{action:'case.teaser.publish',objectId:id,confirmed:true}));
 const sources=await f.runtime.api.call('/v2/contributions/sources',{kind:'case-event',parentId:id});
 const input={id:randomUUID(),kind:'publish',sourceRefs:[{...sources.items[0].source,fields:['eventType','actorId']}],purposes:['honor'],
  purpose:'public-contribution-projections-only',expiresAt:new Date((f.now()+3600)*1000).toISOString(),redactionConfirmed:true,
  publicationScope:'selected-fields-and-bounded-purpose-conclusions; original-text-permissions-unchanged'};
 return{input,client:getContributionClient(f.runtime,subjectId,{now:f.now})};
}
const writes=(f,path)=>f.requests.filter(item=>item.path===path).length;
const deletion={action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};

test('confirmed contribution resumes an absent original with the same fields, purposes and deadline; accepted unknown results do not repeat writes',async t=>{
 const f=await fixture(t),{client,input}=await contribution(f);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('isolated consent before delivery');}};
 await assert.rejects(client.submit(input,{confirmed:true}),/isolated consent before delivery/);
 const original=(await client.local()).pending;f.setTime(f.now()+301);
 assert.equal((await client.resumePending()).state,'published');assert.equal((await client.local()).pending,null);
 const stored=(await f.f.db.query('SELECT payload_text,consent_id FROM contribution_publications WHERE id=$1',[input.id])).rows[0];
 const grant=(await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[stored.consent_id])).rows[0].intent;
 assert.equal(stored.payload_text,original.payloadJson);assert.equal(grant.expiresAt,original.prepared.intent.expiresAt);
 assert.equal(grant.bindingId,original.prepared.intent.bindingId);assert.notEqual(grant.id,original.prepared.intent.id);
 assert.deepEqual(JSON.parse(stored.payload_text).purposes,['honor']);assert.deepEqual(JSON.parse(stored.payload_text).sourceRefs[0].fields,['eventType','actorId']);
 let lose=true;f.wireHooks.after=(path,response)=>{if(lose&&path==='/v2/contributions/publish'){lose=false;assert.equal(response.status,200);throw Error('isolated contribution ACK lost');}};
 await assert.rejects(client.submit({...input,id:randomUUID()},{confirmed:true}),/isolated contribution ACK lost/);
 const before=writes(f,'/v2/contributions/publish');assert.equal((await client.resumePending()).state,'published');assert.equal(writes(f,'/v2/contributions/publish'),before);
});
test('contribution recovery keeps a missing Consent in a changed binding or an unsigned legacy journal read-only',async t=>{
 const f=await fixture(t),{client,input}=await contribution(f);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('isolated consent before delivery');}};
 await assert.rejects(client.submit(input,{confirmed:true}));const original=(await client.local()).pending;
 f.setTime(f.now()+301);await f.runtime.connect({confirmed:true});let start=f.requests.length;
 assert.equal((await client.resumePending()).reason,'original-binding-changed');
 assert.ok(f.requests.slice(start).every(item=>item.path!=='/v1/consents'&&item.path!=='/v2/contributions/publish'));
 assert.equal((await client.local()).pending.prepared.signedIntent,original.prepared.signedIntent);assert.equal((await client.local()).pending.payloadJson,original.payloadJson);
 assert.equal((await client.reconcile({retry:true,reauthorize:true,confirmed:true})).state,'published');
 const accepted=(await f.f.db.query('SELECT payload_text,consent_id FROM contribution_publications WHERE id=$1',[original.payload.id])).rows[0],
  grant=(await f.f.db.query('SELECT intent FROM consents WHERE id=$1',[accepted.consent_id])).rows[0].intent;
 assert.equal(accepted.payload_text,original.payloadJson);assert.equal(grant.expiresAt,original.authorizationExpiresAt);
 assert.equal(grant.bindingId,f.runtime.api.snapshot().bindingId);assert.notEqual(grant.bindingId,original.prepared.intent.bindingId);
 drop=true;await assert.rejects(client.submit({...input,id:randomUUID()},{confirmed:true}));
 const key=`contribution-operations:${f.original.subjectId}`;
 await f.runtime.updateLocal(key,state=>{const pending={...state.pending};delete pending.prepared;delete pending.authorizationBindingId;delete pending.submission;return{...state,pending};});
 start=f.requests.length;assert.equal((await client.resumePending()).reason,'original-binding-unavailable');
 assert.ok(f.requests.slice(start).every(item=>item.path!=='/v1/consents'&&item.path!=='/v2/contributions/publish'));
});

test('automatic contribution recovery never publishes an expired or explicitly stopped original journal',async t=>{
 const f=await fixture(t),{client,input}=await contribution(f);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('isolated consent before delivery');}};
 await assert.rejects(client.submit({...input,expiresAt:new Date((f.now()+10)*1000).toISOString()},{confirmed:true}),/isolated consent before delivery/);
 const original=(await client.local()).pending;
 // This explicit durable marker represents the owner stopping local retries;
 // it does not claim a remote revocation or alter the publication's content.
 await f.runtime.putLocal(`contribution-operations:${f.original.subjectId}`,{...await client.local(),pending:{...original,localRetryStopped:true}});
 let before=writes(f,'/v1/consents');assert.equal((await client.resumePending()).reason,'stopped-local');assert.equal(writes(f,'/v1/consents'),before);
 await f.runtime.putLocal(`contribution-operations:${f.original.subjectId}`,{...await client.local(),pending:original});
 f.setTime(f.now()+11);before=f.requests.length;assert.equal((await client.resumePending()).reason,'authorization-expired');
 assert.equal(f.requests.slice(before).filter(item=>item.path==='/v1/consents'||item.path==='/v2/contributions/publish').length,0);
 assert.equal((await client.local()).pending.payloadJson,original.payloadJson);
});

test('a fresh explicit contribution can replace a stopped or expired local slot without deleting its exact original receipt',async t=>{
 const f=await fixture(t),{client,input}=await contribution(f);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('isolated original before delivery');}};
 await assert.rejects(client.submit(input,{confirmed:true}));let original=(await client.local()).pending;
 await f.runtime.updateLocal(`contribution-operations:${f.original.subjectId}`,state=>({...state,pending:{...state.pending,localRetryStopped:true}}));
 assert.equal((await client.resumePending()).reason,'stopped-local');assert.equal((await client.local()).pending.canStartNewSelection,true);
 const freshId=randomUUID();assert.equal((await client.submit({...input,id:freshId},{confirmed:true})).state,'published');
 let archive=(await client.previousOperations()).find(row=>row.operationId===original.payload.id);
 assert.equal(archive.payloadHash,original.payloadHash);assert.equal(archive.payload,undefined);assert.equal(archive.sourceRefs,undefined);
 let before=f.requests.length;assert.equal((await client.reconcilePrevious(original.payload.id)).state,'unconfirmed');
 assert.ok(f.requests.slice(before).every(row=>row.path==='/v2/contributions/status'));
 drop=true;await assert.rejects(client.submit({...input,id:randomUUID(),expiresAt:new Date((f.now()+10)*1000).toISOString()},{confirmed:true}));
 original=(await client.local()).pending;f.setTime(f.now()+11);assert.equal((await client.resumePending()).reason,'authorization-expired');
 assert.equal((await client.local()).pending.canStartNewSelection,true);
 const next=randomUUID();assert.equal((await client.submit({...input,id:next,expiresAt:new Date((f.now()+3600)*1000).toISOString()},{confirmed:true})).state,'published');
 archive=(await client.previousOperations()).find(row=>row.operationId===original.payload.id);assert.equal(archive.reason,'authorization-expired');
 before=f.requests.length;assert.equal((await client.reconcilePrevious(original.payload.id)).state,'unconfirmed');
 assert.ok(f.requests.slice(before).every(row=>row.path==='/v2/contributions/status'));
 assert.equal(Number((await f.f.db.query('SELECT count(*) FROM contribution_publications WHERE id=$1',[original.payload.id])).rows[0].count),0);
});

test('queued contribution confirmation checks the reviewed operation and hash before authorizing a different local record',async t=>{
 const f=await fixture(t),{client,input}=await contribution(f),other=getContributionClient({...f.runtime},f.original.subjectId,{now:f.now});let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v1/consents'){drop=false;throw Error('isolated original consent before delivery');}};
 await assert.rejects(client.submit(input,{confirmed:true}));const original=(await client.local()).pending;
 let entered,release;const reached=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});let hold=true;
 f.wireHooks.before=async path=>{if(hold&&path==='/v2/contributions/status'){hold=false;entered();await barrier;}};
 const reading=client.reconcile();await reached;
 const confirms=client.reconcile({retry:true,reauthorize:true,confirmed:true,expectedOperationId:original.payload.id,expectedPayloadHash:original.payloadHash});
 const key=`contribution-operations:${f.original.subjectId}`;
 await f.runtime.updateLocal(key,state=>({...state,pending:{...state.pending,localRetryStopped:true}}));
 let stop=true;f.wireHooks.before=path=>{if(stop&&path==='/v1/consents'){stop=false;throw Error('isolated newer confirmed signature before delivery');}};
 await assert.rejects(other.submit({...input,id:randomUUID()},{confirmed:true}));const next=(await other.local()).pending;
 const start=f.requests.length;release();await reading;await assert.rejects(confirms,/contribution_original_replaced/);
 assert.ok(f.requests.slice(start).every(row=>row.path!=='/v1/consents'&&row.path!=='/v2/contributions/publish'));
 assert.equal((await other.local()).pending.payload.id,next.payload.id);assert.equal((await other.local()).pending.prepared.signedIntent,next.prepared.signedIntent);
 await assert.rejects(client.reconcile({retry:true,reauthorize:true,confirmed:true,expectedOperationId:next.payload.id,expectedPayloadHash:original.payloadHash}),/contribution_original_replaced/);
 assert.ok(f.requests.slice(start).every(row=>row.path!=='/v1/consents'&&row.path!=='/v2/contributions/publish'));
 assert.equal((await other.reconcile({retry:true,confirmed:true,expectedOperationId:next.payload.id,expectedPayloadHash:next.payloadHash})).state,'published');
});

test('late original contribution acknowledgement keeps a later explicit operation pending',async t=>{
 const f=await fixture(t),{client,input}=await contribution(f),other=getContributionClient({...f.runtime},f.original.subjectId,{now:f.now});
 let entered,release;const reached=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});let held=true;
 f.wireHooks.after=async(path,response)=>{if(held&&path==='/v2/contributions/publish'){held=false;assert.equal(response.status,200);entered();await barrier;}};
 const first=client.submit(input,{confirmed:true});await reached;
 await f.runtime.updateLocal(`contribution-operations:${f.original.subjectId}`,state=>({...state,pending:{...state.pending,localRetryStopped:true}}));
 let drop=true;f.wireHooks.before=path=>{if(drop&&path==='/v2/contributions/publish'){drop=false;throw Error('isolated newer operation before delivery');}};
 const nextId=randomUUID();await assert.rejects(other.submit({...input,id:nextId},{confirmed:true}),/isolated newer operation before delivery/);
 release();assert.equal((await first).state,'published');assert.equal((await client.local()).pending.payload.id,nextId);
 assert.equal((await client.reconcilePrevious(input.id)).exactOperationConfirmed,true);
 assert.equal((await other.resumePending()).state,'published');
});

test('signed deletion originals resume only within their original authority; lost cancellation ACK is read without repeating it',async t=>{
 const f=await fixture(t),preview=await f.runtime.privacy.prepareDeletion(deletion);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path==='/v1/deletion-requests/submit'){drop=false;throw Error('isolated deletion before delivery');}};
 await assert.rejects(f.runtime.privacy.submitDeletion(preview,{confirmed:true}),/isolated deletion before delivery/);
 const pending=await f.runtime.privacy.pendingDeletion();assert.equal((await f.runtime.privacy.resumeDeletion()).requestHash,pending.payloadHash);
 const receipt=(await f.runtime.privacy.queryDeletion()).items[0],cancel=await f.runtime.privacy.prepareDeletion({action:'cancel',requestId:receipt.id,expectedRevision:receipt.revision});
 let lose=true;f.wireHooks.after=(path,response)=>{if(lose&&path==='/v1/deletion-requests/submit'){lose=false;assert.equal(response.status,200);throw Error('isolated cancellation ACK lost');}};
 await assert.rejects(f.runtime.privacy.submitDeletion(cancel,{confirmed:true}),/isolated cancellation ACK lost/);
 let before=writes(f,'/v1/deletion-requests/submit');assert.equal((await f.runtime.privacy.resumeDeletion()).state,'cancelled');assert.equal(writes(f,'/v1/deletion-requests/submit'),before);
 const next=await f.runtime.privacy.prepareDeletion(deletion);drop=true;
 await assert.rejects(f.runtime.privacy.submitDeletion(next,{confirmed:true}),/isolated deletion before delivery/);
 await f.runtime.connect({confirmed:true});before=writes(f,'/v1/deletion-requests/submit');
 assert.equal((await f.runtime.privacy.resumeDeletion()).reason,'original-binding-changed');assert.equal(writes(f,'/v1/deletion-requests/submit'),before);
 f.setTime(f.now()+301);assert.equal((await f.runtime.privacy.resumeDeletion()).reason,'authorization-expired');
 assert.equal((await f.runtime.privacy.pendingDeletion()).payloadJson,next.payloadJson);assert.equal(writes(f,'/v1/deletion-requests/submit'),before);
 assert.equal((await f.runtime.privacy.queryDeletion()).items.every(item=>item.physicalDeletionPerformed===false),true);
});

test('ready export recovery preserves the original cutoff and lifetime; an unknown ticket never silently creates a snapshot',async t=>{
 const f=await fixture(t),ticket=await f.createExport(['identity','case-events']);f.setTime(f.now()+301);
 const ready=await f.runtime.privacy.resumeExport();assert.equal(ready.state,'ready');assert.equal(ready.ticket.id,ticket.id);
 assert.equal(ready.ticket.expiresAt,ticket.expiresAt);assert.deepEqual(ready.ticket.bounds,ticket.bounds);assert.equal(ready.ticket.selectionCutoff,ticket.selectionCutoff);
 await f.runtime.privacy.closeExport();let lose=true;
 f.wireHooks.after=(path,response)=>{if(lose&&path==='/v1/data-exports/create'){lose=false;assert.equal(response.status,200);throw Error('isolated ticket ACK lost');}};
 await assert.rejects(f.runtime.privacy.createExport({datasets:['identity']},{confirmed:true}),/isolated ticket ACK lost/);
 const original=await f.runtime.privacy.exportOperation(),before=f.requests.length;
 assert.equal((await f.runtime.privacy.resumeExport()).reason,'ticket-result-unknown');assert.equal(f.requests.length,before);
 const downloaded=await f.runtime.privacy.download();assert.equal(downloaded.manifest.ticket.id,original.selected.id);assert.equal(downloaded.manifest.complete,true);
 await f.runtime.connect({confirmed:true});const start=f.requests.length;
 assert.equal((await f.runtime.privacy.resumeExport()).reason,'original-binding-changed');assert.equal(f.requests.length,start);
});

test('current original device lists minimal saved deletion locators after exit; legacy receipts require no scan of other identities',async t=>{
 const f=await fixture(t),preview=await f.runtime.privacy.prepareDeletion(deletion),receipt=await f.runtime.privacy.submitDeletion(preview,{confirmed:true});
 await f.runtime.disconnect();const reads=[];f.journal.hooks.get=key=>{reads.push(key);};
 const index=await f.runtime.privacy.deletionReceipts();assert.equal(index.length,1);assert.equal(index[0].requestId,receipt.id);
 assert.equal(index[0].deviceId,f.originalOwner.deviceId);assert.equal(index[0].state,'requested');assert.equal(index[0].physicalDeletionPerformed,false);
 assert.equal(JSON.stringify(index).includes('payloadJson'),false);assert.equal(JSON.stringify(index).includes('signature'),false);
 assert.equal(reads.every(key=>key===f.localKey('deletion-receipt-index')),true);
 assert.equal((await f.runtime.privacy.holderStatus(index[0].requestId)).id,receipt.id);
 await f.runtime.putLocal('deletion-receipt-index',null);assert.deepEqual(await f.runtime.privacy.deletionReceipts(),[]);
 assert.equal((await f.runtime.privacy.holderStatus(receipt.id)).id,receipt.id,'an older known receipt still works without an index');
});

test('download manifest counts exact UTF-8 NDJSON bytes when selected datasets include empty pages',async t=>{
 const f=await fixture(t);await f.createExport(['identity','case-events','proofs']);
 const progress=[],data=await f.runtime.privacy.download({onProgress:value=>progress.push(value)});
 assert.equal(data.manifest.complete,true);assert.ok(data.manifest.pages.some(page=>page.rows===0));
 assert.equal(data.manifest.rows,data.content.trim().split('\n').length);assert.equal(data.manifest.bytes,Buffer.byteLength(data.content));
 assert.equal(progress.at(-1).bytes,data.manifest.bytes);
 assert.equal(data.manifest.dataSha256,[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.content)))].map(value=>value.toString(16).padStart(2,'0')).join(''));
});
