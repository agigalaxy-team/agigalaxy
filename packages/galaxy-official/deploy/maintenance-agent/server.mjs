import {createServer} from 'node:http';
import {mkdir,lstat,chmod,chown,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {noSymlinkPath,assertTarget} from '../operations-stack/host.mjs';
import {verifyMaintenanceSignature,maintenanceServiceKeyMatches} from '../../src/operations-maintenance-native.mjs';
import {readMaintenanceAgentConfiguration} from './configuration.mjs';
import {MaintenanceNativeRuntime} from './runtime.mjs';
import {ModelConfigurationRuntime,readModelConfigurationControl} from './model-configuration.mjs';
import {createSystemSettingsRuntime,readSystemSettingsControl} from '../system-settings/configuration.mjs';
import {systemSettingsErrorCodes} from '../../src/operations/system-settings/schema.mjs';

export function createMaintenanceNativeHttpServer({runtime,modelRuntime=null,systemSettingsRuntime=null,serviceKey,now=()=>Math.floor(Date.now()/1000)}){
 const seen=new Map();
 return createServer(async(request,response)=>{
  const send=(status,body)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(body));};
  // Verify the dedicated service identity before consuming a request body.
  if(!maintenanceServiceKeyMatches(serviceKey,request.headers['x-galaxy-service-key'])){request.resume();return send(401,{error:'maintenance_service_denied'});}
  if(request.method!=='POST'||!['/v1/maintenance','/v1/model-settings','/v1/system-settings'].includes(request.url)){request.resume();return send(404,{error:'maintenance_route_not_found'});}
  const models=request.url==='/v1/model-settings',system=request.url==='/v1/system-settings',selected=system?systemSettingsRuntime:models?modelRuntime:runtime;
  if(!selected){request.resume();return send(503,{error:system?'system_settings_native_not_configured':models?'model_settings_native_not_configured':'maintenance_native_unavailable'});}
  const id=request.headers['x-galaxy-request-id'],at=request.headers['x-galaxy-request-at'];
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||typeof at!=='string'||!/^\d{1,12}$/.test(at)||Math.abs(now()-Number(at))>30){request.resume();return send(401,{error:'maintenance_service_denied'});}
  for(const [key,time] of seen)if(time<now()-30)seen.delete(key);
  if(seen.has(id)){request.resume();return send(409,{error:'maintenance_request_replayed'});}
  const length=Number(request.headers['content-length']);
  if(!Number.isInteger(length)||length<2||length>65536||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']??'')){request.resume();return send(400,{error:'maintenance_request_invalid'});}
  const chunks=[];let size=0;
  try{
   for await(const chunk of request){size+=chunk.length;if(size>65536)throw Error('body_limit');chunks.push(chunk);}
   if(size!==length)return send(400,{error:'maintenance_request_invalid'});
   const body=Buffer.concat(chunks).toString('utf8');
   if(!verifyMaintenanceSignature(serviceKey,request.headers['x-galaxy-service-signature'],{id,at,body}))return send(401,{error:'maintenance_service_denied'});
   if(seen.size>=10000)return send(503,{error:'maintenance_service_capacity'});seen.set(id,now());
   let input;try{input=JSON.parse(body);}catch{return send(400,{error:'maintenance_request_invalid'});}
   const result=await selected.call(input);
   if(system&&Buffer.byteLength(JSON.stringify(result),'utf8')>1048576)return send(503,{error:'system_settings_native_response_invalid'});
   return send(200,result);
  }catch(error){
   if(system){const code=systemSettingsErrorCodes.includes(error.code)?error.code:'system_settings_native_unavailable';
    const status=error.code==='invalid_system_settings_request'?400:code==='system_settings_permission_denied'?403:['system_settings_version_changed','system_settings_operation_changed','system_settings_native_busy','system_settings_source_changed','system_settings_configuration_incomplete'].includes(code)?409:503;
    return send(status,{error:code});}
   if(models){const code=/^model_settings_[a-z_]{1,80}$/.test(error.code??'')?error.code:'model_settings_native_unavailable';
    const status=['model_settings_operation_conflict','model_settings_version_changed','model_settings_native_busy'].includes(code)?409:code==='model_settings_permission_denied'?403:code==='model_settings_native_request_invalid'?400:503;
    return send(status,{error:code});}
   const code=/^maintenance_[a-z_]{1,80}$/.test(error.code??'')?error.code:'maintenance_native_failed';
   const status=['maintenance_operation_conflict','maintenance_catalog_changed','maintenance_plan_changed','maintenance_native_busy'].includes(code)?409:['maintenance_native_request_invalid','maintenance_log_window_invalid','maintenance_log_component_unknown'].includes(code)?400:code==='maintenance_backup_not_found'?404:503;
   return send(status,{error:code});
  }
 });
}
export async function startMaintenanceAgent(configuration){
 assertTarget(configuration.operations);await noSymlinkPath('/run/galaxy-maintenance');
 await mkdir('/run/galaxy-maintenance',{recursive:true,mode:0o750});await chown('/run/galaxy-maintenance',0,configuration.apiGroupId);await chmod('/run/galaxy-maintenance',0o750);
 // Refuse to unlink an unknown socket or a symlink. systemd RuntimeDirectory
 // removes this service's socket on stop; a stale file requires operator review.
 try{await lstat(configuration.socketPath);throw Error('maintenance_socket_already_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 const runtime=new MaintenanceNativeRuntime({configuration});await runtime.journal.initialize();
 let modelRuntime=null;
 try{const control=await readModelConfigurationControl();modelRuntime=new ModelConfigurationRuntime({configuration,control});await modelRuntime.initialize();}
 catch(error){if(error.code!=='ENOENT')throw error;}
 let systemSettingsRuntime=null;
 try{const control=await readSystemSettingsControl(process.env.GALAXY_SYSTEM_SETTINGS_CONTROL_FILE??'/etc/galaxy/system-settings/control.json');systemSettingsRuntime=await createSystemSettingsRuntime({configuration,control});}
 catch(error){if(error.code!=='ENOENT')throw error;}
 const server=createMaintenanceNativeHttpServer({runtime,modelRuntime,systemSettingsRuntime,serviceKey:configuration.serviceKey});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(configuration.socketPath,resolve);});
 await chown(configuration.socketPath,0,configuration.apiGroupId);await chmod(configuration.socketPath,0o660);
 return{runtime,modelRuntime,systemSettingsRuntime,server,async stop(){await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...runtime.tasks.values(),...(modelRuntime?.tasks.values()??[]),...(systemSettingsRuntime?.tasks.values()??[])]);await unlink(configuration.socketPath);}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const i=process.argv.indexOf('--config');
 try{
  if(i!==2||!process.argv[i+1]||process.argv.length!==4)throw Error('configuration_required');
  const instance=await startMaintenanceAgent(await readMaintenanceAgentConfiguration(process.argv[i+1]));
  const stop=()=>instance.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));process.once('SIGTERM',stop);process.once('SIGINT',stop);
  process.stdout.write(JSON.stringify({event:'maintenance_agent_ready',scope:'private-unix-socket',publicRestoreEnabled:false})+'\n');
 }catch{process.stderr.write(JSON.stringify({event:'maintenance_agent_start_failed',code:'maintenance_configuration_or_runtime_unavailable'})+'\n');process.exitCode=1;}
}
