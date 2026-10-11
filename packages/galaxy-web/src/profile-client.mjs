import {z} from 'zod/v4';
import {readProfileDisplayNames} from '../../galaxy-official/src/profile-display-names.mjs';

const subject=z.string().regex(/^GUID[0-9A-Z]{28}$/);
const unavailableHonor=error=>['honor_subject_outside_scope','honor_rule_unavailable','honor_source_profile_mismatch'].includes(error?.code??error?.message);

/** Viewer identity and the profile being read are separate, explicit contexts. */
/** @param {any} runtime @param {{subjectId?:string|null,targetSubjectId?:string|null,authenticated?:boolean}} options */
export function createProfileClient(runtime,{subjectId=null,targetSubjectId=subjectId,authenticated=false}={}) {
 const api=runtime.api,endpoint=api.endpoint,initial=api.snapshot?.()??null;
 const authority=authenticated&&initial?runtime.receiptStatus?.captureLease?.():null;
 let closed=false,lastRules=null;
 async function check(){
  authority?.assertCurrent();
  if(closed||api.endpoint!==endpoint)throw Error('profile_identity_changed');
  const status=await runtime.status(),current=api.snapshot?.()??null;
  authority?.assertCurrent();
  if(closed||(status.identity?.subjectId??null)!==subjectId
   || ['subjectId','bindingId','generation'].some(key=>initial?.[key]!==current?.[key]))throw Error('profile_identity_changed');
 }
 const call=async(path,input,options={authenticated})=>{await check();try{const value=await api.call(path,input,options);await check();return value;}
  catch(error){await check();throw error;}};
 async function rules(){const page=await call('/v1/honor/rules',{}, {authenticated:false});lastRules=page.rules;return page.rules;}
 const ruleInput=rule=>({ruleId:rule.id,ruleVersion:rule.version});
 const honorPath=rule=>rule.requiredApiVersion===2||rule.sourceProfile==='facts-v2'?'/v2/honor/query':'/v1/honor/query';
 return Object.freeze({check,close(){closed=true;},
  async overview(){
   const selected=subject.parse(targetSubjectId),page=await call('/v1/history/query',{subjectId:selected,limit:1});
   let honors=[],honorsError=null;
   try{
    const definitions=await rules(),results=[];
    for(let start=0;start<definitions.length;start+=4)results.push(...await Promise.allSettled(definitions.slice(start,start+4)
     .map(rule=>call(honorPath(rule),{...ruleInput(rule),subjectId:selected,limit:1}))));
    await check();
    honors=results.filter(result=>result.status==='fulfilled'&&result.value.card?.status==='active').map(result=>{
     const card=result.value.card;return{id:card.id,title:card.rule.title,kind:card.rule.kind,ruleId:card.rule.id,ruleVersion:card.rule.version,
      issuer:card.issuer,capabilityId:card.rule.capabilityId,status:card.status,statusUrl:card.statusUrl,checkedAt:card.checkedAt};});
    const failures=results.filter(result=>result.status==='rejected'&&!unavailableHonor(result.reason));
    if(failures.length)honorsError=failures[0].reason?.code??failures[0].reason?.message??'honor_unavailable';
   }catch(error){await check();honorsError=error.code??error.message??'honor_unavailable';}
   const declaration=page.selfDeclared??{};
   return{subjectId:selected,displayName:declaration.displayName?.trim()||null,about:declaration.about?.trim()||null,
    tags:declaration.claimedCapabilities??[],projects:declaration.projects??[],profileSource:page.selfDeclaredSource??null,
    ...(page.selfDeclaredRevision!==undefined?{profileRevision:page.selfDeclaredRevision}:{}),honors,honorsError,checkedAt:page.checkedAt};
  },
  /** @param {{ruleId:string,ruleVersion:string}} item @param {{after?:string,expectedFingerprint?:string,limit?:number}} options */
  async honor(item,{after,expectedFingerprint,limit=8}={}){
   const definitions=lastRules??await rules(),rule=definitions.find(value=>value.id===item.ruleId&&value.version===item.ruleVersion);
   if(!rule)throw Error('honor_rule_unavailable');
   return call(honorPath(rule),{...ruleInput(rule),subjectId:subject.parse(targetSubjectId),limit,
    ...(after?{after}:{}),...(expectedFingerprint?{expectedFingerprint}:{})});
  },
  async displayNames(ids){const result=await readProfileDisplayNames(call,ids,{authenticated});await check();return result;},
 });
}
