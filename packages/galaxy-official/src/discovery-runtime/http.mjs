import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {ServiceError} from '../shared/service-error.mjs';
import {body} from '../adapters/http/request.mjs';
import {discoveryEventNames,discoveryPagePaths} from './purpose.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Only actual transport metadata is relayed. The closed event body cannot set
// this field, and a missing/malformed UA is not invented as browser traffic.
function requestTransport(request){const userAgent=request.headers['user-agent'];return typeof userAgent==='string'&&userAgent.length>=1&&userAgent.length<=512&&/^[\x20-\x7e]+$/.test(userAgent)?{userAgent}:{};}
function query(url,keys){const result={};for(const[key,value]of url.searchParams){if(!keys.includes(key)||Object.hasOwn(result,key))throw new ServiceError('invalid_discovery_request',400);result[key]=value;}return result;}
export function createDiscoveryHttp({websiteOrigin,visitorSecret,secureCookies=true}){
 if(typeof visitorSecret!=='string'||visitorSecret.length<32)throw new Error('Explicit discovery visitor secret required');
 if(new URL(websiteOrigin).origin!==websiteOrigin)throw new Error('Explicit website origin required');
 const sign=value=>createHmac('sha256',visitorSecret).update(value).digest('base64url');
 const name='galaxy-discovery-visitor';
 function visitor(request,response){
  const value=(request.headers.cookie??'').split(';').map(item=>item.trim()).find(item=>item.startsWith(name+'='))?.slice(name.length+1),[id,signature]=value?.split('.')??[];
  if(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id??'')&&same(signature,sign(id)))return id;
  const next=randomUUID(),cookie=name+'='+next+'.'+sign(next)+'; Path=/v1/discovery; HttpOnly; SameSite=Lax'+(secureCookies?'; Secure':'');
  const previous=response.getHeader('Set-Cookie');response.setHeader('Set-Cookie',[...(Array.isArray(previous)?previous:previous?[previous]:[]),cookie]);return next;
 }
 return Object.freeze({
  async dispatch({discovery,officialAccounts,authorizeOperator,request,response,url,send,requestId}){
   const analytics=url.pathname==='/v1/operations/discovery/analytics';
   if(!url.pathname.startsWith('/v1/discovery/')&&!analytics)return false;
   if(!discovery)throw new ServiceError('discovery_not_connected',503);
   response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
   if(analytics){
    if(request.method!=='GET')throw new ServiceError('not_found',404);
    const p=query(url,['kind','days','scope','accountId']),actor=await authorizeOperator(request,{write:false,requestId,action:'analytics.read'});
    send(200,await discovery.analytics(actor,{...p,...(p.days===undefined?{}:{days:Number(p.days)})}));return true;
   }
   const visitorId=visitor(request,response);
   if(request.method==='GET'&&url.pathname==='/v1/discovery/config'){
    query(url,[]);send(200,{csrfToken:sign('csrf:'+visitorId),pageKeys:Object.keys(discoveryPagePaths),events:discoveryEventNames,engines:{search:!!discovery.meili,recommendations:!!discovery.gorse,analytics:!!discovery.openpanel},state:'configured',purposes:['site-usage-analytics','public-community-recommendation']});return true;
   }
   async function actor(write){
    if(request.headers.authorization!==undefined)throw new ServiceError('discovery_identity_required',401);
    if(request.headers['x-galaxy-account-id']!==undefined){if(!officialAccounts)throw new ServiceError('official_account_unavailable',503);return officialAccounts.actionActor(request,{write});}
    // An ambient login must not silently convert an anonymous in-flight event
    // into an account event. The collector refreshes the official session first.
    if(await officialAccounts?.currentSession(request))throw new ServiceError('official_account_changed',409);
    return null;
   }
   if(request.method==='POST'&&url.pathname==='/v1/discovery/events'){
    query(url,[]);if(request.headers.origin!==websiteOrigin||!same(request.headers['x-galaxy-discovery-csrf'],sign('csrf:'+visitorId)))throw new ServiceError('discovery_csrf_invalid',403);
     const current=await actor(true),input=await body(request,undefined,{maxBytes:2048});send(202,await discovery.recordUsage(current,visitorId,input,requestTransport(request)));return true;
   }
   if(request.method==='GET'&&url.pathname==='/v1/discovery/search'){
    const p=query(url,['q','topic','after','limit']);send(200,await discovery.search({query:p.q,...(p.topic?{topic:p.topic}:{}),...(p.after===undefined?{}:{after:Number(p.after)}),...(p.limit===undefined?{}:{limit:Number(p.limit)})},{usageIdentity:{actor:await actor(false),visitorId}}));return true;
   }
   if(request.method==='GET'&&url.pathname==='/v1/discovery/recommendations'){
    const p=query(url,['mode','topic','limit']);send(200,await discovery.recommend(await actor(false),visitorId,{...(p.mode?{mode:p.mode}:{}),...(p.topic?{topic:p.topic}:{}),...(p.limit===undefined?{}:{limit:Number(p.limit)})}));return true;
   }
   throw new ServiceError('not_found',404);
  }
 });
}
