import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistanceMenu } from '../assistance-menu.mjs';

const wait = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('UI did not settle'); };
const isChoice=page=>page?.kind==='select'&&page.options?.some(o=>o.title==='允许本次内容与范围');
function fixture(record, overrides = {}) {
  let page, current = true, canceled = 0, submissions = 0;
  const prepared = [], queries = [];
  const preview = { assistanceId: record.request.id, eventId: 'event', endpoint: 'https://fixture.example',
    intentJson: '{"action":"assistance.publish"}', payloadJson: '{"kind":"offer"}', confirmation: 'CONFIRM fixture' };
  const menu = createAssistanceMenu({ language: 'zh-CN', isCurrent: () => current, onBack: () => { current = false; },
    select: value => { page = { kind: 'select', ...value }; }, prompt: value => { page = { kind: 'prompt', ...value }; },
    info: (title, message, onBack) => { page = { kind: 'info', title, message, onBack }; },
    controller: {
      cancel() { canceled++; }, async queryAssistance(query) { queries.push(query); return { items: [{ ...record, assistanceId: record.request.id }], nextAfter: null }; },
      async getAssistance() { return record; }, async prepareCollaboration(input) { prepared.push(input); return preview; },
      async executeCollaboration(value, confirmation) { assert.equal(value, preview); assert.equal(confirmation, preview.confirmation); submissions++; return preview; }, ...overrides
    } });
  return { menu, prepared, queries, page: () => page, submissions: () => submissions, canceled: () => canceled,
    async readRequest() { await wait(()=>page?.kind==='info'&&page.title===record.request.title); assert.ok(page.message.includes(record.request.scope??'')); page.onBack(); await wait(()=>page?.kind==='select'&&page.title.includes(record.request.title)); },
    choose(title) { const option = page.options.find(option => option.title === title); assert.ok(option, title); page.routes[option.number](); } };
}
const request = { id: 'request', title: 'Compiler help', problem: 'Build fails', attemptedApproaches: ['Check config'], scope: 'Inspect logs',
  collaboration: 'open-assistance', enrollmentExpiresAt: Math.floor(Date.now() / 1000) + 3600 };
test('native archive previews its cutoff and submits only on confirmation',async()=>{
  let submitted=0,archive;
  const f=fixture({request},{async notificationPreferences(){return {revision:4,archiveSupported:true,archivedBefore:null,settings:{enabled:true,invitations:true,collaboration:true,materials:true,capsules:true,incidents:true,mutedAssistanceIds:[]}};},
    async queryNotifications(){return {items:[],nextAfter:null,enabled:true};},async archiveNotifications(input){archive=input;submitted++;return {removedReadMarkers:2};}});
  f.menu.open();f.choose('更多');while(!f.page().options.some(o=>o.title==='通知偏好'))f.choose('下一页');f.choose('通知偏好');
  await wait(()=>f.page().options?.some(o=>o.title==='保存偏好'));f.choose('下一页');f.choose('归档较早通知');
  f.page().onConfirm('30');assert.equal(submitted,0);assert.ok(f.page().title.includes('原协作、材料与事件仍保留'));f.choose('确认归档');
  await wait(()=>submitted===1);assert.equal(archive.expectedRevision,4);assert.ok(archive.before<Math.floor(Date.now()/1000));
});
test('native requester history opens full fact pages and carries the source cursor',async()=>{
  const reads=[],fact={eventId:'event-one',kind:'cancel',actorId:'actor',at:2000000000,summary:'Full cancellation reason',authority:'signed-participant-event'};
  const f=fixture({request},{async queryRequesterHistory(){return {subjectId:'owner',items:[{title:'Paged history',assistanceId:'case-request',factsSupported:1}],nextAfter:null};},
    async queryRequesterHistoryFacts(input){reads.push(input);return {title:'Paged history',requesterId:'owner',description:{problem:'Issue',scope:'Scope',attemptedApproaches:[]},responseSeconds:null,
      facts:input.after?[]:[fact],nextAfter:input.after?null:'event-one',visibleFactCount:1,counts:{acceptances:0,cancellations:1,disputes:0}};}});
  f.menu.open();f.choose('更多');f.choose('我的求助经历');
  await wait(()=>f.page().options?.some(o=>o.title==='Paged history'));f.choose('Paged history');await wait(()=>f.page().options?.some(o=>o.title.startsWith('取消协作 · ')));
  f.choose(f.page().options.find(o=>o.title.startsWith('取消协作 · ')).title);assert.ok(f.page().title.includes('Full cancellation reason'));assert.ok(!f.page().title.includes('event-one'));f.choose('来源详情');assert.ok(f.page().message.includes('event-one'));f.page().onBack();
  await wait(()=>f.page().options?.some(o=>o.title==='下一批事实'));f.choose('下一批事实');await wait(()=>reads.some(q=>q.after==='event-one'));
  assert.equal(reads.at(-1).assistanceId,'case-request');
});

test('legacy requester history rereads the visible source and keeps internal fact authority in its explicit source detail',async()=>{
  let visible=true,reads=0;const item={title:'Legacy request',assistanceId:'original-request',requesterId:'original-owner',factsSupported:0,
    description:{problem:'Original issue',scope:'Only this scope',attemptedApproaches:[]},facts:[{kind:'cancel',actorId:'original-actor',summary:'Original reason',authority:'signed-participant-event'}]};
  const f=fixture({request},{async queryRequesterHistory(){reads++;return{items:visible?[item]:[],nextAfter:null};}});
  f.menu.open();f.choose('更多');f.choose('我的求助经历');await wait(()=>f.page().options?.some(o=>o.title==='Legacy request'));f.choose('Legacy request');
  await wait(()=>f.page().kind==='info'&&f.page().title==='Legacy request');assert.equal(reads,2);assert.match(f.page().message,/原|Original/);assert.ok(f.page().message.includes('取消协作'));assert.ok(!f.page().message.includes('original-actor'));assert.ok(!f.page().message.includes('signed-participant-event'));
  f.page().onBack();f.choose('来源与完整记录');assert.ok(f.page().message.includes('original-actor'));assert.ok(f.page().message.includes('signed-participant-event'));f.page().onBack();f.choose('继续查看求助经历');await wait(()=>f.page().options?.some(o=>o.title==='Legacy request'));
  visible=false;f.choose('Legacy request');await wait(()=>f.page().kind==='info'&&f.page().message.includes('当前已不可读'));assert.ok(!f.page().message.includes('Original reason'));assert.equal(f.submissions(),0);
});
test('native resume-work action uses the endpoint feature and retains exact confirmation',async()=>{
  const record={request,view:'selected-provider',state:'disputed',version:8,offers:[],requesterId:'requester',selected:{providerId:'provider'},eventFeatures:{resumeWorkResolution:1}};
  const f=fixture(record);f.menu.openRequest(request.id);await f.readRequest();await wait(()=>f.page().options?.some(o=>o.title==='提出继续工作方案'));f.choose('提出继续工作方案');
  f.page().onConfirm('Deliver corrected work');await wait(()=>f.prepared.length===1);assert.equal(f.prepared[0].event.outcome,'resume-work');assert.equal(f.submissions(),0);
  f.page().onBack();assert.equal(f.submissions(),0);
  const legacy=fixture({...record,eventFeatures:undefined});legacy.menu.openRequest(request.id);await legacy.readRequest();await wait(()=>legacy.page().options?.some(o=>o.title==='提出解决方案'));
  assert.ok(!legacy.page().options.some(o=>o.title==='提出继续工作方案'));
});
test('native direct contribution action offers private or explicit public preview before signing',async()=>{
  const f=fixture({request:{...request,visibility:'Public'},view:'selected-provider',state:'awaiting-confirmation',version:3,offers:[],requesterId:'requester',selected:{providerId:'provider'}});
  f.menu.openRequest(request.id);await f.readRequest();await wait(()=>f.page().options?.some(option=>option.title==='确认参与'));f.choose('确认参与');
  assert.ok(f.page().options.some(option=>option.title==='私有：仅协作参与者'));assert.equal(f.prepared.length,0);
  f.choose('公开：用于公开履历');await wait(()=>f.prepared.length===1);assert.equal(f.prepared[0].eventVisibility,'Public');
  assert.equal(f.submissions(),0);f.page().onBack();assert.equal(f.submissions(),0);
});

test('native verifier participation shows scope and requires exact confirmation before accepting or submitting an opinion',async()=>{
  const inputs=[];let sent=0,accepted=false;
  const preview={reportId:'report',endpoint:'https://fixture.example',participation:{invitationId:'invitation',scope:'Inspect one source'},
    intentJson:'{"action":"moderation.publish"}',payloadJson:'{"invitationId":"invitation"}',confirmation:'CONFIRM VERIFIER fixture'};
  const f=fixture({request},{queryModeration:async()=>({items:[{reportId:'report',state:'open'}],nextAfter:null}),
    getModeration:async()=>({reportId:'report',caseId:'case',state:'open',report:null,source:null,events:[],canAcceptVerifier:!accepted,canDeclineVerifier:!accepted,
      canSubmitVerification:accepted,canWithdrawVerifier:accepted,verifierParticipation:{own:{scope:'Inspect one source'},independenceVerified:false}}),
    prepareModeration:async input=>{inputs.push(input);return preview;},
    executeModeration:async(value,text)=>{assert.equal(text,preview.confirmation);accepted=true;sent++;return {reportId:'report',eventId:'reply'};}});
  f.menu.openCaseModeration({caseId:'case',sourceVersion:1,events:[]});f.choose('Case举报与处理记录');await wait(()=>f.page().options?.some(o=>o.title==='report'));f.choose('report');
  await wait(()=>f.page().options?.some(o=>o.title==='接受验证者邀请'));f.choose('接受验证者邀请');f.page().onConfirm('I accept this scope');
  await wait(()=>isChoice(f.page()));
  assert.ok(f.page().options[0].description.includes('Inspect one source'));assert.equal(sent,0);f.page().routes[1]();
  await wait(()=>sent===1);f.page().onBack();await wait(()=>f.page().options?.some(o=>o.title==='提交复核意见'));
  f.choose('提交复核意见');f.choose('inconclusive');f.page().onConfirm('Insufficient external evidence');
  await wait(()=>isChoice(f.page()));assert.equal(inputs.at(-1).conclusion,'inconclusive');
  assert.equal(sent,1);f.page().onBack();assert.equal(sent,1);
});

test('native Case moderation reports the selected source version and reuses independent decisions without Assistance',async()=>{
  const inputs=[],filters=[];let sent=0;
  const preview={reportId:'case-report',endpoint:'https://fixture.example',intentJson:'{"action":"moderation.publish","visibility":"Private"}',payloadJson:'{"caseId":"case","targetEventId":"event-2"}',confirmation:'CONFIRM MODERATION case'};
  const f=fixture({request},{
    queryModeration:async input=>{filters.push(input);return {items:[{reportId:'case-report',caseId:'case',state:'open',paused:false}],nextAfter:null};},
    getModeration:async()=>({reportId:'case-report',caseId:'case',state:'open',paused:false,report:{summary:'A claim'},source:null,events:[],canModerate:true}),
    prepareModeration:async input=>{inputs.push(input);return preview;},
    executeModeration:async(value,confirmation)=>{assert.equal(value,preview);assert.equal(confirmation,preview.confirmation);sent++;return {reportId:'case-report',eventId:'decision'};}
  });
  f.menu.openCaseModeration({caseId:'case',sourceVersion:7,events:[{id:'event-1',kind:'case'},{id:'event-2',kind:'result'}]});
  assert.match(f.page().title,/提出争议不等于裁决/);f.choose('就此Case提出争议');f.choose('result · event-2');
  f.page().onConfirm('misrepresentation');f.page().onConfirm('Disputed result');
  await wait(()=>isChoice(f.page()));
  assert.deepEqual(inputs[0],{kind:'report',caseId:'case',caseVersion:7,targetEventId:'event-2',category:'misrepresentation',summary:'Disputed result'});
  assert.equal(sent,0);f.page().onBack();assert.equal(sent,0);
  f.choose('Case举报与处理记录');await wait(()=>f.page().options?.some(o=>o.title==='case-report'));
  assert.deepEqual(filters[0],{caseId:'case',limit:8});f.choose('case-report');
  await wait(()=>f.page().options?.some(o=>o.title==='查看Case来源与报告版本'));
  f.choose('查看Case来源与报告版本');assert.match(f.page().message,/处理权限不授予来源访问/);f.page().onBack();
  await wait(()=>f.page().options?.some(o=>o.title==='暂停Case关联协作与衍生资格'));
  f.choose('暂停Case关联协作与衍生资格');f.page().onConfirm('Hold related work');
  await wait(()=>isChoice(f.page()));f.page().routes[1]();
  await wait(()=>sent===1);assert.equal(inputs[1].kind,'pause');assert.equal(f.queries.length,0);
});

test('history-linked collaboration opens its exact dispute and moderation records without a discovery search',async()=>{
  let selection;
  const f=fixture({request,view:'selected-provider',state:'disputed',paused:true,version:5,offers:[],requesterId:'requester',selected:{providerId:'provider'}},
    {queryModeration:async input=>{selection=input;return {items:[{reportId:'report',state:'open',paused:true}],nextAfter:null};}});
  f.menu.openRequest(request.id);await f.readRequest();await wait(()=>f.page().options?.some(option=>option.title==='举报与处理记录'));
  assert.equal(f.queries.length,0);f.choose('举报与处理记录');await wait(()=>f.page().options?.some(option=>option.title==='report'));
  assert.equal(selection.assistanceId,request.id);assert.equal(f.submissions(),0);
  f.page().onBack();await wait(()=>f.page().title.includes('Compiler help'));f.page().onBack();assert.equal(f.canceled(),1);
});

test('native Evidence report and independent revalidation preserve the exact result and Evidence target',async()=>{
  const inputs=[];let sent=0;
  const preview={reportId:'evidence-report',endpoint:'https://fixture.example',intentJson:'{"action":"moderation.publish"}',payloadJson:'{"evidenceId":"evidence"}',confirmation:'CONFIRM EVIDENCE fixture'};
  const f=fixture({request},{
    queryModeration:async()=>({items:[{reportId:'evidence-report',state:'open',paused:false}],nextAfter:null}),
    getModeration:async()=>({reportId:'evidence-report',caseId:'case',state:'open',paused:false,report:null,source:null,events:[],canModerate:true,canRevalidate:true,revalidation:{evidenceId:'evidence',generation:1,state:'completed'}}),
    prepareModeration:async input=>{inputs.push(input);return preview;},executeModeration:async()=>{sent++;return {eventId:'revalidation'};}
  });
  f.menu.openCaseModeration({caseId:'case',sourceVersion:3,events:[{id:'result',kind:'result'}]});
  f.choose('就此Case提出争议');f.choose('此结果的Evidence争议 · result');f.page().onConfirm('evidence');f.page().onConfirm('Please check changed source');
  await wait(()=>isChoice(f.page()));
  assert.deepEqual(inputs[0],{kind:'report',caseId:'case',caseVersion:3,targetEventId:'result',category:'false-verification',evidenceId:'evidence',summary:'Please check changed source'});
  f.page().onBack();f.choose('Case举报与处理记录');await wait(()=>f.page().options?.some(o=>o.title==='evidence-report'));f.choose('evidence-report');
  await wait(()=>f.page().options?.some(o=>o.title==='重新验证此Evidence'));f.choose('重新验证此Evidence');f.page().onConfirm('Revalidate now');
  await wait(()=>isChoice(f.page()));assert.equal(sent,0);
  assert.deepEqual(inputs[1],{kind:'revalidate',reportId:'evidence-report',evidenceId:'evidence',summary:'Revalidate now'});
  f.page().routes[1]();await wait(()=>sent===1);
});

test('native assistance menu searches, renders details, builds an offer and sends only after confirmation', async () => {
  const f = fixture({ request, view: 'applicant', state: 'open', version: 1, offers: [], requesterId: 'requester' });
  f.menu.open(); f.choose('找需要帮助的工作'); await wait(() => f.page().kind === 'select' && f.page().options.some(o => o.title === request.title));
  assert.equal(f.queries[0].view, 'open');
  f.choose(request.title);await f.readRequest(); await wait(() => f.page().kind === 'select' && f.page().options.some(o => o.title === '申请协助'));
  f.choose('申请协助'); f.page().onConfirm('Proposed fix'); f.page().onConfirm('Inspect compiler logs');
  await wait(() => isChoice(f.page()));
  assert.equal(f.submissions(), 0); assert.deepEqual(f.prepared[0], { assistanceId: 'request', event: { kind: 'offer', proposal: 'Proposed fix', scope: 'Inspect compiler logs' } });
  f.page().routes[2](); assert.equal(f.submissions(), 0); f.page().onBack();
  f.page().routes[1](); await wait(() => f.submissions() === 1);
});

test('native resolution controls offer confirmation only to the other party and preserve explicit scope', async () => {
  const record = { request, view: 'requester', state: 'awaiting-resolution-confirmation', version: 7, offers: [],
    requesterId: 'requester', selected: { providerId: 'provider' }, resolution: { id: 'resolution', proposerId: 'provider', summary: 'Agreed fix' } };
  const f = fixture(record); f.menu.open(); f.choose('我发起的求助'); await wait(() => f.page().options?.some(o => o.title === request.title));
  f.choose(request.title);await f.readRequest(); await wait(() => f.page().options?.some(o => o.title === '确认对方解决方案'));
  f.choose('确认对方解决方案'); await wait(() => f.prepared.length === 1);
  assert.deepEqual(f.prepared[0].event, { kind: 'confirm-resolution', proposalId: 'resolution' });
  await wait(() => isChoice(f.page())); f.page().onBack(); assert.equal(f.submissions(), 0); assert.equal(f.canceled(), 1);
});

test('native materials menu requires a separate participant confirmation before displaying text', async () => {
  let accepted = false, submitted = 0, prepared;
  const record = { request, view: 'selected-provider', state: 'active', version: 4, offers: [],
    requesterId: 'requester', selected: { providerId: 'provider' }, agreedScope: 'Inspect logs' };
  const grant = () => ({ grantId: 'grant', state: accepted ? 'accepted' : 'pending', scope: 'Inspect logs',
    participantId: 'provider', expiresAt: 2000000000, materialsHash: 'hash', contextAccessGranted: accepted,
    materials: [{ label: 'Selected log', contentHash: 'hash', ...(accepted ? { content: 'Visible excerpt' } : {}) }] });
  const preview = { grantId: 'grant', endpoint: 'https://fixture.example', intentJson: '{"action":"context.grant"}',
    payloadJson: '{"grantId":"grant"}', confirmation: 'CONFIRM MATERIALS fixture' };
  const f = fixture(record, { async queryContext() { return { items: [grant()] }; }, async getContext() { return grant(); },
    async prepareContext(input) { prepared = input; return preview; },
    async executeContext(value, confirmation) { assert.equal(value, preview); assert.equal(confirmation, preview.confirmation); submitted++; accepted = true; return { grantId: 'grant', state: 'accepted' }; } });
  f.menu.open(); f.choose('我参与的协作'); await wait(() => f.page().options?.some(o => o.title === request.title));
  f.choose(request.title);await f.readRequest(); await wait(() => f.page().options?.some(o => o.title === '查看材料授权'));
  f.choose('查看材料授权'); await wait(() => f.page().options?.some(o => o.title === 'Selected log'));
  f.choose('Selected log'); await wait(() => f.page().options?.some(o => o.title === '确认接收这份材料授权'));
  assert.ok(!f.page().title.includes('Visible excerpt'));
  f.choose('确认接收这份材料授权'); await wait(() => isChoice(f.page()));
  assert.deepEqual(prepared, { kind: 'accept', grantId: 'grant' }); assert.equal(submitted, 0);
  await f.page().routes[1](); await wait(() => f.page().kind === 'info' && f.page().message === '所选材料的授权已保存。');
  f.page().onBack(); await wait(() => f.page().options?.some(o => o.title === 'Selected log'));
  f.choose('Selected log'); assert.equal(f.page().message, 'Visible excerpt'); assert.equal(submitted, 1);
});

test('native inbox opens source events and saves an explicit unsubscribe preference', async () => {
  const settings = { enabled:true,invitations:true,collaboration:true,materials:true,mutedAssistanceIds:[] };
  let saved, reads=0;
  const record={request,view:'applicant',state:'open',version:1,offers:[],requesterId:'requester'};
  const f=fixture(record,{
    async queryNotifications(){return {enabled:true,items:[{id:'assistance:event',assistanceId:'request',title:'Invitation',eventKind:'invite',category:'invitations',read:false,summary:'Inspect this request'}],nextAfter:null};},
    async markNotificationRead(id){assert.equal(id,'assistance:event');reads++;return {id,read:true};},
    async notificationPreferences(){return {revision:0,settings};},
    async saveNotificationPreferences(input){saved=input;return {revision:1,settings:input.settings};}
  });
  f.menu.open();f.choose('消息');await wait(()=>f.page().options?.some(o=>o.title==='Invitation'));
  f.choose('Invitation');assert.ok(f.page().message.includes('Inspect this request'));f.page().onBack();await wait(()=>reads===1);
  await f.readRequest();await wait(()=>f.page().options?.some(o=>o.title==='申请协助'));
  f.menu.open();f.choose('更多');f.choose('通知偏好');await wait(()=>f.page().options?.some(o=>o.title==='站内通知总开关'));
  f.choose('站内通知总开关');assert.equal(saved,undefined);f.choose('保存偏好');await wait(()=>!!saved);
  assert.equal(saved.expectedRevision,0);assert.equal(saved.settings.enabled,false);
});

test('native incident notice returns to inbox without opening a nonexistent collaboration',async()=>{
  let reads=0,opened=0;
  const f=fixture({request,view:'applicant',state:'open',version:1,offers:[]},{
    async queryNotifications(){return {enabled:true,nextAfter:null,items:[{id:'incident:notice',incidentId:'incident',title:'Service incident',eventKind:'incident-update',actorId:'operator:fixture',summary:'Recovery advice',at:'2026-09-10',category:'incidents',read:!!reads}]};},
    async markNotificationRead(){reads++;return {read:true};},async getAssistance(){opened++;throw new Error('No collaboration for incident');}
  });
  f.menu.open();f.choose('消息');await wait(()=>f.page().options?.some(o=>o.title==='Service incident'));
  f.choose('Service incident');assert.ok(f.page().message.includes('Recovery advice'));f.page().onBack();
  await wait(()=>reads===1&&f.page().options?.some(o=>o.title==='Service incident'));assert.equal(opened,0);
});

test('paused native collaboration exposes report confirmation and hides work actions', async()=>{
  let prepared,submitted=0;
  const preview={reportId:'report',endpoint:'https://fixture.example',intentJson:'{"action":"moderation.publish"}',payloadJson:'{}',confirmation:'CONFIRM MODERATION fixture'};
  const f=fixture({request,view:'selected-provider',state:'active',paused:true,version:4,offers:[],requesterId:'requester',selected:{providerId:'provider'}},{
    async queryModeration(){return {items:[],nextAfter:null};},async prepareModeration(input){prepared=input;return preview;},
    async executeModeration(value,confirmation){assert.equal(value,preview);assert.equal(confirmation,preview.confirmation);submitted++;return {reportId:'report',eventId:'report'};}
  });
  f.menu.open();f.choose('我参与的协作');await wait(()=>f.page().options?.some(o=>o.title===request.title));f.choose(request.title);await f.readRequest();
  await wait(()=>f.page().options?.some(o=>o.title==='举报该协作'));
  assert.ok(f.page().title.includes('管理暂停'));assert.ok(!f.page().options.some(o=>o.title==='提交交付'));
  f.choose('举报该协作');f.page().onConfirm('scope');f.page().onConfirm('Review request');await wait(()=>isChoice(f.page()));
  assert.equal(submitted,0);assert.deepEqual(prepared,{kind:'report',assistanceId:'request',category:'scope',summary:'Review request'});
  f.page().routes[1]();await wait(()=>submitted===1);
});

test('native moderation adds artifact references and corrects own statements through exact previews',async()=>{
  const inputs=[];let sent=0;
  const preview={reportId:'report',endpoint:'https://fixture.example',intentJson:'{"action":"moderation.publish"}',payloadJson:'{}',confirmation:'CONFIRM MODERATION fixture'};
  const f=fixture({request,view:'selected-provider',state:'active',paused:true,version:4,offers:[],requesterId:'requester',selected:{providerId:'provider'}},{
    async queryModeration(){return {items:[{reportId:'report',state:'resolved',paused:true}],nextAfter:null};},
    async getModeration(){return {reportId:'report',state:'resolved',paused:true,report:null,events:[],canSupplement:true,canCorrectEventIds:['own-event'],canModerate:false,canAppeal:true};},
    async prepareModeration(input){inputs.push(input);return preview;},async executeModeration(){sent++;return {reportId:'report',eventId:'event'};}
  });
  f.menu.open();f.choose('我参与的协作');await wait(()=>f.page().options?.some(o=>o.title===request.title));f.choose(request.title);await f.readRequest();
  await wait(()=>f.page().options?.some(o=>o.title==='举报与处理记录'));f.choose('举报与处理记录');await wait(()=>f.page().options?.some(o=>o.title==='report'));f.choose('report');
  await wait(()=>f.page().options?.some(o=>o.title==='补充说明与引用'));
  f.choose('补充说明与引用');f.page().onConfirm('Artifact observation');f.choose('添加引用: artifact');f.page().onConfirm('a'.repeat(64));f.choose('确认补充');
  await wait(()=>isChoice(f.page()));
  assert.equal(sent,0);assert.deepEqual(inputs[0],{kind:'supplement',reportId:'report',summary:'Artifact observation',references:[{kind:'artifact',sha256:'a'.repeat(64)}]});
  f.page().routes[1]();await wait(()=>sent===1);f.page().onBack();
  await wait(()=>f.page().options?.some(o=>o.title==='纠正自己的说明'));f.choose('纠正自己的说明');f.choose('own-event');
  f.page().onConfirm('Corrected observation');f.page().onConfirm('Clarification');await wait(()=>inputs.length===2);
  assert.deepEqual(inputs[1],{kind:'correct',reportId:'report',correctsEventId:'own-event',summary:'Corrected observation',reason:'Clarification'});
});
