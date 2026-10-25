import {isDeepStrictEqual} from "node:util";
import {ServiceError} from "../../shared/service-error.mjs";

export const iso=seconds=>new Date(seconds*1000).toISOString(),stamp=value=>new Date(value).toISOString();
export const fail=(code,status=409)=>{throw new ServiceError(code,status);};
export const phases=new Set(['prepared','submitting','task-pending','result-unknown']);
export const unknownMetrics=()=>({searches:null,measuredSearches:null,resultKnownSearches:null,noResults:null,noResultRate:null,clicks:null,clickedSearches:null,clickRate:null,followUps:null,scanLimited:null});
export const versionView=row=>row?{id:row.id,version:row.version,settings:row.settings,kind:row.kind,createdAt:stamp(row.created_at),operatorId:row.operator_id,restoredFrom:row.restored_from,restorable:row.kind==='baseline'||row.was_applied===true}:null;
export const operationView=(row,replayed=false)=>({operationId:row.operation_id,kind:row.kind,versionId:row.version_id,phase:row.phase,errorCode:row.error_code,recordedAt:stamp(row.created_at),updatedAt:stamp(row.updated_at),replayed});
export const changes=(before,after)=>Object.fromEntries(['synonyms','rankingMode'].filter(key=>!isDeepStrictEqual(before?.[key]??null,after?.[key]??null)).map(key=>[key,{before:before?.[key]??null,after:after?.[key]??null}]));
export const nativeFailure=error=>error instanceof ServiceError?error.code:'search_quality_native_unavailable';
