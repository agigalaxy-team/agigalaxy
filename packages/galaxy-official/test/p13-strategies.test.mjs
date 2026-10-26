import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {p13Fixture} from './p13-strategies-fixture.mjs';
import {p13ContinueSchema,p13ConfigurationSchema} from '../src/shared/p13-strategies-schema.mjs';
import {p13Classify} from '../src/operations/strategies/evaluator.mjs';
import {dispatchP13Strategies} from '../src/adapters/http/operations-strategies-http.mjs';
import {requestUrl} from '../src/adapters/http/policy.mjs';
import {operationsReadPath,operationsProxyPolicy} from '../../../apps/galaxy-admin/src/lib/proxy-policy.mjs';
import {businessAuditMetadata} from '../src/business-admin-audit-view.mjs';

test('P13 history and version details show the same-endpoint management name while retaining internal attribution',{timeout:60000},async t=>{
 const f=await p13Fixture(t),saved=await f.service.saveDraft(f.admin,{operationId:randomUUID(),expectedRevision:0,configuration:f.configuration(),reason:'核查名称归属，不发布策略'},{authorize:async()=>f.admin});
 await f.db.query('UPDATE operations_operator_principals_v1 SET display_name=$3 WHERE endpoint=$1 AND operator_id=$2',[f.endpoint,f.admin.operatorId,'银河运营']);
 const current=await f.service.get(f.admin),versions=await f.service.versions(f.admin),records=await f.service.records(f.admin);
 assert.equal(current.draft.id,saved.versionId);assert.equal(current.draft.createdByDisplayName,'银河运营');assert.equal(current.draft.createdBy,f.admin.operatorId);
 assert.equal(versions.items[0].createdByDisplayName,'银河运营');assert.equal(records.items[0].operatorDisplayName,'银河运营');assert.equal(records.items[0].operatorId,f.admin.operatorId);
 await f.service.event(f.db,'automatic-stop',{versionId:saved.versionId});
 assert.equal((await f.service.records(f.admin)).items[0].operatorDisplayName,null);
});

test('P13 real PG versions, current consumer rehearsal, pinned matters and original effect receipts preserve current authority and source',{timeout:60000},async t=>{
 const f=await p13Fixture(t),first=await f.task(),second=await f.task(),config=f.configuration(),strategy=config.strategies[0];
 await assert.rejects(f.service.get(f.reader),{code:'operations_permission_denied'});
 const active=await f.publish(config,[first.execution.id]);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM operations_content_visibility_v1')).rows[0].n,0,'rehearsal made no effect');
 const operationId=randomUUID(),a=await f.service.run(f.admin,{operationId,strategyId:strategy.id,executionId:first.execution.id},{authorize:async()=>f.admin});assert.equal(a.run.versionId,active.versionId);
 const newer=structuredClone(config);newer.strategies[0].mode='human-led';const secondActive=await f.publish(newer,[second.execution.id]);
 const prepared=await f.service.step({runId:operationId,executionId:first.execution.id,nativeRunId:operationId,phase:'prepare'});assert.equal(prepared.mode,'code-automatic');assert.equal(prepared.versionId,active.versionId);
 const result=await f.service.step({runId:operationId,executionId:first.execution.id,nativeRunId:operationId,phase:'effect'});assert.equal(result.effect.visibility.hidden,true);
 assert.equal((await f.forum.getPost(first.post.postId)).availability,'unavailable');
 assert.deepEqual(await f.service.step({runId:operationId,executionId:first.execution.id,nativeRunId:operationId,phase:'effect'}),result);
 const effects=(await f.db.query("SELECT count(*)::int AS n FROM business_admin_audit_v1 WHERE action='community-content-visibility' AND execution_id=$1",[first.execution.id])).rows[0].n;assert.equal(effects,1);
 const runId=randomUUID();await f.service.run(f.admin,{operationId:runId,strategyId:strategy.id,executionId:second.execution.id},{authorize:async()=>f.admin});
 await f.service.step({runId,executionId:second.execution.id,nativeRunId:runId,phase:'prepare'});
 await assert.rejects(f.service.step({runId,executionId:second.execution.id,nativeRunId:runId,phase:'effect'}),{code:'p13_human_confirmation_required'});
 // Explicit native transport double follows the current immutable pause and
 // once-only continuation receipt contract; it is not an Agno runtime test.
 const pauseId=randomUUID()+':0',acceptedContinuations=new Set(),continueNative=f.native.continue.bind(f.native);
 f.native.continuation=async(row,operationId)=>({operationId,runId:row.id,nativeRunId:row.id,pauseId,state:acceptedContinuations.has(operationId)?'accepted':'not-recorded'});
 f.native.continue=async(row,input)=>{await continueNative(row,input);acceptedContinuations.add(input.operationId);};
 f.nativeRuns.set(runId,{runId,status:'PAUSED',awaitingHuman:true,pauseKind:'confirmation',pauseId,workflowId:'galaxy-p13-selected-content-v1',workflowVersion:1});
 await f.service.continue(f.admin,runId,{operationId:randomUUID(),confirmed:true},{authorize:async()=>f.admin});
 await f.db.query('UPDATE operations_automation_grants_v1 SET enabled=false,version=version+1 WHERE id=$1',[second.grant.id]);
 await assert.rejects(f.service.step({runId,executionId:second.execution.id,nativeRunId:runId,phase:'effect'}),{code:'operations_agentos_authority_changed'});
 const detail=await f.service.runDetail(f.admin,operationId);assert.equal(detail.run.version.id,active.versionId);assert.equal(detail.run.strategy.mode,'code-automatic');assert.notEqual(detail.run.version.id,secondActive.versionId);
 const audit=(await f.db.query("SELECT * FROM business_admin_audit_v1 WHERE action='strategies.publish' ORDER BY sequence DESC LIMIT 1")).rows[0],projected=businessAuditMetadata({...audit,selection:{...audit.selection,instructions:'PRIVATE_SENTINEL'},result:{...audit.result,rawKey:'SECRET_SENTINEL'}});
 assert.equal(JSON.stringify(projected).includes('SENTINEL'),false);
 const privileges=(await f.db.query("SELECT has_table_privilege('galaxy_evidence_worker','operations_p13_strategy_versions_v1','INSERT') AS worker_write,has_table_privilege('galaxy_api','operations_p13_strategy_versions_v1','UPDATE') AS version_update,has_table_privilege('galaxy_api','operations_p13_strategy_events_v1','DELETE') AS audit_delete")).rows[0];assert.deepEqual(privileges,{worker_write:false,version_update:false,audit_delete:false});
});

test('P13 stop/recovery only affects new matters, rejects unclassified/source-changed plans and keeps four leadership modes fail closed',{timeout:60000},async t=>{
 const f=await p13Fixture(t),task=await f.task(),other=await f.task(),config=f.configuration(),sid=config.strategies[0].id,initial=await f.publish(config,[task.execution.id]);
 const config2=f.configuration({strategyId:sid,recovery:{versionId:initial.versionId,conditions:['workflow-failed']}}),next=await f.publish(config2,[task.execution.id]);
 const runId=randomUUID();await f.service.run(f.admin,{operationId:runId,strategyId:sid,executionId:task.execution.id},{authorize:async()=>f.admin});
 const stopped=await f.service.step({runId,executionId:task.execution.id,nativeRunId:runId,phase:'failed',failure:'workflow-failed'});assert.equal(stopped.recoveredVersionId,initial.versionId);assert.equal(stopped.newMattersOnly,true);
 const current=await f.service.get(f.admin);assert.equal(current.active.id,initial.versionId);assert.ok(current.blockedVersionIds.includes(next.versionId));
 await assert.rejects(f.service.step({runId,executionId:task.execution.id,nativeRunId:runId,phase:'effect'}),{code:'p13_strategy_paused'});
 const nextRun=await f.service.run(f.admin,{operationId:randomUUID(),strategyId:sid,executionId:other.execution.id},{authorize:async()=>f.admin});assert.equal(nextRun.run.versionId,initial.versionId);
 const facts={authorized:true,sourceAvailable:true,casMatches:true,temporalAllowed:true,independent:true};
 for(const mode of ['code-automatic','ai-autonomous','ai-human-participation','human-led']){const v=f.configuration({mode,judgment:mode==='code-automatic'?'prepared-command':'semantic'}),s=v.strategies[0];assert.equal(p13Classify(v,s,facts).route,mode==='code-automatic'?'code':mode==='human-led'?'human':'ai');assert.equal(p13Classify(v,s,{...facts,independent:false}).route,'blocked');assert.equal(p13Classify(v,s,{...facts,sourceAvailable:undefined}).route,'blocked');}
 assert.equal(p13ContinueSchema.safeParse({operationId:randomUUID(),confirmed:true,inputDecision:'proceed'}).success,false);
 assert.equal(p13ConfigurationSchema.safeParse({...config,strategies:[{...config.strategies[0],script:'arbitrary'}]}).success,false);
 const lost=await f.task();f.advance(3601);const v=await f.service.saveDraft(f.admin,{operationId:randomUUID(),expectedRevision:current.revision,configuration:config,reason:'过期样本不可当有效预演'},{authorize:async()=>f.admin});
 const rehearsal=await f.service.rehearsal(f.admin,{operationId:randomUUID(),versionId:v.versionId,executionIds:[lost.execution.id]});assert.equal(rehearsal.valid,false);
});

test('P13 exact query/BFF and private service-before-body boundaries use only the new closed paths',async()=>{
 const endpoint='https://operations.example.org',id=randomUUID(),path='/v1/operations/strategies/records?after=3&limit=20&strategyId='+id;
 assert.equal(requestUrl({method:'GET',url:path,headers:{}},endpoint).pathname,'/v1/operations/strategies/records');
 assert.throws(()=>requestUrl({method:'GET',url:path+'&after=4',headers:{}},endpoint));
 assert.equal(operationsReadPath(path),true);assert.equal(operationsReadPath(path+'&body=anything'),false);
 const headers=new Headers({origin:endpoint});assert.equal(operationsProxyPolicy({url:endpoint+'/v1/operations/strategies/publish',method:'POST',headers,publicOrigin:endpoint}).allowed,true);
 assert.equal(operationsProxyPolicy({url:endpoint+'/v1/internal/agentos/p13/step',method:'POST',headers,publicOrigin:endpoint}).allowed,false);
 let consumed=false;const stream=new Readable({read(){consumed=true;this.push('{"runId":"'+id+'"}');this.push(null);}});stream.method='POST';stream.headers={authorization:'Bearer wrong'};
 await assert.rejects(dispatchP13Strategies({strategies:{},agentOsGateway:{verifyService(){throw Object.assign(new Error('denied'),{code:'denied'});}},request:stream,url:new URL(endpoint+'/v1/internal/agentos/p13/step'),send(){}}),{code:'denied'});assert.equal(consumed,false);
});
