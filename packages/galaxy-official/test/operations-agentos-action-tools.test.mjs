import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {OperationsPermissionsService} from '../src/operations-permissions.mjs';
import {OperationsAiWorkAccountsService} from '../src/operations/accounts/ai-work-service.mjs';
import {BusinessAdminService} from '../src/business-admin.mjs';
import {CommunityForumV1} from '../src/community-forum-v1.mjs';
import {CommunityForumGovernanceV1} from '../src/community-forum-governance-v1.mjs';
import {OperationsCommunityService} from '../src/operations-community.mjs';
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {OperationsAgentOsAuthority} from '../src/operations-agentos-authority.mjs';
import {OperationsAgentOsGateway} from '../src/operations-agentos-gateway.mjs';
import {AgentOsConversations} from '../src/operations-agentos-conversations.mjs';
import {OperationsAgentOsActionTools} from '../src/operations-agentos-action-tools.mjs';
import {workbenchActionCatalog} from '../src/operations-agentos-action-catalog.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('workbench action tools use actual owned PG authority and frozen commands, preserve one effect/audit, and separate the human card from executor authority',{timeout:60000},async t=>{
 const f=await accountChatFixture();t.after(f.close);
 const admin={kind:'business-operator',operatorId:'synthetic-workbench-admin',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'synthetic-workbench-reader',role:'reader'},other={...reader,operatorId:'synthetic-workbench-other'},roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader'],[other.operatorId,'reader']]);
 for(const actor of [admin,reader,other])await f.db.query("INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at) VALUES($1,$2,'https://operations.invalid',$1,'合成管理账户',$3,$3)",[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId),now:f.now}),authority=new OperationsAgentOsAuthority({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,executorAuthority:authority,now:f.now}),
  forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),gateway=new OperationsAgentOsGateway({authority,content:community.content,serviceKey:'synthetic-workbench-internal-key-no-provider'});
 businessAdmin.executorGateway=gateway;
 const aiAccountId=randomUUID(),aiWorkAccounts=new OperationsAiWorkAccountsService({db:f.db,endpoint:f.endpoint,businessAdmin,now:f.now});permissions.aiWorkAccounts=aiWorkAccounts;authority.aiWorkAccounts=aiWorkAccounts;
 await f.db.query("INSERT INTO operations_ai_work_accounts_v1(id,endpoint,domain,name,description,enabled,version,authorization_version,created_at,updated_at) VALUES($1,$2,'governance','真实合成治理岗位','',true,1,1,$3,$3)",[aiAccountId,f.endpoint,new Date(f.now()*1000)]);
 const role=(await permissions.saveRole(admin,{operationId:randomUUID(),expectedVersion:0,name:'工作台具体内容',description:'',enabled:true,permissions:['workbench.read','ai.use.governance','content.read','content.hide','content.restore']},{authorize:async()=>admin})).role;
 await aiWorkAccounts.assignment(admin,'governance',{operationId:randomUUID(),expectedVersion:0,roleId:role.id,enabled:true},{authorize:async()=>admin});
 for(const actor of [reader,other])await permissions.saveAssignment(admin,{operationId:randomUUID(),expectedVersion:0,operatorId:actor.operatorId,roleId:role.id,enabled:true},{authorize:async()=>admin});
 const conversations=new AgentOsConversations({authority,client:null}),tools=new OperationsAgentOsActionTools({conversations,authority,gateway,services:{content:community.content},now:f.now});let session=(await conversations.session(reader,'governance',{create:true})).row;
 const envelope=(tool,args,callId=tool)=>({conversationId:session.id,sessionId:session.session_id,turnId:randomUUID(),runId:'synthetic-native-run',callId,tool,arguments:args});
 const owner=f.people[0],payload=await bindForumIds('create-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:owner.accountId,title:'实际PG公开合成内容',body:'DO_NOT_COPY_PUBLIC_BODY_IN_CARD_OR_RESULT',links:[],topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});
 await forum.publish(owner,{payloadJson:JSON.stringify(payload)});
 const proposal=await tools.prepareFor(reader,'governance',{kind:'content-visibility',targetKind:'post',targetId:payload.postId,action:'hide',until:f.now()+60,reason:'人工具体内容处理'});
 assert.equal(proposal.command.expectedVersion,1);assert.equal(proposal.command.expectedRevision,0);assert.equal((await community.content.get(reader,'post',payload.postId)).content.visibility.hidden,false);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_automation_grants_v1')).rows[0].n,0);assert.equal(JSON.stringify(proposal).includes(payload.body),false);
 const humanOperation=randomUUID(),done=await tools.executePrepared(reader,proposal,{authorize:async()=>reader,operationId:humanOperation});assert.equal(done.state,'completed');assert.equal((await tools.executePrepared(reader,proposal,{authorize:async()=>reader,operationId:humanOperation})).receipt.replayed,true);
 assert.equal((await tools.recoverPrepared(reader,proposal,humanOperation)).state,'completed');assert.equal((await tools.recoverPrepared(reader,proposal,randomUUID())).state,'not-recorded');
 const audit=(await f.db.query('SELECT actor_kind,operator_role,execution_id FROM business_admin_audit_v1 WHERE operation_id=$1',[humanOperation])).rows[0];assert.deepEqual(audit,{actor_kind:'business-operator',operator_role:'reader',execution_id:null});
 const grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'具体内容自动恢复',executorKind:'ai',mode:'assisted',enabled:true,aiAccountId,permissions:['content.read','content.hide','content.restore'],resourceIds:[payload.postId]},{authorize:async()=>admin})).automation;
 await community.content.visibility(reader,'post',payload.postId,{operationId:randomUUID(),expectedVersion:1,expectedRevision:1,kind:'restore',reason:'先解除本次人工限制'});
 const execution=(await authority.create(reader,{operationId:randomUUID(),grantId:grant.id,expectedGrantVersion:grant.version,domain:'governance',actions:['content.read','content.hide','content.restore'],resourceIds:[payload.postId],preparedCommand:{tool:'content-visibility',targetKind:'post',targetId:payload.postId,input:{expectedVersion:1,expectedRevision:2,kind:'hide',until:f.now()+60,reason:'已有明确授权的普通处理'}}},{authorize:async()=>reader})).execution;
 assert.equal((await tools.execute(envelope('list-authorized-work',{}))).items.some(item=>item.executionId===execution.id),true,'unrelated grant creation does not replace this reader and AI position authority');session=(await conversations.session(reader,'governance',{create:true})).row;
 const listed=await tools.execute(envelope('list-authorized-work',{}));assert.equal(listed.items[0].available,true);assert.equal(listed.items[0].target.label,payload.title);
 const actual=await tools.execute(envelope('run-authorized-work',{executionId:execution.id}));assert.equal(actual.state,'completed');assert.equal(actual.result.hidden,true);
 const repeat=await tools.execute(envelope('run-authorized-work',{executionId:execution.id},'another-call'));assert.equal(repeat.replayed,true);assert.equal(repeat.result.operationId,actual.result.operationId);
 const executorAudit=(await f.db.query('SELECT actor_kind,operator_role,execution_id,grant_id FROM business_admin_audit_v1 WHERE operation_id=$1',[actual.result.operationId])).rows[0];assert.equal(executorAudit.actor_kind,'operations-executor');assert.equal(executorAudit.operator_role,null);assert.equal(executorAudit.execution_id,execution.id);assert.equal(executorAudit.grant_id,grant.id);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE operation_id=$1',[actual.result.operationId])).rows[0].n,1);assert.equal(JSON.stringify(actual).includes(payload.body),false);
 const foreign=(await authority.create(other,{operationId:randomUUID(),grantId:grant.id,expectedGrantVersion:grant.version,domain:'governance',actions:['content.read'],resourceIds:[payload.postId],preparedCommand:null},{authorize:async()=>other})).execution;
 await assert.rejects(tools.execute(envelope('run-authorized-work',{executionId:foreign.id})),{code:'operations_agentos_execution_not_found'});
 await assert.rejects(tools.execute({...envelope('list-authorized-work',{}),sessionId:randomUUID()}),{code:'operations_agentos_scope_denied'});
 await assert.rejects(tools.execute(envelope('prepare-operation',{...proposal.request,role:'administrator'})),{code:'invalid_operations_agentos_action'});
 await f.db.query('UPDATE operations_automation_grants_v1 SET version=version+1,enabled=false WHERE id=$1',[grant.id]);await assert.rejects(tools.execute(envelope('run-authorized-work',{executionId:execution.id})),{code:'operations_agentos_authority_changed'});
 roles.delete(reader.operatorId);await assert.rejects(tools.executePrepared(reader,proposal,{authorize:async()=>reader,operationId:humanOperation}),{code:'business_admin_denied'});
});

test('typed prepared dispatcher uses fresh service versions across real method contracts, never model URLs/CAS or unconfirmed effects, and reports external task acceptance accurately',async()=>{
 const targetId=randomUUID(),versionId=randomUUID(),at=2000000000,operator={kind:'business-operator',operatorId:'synthetic-current',endpoint:'https://official.invalid',businessAuthorization:{version:'1',permissions:['workbench.read']}},calls=[];
 let allowed=true;
 const authority={db:{async query(){return{rows:[{operator_id:operator.operatorId,kind:'apply',version_id:versionId}]};}},endpoint:operator.endpoint,now:()=>at,async human(actor,{action,domain,purpose}){if(!allowed)throw new ServiceError('operations_permission_denied',403);assert.equal(actor,operator);if(action===undefined){assert.equal(purpose,'prepare');assert.ok(['overview','governance','messaging','discovery','maintenance'].includes(domain));}else assert.equal(typeof action,'string');return operator;}},write=name=>async(...args)=>{calls.push({name,args});return {operationId:args.flatMap(value=>typeof value==='object'&&value?.operationId?[value.operationId]:[])[0],state:'scheduled',body:'PRIVATE_RESULT_BODY',file:{name:'PRIVATE_FILE_NAME'}};};
 const content={sourceState:'available',kind:'post',id:targetId,version:7,title:'实际对象名',publishedUntil:at+600,visibility:{version:8,hidden:false},curation:{revision:9},capabilities:{canHide:true,canRestore:true,canCurate:true},maxHideSeconds:300};
 const services={content:{get:async()=>({content}),tags:async()=>({items:[]}),visibility:write('content.visibility'),curate:async(...args)=>{const saved=await write('content.curate')(...args);return{operationId:saved.operationId,replayed:false,content:{...content,curation:{revision:content.curation.revision+1,sourceVersion:content.version,appliesToCurrent:true,topic:null,pinned:args[3].pinned??false,featured:false,tagIds:[],tags:[],publicPlacement:'not-connected'}}};}},
  community:{section:async()=>({...content,canManage:true,canHide:true,canRestore:true,category:'technology'}),classify:write('community.classify'),sectionVisibility:write('community.sectionVisibility'),report:async()=>({...content,canModerate:true,currentEffect:{canKeep:true,canHide:true,canRelease:true,active:true},source:{publishedUntil:at+600}}),resolve:write('community.resolve')},
  resources:{get:async()=>({...content,canHide:true,canRestore:true}),visibility:write('resources.visibility')},feedback:{get:async()=>({feedback:{id:targetId,title:'反馈对象',revision:11,state:'pending'},permissions:{canManage:true}}),event:async(...args)=>{calls.push({name:'feedback.event',args});const input=args[2];return{operationId:input.operationId,feedback:{id:args[1],revision:input.expectedRevision+1,state:input.state??'pending',category:input.category??null,module:input.module??'other'}};}},
  files:{get:async()=>({name:'实际文件名',canRetryScan:true,processingVersion:'source-version-12',readExpiresAt:at+30}),retry:write('files.retry')},
  messaging:{get:async()=>({plan:{version:13,revision:14,state:'draft',config:{content:{title:'已存计划'},channels:['email'],audience:{kind:'accounts',accountIds:[targetId]}},capabilities:{canActivate:true}}}),action:write('messaging.action')},
  strategies:{get:async()=>({active:{id:versionId},revision:15,paused:false,capabilities:{canControl:true}}),control:write('strategies.control'),runDetail:async()=>({run:{strategy:{name:'具体运行'},canContinue:true,native:{status:'PAUSED',awaitingHuman:true,pauseKind:'confirmation',currentStep:'人工决定'}}}),continue:async(...args)=>{calls.push({name:'strategies.continue',args});return{run:{state:'running'}};}},
  searchQuality:{overview:async()=>({configuration:{revision:16,draft:{id:versionId,version:4},active:null},capabilities:{canPublish:true,canRestore:true}}),history:async()=>({versions:[{id:versionId,version:4,restorable:true}]}),command:async(...args)=>{calls.push({name:'search.command',args});return{phase:'task-pending',operationId:args[2].operationId};}}};
 const tools=new OperationsAgentOsActionTools({authority,gateway:null,conversations:null,services});
 const cases=[
  [{kind:'content-visibility',targetKind:'post',targetId,action:'hide',until:at+60,reason:'具体内容处理'},'content.visibility'],
  [{kind:'content-curation',targetKind:'post',targetId,pinned:true,reason:'具体编排处理'},'content.curate'],
  [{kind:'section-classification',targetId,category:'learning',reason:'修改实际分类'},'community.classify'],
  [{kind:'section-visibility',targetId,action:'hide',until:at+60,reason:'具体版块处理'},'community.sectionVisibility'],
  [{kind:'resource-visibility',targetKind:'projects',targetId,action:'restore',reason:'具体资源处理'},'resources.visibility'],
  [{kind:'feedback-update',targetId,state:'processing'},'feedback.event'],
  [{kind:'file-scan-retry',targetKind:'forum',targetId,reason:'扫描失败重试'},'files.retry'],
  [{kind:'case-resolve',targetId,resolution:'dismissed',summary:'人工复核具体材料',restrictionAction:'keep'},'community.resolve'],
  [{kind:'messaging-state',targetId,action:'activate'},'messaging.action'],
  [{kind:'strategy-control',action:'pause',reason:'暂停当前策略'},'strategies.control'],
  [{kind:'strategy-continue',runId:targetId,decision:'proceed'},'strategies.continue'],
  [{kind:'search-apply',reason:'应用已存草稿'},'search.command'],
  [{kind:'search-restore',versionId,reason:'恢复原生基线'},'search.command'],
 ];
 assert.deepEqual(cases.map(([request])=>request.kind).sort((a,b)=>a.localeCompare(b)),workbenchActionCatalog.filter(item=>!['job-cancel','job-retry','search-retry','ai-role-command','ai-work-prompt-save','rule-publish','rule-restore','file-cleanup-approve','account-restriction','file-access','recommendation-direction','ordinary-strategy-draft','ordinary-strategy-publish','public-content-batch','private-case-message','message-draft-create','message-draft-save'].includes(item.kind)).map(item=>item.kind).sort((a,b)=>a.localeCompare(b)));
 for(const [request,method]of cases){const before=calls.length,proposal=await tools.prepareFor(operator,'overview',request);assert.equal(calls.length,before,'Preparing must have no command side effect');assert.equal(proposal.readExpiresAt,at+30);
  assert.equal(JSON.stringify(proposal).includes('PRIVATE_RESULT_BODY'),false);const operationId=randomUUID(),result=await tools.executePrepared(operator,proposal,{authorize:async()=>operator,operationId});assert.equal(calls.at(-1).name,method);assert.equal(result.operationId,operationId);assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  const body=calls.at(-1).args.find(value=>value?.operationId===operationId);assert.ok(body);assert.equal(body.operationId,operationId);assert.equal(Object.hasOwn(body,'path'),false);
  if(method==='content.visibility'){assert.equal(body.expectedVersion,7);assert.equal(body.expectedRevision,8);}
  if(method==='files.retry'){assert.equal(body.expectedVersion,'source-version-12');assert.equal(body.kind,'scan');assert.equal(result.summary.includes('等待扫描结果'),true);}
  if(method==='search.command'){assert.equal(body.expectedRevision,16);assert.equal(result.state,'processing');assert.equal(result.summary.includes('已生效'),false);}
  if(method==='strategies.continue'){assert.equal(body.confirmed,true);assert.equal(result.state,'processing');}
 }
 const searchProposal=await tools.prepareFor(operator,'overview',{kind:'search-apply',reason:'查询原生结果'});let phase='task-pending';services.searchQuality.operation=async(_actor,operationId)=>({operationId,phase});
 const noWriteCount=calls.length,originalOperation=randomUUID();assert.equal((await tools.recoverPrepared(operator,searchProposal,originalOperation)).state,'processing');phase='result-unknown';assert.equal((await tools.recoverPrepared(operator,searchProposal,originalOperation)).state,'unknown');phase='applied';assert.equal((await tools.recoverPrepared(operator,searchProposal,originalOperation)).summary,'搜索配置已生效。');assert.equal(calls.length,noWriteCount);
 const start=calls.length;
 for(const request of [{kind:'file-purge',targetId},{kind:'model-apply',targetId},{kind:'content-visibility',targetKind:'post',targetId,action:'hide',until:at+60,reason:'不信任版本',expectedVersion:999},{kind:'messaging-state',targetId,action:'activate',path:'/v1/arbitrary'}])await assert.rejects(tools.prepareFor(operator,'overview',request),{code:'invalid_operations_agentos_action'});
 assert.equal((await tools.prepareFor(operator,'messaging',cases[0][0])).domain,'messaging','position context does not replace actual role authority');allowed=false;await assert.rejects(tools.prepareFor(operator,'overview',cases[0][0]),{code:'operations_permission_denied'});assert.equal(calls.length,start);
});

test('existing strategy binding or explicit prepared-review wait cannot be bypassed by the conversation run tool',async()=>{
 const id=randomUUID(),targetId=randomUUID(),actor={kind:'business-operator',operatorId:'same-owner',endpoint:'https://official.invalid'},calls=[];let bound=true,review=false;
 const db={async query(sql){return{rows:sql.includes('operations_p13_strategy_runs')&&bound?[{id:randomUUID(),state:'awaiting-human'}]:sql.includes('operations_agentos_commands')&&review?[{id:randomUUID()}]:[]};},async connect(){return{query:this.query.bind(this),release(){}};}};
 const authority={db,endpoint:actor.endpoint,now:()=>1000,async human(){return actor;},async get(){return{execution:{id,domain:'governance',executorKind:'ai'},preparedAction:{targetKind:'post',targetId,input:{kind:'hide',expectedVersion:1,expectedRevision:0,until:1060}}};},async actor(){return actor;},async requireAction(){return actor;}};
 const gateway={async checkPriorDecision(){},async execute(){calls.push('effect');}},content={async get(){return{content:{title:'已选内容',sourceState:'available',version:1,publishedUntil:1100,maxHideSeconds:300,visibility:{version:0},capabilities:{canHide:true}}};}},tools=new OperationsAgentOsActionTools({authority,gateway,services:{content}});
 assert.equal((await tools.runAuthorizedWork(actor,'governance',id)).code,'operations_agentos_workflow_bound');bound=false;review=true;assert.equal((await tools.runAuthorizedWork(actor,'governance',id)).code,'operations_agentos_human_review_required');assert.deepEqual(calls,[]);
});

test('workbench continuation recovery distinguishes an accepted original decision from native completion without dispatching a write',async()=>{
 const runId=randomUUID(),operationId=randomUUID(),operator={kind:'business-operator',operatorId:'same-owner',endpoint:'https://official.invalid'};let receipt='accepted',runState='awaiting-human',reads=0;
 const authority={db:{},endpoint:operator.endpoint,now:()=>1000,async human(actor){assert.equal(actor,operator);return actor;}},
  strategies={async operation(_actor,id){reads++;assert.equal(id,operationId);return{state:'recorded',kind:'continue',result:{operationId,runId,confirmed:true},continuation:{operationId,runId,state:receipt}};},
   async runDetail(_actor,id){reads++;assert.equal(id,runId);return{run:{id,state:runState,native:{awaitingHuman:runState==='awaiting-human'}}};},async continue(){throw Error('Readonly recovery must not dispatch a continuation');}},
  tools=new OperationsAgentOsActionTools({authority,services:{strategies}}),proposal={schemaVersion:1,kind:'strategy-continue',request:{kind:'strategy-continue',runId,decision:'proceed'},command:{confirmed:true},requiredAction:'strategies.run'};
 const accepted=await tools.recoverPrepared(operator,proposal,operationId);assert.equal(accepted.state,'processing');assert.equal(accepted.receipt.state,'awaiting-human');assert.equal(accepted.summary.includes('完成'),false);
 receipt='unknown';assert.equal((await tools.recoverPrepared(operator,proposal,operationId)).state,'unknown');
 receipt='accepted';runState='completed';assert.equal((await tools.recoverPrepared(operator,proposal,operationId)).state,'completed');assert.equal(reads,6);
});
