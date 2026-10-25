import assert from 'node:assert/strict';
import test from 'node:test';
import {buildMessageConfig,createMessageDraft,messageAttemptLabel,messageAudienceLabel,messagePlanStates,messagePlansPath,messageRecipientLabel,messageRecipientsPath,messageRunsPath,messageScheduleLabel,messagingHref,messagingLocation} from '../src/lib/messaging-view-model.ts';

const planId='1a111111-1111-4111-8111-111111111111',runId='2b222222-2222-4222-8222-222222222222';
function filled(){const draft=createMessageDraft();draft.config.content.title=' 服务变更 ';draft.config.content.body='第一段\n\n第二段';draft.expiresLocal='2030-10-23T19:00';return draft;}

test('messaging APIs receive only their exact filters and preserve bigint cursors without numeric rounding',()=>{
 const location=messagingLocation({id:planId,run:runId,state:'paused',channel:'email',view:'history',after:'9007199254740993',trail:'start,21',recipientAfter:'9007199254740994',recipientChannel:'email',recipientState:'unknown',query:'private-value',scope:'all',limit:'999'});
 const plans=new URL(messagePlansPath(location),'https://admin.invalid'),runs=new URL(messageRunsPath(planId,location.after),'https://admin.invalid'),recipients=new URL(messageRecipientsPath(runId,location),'https://admin.invalid');
 assert.deepEqual([...plans.searchParams.keys()].sort(),['after','limit','state']);
 assert.equal(plans.searchParams.get('after'),'9007199254740993');
 assert.deepEqual([...runs.searchParams.keys()].sort(),['after','limit','planId']);
 assert.deepEqual([...recipients.searchParams.keys()].sort(),['after','channel','limit','state']);
 for(const value of [plans,runs,recipients])for(const key of ['id','run','view','trail','query','scope'])assert.equal(value.searchParams.has(key),false);
 const invalid=messagingLocation({id:planId+'&scope=all',run:'../other',after:'9223372036854775808',state:'expired',recipientState:'sent'});
 assert.equal(invalid.id,'');assert.equal(invalid.run,'');assert.equal(invalid.after,'');assert.equal(invalid.state,'');assert.equal(invalid.recipientState,'');
});

test('plan and run deep links keep list filters, channel, record page and return context together',()=>{
 const location=messagingLocation({id:planId,run:runId,state:'active',channel:'email',view:'recipients',after:'42',trail:'start,67',recipientAfter:'91',recipientTrail:'start,17'});
 const history=messagingLocation(Object.fromEntries(new URL(messagingHref(location,{view:'history'}),'https://admin.invalid').searchParams));
 assert.equal(history.id,planId);assert.equal(history.run,runId);assert.equal(history.channel,'email');assert.equal(history.after,'42');assert.equal(history.recipientAfter,'91');assert.deepEqual(history.recipientTrail,['start','17']);
 const back=messagingLocation(Object.fromEntries(new URL(messagingHref(history,{id:'',run:'',view:'runs'}),'https://admin.invalid').searchParams));
 assert.equal(back.state,'active');assert.equal(back.after,'42');assert.deepEqual(back.trail,['start','67']);
 assert.equal(messagingLocation({run:runId}).view,'recipients');
});

test('a new direct message requires a deliberate recipient scope while a public announcement needs no redundant recipient choice',()=>{
 const draft=filled();assert.equal(draft.audienceChosen,false);assert.equal(draft.config.audience.kind,'accounts');
 assert.match(buildMessageConfig(draft).error,/收件范围/);
 draft.config.channels=['announcement'];const announcement=buildMessageConfig(draft);assert.equal(announcement.error,'');assert.deepEqual(announcement.config.audience,{kind:'all-accounts'});
 draft.config.channels=['inapp','email'];draft.audienceChosen=true;draft.config.audience={kind:'attributes',subjectTypes:['organization']};
 const direct=buildMessageConfig(draft);assert.equal(direct.error,'');assert.deepEqual(direct.config.audience,{kind:'attributes',subjectTypes:['organization']});
 assert.equal(messageAudienceLabel({kind:'all-accounts'}),'当前业务服务的全部账户');assert.equal(messageAudienceLabel(direct.config.audience),'组织账户 · 按账户类型');
});

test('message configuration keeps plain content and valid site links without adding model, recipient hierarchy or hidden delivery claims',()=>{
 const draft=filled();draft.audienceChosen=true;draft.config.audience={kind:'accounts',accountIds:[planId]};draft.config.channels=['inapp','email','email'];draft.config.content.href='/app/rooms?room=sample';
 const result=buildMessageConfig(draft);assert.equal(result.error,'');assert.equal(result.config.content.title,'服务变更');assert.equal(result.config.content.body,'第一段\n\n第二段');assert.deepEqual(result.config.channels,['inapp','email']);assert.equal(result.config.senderKey,'notice');
 for(const href of ['//outside.invalid','/admin/operations','/api/private','/v1/accounts','/app/rooms\\other','/app/rooms path']){draft.config.content.href=href;assert.match(buildMessageConfig(draft).error,/官网内/);}
 draft.expiresLocal='';assert.match(buildMessageConfig(draft).error,/截止时间/);
});

test('guided scheduling creates a real timezone-bound recurrence and retains an existing custom schedule',()=>{
 const draft=filled();draft.config.channels=['announcement'];draft.config.schedule={kind:'recurring',cron:'',timezone:'Asia/Shanghai'};draft.recurrence={pattern:'weekly',weekday:'3',time:'09:15'};
 const weekly=buildMessageConfig(draft);assert.equal(weekly.error,'');assert.deepEqual(weekly.config.schedule,{kind:'recurring',cron:'15 9 * * 3',timezone:'Asia/Shanghai'});assert.equal(messageScheduleLabel(weekly.config.schedule),'每周三 09:15 · Asia/Shanghai');
 draft.recurrence.weekday='3,4';assert.match(buildMessageConfig(draft).error,/日期/);
 draft.recurrence.pattern='saved';draft.config.schedule.cron='0 9 1 * *';assert.equal(buildMessageConfig(draft).config.schedule.cron,'0 9 1 * *');
 draft.config.schedule.timezone='not-a-zone';assert.match(buildMessageConfig(draft).error,/时区/);
});

test('editing a current plan never mutates its saved version or a prior run content snapshot',()=>{
 const source=filled();source.config.content.expiresAt='2030-10-23T11:00:00.000Z';source.config.audience={kind:'accounts',accountIds:[planId]};
 const saved={version:4,revision:8,config:structuredClone(source.config)},runConfig=structuredClone(saved.config),draft=createMessageDraft(saved);
 draft.config.content.body='新的正文';draft.config.audience.accountIds.push(runId);draft.baseRevision=9;
 assert.equal(saved.config.content.body,'第一段\n\n第二段');assert.equal(runConfig.content.body,saved.config.content.body);assert.deepEqual(saved.config.audience.accountIds,[planId]);assert.equal(saved.revision,8);assert.equal(draft.baseVersion,4);
 assert.equal(messagePlanStates.expired,'已到期');
});

test('SMTP submission, local deferral, an unknown result and a delivered in-app notice keep distinct meanings',()=>{
 assert.equal(messageRecipientLabel({state:'submitted',deferred:false}),'已提交邮件');assert.equal(messageRecipientLabel({state:'delivered',deferred:false}),'已投递站内信');
 assert.equal(messageRecipientLabel({state:'pending',deferred:true}),'等待发送名额');assert.equal(messageRecipientLabel({state:'unknown',deferred:false}),'结果未确认');
 assert.equal(messageAttemptLabel({state:'failed',networkAttempt:false}),'本地延后，未尝试网络提交');
 assert.equal(messageAttemptLabel({state:'submitted',networkAttempt:true}),'邮件已提交');
 assert.doesNotMatch(messageAttemptLabel({state:'failed',networkAttempt:false}),/失败|送达/);
});
