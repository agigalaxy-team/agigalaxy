import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {MaintenanceNativeClient,loadMaintenanceNativeConfiguration,maintenanceRequestSignature} from "../maintenance/native.mjs";
import {modelSettingsNativeCommandSchema,modelSettingsDomains} from "../../shared/operations-model-settings-schema.mjs";
import {ServiceError} from "../../shared/service-error.mjs";

const fail=()=>new ServiceError('model_settings_native_unavailable',503);
const count=z.number().int().nonnegative().nullable().catch(null);
const timestamp=z.iso.datetime({offset:true}).nullable().catch(null);
const version=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).nullable().catch(null);
const uuid=z.uuid().transform(value=>value.toLowerCase());
const reference=z.string().regex(/^model-key:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const credential=z.object({reference,modelRecordId:uuid,configured:z.boolean()});
const engineState=z.enum(['available','ready','running','configured','not-configured','unavailable','unknown']).catch('unknown');
const availability=z.object({state:z.enum(['available','unavailable']).catch('unavailable')}).catch({state:'unavailable'});
const safeCode=z.string().regex(/^(?:models|model_settings|model_configuration)_[a-z0-9_]{1,80}$/).nullable().catch(null);
const operation=z.object({
 id:uuid,kind:z.enum(['models-apply','models-credential-provision']),
 state:z.enum(['accepted','running','completed','failed','unknown']),code:safeCode,
 credentialRef:reference.optional(),startedAt:timestamp,finishedAt:timestamp,
});
const status=z.object({
 availability,configurationVersion:version,appliedVersionId:uuid.nullable().catch(null),
 engines:z.object({
  gateway:z.object({state:engineState,configurationVersion:version,modelCount:count}),
  agentos:z.object({state:engineState,configurationVersion:version,configuredScenarios:z.array(z.enum(modelSettingsDomains)).max(5).refine(rows=>new Set(rows).size===rows.length)}),
 }),
 credentials:z.array(credential).max(1000),operation:operation.optional(),
});
const tokens=z.object({input:count,output:count,total:count,cachedInput:count,reasoning:count}).catch({input:null,output:null,total:null,cachedInput:null,reasoning:null});
const calls=z.object({total:count,completed:count,failed:count,unknown:count}).catch({total:null,completed:null,failed:null,unknown:null});
const usage=z.object({
 availability,days:z.union([z.literal(7),z.literal(30)]),from:timestamp,to:timestamp,coverageFrom:timestamp,coversWholeWindow:z.boolean().nullable().catch(null),calls,tokens,unknownUsageCalls:count,
 byScenario:z.array(z.object({domain:z.enum(modelSettingsDomains),calls,tokens,unknownUsageCalls:count})).max(5),
 byModel:z.array(z.object({modelRecordId:uuid,calls,tokens,unknownUsageCalls:count})).max(1000),
});
function project(schema,value){const result=schema.safeParse(value);if(!result.success)throw new ServiceError('model_settings_native_response_invalid',503);return result.data;}
export const modelSettingsNativeStatus=value=>project(status,value);
export const modelSettingsNativeOperation=value=>project(operation,value);
export const modelSettingsNativeCredential=value=>project(credential,value);
export const modelSettingsNativeUsage=value=>project(usage,value);
export const loadModelSettingsNativeConfiguration=loadMaintenanceNativeConfiguration;

// Same protected socket/key transport as maintenance, a separate closed path
// and command schema. No upstream model/provider request is made by this client.
export class ModelSettingsNativeClient{
 constructor({socketPath,key,now=()=>Math.floor(Date.now()/1000),transport=null}={}){
  Object.assign(this,{socketPath,key,now,transport});this.authentication=new MaintenanceNativeClient({socketPath,key,now});
 }
 verifyService(request){return this.authentication.verifyService(request);}
 verifyBody(context,body){return this.authentication.verifyBody(context,body);}
 async call(input){
  const parsed=modelSettingsNativeCommandSchema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_model_settings_request',400);
  if(this.transport)return this.transport(parsed.data);
  if(!this.socketPath||!this.key)throw new ServiceError('model_settings_native_not_configured',503);
  const body=JSON.stringify(parsed.data);if(Buffer.byteLength(body)>65536)throw new ServiceError('invalid_model_settings_request',400);
  const id=randomUUID(),at=String(this.now());
  return new Promise((resolve,reject)=>{
   const request=httpRequest({socketPath:this.socketPath,path:'/v1/model-settings',method:'POST',headers:{
    'content-type':'application/json','content-length':Buffer.byteLength(body),'x-galaxy-service-key':this.key,
    'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(this.key,{id,at,body}),
   }},response=>{
    const chunks=[];let bytes=0;
    response.on('data',chunk=>{bytes+=chunk.length;if(bytes>4194304){request.destroy();reject(fail());}else chunks.push(chunk);});
    response.on('error',()=>reject(fail()));response.on('end',()=>{
     let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(fail());}
     if(response.statusCode!==200){
      const allowed=new Set(['model_settings_native_busy','model_settings_version_changed','model_settings_configuration_invalid','model_settings_credential_unavailable','model_settings_permission_denied','model_settings_authorization_unavailable']);
      const error=new ServiceError(allowed.has(value?.error)?value.error:'model_settings_native_unavailable',[400,403,409].includes(response.statusCode)?response.statusCode:503);error.nativeStatus=response.statusCode;return reject(error);
     }
     resolve(value);
    });
   });
   request.setTimeout(20000,()=>request.destroy());request.on('error',()=>reject(fail()));request.end(body);
  });
 }
}

