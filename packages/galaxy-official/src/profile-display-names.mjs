import {z} from 'zod/v4';

const subjects=z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(20);

// A caller already holds these subject references. Read only current permitted
// self-declarations through the existing profile projection; account/provider
// metadata and earlier revoked declarations never supply a fallback name.
export async function readProfileDisplayNames(call,subjectIds,{authenticated=true}={}) {
 const ids=[...new Set(subjects.parse(subjectIds))],results=[];
 for(let start=0;start<ids.length;start+=4){
  const batch=ids.slice(start,start+4),read=await Promise.allSettled(batch.map(subjectId=>
   call('/v1/history/query',{subjectId,limit:1},{authenticated})));
  for(let index=0;index<batch.length;index++){
   const result=read[index];
   if(result.status==='rejected')results.push({subjectId:batch[index],displayName:null,error:result.reason?.code??result.reason?.message??'profile_unavailable'});
   else results.push({subjectId:batch[index],displayName:result.value.selfDeclared?.displayName?.trim()||null,
    ...(result.value.selfDeclaredReadExpiresAt!==undefined?{readExpiresAt:result.value.selfDeclaredReadExpiresAt}:{})});
  }
 }
 return results;
}
