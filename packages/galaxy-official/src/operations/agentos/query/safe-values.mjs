import {ServiceError} from '../../../shared/service-error.mjs';

// Deliberately enumerate model-visible fields. Never return a source DTO,
// credential reference, upstream error, session list, issuer, or raw subject.
export const fail=()=>{throw new ServiceError('operations_query_response_invalid',503);};
// eslint-disable-next-line no-control-regex -- Deliberately reject or sanitize ASCII control characters.
export const text=(value,max=240)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)?value:null;
export const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
export const bool=value=>typeof value==='boolean'?value:null;
export const one=(value,values)=>values.includes(value)?value:null;
export const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)?value:null;
export const array=(value,max)=>{if(!Array.isArray(value)||value.length>max)fail();return value;};
export function combinedQueryLease(values){
 if(!values.length||values.some(value=>!Number.isSafeInteger(value?.checkedAt)||!Number.isSafeInteger(value?.readExpiresAt)||value.readExpiresAt<value.checkedAt))fail();
 return{checkedAt:Math.max(...values.map(value=>value.checkedAt)),readExpiresAt:Math.min(...values.map(value=>value.readExpiresAt)),metadataOnly:true};
}
