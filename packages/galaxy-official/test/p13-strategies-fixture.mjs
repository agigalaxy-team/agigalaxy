import {randomUUID} from 'node:crypto';
import {accountChatFixture} from './account-chat-fixture.mjs';
import {migrate} from "../src/infrastructure/database.mjs";
import {OperationsPermissionsService} from "../src/operations/permissions/index.mjs";
import {BusinessAdminService} from "../src/operations/audit/service.mjs";
import {CommunityForumV1} from "../src/community/community-forum-v1.mjs";
import {CommunityForumGovernanceV1} from "../src/community/community-forum-governance-v1.mjs";
import {OperationsCommunityService} from "../src/operations/community/service.mjs";
import {bindForumIds} from '../src/shared/community-forum-ids-v1.mjs';
import {P13StrategiesGateway} from '../src/operations/strategies/gateway.mjs';
import {P13OrdinaryStrategies} from '../src/operations/strategies/ordinary.mjs';
import {P13StrategiesAuthority} from '../src/operations/strategies/authority.mjs';
import {P13StrategiesService} from '../src/operations/strategies/service.mjs';
import {P13StrategyEffects} from '../src/operations/strategies/effects.mjs';
import {p13EmptyConfiguration} from '../src/shared/p13-strategies-schema.mjs';

export async function p13Fixture(t){
 const f=await accountChatFixture();t.after(f.close);await migrate(f.db,{roles:['api','worker']});
 const admin={kind:'business-operator',operatorId:'synthetic-p13-human',role:'administrator',endpoint:f.endpoint},reader={...admin,operatorId:'synthetic-p13-reader',role:'reader'},roles=new Map([[admin.operatorId,'administrator'],[reader.operatorId,'reader']]);
 for(const actor of [admin,reader])await f.db.query(`INSERT INTO operations_operator_principals_v1(operator_id,endpoint,issuer,external_subject,display_name,created_at,updated_at)
  VALUES($1,$2,'https://operations.invalid',$1,'合成P13管理身份',$3,$3)`,[actor.operatorId,f.endpoint,new Date(f.now()*1000)]);
 const permissions=new OperationsPermissionsService({db:f.db,endpoint:f.endpoint,operatorAuthorization:async actor=>roles.get(actor.operatorId),now:f.now}),authority=new P13StrategiesAuthority({db:f.db,endpoint:f.endpoint,permissions,now:f.now}),businessAdmin=new BusinessAdminService({db:f.db,endpoint:f.endpoint,permissions,executorAuthority:authority,now:f.now}),forum=new CommunityForumV1(f.access,null,{accounts:f.accounts,publicWrites:f.publicWrites}),governance=new CommunityForumGovernanceV1(f.access,null,forum,{accounts:f.accounts}),community=new OperationsCommunityService({businessAdmin,forum,governance,now:f.now}),gateway=new P13StrategiesGateway({authority,content:community.content,serviceKey:'synthetic-service-key-not-production'});
 businessAdmin.executorGateway=gateway;
 const nativeRuns=new Map();
 // Explicit native transport double. Native Workflow/queue/pause persistence
 // has a separate actual Agno-library group; this group uses the real PG/domain.
 const native={async status(){return {state:'connected',modelState:'not-configured'};},async start(row){nativeRuns.set(row.id,{runId:row.id,status:'PENDING',awaitingHuman:false,workflowId:row.workflow_id,workflowVersion:1});},async read(row){return nativeRuns.get(row.id)??null;},async continue(row){nativeRuns.get(row.id).status='RUNNING';nativeRuns.get(row.id).awaitingHuman=false;}};
 const service=new P13StrategiesService({db:f.db,endpoint:f.endpoint,businessAdmin,authority,effects:new P13StrategyEffects({authority,gateway,content:community.content}),native,now:f.now});authority.strategies=service;
 gateway.ordinaryStrategies=new P13OrdinaryStrategies({strategies:service});
 async function task({until=f.now()+600,owner=f.people[0]}={}){const payload=await bindForumIds('create-post','account:'+owner.accountId,{schemaVersion:1,operationId:randomUUID(),postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,accountId:owner.accountId,title:'本次明确选定公开内容',body:'SYNTHETIC_PUBLIC_SOURCE_ONLY',links:[],topic:'technology',audience:{read:{kind:'everyone'},participate:{kind:'accounts'}},publishedUntil:f.now()+3600});await forum.publish(owner,{payloadJson:JSON.stringify(payload)});
  const grant=(await permissions.saveAutomation(admin,{operationId:randomUUID(),expectedVersion:0,name:'P13具体对象程序授权',executorKind:'program',mode:'automatic',enabled:true,permissions:['content.read','content.hide','content.restore'],resourceIds:[payload.postId]},{authorize:async()=>admin})).automation;
  const execution=(await authority.create(admin,{operationId:randomUUID(),grantId:grant.id,expectedGrantVersion:grant.version,domain:'governance',actions:['content.read','content.hide','content.restore'],resourceIds:[payload.postId],preparedCommand:{tool:'content-visibility',targetKind:'post',targetId:payload.postId,input:{expectedVersion:1,expectedRevision:0,kind:'hide',until,reason:'合成场景明确准备的公开内容处置'}}},{authorize:async()=>admin})).execution;
  return {post:payload,grant,execution};
 }
 const configuration=({mode='code-automatic',strategyId=randomUUID(),judgment='prepared-command',recovery={versionId:null,conditions:[]}}={})=>{const value=structuredClone(p13EmptyConfiguration);value.common={objective:'处理已明确获准的公开内容事项',automationEnabled:true};value.domains.find(d=>d.key==='governance').objective='按当前边界执行选定处置';value.domains.find(d=>d.key==='governance').executionEnabled=true;value.strategies=[{id:strategyId,name:'已选内容处理',domain:'governance',objective:'仅处理本次已准备操作',enabled:true,mode,template:'selected-public-content-visibility',judgment,instructions:judgment==='semantic'?'需要复杂判断时按明确条件分析，不确定转人工':null,recovery}];return value;};
 async function publish(configuration,executionIds,{expectedRevision=null}={}){const revision=expectedRevision??(await service.get(admin)).revision,draft=await service.saveDraft(admin,{operationId:randomUUID(),expectedRevision:revision,configuration,reason:'显式保存本次合成策略'},{authorize:async()=>admin}),rehearsal=await service.rehearsal(admin,{operationId:randomUUID(),versionId:draft.versionId,executionIds});
  const result=await service.publish(admin,{operationId:randomUUID(),expectedRevision:draft.revision,versionId:draft.versionId,rehearsalId:rehearsal.rehearsalId,reason:'当前真实资格预演通过后发布'},{authorize:async()=>admin});return {...result,configuration};}
 return {...f,admin,reader,roles,permissions,authority,businessAdmin,forum,content:community.content,gateway,service,native,nativeRuns,task,configuration,publish};
}
