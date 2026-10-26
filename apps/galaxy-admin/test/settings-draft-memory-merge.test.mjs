import test from 'node:test';
import assert from 'node:assert/strict';
import {searchQualityDraft,searchQualityMerge,searchQualityFixed} from "../src/lib/search/search-quality-view-model.ts";
import {recommendationGlobalPolicyDraft,recommendationThemePolicyDraft,recommendationMergePolicy,recommendationThemeDraft,recommendationMergeTheme} from "../src/lib/recommendation/recommendation-view-model.ts";

test('returned search draft merges against its original settings instead of only replacing the revision',()=>{
 const base={synonyms:[{term:'协作',alternatives:['合作']}],rankingMode:'relevance',fixedConstraints:{...searchQualityFixed}};
 const current={revision:1,draft:null,active:null,pending:null,native:{state:'available',settings:structuredClone(base)}};
 const mine=searchQualityDraft(current);mine.rows[0].alternatives='共同协作';mine.reason='人工说明';
 current.revision=2;current.native.settings.rankingMode='newest';
 let merged=searchQualityMerge(mine,current);assert.equal(merged.unresolved,0);assert.equal(merged.draft.rows[0].alternatives,'共同协作');assert.equal(merged.draft.rankingMode,'newest');assert.equal(merged.draft.reason,'人工说明');assert.equal(merged.draft.baseRevision,2);
 current.native.settings.synonyms[0].alternatives=['协同'];merged=searchQualityMerge(mine,current);assert.equal(merged.unresolved,1);assert.equal(merged.conflicts[0].key,'synonyms');
 merged=searchQualityMerge(mine,current,{synonyms:'mine'});assert.equal(merged.unresolved,0);assert.equal(merged.draft.rows[0].alternatives,'共同协作');assert.equal(merged.draft.rankingMode,'newest');
 assert.equal(mine.baseRevision,1);assert.equal(mine.base.rankingMode,'relevance');assert.equal(searchQualityMerge({...mine,base:null},current),null);
});

test('returned recommendation global/topic drafts preserve independent current fields and require choices only for true conflicts',()=>{
 const base={version:1,enabled:true,controls:{avoidRepetition:true,avoidConcentration:true},directions:[],fixedConstraints:{personalNeeds:true,supply:true,negativeFeedback:true},algorithm:'galaxy-opportunity-v1',updatedAt:null};
 const local=recommendationThemePolicyDraft(base,'category:a'),global=recommendationGlobalPolicyDraft(base);local.direction='increase';global.controls.avoidRepetition=false;
 const current=structuredClone(base);current.version=2;current.controls.avoidConcentration=false;
 let merged=recommendationMergePolicy(current,local.themeKey,local,global);assert.equal(merged.unresolved,0);assert.deepEqual(merged.global.controls,{avoidRepetition:false,avoidConcentration:false});assert.equal(merged.theme.direction,'increase');assert.equal(merged.global.base.version,2);
 current.directions=[{key:local.themeKey,direction:'decrease'}];merged=recommendationMergePolicy(current,local.themeKey,local,global);assert.equal(merged.unresolved,1);assert.equal(merged.conflicts[0].key,'direction');merged=recommendationMergePolicy(current,local.themeKey,local,global,{direction:'current'});assert.equal(merged.theme.direction,'decrease');assert.deepEqual(merged.global.controls,{avoidRepetition:false,avoidConcentration:false});
 const theme={id:'f4a43fd1-4eb3-486f-966d-642b06c008cc',key:'theme:f4a43fd1-4eb3-486f-966d-642b06c008cc',kind:'theme',label:'原主题',version:1,enabled:true,mapping:{categories:['task'],tagIds:[],queryTerms:['原词']},source:'operator-mapping'};
 const draft=recommendationThemeDraft(theme);draft.label='本地名称';const now=structuredClone(theme);now.version=2;now.mapping.queryTerms=['远程新词'];
 let mapped=recommendationMergeTheme(draft,now);assert.equal(mapped.unresolved,0);assert.equal(mapped.draft.label,'本地名称');assert.equal(mapped.draft.queryTerms,'远程新词');assert.equal(mapped.draft.baseVersion,2);
 now.label='当前名称';mapped=recommendationMergeTheme(draft,now);assert.equal(mapped.unresolved,1);mapped=recommendationMergeTheme(draft,now,{label:'mine'});assert.equal(mapped.unresolved,0);assert.equal(mapped.draft.label,'本地名称');assert.equal(mapped.draft.queryTerms,'远程新词');assert.equal(draft.baseVersion,1);
});
