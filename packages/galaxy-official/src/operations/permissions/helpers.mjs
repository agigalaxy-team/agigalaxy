import {ServiceError} from "../../shared/service-error.mjs";

export const fail=(code,status=403)=>{throw new ServiceError(code,status);};
export const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)fail('invalid_operations_permissions_request',400);return result.data;};
export const identity=(actor,endpoint)=>{
 if(actor?.kind!=='business-operator'||actor.endpoint!==endpoint||typeof actor.operatorId!=='string'||!actor.operatorId||actor.operatorId.length>1024)fail('business_admin_denied');
 return {kind:'business-operator',operatorId:actor.operatorId,endpoint,httpRequestId:actor.httpRequestId??null};
};
