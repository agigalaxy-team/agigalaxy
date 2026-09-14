import { honorQuerySchema, honorRankingSchema,honorRuleHistorySchema } from './shared/honor-schema.mjs';
import { postPublicJson, validatePublicUrl } from './public-fetch.mjs';
function validHonorPage(result,query){
  const pagination=result.pagination;
  if(!pagination)return !['limit','after','proofAfter','riskAfter','sourceId','sourceAfter','riskIndex','riskReferenceAfter','expectedFingerprint'].some(key=>query[key]!==undefined);
  const limit=query.limit??8,integer=value=>Number.isSafeInteger(value)&&value>=0;
  if(pagination.version!==1||pagination.limit!==limit||!/^[a-f0-9]{64}$/.test(result.card.sourceFingerprint)
    ||query.expectedFingerprint&&query.expectedFingerprint!==result.card.sourceFingerprint)return false;
  const page=(value,items,key,after)=>{
    if(!value||!Array.isArray(items)||items.length>limit||!integer(value.total)||value.total<items.length||value.after!==after)return false;
    if(key){const ids=items.map(item=>item[key]);return ids.every((id,i)=>typeof id==='string'&&(!after||id>after)&&(!i||id>ids[i-1]))
      &&(value.nextAfter===null||items.length===limit&&value.nextAfter===ids.at(-1));}
    return value.nextAfter===(after+items.length<value.total?after+items.length:null)&&items.length===Math.min(limit,Math.max(0,value.total-after));
  };
  if(!page(pagination.contributions,result.contributions,'assistanceId',query.after??null)
    ||!page(pagination.proofs,result.card.proofs,'proofId',query.proofAfter??null)
    ||!page(pagination.risks,result.riskAssessment?.flags,null,query.riskAfter??0))return false;
  if(query.sourceId&&(result.sourceDetail?.assistanceId!==query.sourceId||!page(result.sourceDetail,result.sourceDetail.items,null,query.sourceAfter??0)))return false;
  if(query.riskIndex!==undefined&&(result.riskDetail?.index!==query.riskIndex||!page(result.riskDetail,result.riskDetail.items,null,query.riskReferenceAfter??0)))return false;
  return true;
}
export function createHonorClient({endpoint,sessions,send=postPublicJson}) {
  if(validatePublicUrl(endpoint).origin!==endpoint)throw new Error('Invalid Honor endpoint.');
  async function request(method,input,options={}) {
    const {signal}=options;signal?.throwIfAborted();
    let authorization;
    if(method==='query'&&sessions){authorization=await sessions.readAuthorization(endpoint);
      if(!authorization?.scopes.includes('history'))throw new Error('History authorization required.');}
    const check=async()=>{signal?.throwIfAborted();if(authorization&&(!await sessions.isAuthorizationCurrent(authorization)||!sessions.matchesAuthorization(authorization)))throw new Error('Honor authorization changed.');};
    const query=method==='rules'?{}:method==='rule-history'?honorRuleHistorySchema.parse(input??{}):method==='ranking'?honorRankingSchema.parse(input):honorQuerySchema.parse({...input,subjectId:input.subjectId??authorization?.subjectId});
    try {await check();const result=await send(`${endpoint}/v1/honor/${method==='publicQuery'?'query':method}`,{bodyJson:JSON.stringify(query),credential:authorization?.credential,signal,maxBytes:1048576});
      await check();
      if(method==='rules'?!Array.isArray(result?.rules):['ranking','rule-history'].includes(method)?!Array.isArray(result?.items)||result.capabilityVerified!==false
        :result?.card?.subjectId!==query.subjectId||result.card.rule.id!==query.ruleId||result.card.rule.version!==query.ruleVersion||result.card.capabilityVerified!==false||!Array.isArray(result.contributions)||!validHonorPage(result,query))throw new Error('Invalid Honor response.');
      return result;
    }catch(error){if(authorization&&error.code==='GALAXY_REMOTE_REJECTED')sessions.invalidateAuthorization(authorization,'remote-rejected');throw error;}
  }
  return Object.freeze({rules:(input,options)=>request('rules',input,options),query:(input,options)=>request('query',input,options),
    ruleHistory:(input,options)=>request('rule-history',input,options),
    publicQuery:(input,options)=>request('publicQuery',input,options),ranking:(input,options)=>request('ranking',input,options)});
}
