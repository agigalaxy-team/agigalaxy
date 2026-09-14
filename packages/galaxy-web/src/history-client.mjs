import {historyV2QuerySchema} from '../../galaxy-official/src/shared/history-v2-schema.mjs';

// The server's existing query is the contract. Environment is comparison
// context, not a hard filter or an inferred compatibility claim.
export function prepareHistoryQuery({subjectId,query='',capabilityId='',timeWindow='all-visible',from='',before='',taskId='',environment='',limit=12}) {
  const window=timeWindow==='custom'?{kind:'custom',from:from?new Date(from).toISOString():'',before:before?new Date(before).toISOString():''}:{kind:timeWindow};
  return historyV2QuerySchema.parse({subjectId:subjectId.trim(),query, ...(capabilityId.trim()?{capabilityId:capabilityId.trim()}:{}),timeWindow:window,
    ...((taskId.trim()||environment.trim())?{context:{...(taskId.trim()?{taskId:taskId.trim()}:{}),...(environment.trim()?{environment:environment.trim()}: {})}}:{}),limit});
}
/** @param {any} runtime @param {{authenticated?:boolean,subjectId?:string|null}} options */
export function createHistoryClient(runtime,{authenticated=false,subjectId=null}={}) {
  let closed=false;
  async function check(){if(closed)throw new Error('history_identity_changed');const current=await runtime.status();if(closed||(current.identity?.subjectId??null)!==subjectId)throw new Error('history_identity_changed');}
  return {
    async query(input){await check();const request=historyV2QuerySchema.parse(input);const result=await runtime.api.call('/v2/history/query',request,{authenticated});await check();return result;},
    close(){closed=true;},
  };
}
