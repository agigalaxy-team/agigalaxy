import test from 'node:test';
import assert from 'node:assert/strict';
import {auditActionLabel,auditActorLabel,auditActorRole,auditAvailableActions,auditCursor,auditDay,auditDecision,auditExecution,auditFilterHref,auditHref,auditInitiator,auditKind,auditMetadata,auditNextHref,auditObjects,auditOutcome,auditPreviousHref,auditReadPath,auditRelations,normalizeAuditFilters} from '../src/lib/audit-view-model.ts';

const id='11111111-1111-4111-8111-111111111111',object='22222222-2222-4222-8222-222222222222';
const operation='33333333-3333-4333-8333-333333333333',request='44444444-4444-4444-8444-444444444444';
const event=(values={})=>({id,sequence:'31',operatorId:'verified-operator',operatorRole:'administrator',action:'feedback-update',accountId:null,operationId:null,httpRequestId:null,selection:{},result:{},createdAt:'2026-10-22T01:30:00Z',...values});

test('AI execution identity and verified decisions keep the exact task and original outcome distinct',()=>{
 const attribution={schemaVersion:1,aiAccountId:object,aiAccountName:'运维岗位',domain:'maintenance',initiatorKind:'schedule',initiatorOperatorId:null,initiatorDisplayName:null,
  decisionSource:'unknown',decisionBasis:'not-recorded',taskId:request,taskSource:'routine',taskReadable:true,cardId:null,planId:null,planVersion:null,grantId:null,grantVersion:null,strategyId:null,strategyVersionId:null},
  item=event({actorKind:'operations-ai-service',operatorRole:null,operatorDisplayName:'不能冒用的管理员名',operatorId:'ai:'+object,attribution,result:{state:'draft'}});
 assert.equal(auditActorLabel(item),'运维岗位');assert.equal(auditActorRole(item),'AI 工作账户');assert.equal(auditExecution(item),'AI 服务账户');assert.equal(auditInitiator(item),'值守计划');assert.equal(auditDecision(item),'未记录');assert.equal(auditOutcome(item).key,'draft');
 assert.equal(auditDecision({...item,attribution:{...attribution,decisionSource:'ai',decisionBasis:'verified-native-tool'}}),'AI 工具判断');
 assert.equal(auditObjects(item).find(x=>x.kind==='autonomy-task')?.href,'/admin/operations/ai-runs?task='+request);
 assert.equal(auditObjects({...item,attribution:{...attribution,taskReadable:false}}).find(x=>x.kind==='autonomy-task')?.href,null);
 assert.deepEqual(auditRelations(item,[item,{...item,id:operation,operationId:object}])[0].basis,['同一任务']);
 assert.equal(auditDecision(event()),'未记录','a role label alone does not prove a historical decision');
 assert.equal(auditDecision(event({attribution:{...attribution,initiatorKind:'human',decisionSource:'human-confirmed',decisionBasis:'confirmed-operation-card',cardId:operation}})),'人工确认操作卡');
});

test('audit rendering exposes only explicit metadata paths and never arbitrary text or nested credentials',()=>{
 const metadata=auditMetadata({id:object,count:0,state:'pending',reason:'private reason',summary:'private summary',query:'private search',note:'private note',noteHash:'private hash',token:'private token',authorization:'private authorization',
  restriction:{active:true,revision:2,reason:'nested private reason',credentials:'nested private token'},
  profile:{subjectType:'person',displayName:'private display name',revision:3},unknown:{state:'private state'},
  fields:['category','note','password','token']});
 const text=JSON.stringify(metadata);
 for(const hidden of ['private reason','private summary','private search','private note','private hash','private token','private authorization','private display name','private state','password']){
  assert.equal(text.includes(hidden),false,hidden+' must stay outside the display projection');
 }
 assert.equal(metadata.find(item=>item.key==='count')?.value,'0');
 assert.equal(metadata.find(item=>item.key==='restriction.active')?.value,'是');
 assert.equal(metadata.find(item=>item.key==='fields')?.value,'反馈类型、内部备注');
 assert.deepEqual(auditMetadata(JSON.parse('{"constructor":"private constructor","__proto__":{"id":"'+object+'"}}')),[]);
 assert.deepEqual(auditMetadata({state:'unapproved-private-state',module:'unapproved-private-module',key:'unapproved-private-key'}),[]);
 assert.equal(auditMetadata({key:'forum-quota'})[0].value,'论坛额度');
 assert.equal(auditMetadata({state:'failed'})[0].value,'失败');
});

test('administrator or action names do not invent a decision source, execution channel or success result',()=>{
 const record=event({action:'retention-failed'});
 assert.equal(auditOutcome(record).key,'unknown');
 assert.equal(auditOutcome(record).label,'未记录');
 assert.equal(auditExecution(record),'未记录');
 assert.equal(auditExecution(event({operatorRole:'ai'})),'未记录');
 assert.equal(auditExecution(event({selection:{execution:'worker'}})),'后台Worker');
 assert.equal(auditOutcome(event({result:{state:'failed'}})).key,'failed');
 assert.equal(auditOutcome(event({action:'users-query',result:{count:0}})).label,'返回0条');
});

test('chat message audit displays only recorded operation metadata without inventing source or content links',()=>{
 const values=auditMetadata({reportId:id,roomId:object,messageId:operation,sourceRevision:3,revision:2,hidden:true,replayed:false,kind:'message-hide',
  summary:'private case reason',body:'private message',query:'private search',source:'unrecorded source'});
 assert.equal(values.find(item=>item.key==='kind')?.value,'屏蔽本案消息');
 assert.equal(values.find(item=>item.key==='messageId')?.value,operation);
 assert.equal(values.find(item=>item.key==='sourceRevision')?.value,'3');
 assert.equal(values.find(item=>item.key==='hidden')?.value,'是');
 assert.equal(JSON.stringify(values).includes('private'),false);
 assert.deepEqual(auditMetadata({kind:'unapproved-message-action',roomId:'private-room',messageId:'private-message'}),[]);
 assert.equal(auditMetadata({kind:'message-restore'})[0].value,'解除本案消息屏蔽');
 assert.equal(auditMetadata({kind:'message-keep'})[0].value,'维持本案消息覆盖');
 assert.equal(auditExecution(event({action:'chat-report-event',selection:{kind:'message-hide'}})),'未记录');
 assert.ok(auditObjects(event({action:'chat-report-event',selection:{reportId:id,roomId:object,messageId:operation}})).every(item=>item.href===null));
});

test('file audit links retain the recorded source kind and survive shared resource locators without guessing a source',()=>{
 for(const kind of ['chat','forum']){
  const file=auditObjects(event({action:'file-retry',selection:{id:object,resourceId:object,kind}}));
  assert.equal(file.length,1);assert.equal(file[0].kind,'file');
  const href=new URL(file[0].href,'https://example.invalid');assert.equal(href.pathname,'/admin/operations/files');
  assert.equal(href.searchParams.get('id'),object);assert.equal(href.searchParams.get('fileKind'),kind);
  assert.deepEqual([...href.searchParams.keys()],['fileKind','id']);
 }
 for(const kind of [undefined,'feedback','https://private.example.invalid']){
  const file=auditObjects(event({action:'file-read',selection:{id:object,resourceId:object,kind}}));
  assert.equal(file.length,1);assert.equal(file[0].href,null);
 }
 const explicit=auditObjects(event({selection:{fileId:object,kind:'forum'}}));
 assert.equal(new URL(explicit[0].href,'https://example.invalid').searchParams.get('fileKind'),'forum');
});

test('associations require shared recorded operations, requests or non-account objects',()=>{
 const record=event({accountId:object,operationId:operation,httpRequestId:request,selection:{fileId:id}});
 const unrelated=event({id:'55555555-5555-4555-8555-555555555555',accountId:object});
 assert.deepEqual(auditRelations(record,[record,unrelated]),[],'same operator, role, account and time do not establish a process');
 const other=event({id:'66666666-6666-4666-8666-666666666666',operationId:operation,httpRequestId:request,selection:{fileId:id}});
 assert.deepEqual(auditRelations(record,[record,other])[0].basis,['同一操作','同一请求','同一对象']);
});

test('action menus use actual controlled codes and query categories include newer content reads',()=>{
 assert.deepEqual(new Set(auditAvailableActions(['feedback-query','community-content-query','feedback-query','unapproved-private-string','constructor'])),new Set(['feedback-query','community-content-query']));
 assert.equal(auditAvailableActions(null).length,0);
 assert.equal(auditKind(event({action:'community-content-query'})),'reads');
 assert.equal(auditKind(event({action:'community-content-batch-preview'})),'reads');
 assert.equal(auditKind(event({action:'community-content-curation'})),'business');
 assert.equal(auditActionLabel('future-action'),'其他业务记录');
});

test('server filters preserve scope and paging, reset cursors on changes and use the Shanghai calendar day',()=>{
 const filters=normalizeAuditFilters({account:id,resource:object,after:'123',trail:'0',selected:operation,query:' metadata term ',kind:'reads',action:'feedback-read',day:'2026-10-22'});
 const backend=new URL(auditReadPath(filters),'https://example.invalid');
 assert.deepEqual([...backend.searchParams.keys()],['limit','accountId','resourceId','after','query','kind','action','day']);
 assert.equal(backend.searchParams.get('query'),'metadata term');
 assert.equal(backend.searchParams.has('id'),false);
 assert.equal(backend.searchParams.has('trail'),false);
 assert.equal(backend.searchParams.has('outcome'),false);
 assert.equal(backend.searchParams.get('accountId'),id);
 const next=auditNextHref(filters,'90'),nextUrl=new URL(next,'https://example.invalid');
 assert.equal(nextUrl.searchParams.get('q'),'metadata term');
 assert.equal(nextUrl.searchParams.get('id'),null);
 const nextFilters=normalizeAuditFilters({...filters,after:nextUrl.searchParams.get('after'),trail:nextUrl.searchParams.get('trail'),selected:''});
 const previous=new URL(auditPreviousHref(nextFilters),'https://example.invalid');
 assert.equal(previous.searchParams.get('after'),'123');
 assert.equal(previous.searchParams.get('resource'),object);
 assert.equal(previous.searchParams.get('day'),'2026-10-22');
 const changed=new URL(auditFilterHref(filters,{query:'next term'}),'https://example.invalid');
 assert.equal(changed.searchParams.get('after'),null);assert.equal(changed.searchParams.get('trail'),null);assert.equal(changed.searchParams.get('id'),null);
 assert.equal(changed.searchParams.get('accountId'),id);assert.equal(changed.searchParams.get('resource'),object);assert.equal(changed.searchParams.get('day'),'2026-10-22');
 assert.equal(auditFilterHref(filters,{query:' metadata term '}),auditHref(filters),'unchanged normalized filters retain the current page and selection');
 assert.equal(auditDay('2026-10-21T15:59:59.999Z'),'2026-10-21');
 assert.equal(auditDay('2026-10-21T16:00:00Z'),'2026-10-22');
 assert.equal(auditDay('2026-10-22T16:00:00Z'),'2026-10-23');
 assert.equal(auditCursor('9223372036854775807'),'9223372036854775807');
 assert.equal(auditCursor('9223372036854775808'),'');
 assert.equal(normalizeAuditFilters({day:'2026-02-31',trail:'0.invalid'}).day,'');
 assert.equal(normalizeAuditFilters({day:'0000-01-01'}).day,'');
 assert.equal(normalizeAuditFilters({trail:'0.invalid'}).trail,'');
 assert.equal(auditHref(normalizeAuditFilters({resource:'javascript:invalid'})),'/admin/operations/audit');
});

test('resource links require known UUID evidence and do not turn private material into a generic content link',()=>{
 assert.equal(auditObjects(event({selection:{id:'javascript:alert(1)',fileId:'not-a-uuid'}})).length,0);
 const feedback=auditObjects(event({selection:{id:object}}));
 assert.equal(feedback[0].href,'/admin/operations/feedback?id='+object);
 const report=auditObjects(event({action:'chat-report-read',selection:{reportId:object}}));
 assert.equal(report[0].href,null,'a private chat report must not be linked to a public-content report page');
});
