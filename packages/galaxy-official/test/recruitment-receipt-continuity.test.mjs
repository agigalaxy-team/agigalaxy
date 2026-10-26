import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyRecruitmentOperationReceipt} from './recruitment-receipt-continuity-workflow.mjs';
import {serviceFixture} from './service-fixture.mjs';
import {createRetirementController} from "../src/privacy/retirement.mjs";
import {serviceAccessV2} from '../src/operations/service-access-v2.mjs';
import {recruitmentOperationReceiptResultSchema} from '../src/shared/recruitment-schema-v2.mjs';

function minimal(value){
  assert.equal(value.currentAccessGranted,false);assert.equal(value.sourceAccessChecked,false);assert.equal(value.contentReturned,false);
  assert.equal(value.authority,'accepted-operation-only');assert.equal(value.audience,'owner-only');
  assert.deepEqual(Object.keys(value).sort(),['schemaVersion','query','state','authority','audience','currentAccessGranted',
    'contentReturned','sourceAccessChecked',...(value.state==='acknowledged'?['receipt']:value.state==='absent'?['absenceMeaning']:['reason'])].sort());
  if(value.state==='acknowledged')assert.deepEqual(Object.keys(value.receipt).sort(),
    ['recruitmentId','operationId','payloadHash','revision','acceptedAt'].sort());
  assert.equal(JSON.stringify(value).includes('FICTIONAL'),false);
}

test('actual historical Recruitment receipt remains exact after role/Consent withdrawal and owner replacement; absent/conflict reveal no body or other owner',async()=>{
  await verifyRecruitmentOperationReceipt(null,{after:async h=>{
    const accepted=await h.receipt(h.ref);minimal(accepted);
    assert.equal(accepted.state,'acknowledged');assert.equal(accepted.receipt.revision,1);
    assert.equal(accepted.receipt.acceptedAt,new Date(h.raw.created_at).toISOString());assert.deepEqual(accepted.query,h.ref);
    const absent=await h.receipt(h.absentRef);assert.equal(absent.state,'absent');minimal(absent);
    assert.equal(absent.absenceMeaning,'no-retained-owner-operation');
    for(const x of [{...h.ref,payloadHash:'f'.repeat(64)},{...h.ref,recruitmentId:randomUUID()}]){
      const wrong=await h.receipt(x);assert.equal(wrong.state,'conflict');assert.deepEqual(wrong.query,x);minimal(wrong);
      const foreign=await h.receipt(x,h.p);assert.equal(foreign.state,'absent');minimal(foreign);
    }
    assert.equal((await h.receipt(h.ref,h.p)).state,'absent');
    const prefix=h.url(h.ref);
    assert.equal((await h.request(null,prefix,null,401)).error,'access_denied');
    const bad=['&extra=1','&operationId='+h.unsentId,'&payloadHash='+h.ref.payloadHash,'&recruitmentId='+randomUUID()];
    for(const extra of bad)assert.equal((await h.request(h.f,prefix+extra,null,400)).error,'invalid_recruitment_receipt_query');
    assert.equal((await h.request(h.f,h.url({...h.ref,payloadHash:'A'.repeat(64)}),null,400)).error,'invalid_recruitment_receipt_query');
    const other=await serviceFixture(['binding','consent'],h.f.db,{now:h.f.now,migrateDatabase:false,syntheticCommunityQuota:false});
    assert.equal((await h.request(other,prefix,null,401)).error,'access_denied');
    assert.equal(recruitmentOperationReceiptResultSchema.safeParse({...accepted,payloadJson:h.raw.payload_text}).success,false);
    assert.equal(recruitmentOperationReceiptResultSchema.safeParse({...accepted,
      receipt:{...accepted.receipt,operationId:h.unsentId}}).success,false);
    assert.deepEqual(await h.original(h.publicationId),h.raw);assert.equal(await h.count(),2);
    // Explicit robustness/retention fixture, not a claim that ordinary TTL has
    // physically deleted every payload. Existing raw hash and Consent remain.
    await h.f.db.query("UPDATE recruitment_events SET payload_text='' WHERE operation_id=$1",[h.publicationId]);
    const require=Reflect.get(h.f.consents,'require');let sourceReads=0;
    try{
      h.f.consents.require=()=>{sourceReads++;throw new Error('Receipt must not reload source Consent/body');};
      assert.deepEqual(await h.receipt(h.ref),accepted);assert.equal(sourceReads,0);
    }finally{h.f.consents.require=require;}
    const retained=await h.original(h.publicationId);
    assert.equal(retained.payload_hash,h.raw.payload_hash);assert.equal(retained.consent_id,h.raw.consent_id);
    await h.f.db.query('DELETE FROM recruitment_events WHERE operation_id=$1',[h.publicationId]);
    assert.equal((await h.receipt(h.ref)).state,'absent','no permanent ledger survives physical event removal');
  }});
});

test('Recruitment client queries original metadata only, keeps absent/unknown bytes and withholds late lease responses or final local saves',async()=>{
  await verifyRecruitmentOperationReceipt(null,{after:async h=>{
    const dispatchBefore=h.dispatch.length;
    h.a.hooks.response=path=>{if(path.includes('/receipt?')){h.a.hooks.response=null;h.a.rebind();}};
    await assert.rejects(h.a.client.reconcile(h.publicationId,{retry:true,confirmed:true}),/连接|authority/);
    assert.equal(h.dispatch.length,dispatchBefore);assert.equal((await h.a.client.pending())[0].operationId,h.publicationId);
    assert.equal([...h.a.values.values()].flat()[0].payloadJson,h.savedA.payloadJson);
    const readAck=await h.a.client.reconcile(h.publicationId,{retry:true,confirmed:true});
    assert.equal(readAck.state,'acknowledged');assert.equal(readAck.receipt.revision,1);
    const {operationId:_operationId,objectId:_objectId,...serviceReceipt}=readAck;minimal(serviceReceipt);
    assert.equal(h.dispatch.length,dispatchBefore);assert.deepEqual(await h.a.client.pending(),[]);
    const terminal=[...h.a.values.values()].flat()[0];
    assert.equal(terminal.payloadJson,undefined);assert.equal(terminal.submission,undefined);
    assert.equal(terminal.payloadHash,h.savedA.payloadHash);assert.equal(terminal.consentId,h.savedA.submission.consentId);
    const requests=h.reads.length;assert.equal((await h.a.client.reconcile(h.publicationId,{retry:true,confirmed:true})).state,'acknowledged');
    assert.equal(h.reads.length,requests);assert.equal(h.dispatch.length,dispatchBefore);
    const absent=await h.b.client.reconcile(h.unsentId);assert.equal(absent.state,'absent');assert.deepEqual(absent.query,h.absentRef);
    assert.equal(h.dispatch.length,dispatchBefore);
    const pending=[...h.b.values.values()].flat()[0];assert.equal(pending.payloadJson,h.savedB.payloadJson);
    assert.deepEqual(pending.submission,h.savedB.submission);assert.equal(pending.operationId,h.unsentId);
    await assert.rejects(h.b.client.reconcile(h.unsentId,{retry:true}),/确认/);assert.equal(h.dispatch.length,dispatchBefore);
    h.b.hooks.response=(path,value)=>{if(path.includes('/receipt?')){
      value.state='conflict';delete value.absenceMeaning;value.reason='original-operation-mismatch';
    }};
    assert.equal((await h.b.client.reconcile(h.unsentId,{retry:true,confirmed:true})).state,'conflict');
    assert.equal(h.dispatch.length,dispatchBefore);assert.equal((await h.b.client.pending())[0].operationId,h.unsentId);
    h.b.hooks.response=(path,value)=>{if(path.includes('/receipt?'))value.payloadJson=h.savedB.payloadJson;};
    await assert.rejects(h.b.client.reconcile(h.unsentId,{retry:true,confirmed:true}));assert.equal(h.dispatch.length,dispatchBefore);
    h.b.hooks.response=path=>{if(path.includes('/receipt?'))throw new Error('Synthetic readonly receipt ACK lost');};
    await assert.rejects(h.b.client.reconcile(h.unsentId),/readonly receipt/);
    assert.equal((await h.b.client.pending())[0].operationId,h.unsentId);assert.equal(h.dispatch.length,dispatchBefore);
    h.b.hooks.response=null;
    // Query result remains untrusted input; do not turn an unexpected body or
    // a different original locator into an ACK or explicit retry.
    h.b.hooks.response=(path,value)=>{if(path.includes('/receipt?'))value.query.operationId=randomUUID();};
    await assert.rejects(h.b.client.reconcile(h.unsentId,{retry:true,confirmed:true}),/回执不匹配/);
    assert.equal(h.dispatch.length,dispatchBefore);h.b.hooks.response=null;
    // Preserve an original unknown caller across terminal save completion too.
    const key=[...h.a.values.keys()][0];h.a.values.set(key,[structuredClone(h.savedA)]);
    h.a.hooks.put=(_key,values)=>{if(values.some(x=>x.state==='acknowledged')){h.a.hooks.put=null;h.a.rebind();}};
    await assert.rejects(h.a.client.reconcile(h.publicationId),/连接|authority/);
    assert.equal([...h.a.values.values()].flat()[0].payloadJson,undefined);
    assert.equal((await h.a.client.reconcile(h.publicationId)).state,'acknowledged');
    assert.equal(h.dispatch.length,dispatchBefore);assert.equal(await h.count(),2);
  }});
});

test('ordinary MCP SDK exposes exact readonly Recruitment receipt, and precise HTTP route permits takeout only',async()=>{
  const now=Math.floor(Date.now()/1000),endpoint='https://official.example.org';let clock=now;
  const retirement=createRetirementController({version:1,id:'synthetic-recruitment-receipt',endpoint,operator:'Fixture',reason:'Test',
    announcedAt:now+1,stopWritesAt:now+60,takeoutUntil:now+120,statusUntil:now+180,
    contactUrl:endpoint+'/contact',deletionPolicyUrl:endpoint+'/deletion'},{endpoint,now:()=>clock});
  await verifyRecruitmentOperationReceipt(null,{retirement,after:async h=>{
    const owner=await h.sdk(h.f),listed=await owner.listTools(),name='galaxy_recruitment_v2_receipt';
    assert.equal(listed.tools.find(t=>t.name===name)?.annotations.readOnlyHint,true);
    const before=await h.count(),expected=await h.receipt(h.ref);
    const called=await owner.callTool({name,arguments:h.ref});assert.ok(!called.isError,JSON.stringify(called));
    const accepted=JSON.parse(called.content[0].text);assert.deepEqual(accepted,expected);minimal(accepted);
    const extra=await owner.callTool({name,arguments:{...h.ref,payloadJson:h.savedA.payloadJson}});assert.equal(extra.isError,true);
    const foreign=await h.sdk(h.p),other=await foreign.callTool({name,arguments:h.ref});
    assert.ok(!other.isError);assert.equal(JSON.parse(other.content[0].text).state,'absent');
    const pathname=new URL(h.url(h.ref),endpoint).pathname;
    assert.equal(serviceAccessV2('GET',pathname),'read');assert.equal(serviceAccessV2('PUT',pathname),null);
    clock=now+60;assert.equal(retirement.phase(),'takeout');assert.deepEqual(await h.receipt(h.ref),expected);
    assert.equal((await h.request(h.f,'/v2/recruitment',h.savedA.submission,410)).error,'service_writes_stopped');
    clock=now+120;assert.equal((await h.request(h.f,h.url(h.ref),null,410)).error,'service_retired');
    clock=now+180;assert.equal((await h.request(h.f,h.url(h.ref),null,410)).error,'service_retired');
    assert.equal(await h.count(),before);assert.deepEqual(await h.original(h.publicationId),h.raw);
  }});
});
