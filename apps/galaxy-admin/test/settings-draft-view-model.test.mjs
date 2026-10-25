import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSettingsNewModel,modelSettingsEmpty,modelSettingsWithFormat,modelSettingsValidBaseUrl,modelSettingsValidation} from '../src/lib/model-settings-view-model.ts';
import {strategiesNewDefinition,strategiesMerge} from '../src/lib/strategies-view-model.ts';
import {recommendationThemePolicyDraft,recommendationGlobalPolicyDraft,recommendationComposePolicyDraft,recommendationAfterPolicySaved} from '../src/lib/recommendation-view-model.ts';
import {modelSettingsModelSchema} from '../../../packages/galaxy-official/src/shared/operations-model-settings-schema.mjs';

const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-'+String(n).padStart(12,'0');
test('format transitions retain only declared compatible efforts and local validation matches the current literal URL/model boundary',()=>{
 const original={...modelSettingsNewModel(id(1)),displayName:'本地连接',reasoning:{mode:'effort',effort:'max',supportedEfforts:['low','high','max'],supportSource:'manual'}};
 const gemini=modelSettingsWithFormat(original,'gemini');
 assert.deepEqual(gemini.reasoning,{mode:'default',effort:null,supportedEfforts:['low','high'],supportSource:'manual'});
 assert.equal(original.reasoning.effort,'max');assert.equal(modelSettingsWithFormat({...original,reasoning:{...original.reasoning,effort:'high'}},'gemini').reasoning.effort,'high');
 assert.deepEqual(modelSettingsWithFormat(gemini,'anthropic').reasoning.supportedEfforts,['low','high']);
 for(const [url,valid] of [['https://provider.example/v1',true],['http://localhost:8000/v1',true],['http://127.0.0.1/v1',true],['http://[::1]:8000',true],['http://127.1',false],['http://provider.example',false],['https://user:secret@provider.example',false],['https://provider.example/?token=x',false],['https://provider.example/#fragment',false],[' https://provider.example',true]]){
  assert.equal(modelSettingsValidBaseUrl(url),valid,url);
  const model={...gemini,baseUrl:url},configuration=modelSettingsEmpty();configuration.models=[model];
  assert.equal(modelSettingsModelSchema.safeParse(model).success,valid,url);
  assert.equal(modelSettingsValidation(configuration).some(line=>line.includes('接口地址')), !valid,url);
 }
 const configuration=modelSettingsEmpty();configuration.models=[{...gemini,modelId:'name with space'}];
 assert.match(modelSettingsValidation(configuration).join(' '),/空白/);assert.equal(modelSettingsModelSchema.safeParse(configuration.models[0]).success,false);
});

test('strategy merge keeps independent current edits/additions by identity and resolves only real conflicts with bound conditions',()=>{
 const base={common:{objective:'共同目标',automationEnabled:false},domains:['overview','governance','messaging','discovery','maintenance'].map(key=>({key,objective:null,priority:null,executionEnabled:false})),strategies:[{...strategiesNewDefinition(id(2)),name:'策略甲'},{...strategiesNewDefinition(id(3)),name:'策略乙'}]};
 const mine=structuredClone(base),current=structuredClone(base);mine.common.objective='本地目标';mine.strategies[0].name='本地甲';current.domains[2].priority='当前优先事项';current.strategies[1].enabled=true;current.strategies.reverse();current.strategies.push({...strategiesNewDefinition(id(4)),name:'远端新增'});
 const merged=strategiesMerge(base,mine,current);assert.equal(merged.unresolved,0);assert.equal(merged.conflicts.length,0);
 assert.equal(merged.configuration.common.objective,'本地目标');assert.equal(merged.configuration.domains[2].priority,'当前优先事项');assert.equal(merged.configuration.strategies.find(v=>v.id===id(2)).name,'本地甲');assert.equal(merged.configuration.strategies.find(v=>v.id===id(3)).enabled,true);assert.equal(merged.configuration.strategies.find(v=>v.id===id(4)).name,'远端新增');
 current.strategies.find(v=>v.id===id(2)).name='当前甲';let result=strategiesMerge(base,mine,current);assert.equal(result.unresolved,1);assert.equal(result.conflicts[0].path,'strategies.'+id(2)+'.name');
 result=strategiesMerge(base,mine,current,{['strategies.'+id(2)+'.name']:'current'});assert.equal(result.unresolved,0);assert.equal(result.configuration.strategies.find(v=>v.id===id(2)).name,'当前甲');assert.equal(result.configuration.common.objective,'本地目标');
 mine.strategies[0].condition={combinator:'and',rules:[{field:'textLength',operator:'gte',value:10}]};current.strategies.find(v=>v.id===id(2)).ordinaryBounds={parameters:[],modes:['human-led'],canEnable:false,canDisable:false};
 result=strategiesMerge(base,mine,current);assert.ok(result.conflicts.some(v=>v.path==='strategies.'+id(2)+'.condition'));
});

test('recommendation global controls have a single owner across topics and saving one topic preserves another real direction conflict',()=>{
 const policy={version:1,enabled:true,controls:{avoidRepetition:true,avoidConcentration:true},directions:[],fixedConstraints:{personalNeeds:true,supply:true,negativeFeedback:true},algorithm:'galaxy-opportunity-v1',updatedAt:null};
 const a=recommendationThemePolicyDraft(policy,'category:a'),b=recommendationThemePolicyDraft(policy,'category:b'),global={...recommendationGlobalPolicyDraft(policy),enabled:false};
 a.direction='increase';a.reason='甲方向';b.direction='decrease';b.reason='乙方向';
 assert.equal(Object.hasOwn(a,'enabled'),false);assert.equal(Object.hasOwn(a,'controls'),false);
 assert.equal(recommendationComposePolicyDraft(policy,a.themeKey,a,global).enabled,false);assert.equal(recommendationComposePolicyDraft(policy,b.themeKey,b,global).enabled,false);
 const saved={...structuredClone(policy),version:2,enabled:false,directions:[{key:b.themeKey,direction:'decrease'}]},remaining=recommendationAfterPolicySaved({[a.themeKey]:a,[b.themeKey]:b},saved,b.themeKey);
 assert.equal(remaining[b.themeKey],undefined);assert.equal(remaining[a.themeKey].base.version,2);assert.equal(remaining[a.themeKey].reason,'甲方向');assert.equal(recommendationComposePolicyDraft(saved,a.themeKey,remaining[a.themeKey],null).enabled,false);
 const concurrent={...saved,version:3,directions:[...saved.directions,{key:a.themeKey,direction:'decrease'}]};
 assert.equal(recommendationAfterPolicySaved({[a.themeKey]:a},concurrent,b.themeKey)[a.themeKey].base.version,1);
});
