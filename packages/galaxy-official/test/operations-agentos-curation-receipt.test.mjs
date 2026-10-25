import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';

test('curation ACK and original audit recovery bind the same operation and curation revision, without confusing the independent visibility revision',async()=>{
 const operationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',target='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const actor={kind:'business-operator',operatorId:'c'.repeat(64),endpoint:'galaxy'};
 const request={kind:'content-curation',targetKind:'post',targetId:target,topic:'learning',reason:'Controlled current-source classification'};
 const proposal={schemaVersion:1,kind:'content-curation',domain:'governance',request,requiredAction:'content.curate',command:{expectedVersion:1,expectedRevision:0,topic:'learning',reason:request.reason}};
 const source={kind:'post',id:target,version:1,visibility:{version:6,hidden:false},curation:{revision:1,sourceVersion:1,topic:'learning'}};
 let writes=0,visibilityWrites=0,reads=0;
 let row={operator_id:actor.operatorId,action:'community-content-curation',selection:{kind:'post',id:target},result:{kind:'post',id:target,revision:1,sourceVersion:1}};
 const db={query:async(sql,parameters)=>{assert.match(sql,/SELECT operator_id,action,selection,result FROM business_admin_audit_v1/);assert.deepEqual(parameters,[actor.endpoint,operationId]);reads++;return{rows:[row]};}};
 const authority={db,endpoint:actor.endpoint,now:()=>1000,human:async value=>value};
 const tools=new OperationsAgentOsActionTools({authority,services:{content:{
  curate:async(value,kind,id,input)=>{writes++;assert.equal(value,actor);assert.equal(kind,'post');assert.equal(id,target);assert.equal(input.operationId,operationId);assert.equal(input.expectedVersion,1);assert.equal(input.expectedRevision,0);return{operationId,replayed:false,content:source};},
  visibility:async(value,kind,id,input)=>{visibilityWrites++;return{operationId:input.operationId,content:{kind,id,version:1,visibility:{version:6,hidden:true}}};},
 }}});
 const ack=await tools.executePrepared(actor,proposal,{authorize:async()=>actor,operationId});
 const recovered=await tools.recoverPrepared(actor,proposal,operationId);
 assert.equal(ack.operationId,operationId);assert.equal(recovered.operationId,operationId);
 assert.equal(ack.receipt.operationId,operationId);assert.equal(recovered.receipt.operationId,operationId);
 assert.equal(ack.receipt.revision,1,'curation revision is 1; visibility revision 6 is unrelated');
 assert.equal(recovered.receipt.revision,1);assert.equal(ack.receipt.version,1);assert.equal(recovered.receipt.version,1);
 assert.equal(ack.receipt.hidden,null,'a classification receipt does not claim a visibility effect');
 assert.deepEqual(ack,recovered,'the same durable original effect must not change shape after a lost ACK');
 assert.equal(writes,1);assert.equal(reads,1,'read-only recovery must not dispatch another mutation');
 row={...row,selection:{kind:'post',id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}};
 await assert.rejects(tools.recoverPrepared(actor,proposal,operationId),error=>error.code==='operations_agentos_operation_conflict');
 row={...row,selection:{kind:'reply',id:target}};
 await assert.rejects(tools.recoverPrepared(actor,proposal,operationId),error=>error.code==='operations_agentos_operation_conflict');
 const visibilityProposal={schemaVersion:1,kind:'content-visibility',domain:'governance',request:{kind:'content-visibility',targetKind:'post',targetId:target,action:'hide',until:1600,reason:request.reason},requiredAction:'content.hide',command:{kind:'hide',expectedVersion:1,expectedRevision:5,until:1600,reason:request.reason}};
 const visibility=await tools.executePrepared(actor,visibilityProposal,{authorize:async()=>actor,operationId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'});
 assert.equal(visibility.receipt.revision,6,'existing visibility receipts retain their own revision');
 assert.equal(visibility.receipt.hidden,true);assert.equal(visibilityWrites,1);assert.equal(writes,1);
});
