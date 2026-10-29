import test from 'node:test';
import assert from 'node:assert/strict';
import {strategiesLocation,strategiesHref,strategiesRecordsPath,strategiesVersionsPath,strategiesOperationPath,strategiesNext,strategiesPrevious,strategyConfiguration,strategiesOverview,strategiesDraft,strategiesDraftBody,strategiesDraftChanged,strategiesOptions,strategiesRehearsal,strategiesRunDetail,strategiesCommandResult,strategiesRecords,strategyOptionLabel,strategyCondition,strategyConditionLeaves,strategyNeedsLegacySamples,strategyRehearsalReady} from "../src/lib/strategies/strategies-view-model.ts";
import {p13ConfigurationSchema} from '../../../packages/galaxy-contracts/src/p13-strategies-schema.mjs';

const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-'+String(n).padStart(12,'0'),time='2026-10-23T10:00:00.000Z',lease={checkedAt:1792749600,readExpiresAt:1792749630,metadataOnly:true};
const configuration=()=>({common:{objective:null,automationEnabled:false},domains:['overview','governance','messaging','discovery','maintenance'].map(key=>({key,objective:null,priority:null,executionEnabled:false})),strategies:[]});
const definition=()=>({id:id(1),name:'已选公开内容',domain:'governance',objective:'处理已获准事项',enabled:true,mode:'code-automatic',template:'selected-public-content-visibility',judgment:'prepared-command',instructions:null,recovery:{versionId:null,conditions:[]}});
const version=()=>({id:id(2),version:3,configuration:configuration(),createdBy:'actual-reader',createdAt:time});
const overview=()=>({...lease,revision:4,active:version(),draft:null,paused:false,blockedVersionIds:[],configuration:configuration(),native:{state:'connected',modelState:'not-configured'},capabilities:{canConfigure:true,canPublish:true,canRun:true,canControl:true,canAiConfigure:false}});
const run=()=>({...lease,run:{id:id(3),strategyId:id(1),versionId:id(2),executionId:id(4),workflow:{id:'galaxy-p13-selected-content-v1',version:1},ruleRefs:[{key:'business-controls',publishedVersion:5,scope:'new-writes-only',appliesToPreparedVisibility:false}],route:'code',state:'prepared',code:null,native:{runId:'native-1',status:'COMPLETED',awaitingHuman:false,pauseKind:null,workflowId:'galaxy-p13-selected-content-v1',workflowVersion:1},effect:null,createdAt:time,updatedAt:time}});

test('strategy navigation preserves object/tab/browser context but only backend page filters cross the boundary',()=>{
 const location=strategiesLocation({tab:'runs',domain:'governance',strategy:id(1),run:id(3),version:id(2),after:'20',trail:'first,40',operatorId:'forged',permissions:'all'});
 assert.deepEqual(strategiesLocation(Object.fromEntries(new URL(strategiesHref(location),'https://local.invalid').searchParams)),location);
 assert.equal(strategiesRecordsPath(location),'/v1/operations/strategies/records?limit=20&strategyId='+id(1)+'&after=20');
 assert.equal(strategiesVersionsPath(location),'/v1/operations/strategies/versions?limit=20');
 assert.deepEqual(strategiesPrevious(location),{after:'40',trail:['']});assert.deepEqual(strategiesNext(location,'10'),{after:'10',trail:['','40','20']});
 assert.equal(strategiesOperationPath('client-secret'),null);assert.deepEqual(strategiesLocation({tab:'prompt',domain:'all',after:'0',trail:'first'}),{tab:'goals',domain:'all',strategy:'',run:'',version:'',after:'',trail:[]});
});
test('empty goals stay empty and closed projections never invent capabilities or models',()=>{
 const raw=overview();raw.configuration.common.secret='DO_NOT_SHOW';raw.catalog={privateKey:'DO_NOT_SHOW'};raw.native.auth='DO_NOT_SHOW';
 const value=strategiesOverview(raw);assert.ok(value);assert.equal(value.native.modelState,'not-configured');assert.equal(value.capabilities.canAiConfigure,false);assert.deepEqual(value.configuration.strategies,[]);assert.equal(value.configuration.common.objective,null);assert.ok(!JSON.stringify(value).includes('DO_NOT_SHOW'));
 assert.equal(strategiesOverview({...raw,native:{state:'connected',modelState:'probably-ready'}}),null);assert.equal(strategiesOverview({...raw,readExpiresAt:lease.checkedAt+600}),null);assert.equal(strategyConfiguration({...configuration(),domains:[]}),null);
});
test('drafts retain original CAS and validate explicit recovery and semantic conditions without rewriting source goals',()=>{
 const data=strategiesOverview(overview()),draft=strategiesDraft(data);draft.configuration.strategies=[definition()];draft.reason='新增已获准处理';
 assert.equal(strategiesDraftBody(draft).expectedRevision,4);assert.equal(strategiesDraftChanged(draft,{...data,revision:5}),true);assert.equal(strategiesDraftBody(draft).expectedRevision,4);assert.deepEqual(data.configuration.strategies,[]);
 draft.configuration.strategies[0].judgment='semantic';assert.equal(strategiesDraftBody(draft),null);draft.configuration.strategies[0].instructions='只分析所选材料';assert.ok(strategiesDraftBody(draft));
 draft.configuration.strategies[0].recovery={versionId:id(9),conditions:[]};assert.equal(strategiesDraftBody(draft),null);draft.configuration.strategies[0].recovery.conditions=['workflow-failed'];assert.ok(strategiesDraftBody(draft));
 draft.configuration.strategies[0].domain='messaging';assert.equal(strategiesDraftBody(draft),null);assert.equal(strategiesDraftBody({...draft,reason:''}),null);
});
test('execution options and rehearsal use real selected metadata, preserve source facts and never imply effects or model calls',()=>{
 const options=strategiesOptions({...lease,items:[{executionId:id(4),domain:'governance',target:{kind:'post',id:id(5),body:'DO_NOT_SHOW'},title:'真实选定标题',action:'content.hide',sourceVersion:4,decisionRevision:2,available:false,canRehearse:true,boundRunId:id(3),sourceExpiresAt:null,commandUntil:lease.checkedAt+3600}],basis:{scope:'owned-active-prepared-executions',limit:100,complete:false}});
 assert.ok(options);assert.equal(options.items[0].available,false);assert.equal(options.items[0].canRehearse,true);assert.match(strategyOptionLabel(options.items[0]),/真实选定标题/);assert.ok(!JSON.stringify(options).includes('DO_NOT_SHOW'));
 const raw={...lease,rehearsalId:id(6),versionId:id(2),valid:false,sideEffects:false,modelCalls:0,uncoveredStrategyIds:[id(1)],samples:[{strategyId:id(1),executionId:id(4),facts:{target:{kind:'post',id:id(5)},action:'content.hide',sourceVersion:4,decisionRevision:2,facts:{authorized:true,sourceAvailable:true,casMatches:null,temporalAllowed:true,independent:false},body:'DO_NOT_SHOW'},classification:{route:'blocked',reason:'existing-human-or-other-grant-decision'}}]};
 const value=strategiesRehearsal(raw);assert.ok(value);assert.equal(value.samples[0].facts.facts.casMatches,null);assert.equal(value.valid,false);assert.equal(value.modelCalls,0);assert.ok(!JSON.stringify(value).includes('DO_NOT_SHOW'));assert.equal(strategiesRehearsal({...raw,sideEffects:true}),null);
});
test('native completion is separate from the original business receipt and bound run metadata does not borrow current strategy',()=>{
 const raw=run();raw.run.native.token='DO_NOT_SHOW';raw.run.effect=null;raw.run.native.steps=[{name:'核对策略、授权与源版本',success:true},{name:'DO_NOT_SHOW',success:false}];raw.run.native.currentStep='DO_NOT_SHOW';const value=strategiesRunDetail(raw);assert.ok(value);assert.equal(value.run.state,'prepared');assert.equal(value.run.effect,null);assert.equal(value.run.strategy,undefined);assert.equal(value.run.native.currentStep,null);assert.deepEqual(value.run.native.steps,[{name:'核对策略、授权与源版本',success:true}]);assert.ok(!JSON.stringify(value).includes('DO_NOT_SHOW'));
 const effect={operationId:id(7),kind:'post',id:id(5),visibility:'hidden',body:'DO_NOT_SHOW'};assert.equal(strategiesRunDetail({...raw,run:{...raw.run,state:'completed',effect}}).run.effect.operationId,id(7));assert.equal(strategiesRunDetail({...raw,run:{...raw.run,state:'accepted-success'}}),null);
 assert.ok(strategiesCommandResult('run',raw,id(3)));assert.equal(strategiesCommandResult('run',raw,id(8)),null);assert.equal(strategiesCommandResult('publish',{operationId:id(8),revision:5,state:'queued'},id(8)),null);assert.ok(strategiesCommandResult('draft',{operationId:id(8),revision:5,versionId:id(2),version:3,state:'saved'},id(8)));
});

test('execution rehearsal projects current checks and source versions without treating failed or unknown checks as valid',()=>{
 const preview={strategyId:id(1),valid:false,checks:[{key:'handler:content.hide',state:'unknown',detail:null,raw:'DO_NOT_SHOW'}],objects:[{action:'content.hide',id:id(5),kind:'post',available:true,version:id(9),revision:3,body:'DO_NOT_SHOW'}],grants:[{id:id(8),version:2,privateBody:'DO_NOT_SHOW'}],scope:{kind:'selected',resourceIds:[id(5)]},qualification:'current-selected-source',classification:'configuration-and-current-consumer',semanticJudgment:'not-validated',sideEffects:false,modelCalls:0};
 const raw={...lease,rehearsalId:id(6),versionId:id(2),valid:false,sideEffects:false,modelCalls:0,uncoveredStrategyIds:[id(1)],samples:[],executionPreviews:[preview]},value=strategiesRehearsal(raw);
 assert.ok(value);assert.equal(value.executionPreviews[0].checks[0].state,'unknown');assert.equal(value.executionPreviews[0].objects[0].version,id(9));assert.equal(value.executionPreviews[0].grants[0].version,2);assert.equal(value.valid,false);assert.ok(!JSON.stringify(value).includes('DO_NOT_SHOW'));
 assert.equal(strategiesRehearsal({...raw,executionPreviews:[{...preview,semanticJudgment:'validated'}]}),null);assert.equal(strategiesRehearsal({...raw,executionPreviews:[{...preview,sideEffects:true}]}),null);
 assert.equal(strategiesRehearsal({...raw,valid:true,uncoveredStrategyIds:[],executionPreviews:[{...preview,valid:true}]}).valid,false);
});

test('new execution does not require legacy options but cannot publish from an empty preview result',()=>{
 const config=configuration(),legacy=definition();config.strategies=[legacy];assert.equal(strategyNeedsLegacySamples(config),true);
 config.strategies=[{...legacy,execution:{aiDomain:'governance',mode:'ai',trigger:{kind:'manual',eventTypes:[]},actions:['content.hide'],grantIds:[id(8)],resourceScope:{kind:'eligible'},requiredRehearsal:true}}];assert.equal(strategyNeedsLegacySamples(config),false);
 const raw={...lease,rehearsalId:id(6),versionId:id(2),valid:true,sideEffects:false,modelCalls:0,uncoveredStrategyIds:[],samples:[]};
 assert.equal(strategyRehearsalReady(strategiesRehearsal(raw),config),false);
 const preview={strategyId:id(1),valid:true,checks:[{key:'execution-configured',state:'pass',detail:null}],objects:[],grants:[{id:id(8),version:2}],scope:{kind:'eligible'},qualification:'checked-before-each-action',classification:'configuration-and-current-consumer',semanticJudgment:'not-validated',sideEffects:false,modelCalls:0};
 assert.equal(strategyRehearsalReady(strategiesRehearsal({...raw,executionPreviews:[preview]}),config),true);
 assert.equal(strategyNeedsLegacySamples({...config,strategies:[{...legacy,id:id(7)},...config.strategies]}),true);
});
test('history projects actual actor and closed evidence without guessing decision ownership or dumping metadata',()=>{
 const raw={...lease,items:[{id:id(9),sequence:'22',versionId:id(2),strategyId:id(1),runId:id(3),kind:'matter-pinned',operatorId:'reader-actual',metadata:{route:'code',workflowVersion:1,token:'DO_NOT_SHOW',reason:'DO_NOT_SHOW'},createdAt:time}],nextAfter:'22'};
 const value=strategiesRecords(raw);assert.ok(value);assert.equal(value.items[0].operatorId,'reader-actual');assert.deepEqual(value.items[0].metadata,{route:'code'});assert.ok(!JSON.stringify(value).includes('DO_NOT_SHOW'));assert.equal(strategiesRecords({...raw,items:[{...raw.items[0],kind:'arbitrary-raw-body'}]}),null);
});

test('strategy display names use recorded names and keep internal identifiers only for association',()=>{
 const source=overview();source.active.createdBy='internal-version-owner';source.active.createdByDisplayName='  运营成员甲  ';
 const value=strategiesOverview(source);assert.equal(value.active.createdByDisplayName,'运营成员甲');assert.equal(value.active.createdBy,'internal-version-owner');
 const missing=strategiesOverview({...source,active:{...source.active,createdByDisplayName:'  '}});assert.equal(missing.active.createdByDisplayName,null);
 const raw={...lease,items:[{id:id(9),sequence:'22',versionId:id(2),strategyId:null,runId:null,kind:'draft',operatorId:'internal-record-owner',operatorDisplayName:'  值班成员乙  ',metadata:{token:'DO_NOT_SHOW'},createdAt:time}],nextAfter:null};
 const records=strategiesRecords(raw);assert.ok(records);assert.equal(records.items[0].operatorDisplayName,'值班成员乙');assert.equal(records.items[0].operatorId,'internal-record-owner');assert.deepEqual(records.items[0].metadata,{});
 assert.equal(strategiesRecords({...raw,items:[{...raw.items[0],operatorDisplayName:undefined}]}).items[0].operatorDisplayName,null);
 assert.ok(!JSON.stringify(records).includes('DO_NOT_SHOW'));
});
test('fixed conditions and explicitly approved ordinary bounds survive drafts without guessing missing numeric values',()=>{
 const condition={combinator:'and',rules:[{field:'textLength',operator:'gte',value:40},{combinator:'or',rules:[{field:'linkCount',operator:'eq',value:0},{field:'attachmentCount',operator:'lte',value:2}]}]};
 assert.deepEqual(strategyCondition(condition),condition);assert.deepEqual(strategyConditionLeaves(condition).map(l=>l.path),[[0],[1,0],[1,1]]);
 const bounds={parameters:[{path:[0],minimum:10,maximum:100},{path:[1,1],minimum:0,maximum:4}],modes:['code-automatic','ai-autonomous'],canEnable:true,canDisable:false};
 const data=strategiesOverview(overview()),draft=strategiesDraft(data);draft.configuration.strategies=[{...definition(),condition,ordinaryBounds:bounds}];draft.reason='明确程序条件与日常范围';
 const body=strategiesDraftBody(draft);assert.ok(body);assert.deepEqual(body.configuration.strategies[0].ordinaryBounds,bounds);assert.deepEqual(p13ConfigurationSchema.parse(body.configuration),body.configuration);
 const original=structuredClone(draft);draft.configuration.strategies[0].condition.rules[0].value='';assert.equal(strategiesDraftBody(draft),null);assert.equal(original.configuration.strategies[0].condition.rules[0].value,40);
 draft.configuration=original.configuration;draft.configuration.strategies[0].ordinaryBounds.parameters[0].minimum='';assert.equal(strategiesDraftBody(draft),null);
 const unknown={...condition,rules:[{field:'privateBody',operator:'eq',value:0}]};assert.equal(strategyCondition(unknown),null);assert.equal(strategyCondition({combinator:'and',rules:[]}),null);
 const wrongPath=structuredClone(original.configuration);wrongPath.strategies[0].ordinaryBounds.parameters[0].path=[19];assert.equal(strategyConfiguration(wrongPath),null);
 const manual=structuredClone(original.configuration);manual.strategies[0].ordinaryBounds.modes=['human-led'];assert.equal(strategyConfiguration(manual),null);
 const event={id:id(9),sequence:'22',versionId:id(2),strategyId:id(1),runId:null,kind:'ordinary-draft',operatorId:'executor:'+id(4),metadata:{version:3,scope:'ordinary-strategy',changes:{parameters:[{path:[0],before:40,after:50}],enabled:{before:false,after:true},mode:{before:'code-automatic',after:'ai-autonomous'},privateKey:'DO_NOT_SHOW'}},createdAt:time};
 const record=strategiesRecords({...lease,items:[event],nextAfter:null});assert.ok(record);assert.equal(record.items[0].operatorId,event.operatorId);assert.deepEqual(record.items[0].metadata.changes.parameters,[{path:[0],before:40,after:50}]);assert.ok(!JSON.stringify(record).includes('DO_NOT_SHOW'));
});
