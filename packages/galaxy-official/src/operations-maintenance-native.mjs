import {request as httpRequest} from 'node:http';
import {timingSafeEqual,randomUUID,createHmac,createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {maintenanceNativeCommandSchema} from './shared/operations-maintenance-schema.mjs';
import {ServiceError} from './shared/service-error.mjs';

const fail=()=>new ServiceError('maintenance_native_unavailable',503);
export function maintenanceRequestSignature(key,{id,at,body}){return createHmac('sha256',key).update(id+'\n'+at+'\n'+body).digest('hex');}
export function verifyMaintenanceSignature(key,supplied,context){
 if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied))return false;
 return timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(maintenanceRequestSignature(key,context),'hex'));
}
export function maintenanceServiceKeyMatches(expected,received){
 if(typeof expected!=='string'||expected.length<32||typeof received!=='string'||received.length>1024)return false;
 const hash=value=>createHash('sha256').update(value).digest();return timingSafeEqual(hash(expected),hash(received));
}
export async function loadMaintenanceNativeConfiguration(path,{read=readFile,stat=lstat}={}){
 if(!path)return null;if(!isAbsolute(path))throw fail();
 const info=await stat(path);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||(info.mode&0o027)||info.size>16384)throw fail();
 let x;try{x=JSON.parse(await read(path,'utf8'));}catch{throw fail();}
 if(!x||x.version!==1||Object.keys(x).some(k=>!['version','socketPath','keyFile'].includes(k))||!/^\/run\/galaxy-maintenance\/[a-z0-9-]+[.]sock$/.test(x.socketPath??'')||!isAbsolute(x.keyFile??''))throw fail();
 const k=await stat(x.keyFile);if(!k.isFile()||k.isSymbolicLink()||k.uid!==0||(k.mode&0o027)||k.size>2048)throw fail();
 const key=(await read(x.keyFile,'utf8')).trim();if(key.length<32||key.length>1024||/[\p{Cc}\s]/u.test(key))throw fail();
 return{socketPath:x.socketPath,key};
}
export class MaintenanceNativeClient{
 constructor({socketPath,key,now=()=>Math.floor(Date.now()/1000),transport=null}={}){Object.assign(this,{socketPath,key,now,transport});}
 verifyService(request){
  if(!this.key)throw new ServiceError('maintenance_native_not_configured',503);
  if(!maintenanceServiceKeyMatches(this.key,request.headers?.['x-galaxy-service-key']))throw new ServiceError('maintenance_service_denied',401);
  const id=request.headers?.['x-galaxy-request-id'],at=request.headers?.['x-galaxy-request-at'],signature=request.headers?.['x-galaxy-service-signature'];
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||typeof at!=='string'||!/^\d{1,12}$/.test(at)||Math.abs(this.now()-Number(at))>30||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))throw new ServiceError('maintenance_service_denied',401);
  return{id,at,signature};
 }
 verifyBody(context,rawBody){if(typeof rawBody!=='string'||Buffer.byteLength(rawBody)>65536||!verifyMaintenanceSignature(this.key,context?.signature,{id:context?.id,at:context?.at,body:rawBody}))throw new ServiceError('maintenance_service_denied',401);}
 async call(input){
  const result=maintenanceNativeCommandSchema.safeParse(input);if(!result.success)throw new ServiceError('invalid_maintenance_request',400);
  if(this.transport)return this.transport(result.data);
  if(!this.socketPath||!this.key)throw new ServiceError('maintenance_native_not_configured',503);
  const body=JSON.stringify(result.data),id=randomUUID(),at=String(this.now());
  return new Promise((resolve,reject)=>{
   const request=httpRequest({socketPath:this.socketPath,path:'/v1/maintenance',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-galaxy-service-key':this.key,'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(this.key,{id,at,body})}},response=>{
    const chunks=[];let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>4194304){request.destroy();reject(fail());}else chunks.push(chunk);});
    response.on('error',()=>reject(fail()));response.on('end',()=>{
     let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(fail());}
     if(response.statusCode!==200)return reject(new ServiceError(['maintenance_native_busy','maintenance_plan_changed','maintenance_production_adapter_unavailable','maintenance_capture_coverage_incomplete'].includes(value?.error)?value.error:'maintenance_native_unavailable',response.statusCode===409?409:503));
     resolve(value);
    });
   });
   request.setTimeout(15000,()=>request.destroy());request.on('error',()=>reject(fail()));request.end(body);
  });
 }
}
