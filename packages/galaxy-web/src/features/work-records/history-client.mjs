import {historyV2QuerySchema} from "../../../../galaxy-official/src/shared/history-v2-schema.mjs";

// The server's existing query is the contract. Environment is comparison
// context, not a hard filter or an inferred compatibility claim.
export function prepareHistoryQuery({subjectId,query='',capabilityId='',timeWindow='all-visible',from='',before='',taskId='',environment='',limit=12}) {
  const window=timeWindow==='custom'?{kind:'custom',from:from?new Date(from).toISOString():'',before:before?new Date(before).toISOString():''}:{kind:timeWindow};
  return historyV2QuerySchema.parse({subjectId:subjectId.trim(),query, ...(capabilityId.trim()?{capabilityId:capabilityId.trim()}:{}),timeWindow:window,
    ...((taskId.trim()||environment.trim())?{context:{...(taskId.trim()?{taskId:taskId.trim()}:{}),...(environment.trim()?{environment:environment.trim()}: {})}}:{}),limit});
}
/** @param {any} runtime @param {{authenticated?:boolean,subjectId?:string|null,targetSubjectId?:string|null}} options */
export function createHistoryClient(runtime,{authenticated=false,subjectId=null,targetSubjectId=subjectId}={}) {
  let closed=false;
  const endpoint=runtime.api.endpoint,initial=runtime.api.snapshot?.()??null,lease=authenticated&&initial?runtime.receiptStatus?.captureLease?.():null;
  async function check(){lease?.assertCurrent();if(closed||runtime.api.endpoint!==endpoint)throw new Error('history_identity_changed');const current=await runtime.status();lease?.assertCurrent();
    if(closed||(current.identity?.subjectId??null)!==subjectId||['subjectId','bindingId','generation'].some(key=>initial?.[key]!==runtime.api.snapshot?.()?.[key]))throw new Error('history_identity_changed');}
  async function query(input={}){await check();const request=historyV2QuerySchema.parse({subjectId:targetSubjectId,...input});
    try{const result=await runtime.api.call('/v2/history/query',request,{authenticated});await check();return result;}
    catch(error){await check();throw error;}}
  return {
    query,
    async more(input){try{return await query(input);}catch(error){if((error.code??error.message)!=='history_sources_changed_retry')throw error;
      return{...await query({...input,after:null}),restarted:true};}},
    close(){closed=true;},
  };
}
