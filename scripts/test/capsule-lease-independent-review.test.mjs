import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCapsuleWebClient} from "../../packages/galaxy-web/src/features/capsules/capsule-workspace-client.mjs";
const subjectId='GUID'+'A'.repeat(28);
function fixture(phase,change){
 const current={subjectId,bindingId:randomUUID(),generation:1,scopes:['capsules','consent']},store=new Map(),calls=[];
 const replace=()=>{if(change==='binding')current.bindingId=randomUUID();else current.generation++;};
 const api={endpoint:'https://official.example.org',snapshot:()=>({...current}),
  prepareAuthorization:async(payloadJson,options)=>{if(phase==='prepareAuthorization')replace();return{payloadJson,intent:{id:randomUUID(),...options}};},
  submitAuthorization:async p=>{if(phase==='submitAuthorization')replace();return{payloadJson:p.payloadJson,consentId:p.intent.id};},
  call:async(path,input)=>{calls.push({path,input});if(path.endsWith('/receipt')){if(phase==='receipt')replace();return{state:'acknowledged',operationId:input.operationId};}return{};}};
 const client=createCapsuleWebClient({api,subjectId,getLocal:async key=>structuredClone(store.get(key)),putLocal:async(key,value)=>{store.set(key,structuredClone(value));}});
 return{client,store,calls,payload:{schemaVersion:2,kind:'revoke',id:randomUUID(),permissionId:randomUUID(),reason:'independent lease boundary'}};
}
for(const phase of ['prepareAuthorization','submitAuthorization','receipt'])for(const change of ['binding','generation'])
 test(`Capsule ${phase} ${change} replacement withholds original operation`,async()=>{
  const f=fixture(phase,change),preview=await f.client.prepare('permission',f.payload);
  await assert.rejects(f.client.execute(preview,{confirmed:true}),/身份|连接/);
  const original=[...f.store.values()][0]?.active;
  assert.equal(original.operationId,preview.operationId,'Keep original journal for exact recovery');
  assert.equal(original.payloadHash,preview.payloadHash);
  const business=f.calls.filter(x=>x.path==='/v2/capsules/permissions');
  assert.equal(business.length,phase==='receipt'?1:0,'A late ACK may follow one accepted write; no retry/new business write');
 });
