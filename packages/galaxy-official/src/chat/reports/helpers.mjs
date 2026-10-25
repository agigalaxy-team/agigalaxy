import {ServiceError} from "../../shared/service-error.mjs";

export const stamp=value=>new Date(value*1000).toISOString(),iso=value=>value?new Date(value).toISOString():null;
export const fail=(code,status=409,details)=>{throw new ServiceError(code,status,details);};
export const parse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)fail('invalid_chat_report_request',400);return result.data;};
export const decisions=new Set(['review','pause','resume','resolve','message-hide','message-restore','message-keep']);
export const terminal=new Set(['resolved','withdrawn']);
export const deletionStates="('requested','review-needed','approved','partial','primary-erased')";
