import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {communityForumFixture} from "./community-forum-fixture.mjs";
import {createBrowserClient} from "../src/browser-client.mjs";
import {recruitmentEventV2Schema} from "../src/shared/recruitment-schema-v2.mjs";
import {getProjectContactClient} from "../../galaxy-web/src/features/projects/clients/operations.mjs";
const digest=text=>createHash('sha256').update(text).digest('hex');

test('actual daily quota rejection retains the original signed recruitment; receipts and current quota reads never blind-retry',async()=>{
 const f=await communityForumFixture(),local=new Map(),calls=[];let signs=0;
 const transport=createBrowserClient({endpoint:f.owner.access.endpoint,trustedKeys:f.owner.bindings.trustedKeys,now:()=>f.clock.now,
  sign:(payload,type)=>f.owner.signForTest(payload,type),fetch:(url,options)=>{const target=new URL(url);calls.push({method:options.method,path:target.pathname});return fetch(f.origin+target.pathname+target.search,options);}});
 try{
  await f.login(f.owner,'independent-original-quota');
  const api={endpoint:f.owner.access.endpoint,snapshot:()=>({...f.owner.actor,generation:1}),
   call:(path,input,options={})=>transport.send(f.owner.access.endpoint+path,{method:options.method??'POST',
    bodyJson:options.method==='GET'?undefined:JSON.stringify(input),credential:f.owner.credential}),
   authorizePayload:async(payloadJson,options)=>{
    signs++;const intent={version:1,id:randomUUID(),subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,
     endpoint:f.owner.access.endpoint,objectId:options.objectId,action:options.action,purpose:options.visibility==='Public'?'public-profile':'operational',
     recipient:f.owner.access.endpoint,fields:Object.keys(JSON.parse(payloadJson)),visibility:options.visibility,viewers:options.viewers,
     payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:f.clock.now,expiresAt:f.clock.now+86400};
    const signedIntent=await f.owner.signForTest(JSON.stringify(intent),'galaxy-consent+jws');
    const receipt=await transport.send(f.owner.access.endpoint+'/v1/consents',{bodyJson:JSON.stringify({signedIntent}),credential:f.owner.credential});
    assert.equal(receipt.consentId,intent.id);return{consentId:intent.id,payloadJson};
   }};
  const runtime={api,getLocal:async key=>structuredClone(local.get(key)),putLocal:async(key,value)=>local.set(key,structuredClone(value))};
  const client=getProjectContactClient(runtime,f.owner.actor.subjectId),projectId=randomUUID();
  await client.submit('project',{kind:'create',projectId,expectedRevision:0,document:{kind:'project',title:'[Synthetic local] Quota source',summary:'An isolated diagnostic source.',functions:['table-extraction'],discoverable:true}},{visibility:'Public',confirmed:true});
  const publication=()=>({operationId:randomUUID(),kind:'create',projectId,recruitmentId:randomUUID(),expectedRevision:0,expiresAt:f.clock.now+3600,
   document:{title:'[Synthetic local] Recruitment',role:'Discuss one limited scope',summary:'No external execution or capability claim.',functions:['table-extraction'],contactSubjectId:f.owner.actor.subjectId}});
  const quota=await api.call('/v2/account/quotas',{});assert.equal(quota.quotas.find(item=>item.category==='task').remaining,2);
  await client.submit('recruitment',publication(),{visibility:'Public',confirmed:true});
  await client.submit('recruitment',publication(),{visibility:'Public',confirmed:true});
  const input=publication();let rejected;
  try{await client.submit('recruitment',input,{visibility:'Public',confirmed:true});assert.fail('must reach the real daily quota');}catch(error){rejected=error;}
  assert.equal(rejected.code,'community_quota_exceeded');assert.equal(rejected.status,429);assert.equal(rejected.resultUnknown,false);
  assert.equal(rejected.originalOperationRetained,true);assert.ok(rejected.retryAfterSeconds>0);
  const saved=structuredClone([...local.values()][0].find(record=>record.operationId===input.operationId));
  const originalPayload=recruitmentEventV2Schema.parse(input);
  assert.equal(saved.state,'rejected-wait');assert.equal(saved.payloadJson,JSON.stringify(originalPayload));assert.equal(saved.payloadHash,digest(saved.payloadJson));assert.ok(saved.submission);
  const consent=(await f.db.query('SELECT intent,signature_hash FROM consents WHERE id=$1',[saved.submission.consentId])).rows[0];
  const baseline={calls:calls.length,signs},review=await client.reviewPending(input.operationId);
  assert.deepEqual(review.payload,originalPayload);assert.equal(review.reason,'quota-wait');assert.equal(review.hasSubmission,true);
  for(let pass=0;pass<2;pass++){
   const resumed=await client.resumePending(input.operationId);assert.equal(resumed.reason,'quota-wait');assert.equal(resumed.operationId,input.operationId);
  }
  const reads=calls.slice(baseline.calls);assert.equal(reads.some(call=>call.path==='/v1/consents'||call.path==='/v2/recruitment'),false);
  assert.equal(signs,baseline.signs);assert.equal(reads.filter(call=>call.path.endsWith('/receipt')).length,2);
  assert.equal(reads.filter(call=>call.path==='/v2/account/quotas').length,2);
  const after=structuredClone([...local.values()][0].find(record=>record.operationId===input.operationId));
  assert.equal(after.payloadJson,saved.payloadJson);assert.equal(after.payloadHash,saved.payloadHash);assert.deepEqual(after.submission,saved.submission);
  assert.deepEqual((await f.db.query('SELECT intent,signature_hash FROM consents WHERE id=$1',[saved.submission.consentId])).rows[0],consent);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM recruitment_events WHERE operation_id=$1',[input.operationId])).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM community_write_receipts WHERE operation_id=$1',[input.operationId])).rows[0].n,0);
 }finally{transport.close();await f.close();}
});

test('browser keeps only safe retry metadata and permits only the existing exact GET recruitment receipt query',async()=>{
 const endpoint='https://official.example.org',operationId=randomUUID(),recruitmentId=randomUUID(),payloadHash='a'.repeat(64),requests=[];
 const api=createBrowserClient({endpoint,trustedKeys:new Map([['test',{}]]),sign:async()=>'',now:()=>2000000000,fetch:async(url,options)=>{
  requests.push({url,method:options.method});return new Response(JSON.stringify({error:'community_quota_exceeded',privateDebug:'must never copy',quota:{category:'task',used:2,limit:2,remaining:0,resetAt:'2033-05-19T00:00:00.000Z',tier:'new',policyVersion:'community-quota/1',privateDebug:'must never copy'}}),{status:429,headers:{'Retry-After':'30'}});
 }});
 const path=`/v2/recruitment/${recruitmentId}/receipt?operationId=${operationId}&payloadHash=${payloadHash}`;
 await assert.rejects(api.call(path,null,{method:'GET',authenticated:false}),error=>error.code==='community_quota_exceeded'&&error.retryAfterSeconds===30&&error.retryAt==='2033-05-18T03:33:50.000Z'&&!('privateDebug'in error)&&!('privateDebug'in error.quota));
 assert.equal(requests.length,1);
 for(const bad of [path+'&token=unsafe',path.replace('operationId=','other='),'/v1/consents?after='+operationId])
  await assert.rejects(api.call(bad,null,{method:'GET',authenticated:false}),/Invalid API path/);
 await assert.rejects(api.call(path,{}, {authenticated:false}),/Invalid API path/);assert.equal(requests.length,1);api.close();
});
