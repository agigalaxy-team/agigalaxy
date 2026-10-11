import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapsuleWebClient} from '../src/capsule-workspace-client.mjs';
const subjectId='GUID10'+'0'.repeat(26),endpoint='https://official.example.org';
function fixture(scopes){
 const calls=[],records=new Map(),state={subjectId,bindingId:crypto.randomUUID(),generation:1,scopes};
 const api={endpoint,snapshot:()=>structuredClone(state),call:async(path,input,options)=>{calls.push({path,input,options});return{};},prepareAuthorization:async()=>assert.fail('ungranted operation must not request Consent')};
 const client=createCapsuleWebClient({api,subjectId,getLocal:async key=>structuredClone(records.get(key)),putLocal:async(key,value)=>records.set(key,structuredClone(value))});
 return{client,api,state,calls,records};
}
test('limited device publicly reads Capsule without its bearer and withholds private writes before Consent or a journal',async()=>{
 const f=fixture(['binding','consent','case-teaser','history','assistance','context']),before=f.api.snapshot(),id=crypto.randomUUID();
 await f.client.get({capsuleId:id});await f.client.versions({capsuleId:id});await f.client.query({});await f.client.uses({capsuleId:id});
 assert.equal(f.calls.length,4);assert.ok(f.calls.every(call=>call.options.authenticated===false));
 const count=f.calls.length;await assert.rejects(f.client.permissions({view:'owned'}),error=>error.code==='capsule_device_scope_required'&&error.scope==='capsules');
 await assert.rejects(f.client.prepare('permission',{schemaVersion:2,kind:'revoke',id:crypto.randomUUID(),permissionId:id,reason:'Explicit isolated test'}),error=>error.code==='capsule_device_scope_required');
 assert.equal(f.calls.length,count);assert.equal(f.records.size,0);assert.deepEqual(f.api.snapshot(),before);
});
test('Capsule permission does not silently request missing Case or verification authority',async()=>{
 const f=fixture(['binding','consent','capsules']),before=f.api.snapshot();
 await f.client.get({capsuleId:crypto.randomUUID()});assert.equal(f.calls[0].options.authenticated,true);
 for(const [read,scope] of [[()=>f.client.caseFacts({caseId:crypto.randomUUID()}),'case-teaser'],[()=>f.client.verification({id:crypto.randomUUID(),version:1}),'evidence'],[()=>f.client.history(),'history']])await assert.rejects(read(),error=>error.code==='capsule_device_scope_required'&&error.scope===scope);
 assert.equal(f.calls.length,1);assert.deepEqual(f.api.snapshot(),before);
});
test('stopping a retained local retry remains available without the Capsule receipt scope and makes no remote cancellation claim',async()=>{
 const f=fixture(['binding']),operationId=crypto.randomUUID(),key=`capsule-operations:${endpoint}:${subjectId}`;
 f.records.set(key,{active:{operationId,type:'use',payloadHash:'a'.repeat(64),payloadJson:'synthetic private bytes',prepared:{synthetic:true},submission:{synthetic:true}},stopped:[]});
 const result=await f.client.stopLocalRetry(operationId,{confirmed:true});assert.deepEqual(result,{state:'stopped-local',serverCancellationConfirmed:false});
 const saved=f.records.get(key);assert.equal(saved.active,null);assert.deepEqual(saved.stopped,[{operationId,type:'use',payloadHash:'a'.repeat(64),state:'stopped-local'}]);assert.equal(f.calls.length,0);
});
