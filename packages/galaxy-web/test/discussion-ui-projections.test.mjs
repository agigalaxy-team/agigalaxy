import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {availableChatMessages,chatMessageAvailable,nextChatMessageExpiry} from "../src/features/chat/chat-workspace-types.ts";
import {emptyAgentForm,hasAgentGrantInput,agentGrantEditorInput,retainedAgentExpiry,sameAgentOperation} from "../src/features/chat/agents/chat-agent-types.ts";
import {availableForumContent,assertForumPrepared,forumSourceTarget} from "../src/features/community-forum/community-forum-view-types.ts";
import {createCommunityForumClient,newForumDraft,forumDraftPayload} from "../src/features/community-forum/community-forum-client.mjs";

test('chat reads withhold expired or unknown-deadline bodies while preserving the original messages and selection',()=>{
 const now=1_700_000_000_000,selected={messageId:randomUUID(),sequence:'12345678901234567890',text:'original selected message',expiresAt:new Date(now+500).toISOString()};
 const expired={messageId:randomUUID(),text:'expired message',expiresAt:new Date(now).toISOString()},unknown={messageId:randomUUID(),text:'unverified deadline',expiresAt:'unavailable'};
 const original=structuredClone([selected,expired,unknown]);
 assert.deepEqual(availableChatMessages([selected,expired,unknown],now),[selected]);
 assert.equal(availableChatMessages([selected],now)[0],selected);
 assert.equal(nextChatMessageExpiry([null,selected,expired,unknown],now),now+500);
 assert.equal(chatMessageAvailable(selected,now+500),false);
 assert.deepEqual([selected,expired,unknown],original);
});

test('reopening Agent choices preserves exact original deadlines and refuses a foreign pending grant',()=>{
 const owner={subjectId:'subject-a',endpoint:'https://fictional.invalid'},roomId=randomUUID(),bindingId=randomUUID(),expiresAt=1_700_000_001;
 const form={...emptyAgentForm,editing:'grant',bindingId,mode:'respond',primary:true};
 const pending={kind:'grant',...owner,roomId,input:{grantId:randomUUID(),bindingId,mode:'respond',primaryResponder:true,expiresAt}};
 const before=structuredClone({form,pending});
 assert.equal(retainedAgentExpiry(form,pending,owner,roomId),expiresAt);
 assert.equal(retainedAgentExpiry({...form,expiresAt:expiresAt-100},pending,owner,roomId),expiresAt-100);
 assert.equal(retainedAgentExpiry(form,{...pending,subjectId:'subject-b'},owner,roomId),null);
 assert.equal(retainedAgentExpiry(form,{...pending,endpoint:'https://other.invalid'},owner,roomId),null);
 assert.equal(retainedAgentExpiry(form,{...pending,roomId:randomUUID()},owner,roomId),null);
 assert.equal(retainedAgentExpiry(form,{...pending,input:{...pending.input,primaryResponder:false}},owner,roomId),null);
 assert.equal(retainedAgentExpiry({...form,keepExpiry:true,originalGrant:pending.input},null,owner,roomId),expiresAt);
 assert.equal(sameAgentOperation(pending,structuredClone(pending)),true);
 assert.equal(sameAgentOperation(pending,{...pending,input:{...pending.input,expiresAt:expiresAt+1}}),false);
 assert.deepEqual({form,pending},before);
});

test('Agent later-continue preserves unbound mode choices and the exact seven-day deadline',()=>{
 const openedAt=1_700_000_000,first=agentGrantEditorInput(emptyAgentForm,openedAt);
 assert.equal(hasAgentGrantInput(emptyAgentForm),false);
 assert.equal(first.expiresAt,openedAt+24*3600);
 assert.equal(first.mode,'draft');
 for(const mode of ['read','draft','respond']){
  const selected={...first,mode,primary:mode==='respond',hours:168,expiresAt:openedAt+168*3600},before=structuredClone(selected);
  const hidden={...selected,editing:null},reopened=agentGrantEditorInput(hidden,openedAt+12);
  assert.equal(hidden.bindingId,'');
  assert.equal(hasAgentGrantInput(hidden),true);
  assert.deepEqual(reopened,selected);
  assert.deepEqual(selected,before);
  assert.deepEqual(agentGrantEditorInput({...reopened,editing:null},openedAt+10*86400),selected);
 }
});

test('Agent continue keeps the exact existing grant and never supplies a missing retained deadline',()=>{
 const now=1_700_000_000,originalGrant={grantId:randomUUID(),bindingId:randomUUID(),mode:'read',primaryResponder:false,expiresAt:now-1};
 const hidden={...emptyAgentForm,bindingId:originalGrant.bindingId,mode:'read',originalGrant,keepExpiry:true,expiresAt:originalGrant.expiresAt};
 const reopened=agentGrantEditorInput(hidden,now+100);
 assert.equal(reopened.originalGrant,originalGrant);
 assert.equal(reopened.bindingId,originalGrant.bindingId);
 assert.equal(reopened.expiresAt,now-1);
 assert.equal(reopened.mode,'read');
 assert.equal(reopened.keepExpiry,true);
 const partial={...emptyAgentForm,mode:'read',hours:168},later=agentGrantEditorInput(partial,now);
 assert.equal(hasAgentGrantInput(partial),true);
 assert.equal(later.expiresAt,null);
 assert.equal(later.mode,'read');
 assert.equal(later.hours,168);
 const child={...emptyAgentForm,childTitle:'unsubmitted child-room title'};
 assert.equal(hasAgentGrantInput(child),false);
 assert.equal(child.childTitle,'unsubmitted child-room title');
});

test('forum public content ends at the selected deadline and returns its exact source version',()=>{
 const postId=randomUUID(),versionId=randomUUID(),replyId=randomUUID(),now=1_700_000_000;
 const value={locator:{kind:'post-version',postId,versionId,versionNumber:9},availability:'available',checkedAt:now,authorId:'original-author',publishedUntil:now+1,payload:{title:'original title',body:'original body',links:[]}};
 assert.equal(availableForumContent(value,now),true);
 assert.equal(availableForumContent(value,now+1),false);
 assert.equal(availableForumContent({...value,availability:'withdrawn'},now),false);
 assert.equal(availableForumContent({...value,publishedUntil:undefined},now),false);
 assert.deepEqual(forumSourceTarget(value),{kind:'post-version',postId,versionId});
 assert.deepEqual(forumSourceTarget({...value,locator:{kind:'reply',postId,postVersionId:versionId,replyId,contentRevision:1}}),{kind:'reply',replyId,contentRevision:1});
 assert.equal(value.locator.versionNumber,9);
 assert.equal(value.payload.body,'original body');
});

test('forum preview validation keeps the actual client confirmation identity, bytes, audience and expiry',async()=>{
 const subjectId='GUID15'+'0'.repeat(26),endpoint='https://fictional.invalid',bindingId=randomUUID(),rows=new Map(),now=1_700_000_000;
 const boundary=new Error('synthetic authorization boundary');let authorizations=0;
 const snapshot=()=>({subjectId,bindingId,generation:1,scopes:['assistance']});
 const api={endpoint,snapshot,prepareAuthorization:async(payloadJson,options)=>{
  authorizations++;assert.equal(payloadJson,JSON.stringify(prepared.payload));assert.deepEqual(options.viewers,prepared.viewers);assert.equal(options.expiresAt,now+3600);throw boundary;
 }};
 const runtime={api,getLocal:async key=>structuredClone(rows.get(key)),updateLocal:async(key,update)=>{
  const value=update(structuredClone(rows.get(key)));rows.set(key,structuredClone(value));return structuredClone(value);
 },receiptStatus:{captureLease:()=>({...snapshot(),endpoint,assertCurrent:()=>{}})}};
 const client=createCommunityForumClient(runtime,{subjectId,now:()=>now});
 const draft=newForumDraft('create-post',{}, {title:'synthetic preview',body:'author selected content'});
 const prepared=await client.prepare('create-post',forumDraftPayload(draft,{maxPermissionSeconds:3600,maxGovernanceHideSeconds:3600},now),{viewers:[],authorizationExpiresAt:now+3600});
 const original=JSON.stringify(prepared),payload=prepared.payload,viewers=prepared.viewers;
 assertForumPrepared(prepared);
 assert.equal(JSON.stringify(prepared),original);assert.equal(prepared.payload,payload);assert.equal(prepared.viewers,viewers);
 await assert.rejects(client.execute({...prepared},{confirmed:true}),error=>error.code==='forum_confirmation_required');
 await assert.rejects(client.execute(prepared,{confirmed:true}),error=>error===boundary);
 assert.equal(authorizations,1);assert.equal(prepared.payload.publishedUntil,now+3600);
 assert.throws(()=>assertForumPrepared({...prepared,payload:{...payload,publishedUntil:'extended'}}));
});
