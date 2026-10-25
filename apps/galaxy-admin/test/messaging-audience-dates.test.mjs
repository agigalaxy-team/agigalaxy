import assert from 'node:assert/strict';
import test from 'node:test';
import {buildMessageConfig,createMessageDraft,messageAudienceAccountLabel,messageAudienceAccounts,messageMerge} from '../src/lib/messaging-view-model.ts';

test('message audience names keep their own qualified source and unchanged dates preserve exact source instants',()=>{
 const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-'+String(n).padStart(12,'0');
 const names=messageAudienceAccounts({state:'available',items:[{accountId:id(1),uid:'Ab12Cd34Ef56',displayName:'真实资料名称',state:'available'},{accountId:id(2),uid:'Zz12Yy34Xx56',displayName:'不得保留的旧名称',state:'unavailable'},{accountId:'not-a-uuid',displayName:'不得采用',state:'available'}]},130,100);
 assert.deepEqual(Object.keys(names),[id(1),id(2)]);assert.equal(names[id(1)].readExpiresAt,130);assert.equal(messageAudienceAccountLabel(names[id(1)],129),'真实资料名称');assert.equal(messageAudienceAccountLabel(names[id(1)],130),'名称暂无法取得');assert.equal(messageAudienceAccountLabel(names[id(2)],100),'账户当前不可用');assert.equal(names[id(2)].displayName,null);assert.equal(names[id(2)].uid,null);
 assert.deepEqual(messageAudienceAccounts({state:'available',items:[{accountId:id(1),uid:'Ab12Cd34Ef56',displayName:'真实资料名称',state:'available'}]},130,130),{});assert.deepEqual(messageAudienceAccounts({state:'not-applicable',items:[]},130,100),{});assert.deepEqual(messageAudienceAccounts(undefined,130,100),{});
 const unnamed=messageAudienceAccounts({state:'available',items:[{accountId:id(3),uid:id(3),displayName:null,state:'available'}]},130,100);assert.equal(messageAudienceAccountLabel(unnamed[id(3)],100),'名称暂无法取得');assert.ok(!messageAudienceAccountLabel(unnamed[id(3)],100).includes(id(3)));
 const plan={version:2,revision:2,config:{channels:['inapp'],content:{purpose:'service-update',title:'原标题',body:'原正文',href:null,expiresAt:'2030-01-20T10:00:45.123Z'},audience:{kind:'accounts',accountIds:[id(1)]},senderKey:'notice',schedule:{kind:'once',at:'2030-01-10T10:00:55.456Z'}}};
 const base=createMessageDraft(plan),mine=structuredClone(base);mine.config.content.title='仅改标题';mine.dirty=true;
 const unchanged=buildMessageConfig(mine);assert.equal(unchanged.error,'');assert.equal(unchanged.config.content.expiresAt,plan.config.content.expiresAt);assert.equal(unchanged.config.schedule.at,plan.config.schedule.at);
 const currentPlan=structuredClone(plan);currentPlan.version=3;currentPlan.revision=4;currentPlan.config.content.expiresAt='2030-01-20T10:00:56.789Z';currentPlan.config.schedule.at='2030-01-10T10:00:59.987Z';
 const merged=messageMerge(base,mine,createMessageDraft(currentPlan));assert.equal(merged.unresolved,0);const built=buildMessageConfig(merged.draft);assert.equal(built.config.content.title,'仅改标题');assert.equal(built.config.content.expiresAt,currentPlan.config.content.expiresAt);assert.equal(built.config.schedule.at,currentPlan.config.schedule.at);
 const edited=structuredClone(mine);edited.expiresLocal='2030-01-22T12:34';edited.onceLocal='2030-01-12T10:15';const explicit=buildMessageConfig(edited);assert.equal(explicit.config.content.expiresAt,new Date(edited.expiresLocal).toISOString());assert.equal(explicit.config.schedule.at,new Date(edited.onceLocal).toISOString());
 assert.equal(plan.config.content.expiresAt,'2030-01-20T10:00:45.123Z');assert.equal(mine.config.schedule.at,'2030-01-10T10:00:55.456Z');
});
