import {currentCapsuleFacts} from './capsule-workspace-client.mjs';
/** @param {{id:string;version:number|string}|null|undefined} ref */
export const exactFactKey=ref=>ref?`${ref.id}:${ref.version}`:'';
/**
 * @param {Pick<import('./capsule-authoring-types').CapsuleCaseHistory,'attempts'|'interventions'>|null|undefined} history
 * @param {import('./capsule-authoring-types').CapsuleCaseFact|null|undefined} result
 * @param {string} subjectId
 * @returns {import('./capsule-authoring-types').CapsuleApplicationOrigin|null}
 */
export function exactApplicationOrigin(history,result,subjectId){
 if(!result||result.actorId!==subjectId||!['attempt','intervention'].includes(result.origin?.kind))return null;
 const source=(history?.[result.origin.kind==='attempt'?'attempts':'interventions']??[]).find(f=>f.id===result.origin.id&&f.version===result.origin.version&&f.actorId===subjectId);
 return source?{kind:result.origin.kind,ref:{kind:result.origin.kind,id:source.id,version:source.version},fact:source}:null;
}
/**
 * @param {Pick<import('./capsule-authoring-types').CapsuleCaseHistory,'attempts'|'interventions'|'results'>|null|undefined} history
 * @param {string} subjectId
 */
export function applicationResults(history,subjectId){return currentCapsuleFacts(history?.results??[]).filter(r=>exactApplicationOrigin(history,r,subjectId));}
/**
 * @param {import('./capsule-authoring-types').CapsuleUseView[]} items
 * @param {{detail:import('./capsule-authoring-types').CapsuleDetail,history:import('./capsule-authoring-types').CapsuleCaseHistory|null|undefined,result:import('./capsule-authoring-types').CapsuleCaseFact|null|undefined,origin:import('./capsule-authoring-types').CapsuleApplicationOrigin|null,subjectId:string}} selection
 */
export function matchingPriorApplications(items,{detail,history,result,origin,subjectId}){
 if(!result||!origin)return[];
 return(items??[]).filter(u=>{const p=u.record,o=p?.originRef??(p?.attemptRef?{kind:'attempt',...p.attemptRef}:null);return u.subjectId===subjectId&&u.kind==='apply'&&p&&p.capsuleId===detail.capsuleId&&p.versionId===detail.versionId&&p.caseId===history.caseId&&exactFactKey(p.resultRef)===exactFactKey(result)&&o?.kind===origin.kind&&exactFactKey(o)===exactFactKey(origin.ref);});
}
/** @param {import('./capsule-authoring-types').CapsuleApplicationOrigin|null} origin */
export function originConfigurationRefs(origin){return origin?.kind==='intervention'?(origin.fact.sourceRefs??[]).filter(r=>r.kind==='configuration').map(({id,version})=>({id,version})):[];}
/**
 * @param {import('./capsule-authoring-types').CapsuleApplicationOrigin|null} origin
 * @param {{id:string;version:number}|null|undefined} configurationRef
 * @param {import('./capsule-authoring-types').CapsuleConfigurationView|null|undefined} configuration
 */
export function applicationEnvironment(origin,configurationRef,configuration){
 if(!origin)throw Error('原工作来源当前不可读取，请刷新已有记录。');
 if(configurationRef){if(!originConfigurationRefs(origin).some(r=>exactFactKey(r)===exactFactKey(configurationRef)))throw Error('只能选择原介入已经记录的准确配置版本。');
  if(configuration?.id!==configurationRef.id||configuration.version!==configurationRef.version||!configuration.record||!configuration.contentAvailable)throw Error('所选配置版本目前不可读取，不能推断环境相同。');
  return{name:configuration.record.conditions.environment.name??'unknown',version:configuration.record.conditions.environment.version??'unknown'};
 }
 if(origin.kind==='attempt'&&typeof origin.fact.environment==='object'&&origin.fact.environment?.name&&origin.fact.environment?.version)return{...origin.fact.environment};
 return{name:'unknown',version:'unknown'};
}
