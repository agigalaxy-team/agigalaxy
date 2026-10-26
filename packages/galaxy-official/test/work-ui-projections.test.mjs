import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {latestFacts} from "../../galaxy-web/src/features/work-records/client.mjs";
import {readWorkCompose} from "../../galaxy-web/src/features/work-records/contracts.ts";
import {assertPreparedComment,commentSubmission} from "../../galaxy-web/src/features/tasks/comments/task-comment-view-types.ts";
import {createTaskCommentClient} from "../../galaxy-web/src/features/tasks/comments/task-comment-client.mjs";

test('latest work facts retain full authored projections and their exact source versions',()=>{
 const first={id:randomUUID(),version:1,actorId:'first-author',description:'original author body',sourceRefs:[{kind:'evidence',id:randomUUID(),version:3}]};
 const other={id:randomUUID(),version:1,actorId:'other-author',description:'independent author body',origin:{kind:'intervention',id:first.id,version:1}};
 const revised={...first,version:2,description:'corrected body',privateProjection:{visible:true}};
 const result=latestFacts([first,other,revised]);
 assert.deepEqual(result,[revised,other]);
 assert.equal(result[0],revised);
 assert.equal(result[1].origin.version,1);
 assert.equal(result[0].sourceRefs[0].version,3);
});

test('work draft restoration keeps authored input and configuration metadata while refusing invalid saved forms',()=>{
 const configuration={ref:{kind:'configuration',id:randomUUID(),version:4},label:'author-selected condition',sourceStatus:'current',authorId:'another-author'};
 const draft={revision:randomUUID(),value:{ui:'work-editor-v1',kind:'intervention',participationId:randomUUID(),participationScopeVersion:2,form:{description:'unsent author text',synthetic:true},configurationSources:[configuration]}};
 const original=structuredClone(draft),restored=readWorkCompose(draft);
 assert.equal(restored.value.form.description,'unsent author text');
 assert.equal(restored.value.form.synthetic,true);
 assert.equal(restored.value.form.resultChoice,'');
 assert.deepEqual(restored.value.configurationSources,[configuration]);
 assert.equal(restored.value.participationScopeVersion,2);
 assert.deepEqual(draft,original);
 const invalid={...draft,value:{...draft.value,form:{description:42}}};
 assert.throws(()=>readWorkCompose(invalid),/原记录已保留/);
 assert.equal(invalid.value.form.description,42);
});

test('comment submission binds correction and moderation to the selected original versions without changing the editing form',()=>{
 const taskId=randomUUID(),commentId=randomUUID(),reportId=randomUUID();
 const form={id:randomUUID(),revision:3,editor:{kind:'correct',comment:{commentId,taskId,revision:7,currentRevision:7}},text:' corrected text ',reason:' correction reason ',audience:['selected-reader'],category:'other',verdict:'upheld',disposition:'reject',rule:'comment-rules/1',pauseMinutes:60};
 const original=structuredClone(form),correction=commentSubmission(form,taskId,false,1_700_000_000_000);
 assert.equal(correction.payload.commentId,commentId);
 assert.equal(correction.payload.expectedRevision,7);
 assert.equal(correction.payload.body,'corrected text');
 assert.equal(correction.payload.reason,'correction reason');
 assert.equal(correction.visibility,'Public');
 const retract=commentSubmission({...form,editor:{...form.editor,kind:'retract'}},taskId,false,1_700_000_000_000);
 assert.equal(retract.visibility,'Private');
 assert.equal('body' in retract.payload,false);
 const decision=commentSubmission({...form,editor:{kind:'resolve',report:{reportId,taskId,version:9}}},taskId,false,1_700_000_000_000);
 assert.equal(decision.payload.expectedVersion,9);
 assert.equal(decision.payload.reviewDisposition,'reject');
 assert.equal(decision.visibility,'Private');
 assert.deepEqual(form,original);
});

test('comment preview validation preserves the actual client WeakMap object and original serialized payload',async()=>{
 const subjectId='GUID'+'A'.repeat(28),endpoint='https://fictional.invalid',taskId=randomUUID(),bindingId=randomUUID(),local=new Map();
 const boundary=new Error('synthetic authorization boundary');let authorizations=0;
 const api={endpoint,snapshot:()=>({subjectId,endpoint,bindingId,generation:1}),
  prepareAuthorization:async(payloadJson)=>{authorizations++;assert.equal(payloadJson,prepared.payloadJson);throw boundary;},
 };
 const client=createTaskCommentClient({api,subjectId,taskId,getLocal:async key=>structuredClone(local.get(key)),putLocal:async(key,value)=>{local.set(key,structuredClone(value));}});
 const prepared=await client.prepare('comment',{schemaVersion:2,id:randomUUID(),commentId:randomUUID(),taskId,expectedRevision:0,kind:'create',body:'synthetic unsent text',visibility:'inherit-task',replyTo:null},{visibility:'Public'});
 const original=JSON.stringify(prepared),viewers=prepared.viewers,payload=prepared.payload;
 assertPreparedComment(prepared);
 assert.equal(JSON.stringify(prepared),original);
 assert.equal(prepared.viewers,viewers);
 assert.equal(prepared.payload,payload);
 await assert.rejects(client.execute({...prepared},{confirmed:true}),/预览并确认/);
 await assert.rejects(client.execute(prepared,{confirmed:true}),error=>error===boundary);
 assert.equal(authorizations,1);
 assert.throws(()=>assertPreparedComment({...prepared,payloadJson:'{}'}),/原载荷不一致/);
});
