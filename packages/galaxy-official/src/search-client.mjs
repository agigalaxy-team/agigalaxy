import { searchQuerySchema,searchScope } from './shared/search-schema.mjs';
import { postPublicJson,validatePublicUrl } from './public-fetch.mjs';

export function createSearchClient({endpoint,sessions,send=postPublicJson,validateEndpoint=validatePublicUrl}){
  if(validateEndpoint(endpoint).origin!==endpoint||!sessions)throw new Error('Invalid search client configuration.');
  async function query(input,{signal}={}){
    const request=searchQuerySchema.parse(input);signal?.throwIfAborted();
    const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization?.scopes.includes(searchScope(request.type)))throw new Error('Search source authorization required.');
    const check=async()=>{signal?.throwIfAborted();if(!await sessions.isAuthorizationCurrent(authorization)||!sessions.matchesAuthorization(authorization))throw new Error('Search authorization changed.');signal?.throwIfAborted();};
    try{
      await check();const page=await send(endpoint+'/v1/search/query',{bodyJson:JSON.stringify(request),credential:authorization.credential,signal,maxBytes:1048576});await check();
      if(page?.version!==1||page.type!==request.type||page.endpoint!==endpoint||page.capabilityVerified!==false||!Array.isArray(page.items)
        ||page.items.length>request.query.limit||page.items.some(item=>item.type!==request.type||!/^[0-9a-f-]{36}$/.test(item.id)||!Array.isArray(item.matchReasons))
        ||!(page.nextCursor===null||/^[0-9a-f-]{36}$/.test(page.nextCursor)))throw new Error('Invalid typed search response.');
      return {...page,source:'endpoint-reported'};
    }catch(error){if(error.code==='GALAXY_REMOTE_REJECTED')sessions.invalidateAuthorization(authorization,'remote-rejected');throw error;}
  }
  return Object.freeze({query});
}
