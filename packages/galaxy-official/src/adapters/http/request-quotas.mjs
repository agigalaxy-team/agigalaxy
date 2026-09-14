import { z } from 'zod';
import { readFile,lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ServiceError } from '../../shared/service-error.mjs';
import { digest } from '../../shared/digest.mjs';

export const requestQuotaCategories=['anonymous','binding','query','submission','notifications','export','revocation'];
const dimensions=z.object({ip:z.number().int().min(1).max(1000000),subject:z.number().int().min(1).max(1000000),credential:z.number().int().min(1).max(1000000)}).strict();
export const requestQuotaPolicySchema=z.object({version:z.literal(1),windowMs:z.number().int().min(1000).max(60000),capacityPerCategory:z.number().int().min(3).max(100000),
  categories:z.object(Object.fromEntries(requestQuotaCategories.map(category=>[category,dimensions]))).strict()}).strict();
export const defaultRequestQuotaPolicy=requestQuotaPolicySchema.parse({version:1,windowMs:60000,capacityPerCategory:10000,categories:{
  anonymous:{ip:60,subject:60,credential:60},binding:{ip:60,subject:60,credential:60},query:{ip:600,subject:120,credential:60},
  submission:{ip:300,subject:60,credential:30},notifications:{ip:300,subject:120,credential:60},export:{ip:120,subject:30,credential:15},revocation:{ip:300,subject:120,credential:60}}});
export async function loadRequestQuotaPolicy(path){
  if(!path)return structuredClone(defaultRequestQuotaPolicy);
  if(!isAbsolute(path))throw new Error('Absolute quota policy path required');
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error('Invalid quota policy file');
  return requestQuotaPolicySchema.parse(JSON.parse(await readFile(path,'utf8')));
}
const uuid='[0-9a-f-]{36}';
const revocation=new RegExp(`^/v1/(?:bindings|consents|proofs|context-grants)/${uuid}/revoke$`);
const publicMetadata=new Set(['/mcp/docs','/.well-known/galaxy-network.json','/.well-known/galaxy-signing-keys.json','/v1/policy','/v1/signing-keys/status','/v1/service-status','/v1/honor/rules','/v1/honor/ranking','/v1/honor/rule-history','/v1/builders/specification']);
export function requestQuotaCategory(method,path,hasCredential=false){
  if(method==='POST'&&path==='/v2/target-governance/events')return 'revocation';
  if(method==='POST'&&['/v2/target-governance/receipt','/v2/target-governance/target'].includes(path))return hasCredential?'query':'anonymous';
  if(path==='/.well-known/oauth-protected-resource/mcp/personal')return 'anonymous';
  if(method==='POST'&&(revocation.test(path)||['/v1/data-exports/revoke','/v1/audit/grants/revoke','/v1/deletion-requests/status','/v1/deletion-requests/submit'].includes(path)))return 'revocation';
  if(method==='POST'&&(['/v1/binding-challenges','/v2/binding-challenges','/v1/bindings','/v1/session-challenges','/v1/sessions'].includes(path)||path.startsWith('/v2/identity/control/')))return 'binding';
  if(publicMetadata.has(path))return 'anonymous';
  if(path.startsWith('/v1/data-exports/')||path==='/v1/audit/export'||path==='/v1/builders/reports/export')return 'export';
  if(path.startsWith('/v1/notifications/'))return 'notifications';
  if(method==='POST'&&path==='/v2/context/receipt')return hasCredential?'query':'anonymous';
  if(method==='POST'&&path.startsWith('/v2/trust-package/')&&path!=='/v2/trust-package/permissions/submit')return hasCredential?'query':'anonymous';
  if(method==='GET'||/(?:\/query|\/read|\/config|\/policies|\/specification)$/.test(path)||['/v1/audit/grants','/v1/requester-history/facts','/v2/requester-history/facts','/v2/honor/ranking','/v2/contributions/preview','/v2/account/quotas','/v2/tasks/receipt','/v2/consents/receipt'].includes(path))return hasCredential?'query':'anonymous';
  return 'submission';
}

// Extend the existing fixed-window policy. These counters are per API process;
// successful authentication supplies identities, never caller-asserted bodies.
export function createRequestQuotas(input,{now=Date.now}={}){
  const policy=requestQuotaPolicySchema.parse(input),states=new Map(requestQuotaCategories.map(category=>[category,{counters:new Map(),nextSweep:0}]));
  function consume(category,identities,response){
    const state=states.get(category);if(!state)throw new Error('Unsupported request quota category');
    const at=now();
    if(at>=state.nextSweep){for(const [key,value] of state.counters)if(value.until<=at)state.counters.delete(key);state.nextSweep=at+1000;}
    const selected=Object.entries(identities).map(([dimension,id])=>{
      const key=dimension+':'+id,prior=state.counters.get(key);
      return {key,dimension,value:prior&&prior.until>at?prior:{until:at+policy.windowMs,count:0}};
    });
    const reject=(dimension,until,code,status)=>{
      response.setHeader('Retry-After',String(Math.max(1,Math.ceil((until-at)/1000))));
      response.setHeader('X-Galaxy-Quota-Category',category);response.setHeader('X-Galaxy-Quota-Dimension',dimension);
      throw new ServiceError(code,status);
    };
    for(const item of selected)if(item.value.count>=policy.categories[category][item.dimension])reject(item.dimension,item.value.until,'rate_limited',429);
    if(state.counters.size+selected.filter(item=>!state.counters.has(item.key)).length>policy.capacityPerCategory)reject('capacity',at+1000,'capacity_limited',503);
    for(const item of selected){item.value.count++;state.counters.set(item.key,item.value);}
  }
  return Object.freeze({
    begin({method,path,hasCredential,address,response}){
      const category=requestQuotaCategory(method,path,hasCredential);consume(category,{ip:address},response);
      return ({subjectId,credential})=>{
        if(typeof subjectId!=='string'||!/^GUID[0-9A-Z]{28}$/.test(subjectId)||typeof credential!=='string')throw new Error('Quota authentication context unavailable');
        consume(category,{subject:subjectId,credential:digest(credential)},response);
      };
    },
    policyHash:digest(JSON.stringify(policy)),
  });
}
