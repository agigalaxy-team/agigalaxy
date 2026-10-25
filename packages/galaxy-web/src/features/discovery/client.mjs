import {createOfficialAccountClient} from '../../official-account-client.mjs';
import {readWithTransientRecovery} from '../../../../../integrations/shared/read-task.mjs';

export const discoveryPageKey=(path,search='')=>{
 if(['/', '/app','/app/'].includes(path))return 'home';
 if(['/help','/help/'].includes(path))return 'help';
 if(['/download','/download/','/downloads','/downloads/'].includes(path))return 'download';
 if(path==='/app/account')return 'account';
 if(path==='/app/find')return 'find';
 if(path==='/app/community'&&!['reports','notifications','owned'].includes(new URLSearchParams(search).get('section')))return 'community';
 return null;
};
const eventNames=new Set(['pageview','content-view','content-click','content-exposure','content-bookmark','content-participate','search','search-click','not-interested']);
const pageKeys=new Set(['home','community','find','account','help','download']);
const visitorConfigurations=new WeakMap();
const recommendationProofs=new WeakMap();
const attributedEvents=new Set(['content-exposure','content-click','content-bookmark','content-participate','not-interested']);
const referenceKey=content=>content?content.kind+':'+content.id.toLowerCase()+':'+content.version:null;
function validEvent(value){
 if(!value||Object.keys(value).some(key=>!['eventId','name','pageKey','content','query','exposureId','recommendation','search'].includes(key))||!eventNames.has(value.name)||!pageKeys.has(value.pageKey))throw Error('Invalid public usage event');
 if(value.content&&(!['post','reply'].includes(value.content.kind)||!/^[0-9a-f-]{36}$/i.test(value.content.id)||typeof value.content.version!=='string'||Object.keys(value.content).some(key=>!['kind','id','version'].includes(key))))throw Error('Invalid public content reference');
 if(value.recommendation&&(!attributedEvents.has(value.name)||Object.keys(value.recommendation).join(',')!=='requestId'||!/^[0-9a-f-]{36}$/i.test(value.recommendation.requestId??'')))throw Error('Invalid recommendation reference');
 if(value.search&&(!['search','search-click','content-bookmark','content-participate'].includes(value.name)||value.recommendation||Object.keys(value.search).join(',')!=='requestId'||!/^[0-9a-f-]{36}$/i.test(value.search.requestId??'')))throw Error('Invalid search reference');
 return value;
}
export function createDiscoveryClient({endpoint,websiteOrigin=globalThis.location?.origin,fetcher=globalThis.fetch}){
 // Reuses the official account origin validation and real cookie session.
 const account=createOfficialAccountClient({endpoint,website:websiteOrigin,fetch:fetcher});
 async function request(path,{signal,method='GET',body,headers={}}={}){
  const response=await fetcher(endpoint+path,{method,credentials:'include',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
  if(Number(response.headers.get('content-length'))>1048576)throw Error('discovery_response_invalid');
  const text=await response.text();if(new TextEncoder().encode(text).length>1048576)throw Error('discovery_response_invalid');
  let value;try{value=JSON.parse(text);}catch{if(!response.ok)throw Object.assign(Error('Discovery request failed'),{code:'discovery_unavailable',status:response.status});throw Error('discovery_response_invalid');}
  if(!response.ok)throw Object.assign(Error('Discovery request failed'),{code:typeof value.error==='string'?value.error:value.error?.code,status:response.status});return value;
 }
 async function accountHeaders(signal,expectedAccountId){const session=await account.session({signal});if(expectedAccountId&&(session.state!=='signed-in'||session.account.id?.toLowerCase()!==expectedAccountId.toLowerCase()))throw Object.assign(Error('The feedback account changed'),{code:'discovery_account_changed'});return session.state==='signed-in'?{'X-Galaxy-Account-ID':session.account.id,'X-Galaxy-Account-CSRF':session.csrfToken}:{};}
 let configurations=visitorConfigurations.get(fetcher);if(!configurations){configurations=new Map();visitorConfigurations.set(fetcher,configurations);}
 const configurationKey=websiteOrigin+'|'+endpoint;
 let proofStores=recommendationProofs.get(fetcher);if(!proofStores){proofStores=new Map();recommendationProofs.set(fetcher,proofStores);}let proofs=proofStores.get(configurationKey);if(!proofs){proofs=new Map();proofStores.set(configurationKey,proofs);}
 function configuration(){
  let pending=configurations.get(configurationKey);if(pending)return pending;
  // Different mounted collectors share one first-visit cookie handshake. Its
  // lifetime is not tied to an individual component's request cancellation.
  pending=request('/v1/discovery/config');configurations.set(configurationKey,pending);
  void pending.catch(()=>{if(configurations.get(configurationKey)===pending)configurations.delete(configurationKey);});return pending;
 }
 return Object.freeze({
  async record(input,{signal,expectedAccountId}={}){
   let event=validEvent({...input,eventId:input.eventId??crypto.randomUUID()});
   const[settings,headers]=await Promise.all([configuration(),accountHeaders(signal,expectedAccountId)]);
   const proof=proofs.get(referenceKey(event.content)),identity=headers['X-Galaxy-Account-ID']??null;
   // Only a recommendation returned by the server can attach a request ID.
   // Version, position, source, theme mapping and identity are resolved there.
   if(!event.recommendation&&!event.search&&['content-bookmark','content-participate'].includes(event.name)&&proof?.identity===identity)event={...event,...(proof.requestId?{recommendation:{requestId:proof.requestId}}:{search:{requestId:proof.searchRequestId}})};
   // No retry under a different account/CSRF. No local storage of analytics,
   // private sources, raw URLs or offline backfill is introduced here.
   try{const result=await request('/v1/discovery/events',{method:'POST',body:event,signal,headers:{...headers,'X-Galaxy-Discovery-CSRF':settings.csrfToken}});
    if(result.accepted===true&&['content-click','search-click'].includes(event.name)&&event.content){const key=referenceKey(event.content);proofs.delete(key);if(event.recommendation||event.search)proofs.set(key,{identity,...(event.recommendation?{requestId:event.recommendation.requestId}:{searchRequestId:event.search.requestId})});while(proofs.size>100)proofs.delete(proofs.keys().next().value);}
    return result;
   }catch(error){if(error.code==='discovery_csrf_invalid')configurations.delete(configurationKey);if(['discovery_recommendation_reference_invalid','discovery_search_reference_invalid'].includes(error.code))proofs.delete(referenceKey(event.content));throw error;}
  },
  async search({query,topic,after=0,limit=3},{signal}={}){const[headers]=await Promise.all([accountHeaders(signal),configuration()]);return readWithTransientRecovery(()=>request('/v1/discovery/search?'+new URLSearchParams({q:query,after:String(after),limit:String(limit),...(topic?{topic}:{})}),{signal,headers}),{signal});},
  async recommendations({mode='personalized',topic,limit=6}={}, {signal}={}){
   const[headers]=await Promise.all([accountHeaders(signal),configuration()]);return readWithTransientRecovery(()=>request('/v1/discovery/recommendations?'+new URLSearchParams({mode,limit:String(limit),...(topic?{topic}:{})}),{signal,headers}),{signal});
  }
 });
}
