import {adminEnvironment,operatorCookies,operatorForwardedAddress} from '../../../../../lib/environment.mjs';
import {operationsProxyRequestPolicy,operationsRequestBodyLimit,isAgentOsConversationEventsPath} from '../../../../../lib/proxy-policy.mjs';
import {adminLog,requestCorrelation} from '../../../../../lib/runtime-log.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const noStore={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
async function boundedBody(request:Request,limit:number){
  if(Number(request.headers.get('content-length'))>limit)throw Error('too_large');
  const reader=request.body?.getReader();if(!reader)return new ArrayBuffer(0);
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('too_large');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes.buffer;
}
async function proxy(request:Request){
  const started=performance.now(),edgeRequestId=requestCorrelation(request.headers);
  const finish=(response:Response,stage:string,error?:unknown)=>{
    const requestId=response.headers.get('x-request-id')??edgeRequestId;
    response.headers.set('X-Request-Id',requestId);
    response.headers.set('X-Galaxy-Edge-Request-Id',edgeRequestId);
    adminLog('operations.proxy',{stage,method:request.method,path:request.url,statusCode:response.status,durationMs:performance.now()-started,requestId,edgeRequestId,error});
    return response;
  };
  const environment=adminEnvironment();
  const policy=operationsProxyRequestPolicy({url:request.url,method:request.method,headers:request.headers,publicOrigin:environment.publicOrigin});
  if(!policy.allowed)return finish(Response.json({error:'operations_request_denied'},{status:policy.status,headers:noStore}),'policy');
  const observing=request.method==='GET'&&isAgentOsConversationEventsPath(new URL(request.url).pathname);
  const forwarded=new Headers({Accept:observing?'text/event-stream':'application/json'}),cookie=operatorCookies(request.headers,environment.fixtureCookies);
  try{forwarded.set('X-Forwarded-For',operatorForwardedAddress(request.headers,environment.fixtureCookies));}
  catch(error){return finish(Response.json({error:'operations_forwarded_address_unavailable'},{status:503,headers:noStore}),'forwarded-address',error);}
  if(cookie)forwarded.set('Cookie',cookie);
  if(policy.forwardOrigin)forwarded.set('Origin',policy.forwardOrigin);
  const csrf=request.headers.get('X-Galaxy-Operator-CSRF');if(csrf)forwarded.set('X-Galaxy-Operator-CSRF',csrf);
  let body:ArrayBuffer|undefined;
  if(request.method==='POST'){
    const pathname=new URL(request.url).pathname;
    const limit=operationsRequestBodyLimit(pathname);
    try{body=await boundedBody(request,limit);}catch(error){return finish(Response.json({error:'operations_request_too_large'},{status:413,headers:noStore}),'request-body',error);}
    if(body.byteLength&&request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return finish(Response.json({error:'operations_json_required'},{status:415,headers:noStore}),'content-type');
    if(body.byteLength)forwarded.set('Content-Type','application/json');
  }
  try{
    const response=await fetch(environment.bffOrigin+policy.path,{method:request.method,headers:forwarded,body,redirect:'manual',cache:'no-store',signal:AbortSignal.any([request.signal,AbortSignal.timeout(20000)])});
    const responseHeaders=new Headers(noStore);
    if(observing){responseHeaders.set('Cache-Control','no-store, no-transform');responseHeaders.set('X-Accel-Buffering','no');}
    for(const name of ['content-type','content-disposition','location','retry-after','x-request-id']){const value=response.headers.get(name);if(value)responseHeaders.set(name,value);}
    for(const cookie of response.headers.getSetCookie())responseHeaders.append('Set-Cookie',cookie);
    return finish(new Response(response.body,{status:response.status,headers:responseHeaders}),'upstream');
  }catch(error){return finish(Response.json({error:'operations_unavailable'},{status:503,headers:noStore}),'upstream-transport',error);}
}
export const GET=proxy;
export const POST=proxy;
