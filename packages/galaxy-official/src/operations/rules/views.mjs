import {isDeepStrictEqual} from "node:util";

export const iso=value=>new Date(value).toISOString();
export const versionView=row=>row?{id:row.id,key:row.policy_key,version:row.version,policy:row.policy,source:row.source,createdBy:row.created_by,
 createdAt:iso(row.created_at),restoredFrom:row.restored_from??null,publishedVersion:row.published_version??null}:null;
export function changes(before,after){const result={};for(const key of new Set([...Object.keys(before??{}),...Object.keys(after)]))if(!isDeepStrictEqual(before?.[key],after[key]))result[key]={before:before?.[key]??null,after:after[key]??null};return result;}
