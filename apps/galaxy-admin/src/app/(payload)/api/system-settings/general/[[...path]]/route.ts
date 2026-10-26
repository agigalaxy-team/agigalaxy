import {readGeneralSettings,saveGeneralSettings,applyGeneralSettings,readGeneralSettingsOperation} from "../../../../../../lib/system-settings/system-settings-general.mjs";
import {adminLog,requestCorrelation} from '../../../../../../lib/runtime-log.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
type Context={params:Promise<{path?:string[]}>};
async function route(request:Request,context:Context){
 const started=performance.now(),requestId=requestCorrelation(request.headers);
 try{
  if(request.url.includes('?'))return Response.json({error:'invalid_system_settings_request'},{status:400,headers});
  const path=(await context.params).path??[];
  if(request.method==='GET'){
   if(!path.length)return Response.json(await readGeneralSettings(request.headers),{headers});
   if(path.length===2&&path[0]==='operations')return Response.json(await readGeneralSettingsOperation(request.headers,path[1]),{headers});
  }
  if(request.method==='POST'&&path.length===1&&['versions','apply'].includes(path[0])){
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return Response.json({error:'system_settings_json_required'},{status:415,headers});
   const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
   if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return Response.json({error:'system_settings_request_too_large'},{status:413,headers});}chunks.push(value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
   let input:unknown;try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return Response.json({error:'invalid_system_settings_request'},{status:400,headers});}
   return Response.json(await(path[0]==='versions'?saveGeneralSettings(request.headers,input):applyGeneralSettings(request.headers,input)),{headers});
  }
  return Response.json({error:'system_settings_route_not_found'},{status:404,headers});
 }catch(error){
  const value=error as {code?:string;status?:number;systemSettingsStage?:string;cause?:unknown};
  adminLog('system.settings.general',{stage:value.systemSettingsStage??'general-request',method:request.method,path:request.url,statusCode:value.status??503,durationMs:performance.now()-started,requestId,error:value.cause??error});
  const code=/^(?:system_settings|invalid_system_settings|operations_permission|operator_login|operator_csrf|business_admin)_[a-z_]{1,80}$/.test(value.code??'')?value.code:'system_settings_source_unavailable';
  return Response.json({error:code},{status:[400,401,403,404,409,413,415].includes(value.status??0)?value.status:503,headers:{...headers,'X-Request-Id':requestId}});
 }
}
export const GET=route;
export const POST=route;
