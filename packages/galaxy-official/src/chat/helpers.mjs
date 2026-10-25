import canonicalize from "canonicalize";
import {digest} from "../shared/digest.mjs";
import {ServiceError} from "../shared/service-error.mjs";

export const day=86400, stamp=n=>new Date(n*1000).toISOString(), hash=x=>digest(canonicalize(x));
export const fail=(code,status=409)=>{throw new ServiceError(code,status);};
export function parse(schema,input){const r=schema.safeParse(input);if(!r.success)fail('invalid_chat_request',400);return r.data;}
export function uuid(value){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))fail('invalid_chat_request',400);return value;}
