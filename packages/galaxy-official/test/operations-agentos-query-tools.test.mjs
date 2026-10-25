import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {p14Fixture} from './p14-rules-fixture.mjs';
import {joinAccountConversation} from './account-chat-fixture.mjs';
import {OperationsAgentOsQueryTools} from '../src/operations-agentos-query-tools.mjs';
import {agentOsQueryArgumentsSchema,agentOsReadArgumentsSchema,agentOsQueryViews} from '../src/shared/operations-agentos-query-schema.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {AccountChatGovernanceService} from '../src/account-chat-governance.mjs';
import {OperationsFeedbackService} from '../src/operations-feedback.mjs';
import {OperationsFilesService} from '../src/operations-files.mjs';
import {OperationsResourcesService} from '../src/operations-resources.mjs';
import {DiscoveryRuntime} from '../src/discovery-runtime/runtime.mjs';
import {PublicCommunitySource} from '../src/discovery-runtime/public-content-source.mjs';
import {OperationsSearchQualityService} from '../src/operations-search-quality.mjs';
import {OperationsRecommendationService} from '../src/operations-recommendation.mjs';
import {OperationsMessagingService} from '../src/operations-messaging.mjs';
import {P13StrategiesService} from '../src/operations/strategies/service.mjs';
import {OperationsMaintenanceService} from '../src/operations-maintenance.mjs';
import {OperationsAiRunsService} from '../src/operations-ai-runs.mjs';
import {createOperationsJobs} from '../src/operations-jobs.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

// Real migrated PGlite services and current PG business grants are used across
// all eighteen modules. Native analytics/maintenance/trace/queue I/O and the
// management directory are explicit local doubles, never production assertions.
test('cross-module query tools use actual service DTOs across eighteen modules, preserve facts and suppress private prose', {timeout:120000},async t=>{
 const f=await p14Fixture(t),governance=new CommunityForumGovernanceV1(f.access,null,f.forum,{accounts:f.accounts}),community=new OperationsCommunityService({businessAdmin:f.businessAdmin,forum:f.forum,governance,now:f.now}),chatReports=new AccountChatGovernanceService({chat:f.chat,businessAdmin:f.businessAdmin}),feedback=new OperationsFeedbackService({businessAdmin:f.businessAdmin,accounts:f.accounts,now:f.now}),
  files=new OperationsFilesService({businessAdmin:f.businessAdmin,chatAttachments:f.files,forumAttachments:f.forumFiles,now:f.now}),resources=new OperationsResourcesService({businessAdmin:f.businessAdmin,projects:null,capsules:null,maxHideSeconds:600,now:f.now}),source=new PublicCommunitySource({db:f.db,endpoint:f.endpoint,forum:f.forum});
 f.businessAdmin.forum=f.forum;
 const meili={settings:async()=>({synonyms:{},rankingRules:['words','typo','proximity','attribute','sort','exactness']}),search:async()=>({hits:[]})},quality=new OperationsSearchQualityService({...f,permissions:f.permissions,businessAdmin:f.businessAdmin,meili}),
  panel={tool:async(name)=>name==='get_profile_metrics'?{sessions:3,screenViews:8,totalEvents:15,uniqueDaysActive:2,avgSessionDurationMin:4,firstSeen:'2033-05-17T03:33:20.000Z',lastSeen:'2033-05-18T03:33:20.000Z',revenue:987654321}:{}},
  analytics=new DiscoveryRuntime({...f,permissions:f.permissions,forum:f.forum,source,meili,searchQuality:quality,openpanel:panel}),recommendations=new OperationsRecommendationService({...f,permissions:f.permissions,businessAdmin:f.businessAdmin,source});
 const queue=new EventEmitter();queue.findJobs=async()=>[{id:randomUUID(),name:'search-recovery',state:'failed',createdOn:new Date(f.now()*1000),data:{privateBody:'QUEUE_PRIVATE_BODY'},output:{code:'search_retry_required',secret:'QUEUE_SECRET'}}];
 const jobs=createOperationsJobs({db:f.db,boss:queue}),messaging=new OperationsMessagingService({...f,businessAdmin:f.businessAdmin,accounts:f.accounts,jobs:{onCancel(){},enqueue:async()=>randomUUID()},now:f.now}),
  strategies=new P13StrategiesService({...f,businessAdmin:f.businessAdmin,native:{status:async()=>({state:'connected',modelState:'not-configured'})}}),
  maintenance=new OperationsMaintenanceService({businessAdmin:f.businessAdmin,native:{call:async input=>input.kind==='catalog'?{items:[],total:0}:input.kind==='logs'?{items:[{at:new Date(f.now()*1000).toISOString(),component:'business-api',level:'error',event:'operations_query_failed',code:'operations_query_unavailable',message:'PRIVATE_LOG_MESSAGE'}]}:{components:[],storage:[]}},now:f.now}),
  authority=new OperationsAgentOsAuthority({...f,permissions:f.permissions}),aiRuns=new OperationsAiRunsService({authority,client:{runs:async()=>({items:[{runId:'real-native-contract',domain:'overview',state:'COMPLETED',createdAt:f.now(),updatedAt:f.now(),tokens:{input:null,output:null,total:null},content:'PRIVATE_RUN_CONTENT'}],total:1,nextPage:null}),runDetail:async()=>({run:{runId:'real-native-contract',domain:'overview',state:'COMPLETED',createdAt:f.now()},spans:[],events:[],input:'PRIVATE_RUN_INPUT'})}});
 const tools=new OperationsAgentOsQueryTools({authority,services:{accounts:f.businessAdmin,community,content:community.content,chatReports,feedback,files,resources,analytics,recommendations,searchQuality:quality,messaging,strategies,rules:f.rules,maintenance,aiRuns,jobs,permissions:f.permissions}}),
  query=(module,view,filters={})=>tools.execute({actor:f.admin,domain:'overview',tool:'query-operations',arguments:{module,view,filters}}),
  read=(kind,id,filters={})=>tools.execute({actor:f.admin,domain:'overview',tool:'read-operation-object',arguments:{kind,id,filters}});
 const p=await bindForumIds('create-post','account:'+f.people[0].accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:f.people[0].accountId,title:'当前公开源标题',body:'CURRENT_PUBLIC_BODY',links:[],topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});
 await f.forum.publish(f.people[0],{payloadJson:JSON.stringify(p)});
 const report=await bindForumIds('create-report','account:'+f.people[1].accountId,{schemaVersion:1,operationId:randomUUID(),reportId:randomUUID(),accountId:f.people[1].accountId,target:{kind:'post-version',postId:p.postId,versionId:p.versionId},category:'other',summary:'PRIVATE_CASE_PROSE'});await governance.report(f.people[1],{payloadJson:JSON.stringify(report)});
 const feedbackReceipt=await feedback.submit(f.people[0],{operationId:randomUUID(),body:'PRIVATE_FEEDBACK_PROSE',category:'problem',module:'account'});
 const roomId=await joinAccountConversation(f,f.people[0],f.people[1]),sent=await f.chat.send(f.people[0],roomId,{clientMessageId:randomUUID(),text:'PRIVATE_CHAT_BODY'}),selection=await chatReports.source(f.people[1],{roomId,messageIds:[sent.messageId]});
 const chatCase=await chatReports.report(f.people[1],{operationId:randomUUID(),roomId,roomVersion:selection.roomVersion,category:'harassment',summary:'PRIVATE_CHAT_REPORT',materials:[{messageId:sent.messageId,revision:1,attachmentIds:[]}]});
 const attachmentId=randomUUID(),bytes=Buffer.from('PRIVATE_FILE_BYTES');await f.files.prepare(f.people[0],{attachmentId,roomId,name:'真实文件名.txt',mediaType:'text/plain',size:bytes.length,sha256:f.digest(bytes),purpose:'temporary-room-attachment',confirmed:true});await f.files.upload(f.people[0],attachmentId,Readable.from([bytes]),{contentLength:bytes.length});await f.files.scanPending();
 const plan=(await messaging.create(f.admin,{operationId:randomUUID(),config:{channels:['inapp'],content:{purpose:'service-update',title:'PRIVATE_NOTICE_TITLE',body:'PRIVATE_NOTICE_BODY',href:'/guide/',expiresAt:new Date((f.now()+3600)*1000).toISOString()},audience:{kind:'all-accounts'},senderKey:'notice',schedule:{kind:'immediate'}}},{authorize:async()=>f.admin})).plan;
 const active=(await messaging.action(f.admin,plan.id,'activate',{operationId:randomUUID(),expectedVersion:plan.version,expectedRevision:plan.revision},{authorize:async()=>f.admin})).plan,run=(await messaging.execute({planId:active.id,planVersion:active.version},{jobId:randomUUID()})).run;
 await f.db.query("UPDATE operations_messaging_recipients_v1 SET state='failed',error_code='synthetic_delivery_failed' WHERE run_id=$1 AND account_id=$2",[run.id,f.people[0].accountId]);
 const visitorId=randomUUID(),empty=await analytics.search({query:'当前缺少结果',limit:2},{usageIdentity:{actor:f.people[0],visitorId}});await analytics.recordUsage(f.people[0],visitorId,{eventId:randomUUID(),name:'search',pageKey:'find',query:empty.query,search:{requestId:empty.search.requestId}});f.advance(1);
 // Every exposed module is routed through its real service instance.
 const requests=[['accounts','list'],['accounts','summary'],['content','list'],['content','sections'],['content','tags'],['cases','list'],['chat-reports','list'],['feedback','list'],['files','list'],['files','summary'],['resources','projects'],['resources','methods'],['analytics','account',{accountId:f.people[0].accountId}],['recommendations','overview'],['recommendations','history'],['search','overview',{issue:'no-results'}],['search','history'],['messaging','plans'],['messaging','runs'],['messaging','recipients',{runId:run.id,state:'failed'}],['messaging','history',{planId:plan.id}],['strategies','overview'],['strategies','versions'],['strategies','records'],['rules','overview'],['rules','versions',{key:'community-quota'}],['maintenance','overview'],['maintenance','backups'],['maintenance','plans'],['maintenance','logs'],['audit','list'],['runs','list'],['jobs','list',{queue:'search-recovery'}],['permissions','roles'],['permissions','personnel'],['permissions','automation']];
 const results=new Map();for(const [module,view,filters]of requests){const value=await query(module,view,filters);assert.equal(value.availability,'available',module+'.'+view);assert(value.data!==null,module+'.'+view);assert(value.readExpiresAt>value.checkedAt);results.set(module+'.'+view,value);}
 assert.equal(new Set(requests.map(x=>x[0])).size,Object.keys(agentOsQueryViews).length);
 assert.equal(results.get('accounts.list').data.items.length,3);assert.equal(results.get('accounts.summary').data.totals.accounts,3);
 assert.equal(results.get('content.list').data.items[0].title,p.title);assert.equal(results.get('files.list').data.items.find(x=>x.id===attachmentId).name,'真实文件名.txt');
 assert.equal(results.get('messaging.recipients').data.items.length,1);assert.equal(results.get('messaging.runs').data.items[0].delivery.email.delivered,null);
 assert.equal(results.get('search.overview').data.queries.items[0].label,empty.query);assert.equal(results.get('search.overview').data.queries.items[0].noResults,1);
 assert.equal(results.get('analytics.account').data.data.sessions,3);assert.equal(results.get('analytics.account').data.data.screenViews,8);assert.equal(results.get('runs.list').data.items[0].createdAt,f.now());
 const details=[await read('account',f.people[0].accountId),await read('account-summary',f.people[0].accountId),await read('post',p.postId),await read('case',report.reportId),await read('chat-report',chatCase.reportId),await read('feedback',feedbackReceipt.feedbackId),await read('chat-file',attachmentId),await read('message-plan',plan.id),await read('message-run',run.id),await read('rule','community-quota'),await read('ai-run','real-native-contract')];
 assert.equal(details[1].data.usage.publicContributions,1);assert.equal(details[2].data.body,'CURRENT_PUBLIC_BODY');assert.equal(details[2].evidenceRefs.find(r=>r.kind==='post').purpose,'public-content');
 assert.match(details[2].evidenceRefs.find(r=>r.kind==='post').href,/contentKind=post/);
 const all=JSON.stringify([...results.values(),...details]);for(const forbidden of ['PRIVATE_FEEDBACK_PROSE','PRIVATE_CASE_PROSE','PRIVATE_CHAT_BODY','PRIVATE_CHAT_REPORT','PRIVATE_NOTICE_TITLE','PRIVATE_NOTICE_BODY','PRIVATE_FILE_BYTES','PRIVATE_LOG_MESSAGE','PRIVATE_RUN_CONTENT','PRIVATE_RUN_INPUT','QUEUE_PRIVATE_BODY','QUEUE_SECRET','987654321'])assert(!all.includes(forbidden),forbidden);
 const publicRef=details[2].evidenceRefs.filter(r=>r.kind==='post');assert.equal((await tools.revalidate({actor:f.admin,domain:'overview',evidenceRefs:publicRef})).valid,true);
 await community.content.visibility(f.admin,'post',p.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:0,kind:'hide',until:f.now()+60,reason:'只为本地来源失效验证'});
 assert.equal((await tools.revalidate({actor:f.admin,domain:'overview',evidenceRefs:publicRef})).valid,false);assert.equal((await read('post',p.postId)).data.body,null);
 const role=(await f.permissions.saveRole(f.admin,{operationId:randomUUID(),expectedVersion:0,name:'限定查询',description:'只读',enabled:true,permissions:['workbench.read','accounts.read']},{authorize:async()=>f.admin})).role,
  assignment=(await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),expectedVersion:0,operatorId:f.reader.operatorId,roleId:role.id,enabled:true},{authorize:async()=>f.admin})).assignment;
 const limited=input=>tools.execute({actor:f.reader,domain:'overview',tool:'query-operations',arguments:input});assert.equal((await limited({module:'accounts',view:'list'})).data.items.length,3);await assert.rejects(limited({module:'files',view:'list'}),{code:'operations_permission_denied'});
 await f.permissions.saveAssignment(f.admin,{operationId:randomUUID(),id:assignment.id,expectedVersion:assignment.version,operatorId:f.reader.operatorId,roleId:role.id,enabled:false},{authorize:async()=>f.admin});await assert.rejects(limited({module:'accounts',view:'list'}),{code:'operations_permission_denied'});
});

test('query tools reject open parameters, keep real cursors and unknowns, recheck authority after reads and invalidate only controlled source revisions',async()=>{
 let now=2000000000,denied=false,changed=false,afterRead=false;const actor={kind:'business-operator',operatorId:'synthetic',endpoint:'https://example.invalid'},checks=[];
 const authority={now:()=>now,human:async(value,{action})=>{assert.equal(value,actor);checks.push(action);if(denied)throw new ServiceError('operations_permission_denied',403);return value;}};
 const id=randomUUID(),next=randomUUID(),row={id,kind:'post',version:1,versionId:randomUUID(),title:'当前公开名称',body:'CURRENT_BODY',excerpt:'CURRENT_EXCERPT',sourceState:'available',visibility:{hidden:false},publishedUntil:now+10},
  services={accounts:{list:async()=>{if(afterRead)denied=true;return{items:[{accountId:id,uid:'U123',displayName:'合成用户',identity:{email:'PRIVATE_EMAIL'},profileRevision:changed?2:1}],nextAfter:next};},get:async()=>({account:{accountId:id,profileRevision:changed?2:1}})},content:{get:async()=>({content:row}),list:async(_actor,q)=>{assert.equal(q.visibility,'visible');return{items:[row],nextAfter:'post:'+id,scanTruncated:true,summary:{total:null}};}}};
 const tools=new OperationsAgentOsQueryTools({authority,services}),run=(tool,args)=>tools.execute({actor,domain:'overview',tool,arguments:args}),query={module:'accounts',view:'list',filters:{limit:1}};
 for(const arguments_ of [{...query,url:'https://evil.invalid'},{...query,filters:{sql:'SELECT 1'}},{...query,filters:{path:'/etc/passwd'}},{module:'feedback',view:'list',filters:{query:'private-body'}},{module:'content',view:'list',filters:{query:'secret',visibility:'hidden'}},{module:'not-real',view:'list'},{module:'maintenance',view:'overview',filters:{actor:{role:'administrator'}}}])await assert.rejects(run('query-operations',arguments_),{code:'invalid_operations_agentos_query'});
 for(const value of [{kind:'chat-message',id},{kind:'post',id,filters:{body:true}},{kind:'backup-point',id:'../../private'},{kind:'post',id,actor:{role:'administrator'}}])assert.equal(agentOsReadArgumentsSchema.safeParse(value).success,false);
 const result=await run('query-operations',query);assert.equal(result.pagination.next.filters.after,next);assert.equal(result.pagination.complete,false);assert(!JSON.stringify(result).includes('PRIVATE_EMAIL'));assert.deepEqual(checks.slice(-4),['workbench.read','accounts.read','workbench.read','accounts.read']);
 changed=true;assert.equal((await tools.revalidate({actor,domain:'overview',evidenceRefs:result.evidenceRefs})).valid,true,'new metadata does not retire an existing as-of conversation');
 const publicResult=await run('read-operation-object',{kind:'post',id}),sourceRef=publicResult.evidenceRefs.find(x=>x.kind==='post');assert.equal(sourceRef.readExpiresAt,now+10);assert.equal(publicResult.readExpiresAt,now+10);assert.equal(sourceRef.controlledSource,true);
 row.version=2;assert.equal((await tools.revalidate({actor,domain:'overview',evidenceRefs:[sourceRef]})).valid,false);row.visibility.hidden=true;
 const hidden=await run('read-operation-object',{kind:'post',id});assert.equal(hidden.data.body,null);assert.equal(hidden.data.title,null);assert.equal(hidden.evidenceRefs.find(x=>x.kind==='post').controlledSource,false);assert(!JSON.stringify(hidden).includes('CURRENT_BODY'));
 const content=await run('query-operations',{module:'content',view:'list',filters:{query:'公开'}});assert.equal(content.data.summary.total,null);assert.equal(content.pagination.complete,false);
 const absent=await run('query-operations',{module:'files',view:'summary'});assert.equal(absent.availability,'not-configured');assert.equal(absent.data,null);assert.equal(absent.pagination.complete,null);
 services.files={get:async()=>({id,kind:'chat',lastError:'private/object-store/path',accounting:{reservedBytes:0,actualStoredBytes:null}})};const file=await run('read-operation-object',{kind:'chat-file',id});assert.equal(file.data.lastError,null);assert.equal(file.data.accounting.reservedBytes,0);assert.equal(file.data.accounting.actualStoredBytes,null);
 row.visibility.hidden=false;row.publishedUntil=now;await assert.rejects(run('read-operation-object',{kind:'post',id}),{code:'operations_query_expired'});
 services.accounts.list=async()=>({items:[],readExpiresAt:now});await assert.rejects(run('query-operations',query),{code:'operations_query_expired'});
 services.accounts.list=async()=>{denied=true;return{items:[{accountId:id,displayName:'MUST_NOT_ESCAPE_AFTER_REVOKE'}]};};await assert.rejects(run('query-operations',query),{code:'operations_permission_denied'});
});
