import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {p14Fixture} from './p14-rules-fixture.mjs';
import {p14EmptyControls} from '../src/shared/p14-rules-schema.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {joinAccountConversation} from './account-chat-fixture.mjs';

async function post(f,actor,text,overrides={}){
 const payload=await bindForumIds('create-post','account:'+actor.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),expectedHeadVersion:0,versionId:randomUUID(),title:'本地规则帖子',body:text,links:[],publishedUntil:f.now()+3600,...overrides});
 return {payload,result:await f.forum.publish(actor,{payloadJson:JSON.stringify(payload)})};
}
const rejectRule=(id,listId,accountId)=>({id,name:'仅本次规则停止',enabled:true,targets:['forum-post','forum-reply','chat-message'],action:'reject',
 conditions:{combinator:'and',rules:[{field:'keywordList',operator:'matches',value:listId}]},exceptions:accountId?[{id:randomUUID(),name:'当前账户仅此规则例外',enabled:true,accountIds:[accountId]}]:[]});

test('real forum and private send/edit entry points use the published rule and never let an exception bypass quota, room authority or current feature stop',async t=>{
 const f=await p14Fixture(t),[a,b,c]=f.people,room=await joinAccountConversation(f,a,b),keyword=randomUUID(),ruleId=randomUUID(),policy=structuredClone(p14EmptyControls);
 policy.lists=[{id:keyword,name:'合成中文名单',kind:'keyword',enabled:true,entries:['停止词']}];policy.rules=[rejectRule(ruleId,keyword,a.accountId)];
 await f.publish(policy);const allowed=await post(f,a,'停止词：本规则获准例外');assert.equal(allowed.result.acknowledged,true);
 await assert.rejects(post(f,b,'停止词：应由真实发表入口拒绝'),{code:'operations_rule_rejected'});
 const reply=await bindForumIds('create-reply','account:'+b.accountId,{schemaVersion:1,operationId:randomUUID(),replyId:randomUUID(),postId:allowed.payload.postId,postVersionId:allowed.payload.versionId,expectedRevision:0,body:'停止词：回复也采用同版',publishedUntil:f.now()+3600,replyTo:null});
 await assert.rejects(f.forum.createReply(b,{payloadJson:JSON.stringify(reply)}),{code:'operations_rule_rejected'});
 const before=(await f.db.query('SELECT count(*) AS count FROM chat_message_refs')).rows[0].count;
 await assert.rejects(f.chat.send(b,room,{clientMessageId:randomUUID(),text:'停止词：不可实际发出'}),{code:'operations_rule_rejected'});
 assert.equal((await f.db.query('SELECT count(*) AS count FROM chat_message_refs')).rows[0].count,before);
 const message=await f.chat.send(b,room,{clientMessageId:randomUUID(),text:'允许的原消息'});
 await assert.rejects(f.chat.edit(b,room,message.messageId,{operationId:randomUUID(),expectedRevision:1,text:'停止词：编辑不可绕过'}),{code:'operations_rule_rejected'});
 await assert.rejects(f.chat.send(c,room,{clientMessageId:randomUUID(),text:'普通文本'}),{code:'chat_access_denied'});
 policy.features.chatSend=false;await f.publish(policy);await assert.rejects(f.chat.send(a,room,{clientMessageId:randomUUID(),text:'账户例外不能开关豁免'}),{code:'operations_feature_disabled'});
 const quota=await f.rules.get(f.admin,'forum-quota'),lower=structuredClone(quota.active.policy);lower.new.post=1;await f.publish(lower,'forum-quota');f.forum.policy=lower;f.forum.budget.policy=lower;
 await assert.rejects(post(f,a,'停止词：例外不能免额度'),{code:'forum_quota_exceeded'});
 const detail=await f.rules.get(f.admin,'business-controls');assert(detail.adoption.observed.some(item=>item.target==='forum-post'&&item.count===1));
 const rows=(await f.db.query('SELECT * FROM operations_p14_rule_decisions_v1')).rows,serialized=JSON.stringify(rows);
 assert.equal(serialized.includes('停止词'),false);assert.equal(serialized.includes('允许的原消息'),false);assert(rows.some(row=>row.exception_ids.length===1));
 assert.equal(Number((await f.db.query('SELECT count(*) AS count FROM forum_replies_v1')).rows[0].count),0);
});

test('actual chat and forum file preparation/upload recheck current rules before storage and preserve existing readable files',async t=>{
 const f=await p14Fixture(t),[a,b]=f.people,room=await joinAccountConversation(f,a,b),bytes=Buffer.from('p14 synthetic bytes'),sha256=f.digest(bytes),chatId=randomUUID(),forumId=randomUUID();
 await f.files.prepare(a,{attachmentId:chatId,roomId:room,name:'chat.txt',mediaType:'text/plain',size:bytes.length,sha256,purpose:'temporary-room-attachment',confirmed:true});
 await f.forumFiles.prepare(a,{attachmentId:forumId,name:'forum.txt',mediaType:'text/plain',size:bytes.length,sha256});
 const policy=structuredClone(p14EmptyControls);policy.features.attachmentUpload=false;await f.publish(policy);
 await assert.rejects(f.files.upload(a,chatId,Readable.from([bytes]),{contentLength:bytes.length}),{code:'operations_feature_disabled'});
 await assert.rejects(f.forumFiles.upload(a,forumId,Readable.from([bytes]),{contentLength:bytes.length}),{code:'operations_feature_disabled'});
 await assert.rejects(f.files.prepare(a,{attachmentId:randomUUID(),roomId:room,name:'new.txt',mediaType:'text/plain',size:bytes.length,sha256,purpose:'temporary-room-attachment',confirmed:true}),{code:'operations_feature_disabled'});
 assert.equal(f.objects.size,0);assert.equal((await f.db.query("SELECT state FROM chat_attachments WHERE id=$1",[chatId])).rows[0].state,'prepared');
 policy.features.attachmentUpload=true;await f.publish(policy);
 await f.files.upload(a,chatId,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();
 await f.forumFiles.upload(a,forumId,Readable.from([bytes]),{contentLength:bytes.length});await f.forumFiles.scanPending();
 assert.equal((await f.files.get(a,{attachmentId:chatId})).state,'available');assert.equal((await f.forumFiles.get(a,{attachmentId:forumId})).state,'available');
 policy.features.attachmentUpload=false;await f.publish(policy);
 assert.equal((await f.files.get(a,{attachmentId:chatId})).state,'available');assert.equal((await f.forumFiles.get(a,{attachmentId:forumId})).state,'available','stopping new uploads does not revoke existing read/source permission');
});
