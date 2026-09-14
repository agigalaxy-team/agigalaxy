import test from 'node:test';
import assert from 'node:assert/strict';
import { assessContributionRisk, contributionProofs, reciprocalAcceptanceCycle } from '../src/domain/contribution-risk.mjs';
const item = (i, extra = {}) => ({ assistanceId: `assistance-${i}`, caseId: `case-${i}`, participatedAt: 1000 + i,
  sourceEvents: [{ eventId: `accepted-${i}`, kind: 'accept' }], proofs: [],
  independence: 'unverified-relationship', corrected: false, disputed: false, paused: false, ...extra });

test('risk projection separates duplicate sources, declared relationships and post-acceptance review from facts', () => {
  const facts = [item(1, { independence: 'issuer-declared-related-party', corrected: true,
    proofs: [{ proofId: 'p1', evidenceId: 'same-evidence' }] }), item(2, { caseId: 'case-1' }),
  item(3, { proofs: [{ proofId: 'p2', evidenceId: 'same-evidence' }] })];
  const before = structuredClone(facts), view = assessContributionRisk(facts, { complete: true, checkedAt: 1020 });
  assert.deepEqual(facts, before); assert.equal(view.automaticPenalty, false); assert.equal(view.fraudDetermined, false);
  assert.deepEqual(new Set(view.flags.map(flag => flag.code)), new Set(['declared-related-parties', 'accepted-work-under-review', 'repeated-source-case', 'evidence-reused-across-cases']));
  assert.deepEqual(view.flags.find(flag => flag.code === 'repeated-source-case').caseIds, ['case-1']);
  assert.equal(assessContributionRisk([item(4)], { complete: true, checkedAt: 1020 }).flags.length, 0);
  assert.equal(assessContributionRisk([], { complete: false, checkedAt: 1020 }).status, 'incomplete-source-scan');
});

test('reciprocity requires a current directed cycle and retains exact visible acceptance sources',()=>{
  const edge=(i,from,to,extra={})=>item(i,{requesterId:from,subjectId:to,eligible:true,accepted:true,
    sourceEvents:[{eventId:`accept-${i}`,kind:'accept',actorId:from}],...extra});
  const facts=[edge(1,'a','b'),edge(2,'b','c'),edge(3,'c','a'),edge(4,'b','d'),edge(5,'d','e')],original=structuredClone(facts);
  assert.equal(reciprocalAcceptanceCycle(facts,'a').length,3);
  assert.equal(reciprocalAcceptanceCycle(facts,'d').length,0);
  assert.equal(reciprocalAcceptanceCycle(facts.slice(0,2),'a').length,0);
  assert.equal(reciprocalAcceptanceCycle(facts.map(x=>x.assistanceId==='assistance-2'?{...x,eligible:false}:x),'a').length,0);
  assert.equal(reciprocalAcceptanceCycle([edge(1,'a','b'),edge(2,'b','a')],'a').length,2);
  const view=assessContributionRisk([facts[2]],{subjectId:'a',complete:true,checkedAt:1020,network:{contributions:facts,complete:false}});
  const flag=view.flags.find(x=>x.code==='reciprocal-acceptance-cycle');
  assert.deepEqual(flag.subjectIds,['a','b','c']);assert.equal(flag.edges.length,3);
  assert.equal(flag.relationshipInferred,false);assert.equal(view.status,'incomplete-source-scan');
  assert.equal(view.contributionScanComplete,true);assert.equal(view.relationshipScanComplete,false);
  assert.deepEqual(facts,original);
});

test('numeric CI source grouping prevents duplicate evidence IDs and conflicting records earning extra proof credit',()=>{
  const proof=(i,extra={})=>({proofId:`proof-${i}`,evidenceId:`evidence-${i}`,sourceKey:'github-actions:repository:1:run:2:attempt:1',commit:'a',conclusion:'success',...extra});
  const facts=[item(1,{proofs:[proof(1)]}),item(2,{proofs:[proof(2)]})];
  assert.equal(contributionProofs(facts).length,1);
  const risk=assessContributionRisk(facts,{complete:true,checkedAt:1020});
  assert.ok(risk.flags.some(x=>x.code==='ci-source-reused'&&x.evidenceIds.length===2));
  const conflict=[facts[0],item(2,{proofs:[proof(2,{commit:'b'})]})];
  assert.equal(contributionProofs(conflict).length,0);
  assert.ok(assessContributionRisk(conflict,{complete:true,checkedAt:1020}).flags.some(x=>x.code==='ci-source-conflict'));
  const failure=proof(3,{conclusion:'failure'}),failed=item(3,{accepted:true,proofs:[],observations:[failure]});
  assert.equal(contributionProofs([failed]).length,0);
  assert.ok(assessContributionRisk([failed],{complete:true,checkedAt:1020}).flags.some(x=>x.code==='accepted-work-ci-not-successful'&&x.taskFailureDetermined===false));
  assert.equal(contributionProofs([facts[0],item(4,{proofs:[proof(4,{sourceKey:'github-actions:repository:1:run:2:attempt:2'})]})]).length,2);
});
test('bulk signal counts distinct collaboration confirmations in an explicit window without a global fraud verdict', () => {
  const burst = Array.from({ length: 20 }, (_, i) => item(i));
  assert.equal(assessContributionRisk(burst, { complete: true, checkedAt: 1020 }).flags.filter(flag => flag.code === 'concentrated-participation').length, 1);
  assert.equal(assessContributionRisk(burst.slice(0, 19), { complete: true, checkedAt: 1020 }).flags.length, 0);
  assert.equal(assessContributionRisk(burst.map((value, i) => ({ ...value, participatedAt: 1000 + i * 60 })), { complete: true, checkedAt: 3000 }).flags.length, 0);
  assert.equal(assessContributionRisk(Array(20).fill(item(1)), { complete: true, checkedAt: 1020 }).flags.length, 0);
});
