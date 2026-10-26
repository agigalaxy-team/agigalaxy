import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {ChatService} from "../src/chat/service.mjs";
import {OutcomeMaterialServiceV2} from "../src/evidence/outcome-material-v2.mjs";
import {createApi} from '../src/http.mjs';
import {invite} from './chat-workflow.mjs';

test('material author inspects the exact current message across pagination; original membership, version and final TTL still control its body', {timeout:60000}, async()=>{
  const scopes=['binding','consent','case-teaser','evidence'],now=Math.floor(Date.now()/1000),a=await serviceFixture(scopes,null,{now}),
    b=await serviceFixture(scopes,a.db,{now,migrateDatabase:false}),c=await serviceFixture(scopes,a.db,{now,migrateDatabase:false}),messages=new Map();
  a.access.now=a.bindings.now=a.consents.now=()=>a.now;
  let afterRead=null,readCount=0;
  // The archive and account adapter are declared doubles; signatures, grants,
  // message/version/member checks, outcome service and PGlite are actual.
  const chat=new ChatService({db:a.db,access:a.access,now:()=>a.now,requireAccountWithin:async()=>{},consumeInviteWithin:async()=>{},markInviteRespondedWithin:async()=>{},
    transport:{available:true,project:async()=>{},send:async value=>{messages.set(value.messageId,{archiveId:value.messageId,text:value.text,revision:1});return{archiveId:value.messageId};},
      read:async input=>{readCount++;const result=input.ids.map(id=>messages.get(id)).filter(Boolean);if(afterRead){const fn=afterRead;afterRead=null;await fn();}return result;},
      edit:async value=>{const revision=value.expectedRevision+1;messages.set(value.messageId,{archiveId:value.messageId,text:value.text,revision});return{revision};}}});
  const materials=new OutcomeMaterialServiceV2(a.access,{consents:a.consents,chat,records:a.verificationRecords}),server=createApi({...a,chat,outcomeMaterials:materials,rateLimit:10000});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
  const post=async(who,path,input)=>{const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+who.credential},body:JSON.stringify(input)});
    return{status:response.status,body:await response.json()};};
  try{
    const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:a.actor.subjectId,
      localRef:randomUUID(),title:'本地合成准确原消息审阅',summary:'不授予额外原文权限',synthetic:true,source:{kind:'local',reference:randomUUID()}};
    await a.cases.submitV2(a.actor,await a.authorize(root,'case.teaser.publish',{objectId:caseId}));
    const roomId=randomUUID();await chat.create(a.actor,{roomId,operationId:randomUUID(),title:'本地合成材料审阅'});await invite(chat,a.actor,roomId,b.actor);
    const create=async(text)=>{
      const sent=await chat.send(b.actor,roomId,{clientMessageId:randomUUID(),text}),selected=await chat.readSelectedWithin(a.db,a.actor,{messageId:sent.messageId,revision:1}),
        source={kind:'message',id:sent.messageId,version:1,sha256:selected.contentHash,roomId},event={id:randomUUID(),materialId:randomUUID(),kind:'request',source,caseId,
          purpose:'在已有权限下审阅准确合成原文',title:'本地合成材料',audience:{visibility:'Private',viewers:[b.actor.subjectId]},uses:['evidence'],
          retention:'with-related-result; independently-authorized-copy',requestExpiresAt:new Date((a.now+3600)*1000).toISOString()},
        signed=await a.authorize(event,'outcome.material',{objectId:event.id,viewers:[b.actor.subjectId]});
      const created=await post(a,'/v2/outcome-materials/request',signed);assert.equal(created.status,200);
      return{sent,event,signed};
    };
    const first=await create('选定的原消息全文，不依赖当前聊天分页'),bodyCount=readCount;
    assert.equal((await post(c,'/v2/outcome-materials/inspect',{id:first.event.materialId,version:1})).status,404);assert.equal(readCount,bodyCount);
    const inspected=await post(b,'/v2/outcome-materials/inspect',{id:first.event.materialId,version:1});assert.equal(inspected.status,200);
    assert.equal(inspected.body.sourceContent.content,'选定的原消息全文，不依赖当前聊天分页');assert.deepEqual(inspected.body.sourceContent.source,first.event.source);
    assert.equal(inspected.body.sourceContent.independentRetentionGranted,false);assert.equal(inspected.body.sourceContent.currentRoomReadOnly,true);
    const ttl=(await a.db.query('SELECT expires_at FROM chat_message_refs WHERE message_id=$1',[first.sent.messageId])).rows[0].expires_at;
    assert.equal(inspected.body.sourceContent.readExpiresAt,Math.floor(Date.parse(ttl)/1000));
    assert.equal((await a.db.query('SELECT body_text FROM outcome_materials_v2 WHERE id=$1',[first.event.materialId])).rows[0].body_text,'','inspect creates no retained copy');
    await chat.edit(b.actor,roomId,first.sent.messageId,{operationId:randomUUID(),expectedRevision:1,text:'后来编辑的正文不能代替原申请'});
    const changed=await post(b,'/v2/outcome-materials/inspect',{id:first.event.materialId,version:1});assert.equal(changed.status,200);
    assert.equal(changed.body.sourceContent,null);assert.equal(changed.body.sourceContentReason,'chat_message_version_unavailable');
    const delayed=await create('准确原文也必须在返回时仍然可读'),expiry=(await a.db.query('SELECT expires_at FROM chat_message_refs WHERE message_id=$1',[delayed.sent.messageId])).rows[0].expires_at;
    afterRead=async()=>{a.now=Math.floor(Date.parse(expiry)/1000)+1;};
    const expired=await post(a,'/v2/outcome-materials/inspect',{id:delayed.event.materialId,version:1});assert.equal(expired.status,200);
    assert.equal(expired.body.sourceContent,null);assert.equal(expired.body.sourceContentReason,'chat_message_version_unavailable');assert.equal(expired.body.request.id,delayed.event.id);
    a.now=now;
    await chat.leave(b.actor,roomId,{operationId:randomUUID()});
    const left=await post(b,'/v2/outcome-materials/inspect',{id:delayed.event.materialId,version:1});assert.equal(left.status,200);
    assert.equal(left.body.sourceContent,null);assert.ok(left.body.sourceContentReason);
  }finally{server.closeAllConnections();await new Promise(done=>server.close(done));await a.db.close();}
});
