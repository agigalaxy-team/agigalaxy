import {isDeepStrictEqual} from "node:util";
import {ServiceError} from "../../shared/service-error.mjs";
import {defaultRecommendationPolicy,recommendationAlgorithm,recommendationFixedConstraints} from "../../discovery-runtime/recommendation-control.mjs";

export const iso=value=>new Date(value*1000).toISOString();
export const stamp=value=>value===null?null:new Date(value).toISOString();
export const fail=(code,status=409)=>{throw new ServiceError(code,status);};
export const metricNames=['exposures','clicks','bookmarks','notInterested'];
export const unknownMetrics=()=>Object.fromEntries(metricNames.map(key=>[key,null]));
export const diff=(before,after,keys)=>Object.fromEntries(keys.filter(key=>!isDeepStrictEqual(before?.[key]??null,after[key])).map(key=>[key,{before:before?.[key]??null,after:after[key]}]));
export const policyView=row=>row?{version:row.revision,enabled:row.enabled,directions:row.directions,controls:row.controls,fixedConstraints:recommendationFixedConstraints,updatedAt:stamp(row.updated_at),algorithm:recommendationAlgorithm}:defaultRecommendationPolicy();
export const themeView=row=>({key:'theme:'+row.id,id:row.id,label:row.label,kind:'theme',version:row.revision,enabled:row.enabled,mapping:row.mapping,source:'operator-mapping'});
