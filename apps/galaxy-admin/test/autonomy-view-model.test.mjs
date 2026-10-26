import test from 'node:test';
import assert from 'node:assert/strict';
import {autonomyConfigBody,autonomyConfigMerge,autonomyNumber,autonomyPercent,autonomyTaskHref} from "../src/lib/autonomy/autonomy-view-model.ts";
import {aiRunsLocation,aiRunsHref,autonomyRunsPath} from "../src/lib/autonomy/ai-runs-view-model.ts";
import {automationDraft,automationSaveBody,roleDraft,roleSaveBody,permissionConditionReason} from "../src/lib/permissions/permissions-view-model.ts";
import {createSettingsDraftMemory,settingsAiWorkReceiptPath,settingsSystemReceiptPath} from '../src/lib/settings-draft-memory.ts';
import {autonomyRuntimeDraft,autonomyRuntimeConfiguration,autonomyRuntimeMerge,systemSettingsMemorySnapshot} from "../src/lib/system-settings/system-settings-view-model.ts";
import {strategyExecution,strategyExecutionDefaults} from "../src/lib/strategies/strategies-view-model.ts";

const id='11111111-1111-4111-8111-111111111111',accountId='22222222-2222-4222-8222-222222222222',operationId='33333333-3333-4333-8333-333333333333';
const config=()=>({id,domain:'maintenance',revision:2,enabled:false,mode:'ai-human',schedule:{kind:'daily',at:null,timezone:'Asia/Shanghai'},purpose:'operations-maintenance',goal:'原目标',prompt:'原提示词',promptVersion:1,planVersion:1,delegationVersion:null,nextDueAt:null,plan:{strategyIds:[],grantIds:[],actions:[],resourceIds:[],eventTypes:[]}});

test('autonomy distinguishes a true zero, unknown value and no eligible rate sample',()=>{
 assert.equal(autonomyNumber(null),'—');assert.equal(autonomyNumber(undefined),'—');assert.equal(autonomyNumber(NaN),'—');assert.equal(autonomyNumber(0),'0');
 assert.equal(autonomyPercent(null),'无样本');assert.equal(autonomyPercent(0),'0%');assert.equal(autonomyPercent(.5),'50%');
});
test('duty editing merges independent current changes without enabling a saved daily plan or replacing its CAS',()=>{
 const base=config(),mine={...base,goal:'本次目标'},current={...base,revision:3,prompt:'另一位维护者的提示词',promptVersion:2};
 const merged=autonomyConfigMerge({base,configuration:mine},current);assert.equal(merged.ready,true);assert.equal(merged.configuration.prompt,current.prompt);assert.equal(merged.configuration.goal,'本次目标');assert.equal(merged.configuration.enabled,false);
 const body=autonomyConfigBody(merged.configuration);assert.equal(body.expectedRevision,3);assert.equal(body.schedule.at,null);assert.equal(body.enabled,false);assert.equal(base.revision,2);
 const conflict=autonomyConfigMerge({base,configuration:{...mine,prompt:'我的提示词'}},current);assert.equal(conflict.ready,false);assert.equal(conflict.conflicts[0].key,'prompt');
 assert.equal(autonomyConfigMerge({base,configuration:{...mine,prompt:'我的提示词'}},current,{prompt:'current'}).configuration.prompt,current.prompt);
});
test('task context keeps the same source, selected object and page while old native run links remain usable',()=>{
 const selected=aiRunsLocation({task:id,source:'routine',mode:'ai-human',state:'waiting-human',domain:'maintenance',page:'2',operatorId:'forged'});
 const path=new URL(autonomyRunsPath(selected),'https://admin.invalid');assert.equal(path.searchParams.get('state'),'waiting-human');assert.equal(path.searchParams.has('operatorId'),false);
 assert.equal(autonomyTaskHref(id),'/admin/operations/ai-runs?task='+id);assert.deepEqual(aiRunsLocation(Object.fromEntries(new URL(aiRunsHref(selected),'https://admin.invalid').searchParams)),selected);
 const legacy=aiRunsLocation({run:'native_run-legacy',span:'span_1',trace:'trace_1',view:'io'});assert.equal(legacy.run,'native_run-legacy');assert.equal(legacy.span,'span_1');
});
test('saving an authorized AI grant is independent from handler readiness while role and human restrictions still apply',()=>{
 const catalog=[{code:'content.hide',humanOnly:false},{code:'models.configure',humanOnly:true}],draft={...automationDraft(),name:'治理范围',executorKind:'ai',aiAccountId:accountId,enabled:true,permissions:['content.hide'],resourceScope:{kind:'eligible'},scopeConfirmed:true};
 const account={id:accountId,domain:'governance',name:'治理',enabled:false,permissions:['content.hide'],executablePermissions:[],canEnable:false,unavailableReason:'execution-not-connected'};
 assert.ok(automationSaveBody(draft,catalog,{state:'available',items:[account]}));assert.equal(automationSaveBody(draft,catalog,{state:'available',items:[{...account,permissions:[]}]}),null);
 assert.equal(automationSaveBody({...draft,permissions:['models.configure']},catalog,{state:'available',items:[{...account,permissions:['models.configure']}]}),null);
 const role={...roleDraft(),name:'AI治理',subjectScope:'ai-only',permissions:['content.hide']};assert.equal(roleSaveBody(role,catalog).subjectScope,'ai-only');
 assert.equal(permissionConditionReason('role-exceeded'),'所配动作超出 AI 当前角色权限。');assert.equal(permissionConditionReason('handler-not-connected'),'该动作的业务处理尚未接通。');assert.equal(permissionConditionReason({code:'other',message:'当前条件说明'}),'当前条件说明');
});

test('runtime settings enforce the real concurrency ceiling and preserve empty authored fields without inventing a value',()=>{
 const current={revision:2,concurrency:2,healthSeconds:30,startGraceSeconds:120,roundSeconds:600,eventCoalesceSeconds:30},draft=autonomyRuntimeDraft(current);
 assert.deepEqual(autonomyRuntimeConfiguration(draft,2).value,{concurrency:2,healthSeconds:30,startGraceSeconds:120,roundSeconds:600,eventCoalesceSeconds:30});
 assert.equal(autonomyRuntimeConfiguration({...draft,concurrency:'3'},2).value,null);assert.equal(autonomyRuntimeConfiguration({...draft,healthSeconds:''},2).value,null);assert.equal(autonomyRuntimeConfiguration({...draft,roundSeconds:'59'},2).value,null);
 assert.equal(autonomyRuntimeConfiguration({...draft,concurrency:'2'},1).value,null);
 const saved=systemSettingsMemorySnapshot({runtime:{revision:2,base:draft,draft:{...draft,healthSeconds:'',serverResult:{raw:'excluded'}}},runtimeChoices:{revision:3,fields:{healthSeconds:'mine',forged:'mine'}}});
 assert.equal(saved.runtime.draft.healthSeconds,'');assert.equal(saved.runtime.draft.serverResult,undefined);assert.deepEqual(saved.runtimeChoices,{revision:3,fields:{healthSeconds:'mine'}});
});

test('runtime settings rebase independent changes but require a choice when the same setting changed',()=>{
 const base=autonomyRuntimeDraft({revision:2,concurrency:2,healthSeconds:30,startGraceSeconds:120,roundSeconds:600,eventCoalesceSeconds:30}),mine={...base,healthSeconds:'45'},current={...base,roundSeconds:'900'};
 const independent=autonomyRuntimeMerge(base,mine,current);assert.equal(independent.unresolved,0);assert.equal(independent.draft.healthSeconds,'45');assert.equal(independent.draft.roundSeconds,'900');
 const conflict=autonomyRuntimeMerge(base,mine,{...current,healthSeconds:'60'});assert.equal(conflict.unresolved,1);assert.equal(conflict.conflicts[0].key,'healthSeconds');
 assert.equal(autonomyRuntimeMerge(base,mine,{...current,healthSeconds:'60'},{healthSeconds:'mine'}).draft.healthSeconds,'45');
});

test('system settings retains the original runtime receipt separately from old mail operations and does not carry it into another login',()=>{
 const memory=createSettingsDraftMemory(),session=memory.open('operator','login'),runtime={operationId,kind:'autonomy.settings',expectedRevision:2};
 session.setPending('system-settings',runtime);assert.equal(settingsSystemReceiptPath(session.pending('system-settings')),'/v1/operations/autonomy/operations/'+operationId);
 assert.equal(settingsSystemReceiptPath({...runtime,versionId:id}),null);assert.equal(settingsSystemReceiptPath({...runtime,expectedRevision:0}),null);
 const old={operationId,kind:'mail.apply',versionId:id,expectedRevision:2};session.setPending('system-settings',old);assert.deepEqual(session.pending('system-settings'),old);assert.equal(settingsSystemReceiptPath(old),'/v1/operations/system-settings/operations/'+operationId);
 const next=memory.open('operator','new-login');assert.equal(next.pending('system-settings'),null);assert.equal(session.current(),false);
});
test('duty and delegation memory retains authored changes and old pending locators only in the original login',()=>{
 const memory=createSettingsDraftMemory(),session=memory.open('operator','login'),base=config();
 const old={operationId,kind:'profile-save',domain:'governance'};session.setPending('ai-work',old);
 session.write('ai-work',{drafts:{},dutyDrafts:{maintenance:{configuration:{...base,prompt:'本次修改',runtimeResponse:'excluded'},base}},editing:{},roleChoice:{},positions:[],serverRuntime:'excluded'});
 assert.deepEqual(session.pending('ai-work'),old);const saved=session.read('ai-work');assert.equal(saved.dutyDrafts.maintenance.configuration.prompt,'本次修改');assert.equal(saved.dutyDrafts.maintenance.configuration.runtimeResponse,undefined);assert.equal(saved.serverRuntime,undefined);
 for(const [kind,path] of [['config-save','/v1/operations/autonomy/operations/'],['delegation-save','/v1/operations/permissions/ai-delegation/operations/']]){const pending={operationId,kind,domain:'overview'};session.setPending('ai-work',pending);assert.equal(settingsAiWorkReceiptPath(session.pending('ai-work')),path+operationId);}
 const next=memory.open('operator','new-login');assert.equal(next.read('ai-work'),null);assert.equal(session.current(),false);session.write('ai-work',{drafts:{},editing:{},roleChoice:{},positions:[]});assert.equal(next.read('ai-work'),null);
});
test('new strategy execution starts without a widened scope and projects only supported authored configuration',()=>{
 const initial=strategyExecutionDefaults({domain:'governance',mode:'code-automatic'});assert.deepEqual(initial.resourceScope,{kind:'unresolved'});assert.deepEqual(initial.actions,[]);assert.equal(initial.requiredRehearsal,true);
 const source={...initial,actions:['content.hide'],grantIds:[id],privateBody:'excluded',trigger:{kind:'daily',at:null,eventTypes:[],privateBody:'excluded'}};
 const value=strategyExecution(source);assert.equal(value.trigger.at,null);assert.deepEqual(value.actions,['content.hide']);assert.equal(JSON.stringify(value).includes('excluded'),false);assert.equal(strategyExecution({...source,aiDomain:'foreign'}),null);
});
