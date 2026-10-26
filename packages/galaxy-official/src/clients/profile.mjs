import * as z from 'zod/v4';
import { profileStatementSchema } from "../shared/profile-schema.mjs";
import { postPublicJson,validatePublicUrl } from "../infrastructure/public-fetch.mjs";

export function createProfileClient({endpoint,sessions,send=postPublicJson}){
  if(validatePublicUrl(endpoint).origin!==endpoint||!sessions)throw new Error('Invalid profile client configuration.');
  return Object.freeze({async publish(input,{signal}={}){
    z.strictObject({consentId:z.uuid(),payloadJson:z.string().max(12000)}).parse(input);
    const statement=profileStatementSchema.parse(JSON.parse(input.payloadJson));
    signal?.throwIfAborted();
    const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization?.scopes.includes('history'))throw new Error('History authorization required.');
    const check=async()=>{
      signal?.throwIfAborted();
      if(!await sessions.isAuthorizationCurrent(authorization)||!sessions.matchesAuthorization(authorization))throw new Error('Profile authorization changed.');
      signal?.throwIfAborted();
    };
    await check();let receipt;
    try{receipt=await send(endpoint+'/v1/profiles/statements',{bodyJson:JSON.stringify(input),credential:authorization.credential,signal});}
    catch(error){if(error.code==='GALAXY_REMOTE_REJECTED')sessions.invalidateAuthorization(authorization,'remote-rejected');throw error;}
    await check();
    if(receipt?.id!==statement.id||receipt.revision!==statement.expectedRevision+1||receipt.classification!=='self-declared'||receipt.capabilityVerified!==false)throw new Error('Invalid profile receipt.');
    return receipt;
  }});
}
