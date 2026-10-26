import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {privacyConsumerFixture} from '../../galaxy-official/test/privacy-consumer-continuity-workflow.mjs';
import {trustPackagePurposeFixture} from '../../galaxy-official/test/trust-package-purpose-fixture.mjs';
import {createTrustPackageWorkspaceClient,matchingTrustPermission} from "../src/features/trust-packages/trust-package-workspace-client.mjs";
import {createTrustPackageClient} from "../../galaxy-official/src/clients/trust-package.mjs";

const permissionPath='/v2/trust-package/permissions/submit';
async function originalFixture(t){
 const f=await privacyConsumerFixture();t.after(()=>f.close());const subjectId=f.original.subjectId,id=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:id,caseId:id,
  expectedVersion:0,actorId:subjectId,localRef:randomUUID(),title:'[本地合成] 准确许可来源',summary:'只有声明的本机文字',synthetic:true,source:{kind:'local',reference:randomUUID()}};
 await f.runtime.api.call('/v2/cases/events',await f.runtime.api.authorizePayload(root,{action:'case.teaser.publish',objectId:id,visibility:'Private',viewers:[],confirmed:true}));
 return{...f,subjectId,ref:{endpoint:f.runtime.api.endpoint,kind:'case-event',id,caseId:id,version:1},client:f.runtime.trustPackages,
  input(){return{id:randomUUID(),operationId:randomUUID(),source:this.ref,grantee:subjectId,audience:{kind:'subjects',subjectIds:[subjectId]},expiresAt:f.now()+86400};}};
}
test('trust known refusal blocks automatic writes; an explicit continuation reuses the original JWS and exact deadline',async t=>{
 const f=await originalFixture(t),input=f.input(),p=await f.client.permissionPreview(input),policy=f.services.access.resourceBudgetPolicy;let locator;
 f.services.access.resourceBudgetPolicy={...policy,maxPayloadBytesPerSubject:0};
 await assert.rejects(f.client.executePermission(p,{confirmed:true,onJournal:value=>{locator=value;assert.equal(f.requests.filter(row=>row.path===permissionPath).length,0);}}),error=>error.outcome==='rejected'&&error.status===409);
 const original=await f.runtime.getLocal('trust-package:permission:'+input.operationId),before=f.requests.filter(row=>row.path===permissionPath).length;
 for(let i=0;i<3;i++)assert.equal((await f.client.resumePending())[0].reason,'business-rejected');
 assert.equal(f.requests.filter(row=>row.path===permissionPath).length,before);assert.equal((await f.client.receiptFor(locator)).state,'absent');
 f.services.access.resourceBudgetPolicy=policy;assert.equal((await f.client.resumePending())[0].reason,'business-rejected');
 assert.equal((await f.client.retry(input.operationId)).state,'recorded');const saved=await f.runtime.getLocal('trust-package:permission:'+input.operationId);
 assert.ok(saved.signed===original.signed,'original signed bytes unchanged');assert.equal(saved.signatureHash,original.signatureHash);assert.equal((await f.client.receiptFor(locator)).state,'acknowledged');
 assert.equal((await f.f.db.query('SELECT count(*) count FROM trust_package_permissions WHERE id=$1',[input.id])).rows[0].count,1);
 assert.equal(JSON.parse(Buffer.from(saved.signed.split('.')[1],'base64url')).expiresAt,input.expiresAt);
});
test('trust new page generation resumes one original binding, while changed binding needs an exact explicit re-sign',async t=>{
 const f=await originalFixture(t),input=f.input(),p=await f.client.permissionPreview(input);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path===permissionPath){drop=false;throw Error('fixture_before_delivery');}};
 await assert.rejects(f.client.executePermission(p,{confirmed:true}),/fixture_before_delivery/);const original=await f.runtime.getLocal('trust-package:permission:'+input.operationId),current=await f.client.refreshIdentity();
 const nextPage=createTrustPackageClient({api:f.runtime.api,now:f.now,current:async()=>({...current,generation:current.generation+1}),captureLease:()=>({assertCurrent(){}}),
  sign:()=>{throw Error('automatic signing prohibited');},getLocal:f.runtime.getLocal,putLocal:f.runtime.putLocal,locks:null});
 assert.equal((await nextPage.resumePending())[0].state,'recorded');assert.ok((await f.runtime.getLocal('trust-package:permission:'+input.operationId)).signed===original.signed,'new generation retains original signed bytes');
 drop=true;const later=f.input();await assert.rejects(f.client.executePermission(await f.client.permissionPreview(later),{confirmed:true}));
 const old=await f.runtime.getLocal('trust-package:permission:'+later.operationId);await f.runtime.connect({confirmed:true});const before=f.requests.filter(row=>row.path===permissionPath).length;
 assert.equal((await f.client.resumePending())[0].reason,'original-binding-changed');const review=await f.client.reviewAuthorization(later.operationId);
 assert.equal(review.state,'reauthorization-required');assert.equal(review.expiresAt,later.expiresAt);assert.equal(review.payloadJson,Buffer.from(old.signed.split('.')[1],'base64url').toString());
 assert.equal(f.requests.filter(row=>row.path===permissionPath).length,before);await f.client.reauthorize(review,{confirmed:true});
 const revised=await f.runtime.getLocal('trust-package:permission:'+later.operationId),payload=JSON.parse(Buffer.from(revised.signed.split('.')[1],'base64url'));
 assert.equal(payload.operationId,later.operationId);assert.deepEqual(payload.source,later.source);assert.deepEqual(payload.audience,later.audience);assert.equal(payload.expiresAt,later.expiresAt);
 assert.ok(revised.signatureHistory[0].signed===old.signed,'old signature retained only in local history');await assert.rejects(f.client.reauthorize(review,{confirmed:true}),{code:'trust_preview_required'});
});
test('trust expired original and stopped send do not revive; exact ACK takes precedence over a changed binding',async t=>{
 const f=await originalFixture(t);let drop=true;
 f.wireHooks.before=path=>{if(drop&&path===permissionPath){drop=false;throw Error('fixture_before_delivery');}};
 const stopped=f.input();await assert.rejects(f.client.executePermission(await f.client.permissionPreview(stopped),{confirmed:true}));await f.client.stopRetry(stopped.operationId);
 const before=f.requests.filter(row=>row.path===permissionPath).length;assert.equal((await f.client.resumePending())[0].reason,'stopped-local');assert.equal(f.requests.filter(row=>row.path===permissionPath).length,before);
 drop=true;const expired={...f.input(),expiresAt:f.now()+2};await assert.rejects(f.client.executePermission(await f.client.permissionPreview(expired),{confirmed:true}));f.setTime(f.now()+3);
 assert.equal((await f.client.reviewAuthorization(expired.operationId)).state,'authorization-expired');
 let lose=true;f.wireHooks.after=path=>{if(lose&&path===permissionPath){lose=false;throw Error('fixture_lost_ack');}};
 const accepted=f.input();await assert.rejects(f.client.executePermission(await f.client.permissionPreview(accepted),{confirmed:true}),/fixture_lost_ack/);
 f.setTime(f.now()+2);await f.runtime.connect({confirmed:true});const writes=f.requests.filter(row=>row.path===permissionPath).length;
 assert.equal((await f.client.reviewAuthorization(accepted.operationId)).state,'acknowledged');assert.equal(f.requests.filter(row=>row.path===permissionPath).length,writes);
});
test('trust workspace reads exact work/material/name projections and clears current borrowed reading after revoke without changing offline bytes',async t=>{
 const f=await trustPackagePurposeFixture();t.after(()=>f.close());const who=f.owner,runtime=who.runtime,subjectId=who.identity.subjectId,
  workspace=createTrustPackageWorkspaceClient(runtime,{subjectId,connected:true});t.after(()=>workspace.close());
 const people=await workspace.peoplePage('rooms');assert.ok(people.items.some(item=>item.subjectId===f.peer.identity.subjectId&&item.displayName===f.peer.name));
 const allowed=await workspace.permissions('grantee');assert.equal(matchingTrustPermission(allowed.items,f.ownRef,f.pair,subjectId)?.id,f.ownPermission.id);
 assert.equal(matchingTrustPermission(allowed.items,f.otherRef,{kind:'public'},subjectId),null);assert.equal(matchingTrustPermission(allowed.items,{...f.ownRef,version:1},f.pair,subjectId),null);
 const history=await workspace.workPage('history');assert.ok(history.items.some(item=>item.caseId===f.own.caseId));
 const materials=await workspace.readWork({caseId:f.own.caseId});assert.ok(materials.some(item=>item.ref.kind==='evidence'&&item.ref.id===f.evidence.id&&item.ref.version===1));
 assert.ok(materials.some(item=>item.ref.kind==='verification'&&item.ref.id===f.verification.id&&item.ref.version===1));
 const selection={ref:f.otherRef,mode:'copy',permissionId:f.otherPermission.id},input={audience:f.pair,expiresAt:f.now()+86400},read=await workspace.sourceReading(selection,input);
 assert.equal(read.state,'available');assert.ok(read.snapshot.bodyText.includes(f.other.attempt.strategy));assert.equal(read.readExpiresAt,f.otherPermission.expiresAt);
 const result=await runtime.trustPackages.exportPackage(await runtime.trustPackages.prepare({claims:[],selections:[selection],...input}),{confirmed:true}),text=JSON.stringify(result.container);
 let sourceCalls=0;f.hooks.beforeRequest=async path=>{if(path!=='/v2/trust-package/sources'||++sourceCalls!==2)return;
  const p=await f.peer.runtime.trustPackages.permissionPreview({id:f.otherPermission.id,operationId:randomUUID()},{revoke:true});await f.peer.runtime.trustPackages.executePermission(p,{confirmed:true});};
 const unavailable=await workspace.sourceReading(selection,input);assert.equal(unavailable.state,'unavailable');assert.equal(unavailable.snapshot,undefined);
 assert.equal((await runtime.trustPackages.checkOnline(result.container,{selectedEndpoint:runtime.api.endpoint})).online.items[0].status,'revoked');
 assert.equal((await runtime.trustPackages.importPackage(text)).integrity,'valid');assert.equal(JSON.stringify(result.container),text);
});
test('trust CAS links only the preview head, local export and accepted permission cannot clear later input',async t=>{
 const f=await originalFixture(t),runtime=f.runtime,workspace=createTrustPackageWorkspaceClient(runtime,{subjectId:f.subjectId,connected:true});t.after(()=>workspace.close());
 const a=workspace.draft('trust-purpose-cas'),b=workspace.draft('trust-purpose-cas');await a.load();const first=await a.save({claim:'original intro',selections:[]});await b.load();
 const preview=await f.client.prepare({claims:[{id:randomUUID(),text:'original intro',authority:'self-asserted',capabilityVerified:false}],selections:[],audience:f.input().audience,expiresAt:f.now()+600});
 await b.save({claim:'newer intro'});let attached=true;await f.client.exportPackage(preview,{confirmed:true,onJournal:async locator=>{attached=await a.attach(locator,first.head);}});
 assert.equal(attached,false);assert.equal(await a.settle(workspace.exportReceipt),false);assert.equal((await b.load()).value.claim,'newer intro');
 const current=await b.load(),local=await f.client.prepare({claims:[{id:randomUUID(),text:'newer intro',authority:'self-asserted',capabilityVerified:false}],selections:[],audience:f.input().audience,expiresAt:f.now()+600});
 await f.client.exportPackage(local,{confirmed:true,onJournal:locator=>b.attach(locator,current.head)});assert.equal(await b.settle(workspace.exportReceipt),true);assert.equal(await b.load(),null);
 const form=await b.save({source:f.ref,grantee:f.subjectId}),input=f.input();let locator;
 await f.client.executePermission(await f.client.permissionPreview(input),{confirmed:true,onJournal:async value=>{locator=value;await b.attach(value,form.head);}});
 await b.save({query:'another recipient'});assert.equal(await b.settle(f.client.receiptFor),false);assert.equal((await b.load()).value.query,'another recipient');
 assert.equal((await f.client.receiptFor(locator)).state,'acknowledged');assert.equal((await f.client.receiptFor({...locator,signatureHash:'0'.repeat(64)})).state,'conflict');
 a.close();b.close();
});
test('trust stopped revocation can explicitly continue at a new binding with its original earlier deadline and one exact receipt',async t=>{
 const f=await originalFixture(t),grant=f.input();await f.client.executePermission(await f.client.permissionPreview(grant),{confirmed:true});
 const operationId=randomUUID(),preview=await f.client.permissionPreview({id:grant.id,operationId},{revoke:true});let drop=true,locator;
 f.wireHooks.before=path=>{if(drop&&path===permissionPath){drop=false;throw Error('fixture_revoke_before_delivery');}};
 await assert.rejects(f.client.executePermission(preview,{confirmed:true,onJournal:value=>{locator=value;}}));
 await f.client.stopRetry(operationId);const old=await f.runtime.getLocal('trust-package:permission:'+operationId),deadline=JSON.parse(preview.payloadJson).expiresAt;
 await f.runtime.connect({confirmed:true});const writes=f.requests.filter(row=>row.path===permissionPath).length;
 assert.equal((await f.client.resumePending())[0].reason,'stopped-local');assert.equal(f.requests.filter(row=>row.path===permissionPath).length,writes);
 const review=await f.client.reviewAuthorization(operationId);assert.equal(review.state,'reauthorization-required');assert.equal(review.expiresAt,deadline);
 await f.client.reauthorize(review,{confirmed:true,onJournal:value=>{locator=value;}});const saved=await f.runtime.getLocal('trust-package:permission:'+operationId),payload=JSON.parse(Buffer.from(saved.signed.split('.')[1],'base64url'));
 assert.equal(payload.expiresAt,deadline);assert.equal(payload.operationId,operationId);assert.ok(saved.signatureHistory[0].signed===old.signed,'original revocation signature remains in local history');
 assert.equal((await f.client.receiptFor(locator)).state,'acknowledged');assert.equal((await f.client.receiptFor(locator)).status,'revoked');
});
