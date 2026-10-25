// No rule DSL or model output confers authority. These facts come exclusively
// from the existing, current source/permission/CAS consumer adapter.
export function p13Classify(configuration,strategy,facts){
 const domain=configuration.domains.find(v=>v.key===strategy.domain),checks=[];
 const check=(key,value)=>{checks.push({key,state:value===true?'pass':value===false?'fail':'unknown'});return value===true;};
 const common=check('common-automation',configuration.common.automationEnabled),domainEnabled=check('domain-enabled',domain?.executionEnabled),strategyEnabled=check('strategy-enabled',strategy.enabled);
 const enabled=common&&domainEnabled&&strategyEnabled;
 const supported=check('supported-consumer',strategy.template==='selected-public-content-visibility'&&strategy.domain==='governance');
 const authority=check('current-authority',facts.authorized),source=check('current-source',facts.sourceAvailable),cas=check('source-and-decision-cas',facts.casMatches),temporal=check('temporal-policy',facts.temporalAllowed);
 const independent=check('prior-decision-boundary',facts.independent);
 const valid=enabled&&supported&&authority&&source&&cas&&temporal;
 if(!valid||!independent)return {route:'blocked',mode:'human-led',reason:!independent?'existing-human-or-other-grant-decision':checks.find(v=>v.state!=='pass')?.key??'facts-unavailable',checks,sideEffects:false};
 if(strategy.condition){const matched=facts.conditionState;checks.push({key:'fixed-condition',state:matched==='hit'?'pass':matched==='miss'?'miss':'unknown'});
  if(matched==='miss')return {route:'code',mode:'code-automatic',reason:'fixed-condition-not-matched',decision:'no-action',checks,sideEffects:false};
  if(matched!=='hit')return {route:'blocked',mode:'human-led',reason:'fixed-condition-unknown',checks,sideEffects:false};
 }
 if(strategy.mode==='human-led')return {route:'human',mode:'human-led',reason:'explicit-human-lead',checks,sideEffects:false};
 if(strategy.judgment==='semantic'){
  if(strategy.mode==='code-automatic')return {route:'blocked',mode:'human-led',reason:'semantic-judgment-not-a-code-rule',checks,sideEffects:false};
  return {route:'ai',mode:strategy.mode,reason:'semantic-judgment-required',checks,sideEffects:false};
 }
 return {route:'code',mode:'code-automatic',reason:'frozen-prepared-command',checks,sideEffects:false};
}
