import config from '@payload-config';
import {REST_GET,REST_POST,REST_DELETE,REST_PATCH,REST_PUT,REST_OPTIONS} from '@payloadcms/next/routes';
import {isAdminWrite} from '../../../../lib/request-origin.mjs';
import {adminLog,requestCorrelation} from '../../../../lib/runtime-log.mjs';
type Handler=ReturnType<typeof REST_POST>;
const observed=(handler:Handler):Handler=>async(request,args)=>{
  const started=performance.now(),requestId=requestCorrelation(request.headers);
  try{
    const response=await handler(request,args);response.headers.set('X-Request-Id',requestId);
    adminLog('cms.request',{stage:'rest',path:request.url,method:request.method,requestId,statusCode:response.status,durationMs:performance.now()-started});return response;
  }catch(error){adminLog('cms.request',{stage:'rest',path:request.url,method:request.method,requestId,statusCode:500,durationMs:performance.now()-started,error});throw error;}
};
const localAuthPath=(request:Request)=>/^\/api\/operators\/(?:login|logout|first-register|forgot-password|reset-password|refresh-token|verify)(?:\/|$)/.test(new URL(request.url).pathname);
const guarded=(handler:Handler):Handler=>async(request,args)=>{
  if(localAuthPath(request))return Response.json({error:'operator_oidc_required'},{status:404,headers:{'Cache-Control':'no-store'}});
  if(!isAdminWrite(request.headers))return Response.json({error:'admin_origin_required'},{status:403,headers:{'Cache-Control':'no-store'}});
  return handler(request,args);
};
const read=REST_GET(config);
export const GET:Handler=observed(async(request,args)=>localAuthPath(request)?Response.json({error:'operator_oidc_required'},{status:404,headers:{'Cache-Control':'no-store'}}):read(request,args));
export const POST=observed(guarded(REST_POST(config)));
export const DELETE=observed(guarded(REST_DELETE(config)));
export const PATCH=observed(guarded(REST_PATCH(config)));
export const PUT=observed(guarded(REST_PUT(config)));
export const OPTIONS=observed(REST_OPTIONS(config));
