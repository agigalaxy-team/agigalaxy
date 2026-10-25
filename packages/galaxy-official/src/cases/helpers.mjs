import {ServiceError} from "../shared/service-error.mjs";
import {caseEventV2Schema} from "../shared/cases-schema.mjs";

export function parseFact(payloadJson) {
  try {
    if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>24000) throw new Error('size');
    return caseEventV2Schema.parse(JSON.parse(payloadJson));
  } catch { throw new ServiceError('invalid_case_v2_payload'); }
}

export function rule(condition,code,status=409) { if(!condition)throw new ServiceError(code,status); }
