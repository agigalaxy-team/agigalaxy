import * as z from 'zod/v4';
import { costInputSchema } from './cost-input.mjs';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
const text=z.string().min(1).max(1600);
const date=z.string().refine(v=>Number.isFinite(Date.parse(v)),'A source timestamp is required');
const refs=z.array(id).min(1).max(20);
const state=z.enum(['confirmed','unknown','not-configured','failed','not-applicable']);
const fact=z.strictObject({state,evidenceRefs:z.array(id).max(20).default([]),scope:text});
const roles=['incident-response','data-requests-and-appeals','pilot-coordination'];
export const readinessInputSchema=z.strictObject({
 schemaVersion:z.literal(2),reportId:id,
 operator:z.strictObject({name:text,publicContact:z.literal('not-open'),
  responsibilities:z.array(z.strictObject({role:z.enum(roles),holderRef:id.nullable(),state:z.enum(['assigned','unassigned']),
   evidenceRefs:z.array(id).max(20),scope:text})).max(10)}),
 policy:z.strictObject({invitedTarget:z.number().int().min(1),concurrentTarget:z.number().int().min(1),
  newProcurementMonthlyCap:z.number().nonnegative(),basisRefs:refs}),
 evidence:z.array(z.strictObject({id,path:text,sha256:z.string().regex(/^[a-f0-9]{64}$/),observedAt:date,
  kind:z.enum(['decision','runtime','configuration','engineering-test','real-pilot','billing']),locator:text,scope:text})).max(200),
 resources:z.array(z.strictObject({resourceRef:id,requiredForPilot:z.boolean(),ownership:fact,configuration:fact,runtime:fact,
  verification:fact,capacity:fact,remainingConditions:z.array(text).max(30)})).max(100),
 costs:z.array(z.strictObject({resourceRef:id,state:z.enum(['unknown','unallocated','attributed']),
  value:costInputSchema.nullable(),evidenceRefs:z.array(id).max(20),scope:text})).max(100),
 scenarios:z.array(z.strictObject({id,scenarioKind:z.enum(['help-return','active-or-ordinary-chat']),
  population:z.enum(['synthetic','real']),state:z.enum(['passed','failed','not-run']),evidenceRefs:z.array(id).max(20),
  participantRefs:z.array(id).max(100),consentScope:text.nullable(),helpReceived:text.nullable(),
  unresolvedReason:text.nullable(),returnToWork:text.nullable(),resourceObservation:text.nullable(),userFeedback:text.nullable()})).max(100),
 exitChecks:z.array(z.strictObject({operation:z.enum(['read-own-data','export-own-data','revoke-and-exit']),...fact.shape})).max(10),
});

// A read-only interpretation of explicitly registered observations. No probe,
// billing request, background timer, account creation or capacity estimate.
export function createReadinessReport(input,{verifiedEvidenceIds=[],now=Date.now(),maxAgeSeconds=86400}={}){
 const x=readinessInputSchema.parse(input),checkedAt=new Date(now).toISOString();
 if(!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<1)throw new Error('invalid_readiness_max_age');
 const evidence=new Map(x.evidence.map(e=>[e.id,e]));
 if(evidence.size!==x.evidence.length)throw new Error('duplicate_readiness_evidence');
 const verified=new Set(verifiedEvidenceIds),issues=[];
 const use=(list,kind=null)=>list.length>0&&list.every(ref=>{
  const e=evidence.get(ref);if(!e)throw new Error('missing_readiness_evidence:'+ref);
  return verified.has(ref)&&(!kind||kind.includes(e.kind));
 });
 const fresh=list=>list.every(ref=>{const e=evidence.get(ref);return e&&Date.parse(e.observedAt)<=now&&now-Date.parse(e.observedAt)<=maxAgeSeconds*1000;});
 const projectFact=(value,{freshRequired=false,kinds=null}={})=>{
  for(const ref of value.evidenceRefs)if(!evidence.has(ref))throw new Error('missing_readiness_evidence:'+ref);
  const integrity=use(value.evidenceRefs,kinds),current=fresh(value.evidenceRefs);
  return {...value,evidenceIntegrityVerified:integrity,sourceObservedAt:value.evidenceRefs.map(ref=>evidence.get(ref).observedAt),
   sufficientlyRecent:current,confirmedInRecordedScope:value.state==='confirmed'&&integrity&&(!freshRequired||current),
   semanticAcceptance:'requires-source-and-scope-review'};
 };
 if(!use(x.policy.basisRefs,['decision']))issues.push('plan-decision-evidence-missing');
 const resources=x.resources.map(r=>({...r,ownership:projectFact(r.ownership),configuration:projectFact(r.configuration),
  runtime:projectFact(r.runtime,{freshRequired:true,kinds:['runtime']}),verification:projectFact(r.verification,{freshRequired:true,kinds:['runtime','engineering-test']}),
  capacity:projectFact(r.capacity,{freshRequired:true,kinds:['engineering-test','real-pilot']})}));
 if(new Set(resources.map(r=>r.resourceRef)).size!==resources.length)throw new Error('duplicate_readiness_resource');
 for(const r of resources.filter(r=>r.requiredForPilot)){
  for(const k of ['ownership','configuration','runtime','verification'])if(!r[k].confirmedInRecordedScope)issues.push('resource:'+r.resourceRef+':'+k);
 }
 if(!resources.some(r=>r.requiredForPilot))issues.push('pilot-resources-not-specified');
 const responsibilities=roles.map(role=>{
  const rows=x.operator.responsibilities.filter(r=>r.role===role);if(rows.length>1)throw new Error('duplicate_readiness_role');
  const r=rows[0],assigned=!!r&&r.state==='assigned'&&!!r.holderRef&&use(r.evidenceRefs,['decision']);
  if(!assigned)issues.push('responsibility:'+role);
  return r?{...r,assignmentEvidenceVerified:assigned}:{role,state:'unassigned',holderRef:null,evidenceRefs:[],assignmentEvidenceVerified:false};
 });
 const costs=x.costs.map(c=>{
  if(!resources.some(r=>r.resourceRef===c.resourceRef))throw new Error('cost_resource_not_registered');
  if(c.state==='unknown'&&c.value!==null||c.state!=='unknown'&&c.value===null)throw new Error('readiness_cost_state_mismatch');
  if(c.value?.scope?.attribution==='unallocated'&&c.state!=='unallocated')throw new Error('shared_cost_not_attributed_to_galaxy');
  if(c.value&&!use(c.evidenceRefs,['billing']))throw new Error('readiness_cost_evidence_missing');
  return {...c,sourceObservedAt:c.value?.observedAt??null,newProcurementCapDoesNotReplaceAmount:true};
 });
 const scenarios=x.scenarios.map(s=>{
  const kind=s.population==='real'?'real-pilot':'engineering-test';
  const accepted=s.state==='passed'&&use(s.evidenceRefs,[kind])&&(s.population!=='real'||s.participantRefs.length>0&&!!s.consentScope&&!!s.userFeedback
   &&(s.scenarioKind!=='help-return'||!!s.helpReceived&&!!s.returnToWork));
  return {...s,evidenceQualifiedInDeclaredScope:accepted,participantCountIsDeclaredNotIdentityVerification:true};
 });
 const scenarioKinds=['help-return','active-or-ordinary-chat'];
 const engineering=scenarioKinds.map(kind=>({kind,covered:scenarios.some(s=>s.scenarioKind===kind&&s.evidenceQualifiedInDeclaredScope)}));
 for(const s of engineering)if(!s.covered)issues.push('engineering-scenario:'+s.kind);
 const realPilot=scenarioKinds.map(kind=>({kind,covered:scenarios.some(s=>s.population==='real'&&s.scenarioKind===kind&&s.evidenceQualifiedInDeclaredScope)}));
 const exitChecks=['read-own-data','export-own-data','revoke-and-exit'].map(operation=>{
  const list=x.exitChecks.filter(v=>v.operation===operation);if(list.length>1)throw new Error('duplicate_exit_operation');
  const value=projectFact(list[0]??{operation,state:'unknown',evidenceRefs:[],scope:'No recorded execution'},
   {freshRequired:true,kinds:['runtime','engineering-test','real-pilot']});
  if(!value.confirmedInRecordedScope)issues.push('exit:'+operation);return value;
 });
 return {schemaVersion:2,reportId:x.reportId,generatedAt:checkedAt,maxSourceAgeSeconds:maxAgeSeconds,
  operator:{...x.operator,responsibilities},designPlan:{...x.policy,measurement:false},resources,costs,
  costSummary:{existingCost:costs.length&&costs.every(c=>c.state==='attributed')?'attributed-records-only':'unallocated-or-unknown',
   perUserCost:null,actualTotalCost:null,newProcurementMonthlyCap:x.policy.newProcurementMonthlyCap},
  scenarios,engineeringCoverage:engineering,realPilotCoverage:realPilot,exitChecks,
  readiness:{readyForControlledPilotInRecordedScope:issues.length===0,remainingConditions:[...new Set(issues)],
   realPilotValidated:realPilot.every(s=>s.covered),productionCapacityPromised:false,wholeProductComplete:false},
  evidence:x.evidence.map(e=>({...e,integrityVerified:verified.has(e.id)})),
  limitations:['Source timestamps are unchanged; generation is not a new runtime probe.',
   'Integrity and declared scope do not prove interpretation, participant consent or operating responsibility.',
   'No SLA, success probability, expert ranking, billing collection or model execution is provided.']};
}
