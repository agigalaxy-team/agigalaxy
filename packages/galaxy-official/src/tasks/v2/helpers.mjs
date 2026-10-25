import * as z from "zod/v4";
import {ServiceError} from "../../shared/service-error.mjs";

export const uuid = value => z.uuid().safeParse(value).success;

export function parse(payloadJson, schema) {
  try {
    if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 100000) throw new Error();
    return schema.parse(JSON.parse(payloadJson));
  } catch { throw new ServiceError('invalid_task_payload'); }
}

export function absent(error) { return error instanceof ServiceError && [403, 404].includes(error.status); }
