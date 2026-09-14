import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadinessReport} from '../src/operations/readiness-v2.mjs';

const now=Date.parse('2026-09-13T03:00:00Z'),when='2026-09-13T02:00:00Z';
function input(){const fact={state:'confirmed',evidenceRefs:['runtime'],scope:'Exact local two-party synthetic execution'};
 return{schemaVersion:2,reportId:'readiness-test',operator:{name:'Synthetic operator',publicContact:'not-open',responsibilities:[]},
  policy:{invitedTarget:10,concurrentTarget:3,newProcurementMonthlyCap:0,basisRefs:['decision']},
  evidence:[['decision','decision'],['runtime','runtime'],['test','engineering-test'],['bill','billing']].map(([id,kind])=>({id,kind,
   path:'synthetic/'+id+'.json',sha256:'a'.repeat(64),observedAt:when,locator:'Synthetic fixture',scope:'Synthetic fixture'})),
  resources:[{resourceRef:'shared-host',requiredForPilot:true,ownership:fact,configuration:fact,runtime:fact,verification:fact,
   capacity:{state:'unknown',evidenceRefs:[],scope:'No measured capacity'},remainingConditions:['No measured concurrent user load']}],
  costs:[{resourceRef:'shared-host',state:'unallocated',value:{version:2,currency:'USD',kind:'billing-export',amount:47.52,budget:null,
   periodStart:'2026-09-01T00:00:00Z',periodEnd:'2026-09-10T00:00:00Z',observedAt:'2026-09-10T21:45:47.778Z',
   scope:{dimension:'resourceId',count:1,sha256:'b'.repeat(64),attribution:'unallocated'}},evidenceRefs:['bill'],scope:'One historical shared compute resource'}],
  scenarios:['help-return','active-or-ordinary-chat'].map((scenarioKind,i)=>({id:'scenario-'+i,scenarioKind,population:'synthetic',state:'passed',
   evidenceRefs:['test'],participantRefs:['test-author'],consentScope:'Synthetic only',helpReceived:'API returned allowed data',unresolvedReason:null,
   returnToWork:'Synthetic return',resourceObservation:null,userFeedback:null})),
  exitChecks:['read-own-data','export-own-data','revoke-and-exit'].map(operation=>({operation,...fact}))};
}
test('scoped readiness keeps shared billing/date and synthetic evidence distinct from budget, capability and real pilot',()=>{
 const x=input(),verifiedEvidenceIds=x.evidence.map(e=>e.id),report=createReadinessReport(x,{now,verifiedEvidenceIds});
 assert.equal(report.designPlan.invitedTarget,10);assert.equal(report.designPlan.measurement,false);
 assert.equal(report.costSummary.newProcurementMonthlyCap,0);assert.equal(report.costSummary.actualTotalCost,null);
 assert.equal(report.costSummary.perUserCost,null);assert.equal(report.costs[0].value.amount,47.52);
 assert.equal(report.costs[0].value.budget,null);assert.equal(report.costs[0].sourceObservedAt,x.costs[0].value.observedAt);
 assert.equal(report.readiness.realPilotValidated,false);assert.equal(report.readiness.readyForControlledPilotInRecordedScope,false);
 assert.equal(report.engineeringCoverage.every(v=>v.covered),true);assert.equal(report.resources[0].capacity.confirmedInRecordedScope,false);
 assert.deepEqual(report.readiness.remainingConditions,['responsibility:incident-response','responsibility:data-requests-and-appeals','responsibility:pilot-coordination']);
 const future=createReadinessReport(x,{now:now+2*86400000,verifiedEvidenceIds});
 assert.equal(future.resources[0].runtime.confirmedInRecordedScope,false);
 assert.deepEqual(future.resources[0].runtime.sourceObservedAt,[when]);
 const missing=createReadinessReport(x,{now,verifiedEvidenceIds:['bill']});assert.equal(missing.resources[0].runtime.confirmedInRecordedScope,false);
 const falseReal=structuredClone(x);for(const s of falseReal.scenarios){s.population='real';s.userFeedback='Looks good';}
 assert.equal(createReadinessReport(falseReal,{now,verifiedEvidenceIds}).readiness.realPilotValidated,false);
 x.costs[0].state='attributed';assert.throws(()=>createReadinessReport(x,{now,verifiedEvidenceIds}),/shared_cost_not_attributed/);
});
test('unknown costs and explicit approved roles permit only the recorded engineering pilot, never fabricated real acceptance',()=>{
 const x=input();x.costs[0]={...x.costs[0],state:'unknown',value:null,evidenceRefs:[]};
 x.operator.responsibilities=['incident-response','data-requests-and-appeals','pilot-coordination'].map(role=>({role,
  holderRef:'confirmed-test-role',state:'assigned',evidenceRefs:['decision'],scope:'Synthetic decision for this fixture'}));
 const report=createReadinessReport(x,{now,verifiedEvidenceIds:x.evidence.map(e=>e.id)});
 assert.equal(report.readiness.readyForControlledPilotInRecordedScope,true);assert.equal(report.readiness.realPilotValidated,false);
 assert.equal(report.costs[0].value,null);assert.equal(report.costSummary.existingCost,'unallocated-or-unknown');
 assert.equal(report.readiness.productionCapacityPromised,false);assert.equal(report.readiness.wholeProductComplete,false);
 x.resources[0].runtime.evidenceRefs=['not-registered'];assert.throws(()=>createReadinessReport(x,{now}),/missing_readiness_evidence/);
});
