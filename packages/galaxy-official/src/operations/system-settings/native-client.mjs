import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {MaintenanceNativeClient,maintenanceRequestSignature,loadMaintenanceNativeConfiguration} from "../maintenance/native.mjs";
import {ServiceError} from '../../shared/service-error.mjs';
import {systemSettingsNativeCommandSchema,parseSystemSettings,systemSettingsErrorCodes} from './schema.mjs';

export const loadSystemSettingsNativeConfiguration=loadMaintenanceNativeConfiguration;
export class SystemSettingsNativeClient{
 constructor({socketPath,key,transport=null,now=()=>Math.floor(Date.now()/1000)}={}){Object.assign(this,{socketPath,key,transport,now});this.verifier=new MaintenanceNativeClient({key,now});}
 verifyService(request){return this.verifier.verifyService(request);}
 verifyBody(context,raw){return this.verifier.verifyBody(context,raw);}
 async call(input){
  const value=parseSystemSettings(systemSettingsNativeCommandSchema,input),body=JSON.stringify(value);
  if(Buffer.byteLength(body)>65536)throw new ServiceError('invalid_system_settings_request',400);
  if(this.transport)return this.transport(value);
  if(!this.socketPath||!this.key)throw new ServiceError('system_settings_native_not_configured',503);
  const id=randomUUID(),at=String(this.now());
  return new Promise((resolve,reject)=>{
   const fail=()=>new ServiceError('system_settings_native_unavailable',503);
   const request=httpRequest({socketPath:this.socketPath,path:'/v1/system-settings',method:'POST',headers:{
    'content-type':'application/json','content-length':Buffer.byteLength(body),'x-galaxy-service-key':this.key,
    'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(this.key,{id,at,body}),
   }},response=>{
    const chunks=[];let bytes=0;
    response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){request.destroy();reject(fail());}else chunks.push(chunk);});
    response.on('error',()=>reject(fail()));response.on('end',()=>{
     let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(fail());}
     if(response.statusCode!==200){const code=systemSettingsErrorCodes.includes(result?.error)?result.error:'system_settings_native_unavailable';
      const error=new ServiceError(code,[400,401,403,404,409,413,415].includes(response.statusCode)?response.statusCode:503);
      error.nativeStatus=response.statusCode;return reject(error);}
     resolve(result);
    });
   });
   request.setTimeout(20000,()=>request.destroy());request.on('error',()=>reject(fail()));request.end(body);
  });
 }
}
