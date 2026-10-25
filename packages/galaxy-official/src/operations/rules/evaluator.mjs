import {p14ControlsSchema,p14FeatureForTarget,p14Domain,p14Parse} from '../../shared/p14-rules-schema.mjs';

const normalized=value=>value.normalize('NFKC').toLocaleLowerCase('und');
function links(text,explicit){
 const values=[...(explicit??[]),...(typeof text==='string'?text.match(/https?:\/\/[^\s<>"'\u3000]+/giu)??[]:[])],hosts=[],urls=[];let invalid=false;
 for(const value of values){try{const url=new URL(value.replace(/[),，。；;！!？?]+$/u,''));if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();hosts.push(url.hostname.toLowerCase().replace(/\.$/,''));urls.push(url.href);}catch{invalid=true;}}
 return {hosts:[...new Set(hosts)],count:invalid?null:new Set(urls).size,known:!invalid};
}
// Samples and production execute this exact three-valued predicate. No code,
// regex, SQL, external request, model or side effect is evaluated here.
export function p14Evaluate(policy,input){
 const config=p14Parse(p14ControlsSchema,policy),linkFacts=links(input.text,input.links),hasText=typeof input.text==='string';
 const facts={accountTier:input.accountTier??null,subjectType:input.subjectType??null,textLength:hasText?Array.from(input.text).length:null,
 linkCount:input.links!==undefined||hasText?linkFacts.count:null,attachmentCount:input.attachmentCount??null,fileBytes:input.fileBytes??null};
 const lists=new Map(config.lists.map(list=>[list.id,list]));
 function condition(node,path){
  if(node.rules){const children=node.rules.map((child,index)=>condition(child,path+'.'+(index+1))),states=children.map(child=>child.state);
   const state=node.combinator==='and'?states.includes('miss')?'miss':states.includes('unknown')?'unknown':'hit':states.includes('hit')?'hit':states.includes('unknown')?'unknown':'miss';
   return {path,kind:'group',combinator:node.combinator,state,children};}
  let state;
  if(node.field==='keywordList'||node.field==='domainList'){
   const list=lists.get(node.value);
   if(!list.enabled)state='miss';
   else if(node.field==='keywordList')state=!hasText?'unknown':list.entries.some(entry=>normalized(input.text).includes(normalized(entry)))?'hit':'miss';
   else state=!hasText&&input.links===undefined||!linkFacts.known?'unknown':list.entries.some(entry=>{const host=p14Domain(entry);return linkFacts.hosts.some(candidate=>candidate===host||candidate.endsWith('.'+host));})?'hit':'miss';
  }else{const actual=facts[node.field];if(actual===null)state='unknown';else{const expected=node.value;state=({eq:()=>actual===expected,neq:()=>actual!==expected,gt:()=>actual>expected,gte:()=>actual>=expected,lt:()=>actual<expected,lte:()=>actual<=expected}[node.operator])()?'hit':'miss';}}
  return {path,kind:'condition',field:node.field,operator:node.operator,value:node.value,state};
 }
 const traces=config.rules.filter(rule=>rule.targets.includes(input.target)).map(rule=>{
  if(!rule.enabled)return {ruleId:rule.id,name:rule.name,state:'disabled',conditions:null,exceptionIds:[]};
  const tree=condition(rule.conditions,'1'),exceptions=rule.exceptions.filter(exception=>exception.enabled),matched=exceptions.filter(exception=>input.accountId&&exception.accountIds.includes(input.accountId));
  return {ruleId:rule.id,name:rule.name,state:tree.state==='hit'&&matched.length?'excepted':tree.state==='hit'&&exceptions.length&&!input.accountId?'unknown':tree.state,
   conditions:tree,exceptionIds:matched.map(exception=>exception.id)};
 });
 const feature=p14FeatureForTarget[input.target],featureEnabled=config.features[feature];
 const outcome=!featureEnabled||traces.some(rule=>rule.state==='hit')?'reject':traces.some(rule=>rule.state==='unknown')?'unknown':'allow';
 return {outcome,feature:{key:feature,enabled:featureEnabled},rules:traces,matchedRuleIds:traces.filter(rule=>rule.state==='hit').map(rule=>rule.ruleId),
  exceptionIds:traces.flatMap(rule=>rule.exceptionIds),missingFacts:[...new Set(traces.flatMap(rule=>{const missing=[];function visit(node){if(!node)return;if(node.children)node.children.forEach(visit);else if(node.state==='unknown')missing.push(node.field);}visit(rule.conditions);if(rule.state==='unknown'&&rule.conditions?.state==='hit')missing.push('accountId');return missing;}))],
  sideEffects:false};
}
