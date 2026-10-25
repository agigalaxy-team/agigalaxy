import {ServiceError} from "../../shared/service-error.mjs";
import {recordObjectAudit} from "../../infrastructure/object-audit.mjs";

export const absent = e => e instanceof ServiceError && [400, 403, 404, 409, 422, 503].includes(e.status);
export const json = value => JSON.stringify(value);
export const compareSubject = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const ownControl=(actor,row,type)=>actor?.subjectId===row.subject_id?{ownerControl:{type,operationId:row.id,consentId:row.consent_id,payloadHash:row.payload_hash}}:{};
export const audit = (db, actor, authorization, id, action) => recordObjectAudit(db, { subjectId: actor.subjectId,
  objectId: id, action, httpRequestId: actor.httpRequestId ?? null, ...authorization });
