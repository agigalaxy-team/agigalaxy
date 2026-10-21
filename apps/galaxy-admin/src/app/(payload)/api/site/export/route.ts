import {authenticatedCMS,exportPublishedSite} from '../../../../../lib/cms';
import {adminLog,requestCorrelation} from '../../../../../lib/runtime-log.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
  const started=performance.now(),requestId=requestCorrelation(request.headers);
  const finish=(response:Response,error?:unknown)=>{response.headers.set('X-Request-Id',requestId);adminLog('cms.export',{stage:'published-export',path:request.url,method:'GET',requestId,statusCode:response.status,durationMs:performance.now()-started,error});return response;};
  try{
    const context=await authenticatedCMS(request.headers);
    if(!context)return finish(Response.json({error:'operator_login_required'},{status:401,headers:{'Cache-Control':'no-store'}}));
    return finish(Response.json(await exportPublishedSite(context),{headers:{'Cache-Control':'no-store'}}));
  }catch(error){return finish(Response.json({error:'published_snapshot_unavailable'},{status:503,headers:{'Cache-Control':'no-store'}}),error);}
}
