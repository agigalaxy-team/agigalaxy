import test from 'node:test';
import assert from 'node:assert/strict';
import {recognitionReading,historyMethodPath} from '../src/person-recognition-view.mjs';

const capsuleId='11111111-1111-4111-8111-111111111111',versionId='22222222-2222-4222-8222-222222222222',caseId='33333333-3333-4333-8333-333333333333';
test('recognition reading preserves finite rule, eligible and related source distinctions',()=>{
 const view=recognitionReading({card:{issuer:'https://issuer.example.org',acceptedCases:2,checkedAt:1800,rule:{title:'公开贡献',version:'3',kind:'open-contributor',sourceProfile:'facts-v2',minAcceptedCases:2,windowFrom:100,windowUntil:1000}},items:[
  {id:'accepted',eligible:true,projections:[{projection:{title:'诗稿排版',summary:'完成了约定的前两首排版。',reportedOutcome:'partial'}}]},
  {id:'other',eligible:false,sourceStatus:'synthetic-excluded',projections:[{projection:{title:'合成示例'}}]},
 ]});
 assert.equal(view.acceptedCases,2);assert.equal(view.minimumCases,2);assert.equal(view.from,100);assert.equal(view.until,1000);
 assert.equal(view.factsV2,true);assert.equal(view.rows[0].eligible,true);assert.equal(view.rows[1].eligible,false);assert.equal(view.rows[1].synthetic,true);
 assert.equal(view.rows[0].recordKey,null,'a selected projection does not invent original-text access');
 assert.deepEqual(view.rows[0].summaries,['完成了约定的前两首排版。']);
 assert.equal('capabilityVerified' in view,false);assert.equal('availableForWork' in view,false);
});
test('legacy recognition can link only its explicit current readable Case source',()=>{
 const view=recognitionReading({card:{rule:{}},contributions:[{assistanceId:'a',caseId,accepted:true,eligible:false,participatedAt:500}]});
 assert.equal(view.rows[0].recordKey,'case:'+caseId);assert.equal(view.rows[0].eligible,false);assert.equal(view.rows[0].participatedAt,500);
 assert.equal(view.acceptedCases,null,'missing counts are unknown, not zero');
});
test('method reading retains the exact historical version',()=>{
 assert.equal(historyMethodPath({capsuleId,versionId,record:{kind:'apply'}}),'/app/capsules/'+capsuleId+'/versions/'+versionId);
 assert.equal(historyMethodPath({record:{capsuleId,versionId,kind:'reference'}}),'/app/capsules/'+capsuleId+'/versions/'+versionId);
});
test('withdrawn or incomplete method-use body does not supply a reading link',()=>{
 assert.equal(historyMethodPath({capsuleId,versionId,record:null}),null);
 assert.equal(historyMethodPath({capsuleId,record:{kind:'apply'}}),null);
 assert.equal(historyMethodPath({capsuleId:'../../settings',versionId,record:{}}),null);
});
