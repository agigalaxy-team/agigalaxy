import {ServiceError} from './service-error.mjs';

const codes=Object.freeze({overview:'ai.use.overview',governance:'ai.use.governance',
 messaging:'ai.use.messaging',discovery:'ai.use.discovery',maintenance:'ai.use.maintenance'});
const marker=Symbol('galaxy-human-ai-use');
const contexts=new WeakMap();
const denied=()=>new ServiceError('operations_agentos_ai_use_denied',403);

export function operationsAiUsePermission(domain){
 return typeof domain==='string'&&Object.hasOwn(codes,domain)?codes[domain]:null;
}
export function operationsAiUseAllowed(permissions,domain){
 const code=operationsAiUsePermission(domain);
 return !!code&&Array.isArray(permissions)&&permissions.includes(code);
}
function context(actor){
 if(!actor||typeof actor!=='object')return null;
 const value=contexts.get(actor),visible=actor[marker];
 if(!value&&!visible)return null;
 if(!value||value!==visible||actor.kind!=='business-operator'||actor.operatorId!==value.operatorId||actor.endpoint!==value.endpoint)throw denied();
 return value;
}
function install(actor,value){
 if(!actor||actor.kind!=='business-operator'||actor.operatorId!==value.operatorId||actor.endpoint!==value.endpoint
  ||actor[marker]!==undefined&&actor[marker]!==value)throw denied();
 // An ordinary spread keeps the marker but has no WeakMap attestation. It is
 // rejected unless an explicitly audited clone boundary inherits this context.
 Object.defineProperty(actor,marker,{value,enumerable:true,writable:false,configurable:false});
 contexts.set(actor,value);return actor;
}
export function operationsAiUseDomain(actor){return context(actor)?.domain??null;}
export function bindOperationsAiUse(actor,domain){
 if(!operationsAiUsePermission(domain)||actor?.kind!=='business-operator')throw denied();
 const previous=context(actor);
 if(previous&&previous.domain!==domain)throw denied();
 return previous?actor:install(actor,Object.freeze({domain,operatorId:actor.operatorId,endpoint:actor.endpoint}));
}
export function inheritOperationsAiUse(source,target){
 const value=context(source),current=context(target);
 if(!value)return target;
 if(current){
  if(current===value)return target;
  if(current.domain!==value.domain||current.operatorId!==value.operatorId||current.endpoint!==value.endpoint
   ||current.work&&value.work&&(current.work.accountId!==value.work.accountId||current.work.resolve!==value.work.resolve))throw denied();
  if(current.work&&!value.work)return target;
  // A fresh authenticated callback may already carry another attested purpose
  // of this exact position. Preserve the source restriction, then let the
  // audited caller explicitly choose the required purpose. Never redefine the
  // non-configurable marker or accept an unattested spread as that callback.
  return install(Object.fromEntries(Object.entries(target)),value);
 }
 return install(target,value);
}

// The business identity of a position is attested only inside this process.
// A model, HTTP body, persisted actor or an ordinary spread cannot supply or
// replace its resolver. Explicit clone boundaries above retain the attestation.
export function operationsAiWorkScope(actor){
 const value=context(actor);return value?.work?{domain:value.domain,accountId:value.work.accountId,purpose:value.work.purpose}:null;
}
export function withOperationsAiWork(actor,{accountId,purpose,resolve}={}){
 const value=context(actor);if(!value||!['conversation','query','prepare','execution'].includes(purpose))throw denied();
 const previous=value.work;
 if(previous){
  if(accountId!==undefined&&accountId!==previous.accountId||resolve!==undefined&&resolve!==previous.resolve)throw denied();
  accountId=previous.accountId;resolve=previous.resolve;
 }
 if(typeof accountId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)||typeof resolve!=='function')throw denied();
 if(previous?.purpose===purpose)return actor;
 // Object.entries excludes the private Symbol. The original is verified before
 // creating a new attested purpose; this is not a public actor deserializer.
 return install(Object.fromEntries(Object.entries(actor)),Object.freeze({...value,work:Object.freeze({accountId,purpose,resolve})}));
}
export async function operationsAiWorkAuthorizationWithin(actor,db){
 const value=context(actor);if(!value?.work)return null;
 const work=value.work,result=await work.resolve(db,value.domain,{accountId:work.accountId,purpose:work.purpose});
 if(!result||result.accountId!==work.accountId||result.domain!==value.domain||result.enabled!==true||!Array.isArray(result.permissions)||!Array.isArray(result.roleVersions))throw denied();
 return result;
}
