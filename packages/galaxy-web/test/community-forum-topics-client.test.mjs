import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommunityForumClient,newForumDraft,forumDraftPayload} from "../src/features/community-forum/community-forum-client.mjs";
import {defaultForumPolicy} from "../../galaxy-contracts/src/policies/forum-quota.mjs";
import {forumTopics} from '../../galaxy-contracts/src/community-forum-topics-v1.mjs';

test('topic selection enters only newly prepared publication bytes; legacy/unclassified drafts omit the signed field',()=>{
 const old=newForumDraft('create-post',{}, {title:'Original title',body:'Original body'});
 assert.equal(Object.hasOwn(old,'topic'),false);assert.equal(Object.hasOwn(forumDraftPayload(old,defaultForumPolicy),'topic'),false);
 for(const topic of forumTopics){const draft=newForumDraft('create-post',{}, {...old,topic:topic.id});assert.equal(forumDraftPayload(draft,defaultForumPolicy).topic,topic.id);}
 const legacy=newForumDraft('create-post',{}, {...old,topic:'unclassified'});assert.equal(Object.hasOwn(forumDraftPayload(legacy,defaultForumPolicy),'topic'),false);
 assert.throws(()=>newForumDraft('create-post',{}, {...old,topic:'spam'}));
});

test('public client sends filter/cursor intact to the real API contract without current-page filtering',async()=>{
 const calls=[],runtime={api:{endpoint:'https://official.example.org',snapshot:()=>null,call:async(path,input,options)=>{calls.push({path,input,options});return{items:[]};}}};
 const client=createCommunityForumClient(runtime);
 await client.topics();await client.posts({topic:'technology',query:'full corpus',order:'published',after:'fp1.exact-location',limit:20});
 assert.equal(calls[0].path,'/v2/community/topics');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.authenticated,false);
 assert.deepEqual(calls[1].input,{topic:'technology',query:'full corpus',order:'published',after:'fp1.exact-location',limit:20});assert.equal(calls[1].path,'/v2/community/posts/query');client.close();
});
