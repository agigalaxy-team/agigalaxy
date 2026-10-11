import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';import {digest}from'../src/shared/digest.mjs';
const ref=materialId=>({format:'task-text-v1',segments:[{kind:'material',materialId}]});
export async function materialTask(f,{expiry=120,independent='Independent target note. ',edit=null,reconnectAfterSource=false}={}){
 await f.login(f.owner,'task-material-owner');
 const post=await f.post({title:'Selected source title',body:'Selected source description.',publishedUntil:f.clock.now+expiry});
 const source=await f.write(f.owner,'create-post',post);assert.equal(source.status,200,JSON.stringify(source.body));
 if(reconnectAfterSource)await f.reconnect(f.owner);
 const selections=[{materialId:randomUUID(),field:'title',start:0,end:[...post.title].length},{materialId:randomUUID(),field:'body',start:0,end:[...post.body].length,...(edit?{text:edit}:{})}];
 const prepared=await f.ok('/v2/task-materials/prepare',{input:{source:{postId:post.postId,versionId:post.versionId},selections,expiresAt:post.publishedUntil}});
 const summary={format:'task-text-v1',segments:[...(independent?[{kind:'literal',text:independent}]:[]),...ref(selections[1].materialId).segments]};
 const request={operationId:randomUUID(),taskId:randomUUID(),caseId:null,intent:'collaboration',title:ref(selections[0].materialId),summary,
  workContext:{goal:ref(selections[0].materialId),currentSituation:ref(selections[1].materialId),attemptRefs:[]},visibility:'Public',collaboration:'open-assistance',enrollmentExpiresAt:f.clock.now+3600,materials:prepared.descriptors};
 const payloadJson=JSON.stringify(request),intent={version:1,id:randomUUID(),subjectId:f.owner.actor.subjectId,bindingId:f.owner.actor.bindingId,endpoint:f.owner.access.endpoint,
  action:'assistance.publish',objectId:request.operationId,purpose:'public-profile',recipient:f.owner.access.endpoint,fields:Object.keys(request),visibility:'Public',viewers:[],payloadHash:digest(payloadJson),policyVersion:'0.1',issuedAt:f.clock.now,expiresAt:f.clock.now+3600};
 const input={signedIntent:await f.owner.signForTest(JSON.stringify(intent),'galaxy-consent+jws'),payloadJson,materialBodies:prepared.materialBodies};
 return {post,source,prepared,request,input,intent,independent};
}