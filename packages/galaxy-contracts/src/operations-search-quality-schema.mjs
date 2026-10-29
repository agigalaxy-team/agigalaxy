import {z} from 'zod';
import {ServiceError} from './service-error.mjs';

export const searchQualityFixedConstraints=Object.freeze({currentSource:true,anonymousPublic:true,withdrawnExcluded:true,expiredExcluded:true});
export const searchQualityRankingRules=Object.freeze({relevance:['words','typo','proximity','attribute','sort','exactness'],newest:['sort','words','typo','proximity','attribute','exactness']});
export const normalizeSearchTerm=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ');
const uuid=z.uuid().transform(value=>value.toLowerCase()),revision=z.number().int().min(0).max(2147483646);
const word=z.string().trim().min(1).max(80).transform(normalizeSearchTerm).refine(value=>value.length>0&&!['__proto__','constructor','prototype'].includes(value));
export const searchQualitySettingsSchema=z.strictObject({
 synonyms:z.array(z.strictObject({term:word,alternatives:z.array(word).min(1).max(20)})).max(100).refine(rows=>new Set(rows.map(row=>row.term)).size===rows.length),
 rankingMode:z.enum(['relevance','newest']),
 fixedConstraints:z.strictObject({currentSource:z.literal(true),anonymousPublic:z.literal(true),withdrawnExcluded:z.literal(true),expiredExcluded:z.literal(true)}),
});
export const searchQualityOverviewSchema=z.strictObject({days:z.union([z.literal(7),z.literal(30),z.literal(90)]).default(7),query:z.string().trim().max(160).default(''),issue:z.enum(['all','no-results','no-recorded-click','scan-limited','unmeasured']).default('all'),after:z.string().max(1024).optional(),limit:z.number().int().min(1).max(50).default(20)});
export const searchQualityHistorySchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(50).default(20)});
export const searchQualityDraftSchema=z.strictObject({operationId:uuid,expectedRevision:revision,settings:searchQualitySettingsSchema,reason:z.string().trim().min(1).max(500)});
export const searchQualityApplySchema=z.strictObject({operationId:uuid,expectedRevision:revision,versionId:uuid,reason:z.string().trim().min(1).max(500)});
export const searchQualityOperationSchema=uuid;
export function parseSearchQuality(schema,input){const value=schema.safeParse(input);if(!value.success)throw new ServiceError('invalid_search_quality_request',400);return value.data;}
export function canonicalSearchSettings(settings){return {...settings,synonyms:settings.synonyms.map(row=>({term:row.term,alternatives:[...new Set(row.alternatives)].sort((a,b)=>a<b?-1:a>b?1:0)})).sort((a,b)=>a.term.localeCompare(b.term))};}
export function nativeSearchSettings(settings){return {synonyms:Object.fromEntries(settings.synonyms.map(row=>[row.term,row.alternatives])),rankingRules:[...searchQualityRankingRules[settings.rankingMode]]};}
export function controlledNativeSettings(value){
 if(!value||typeof value!=='object'||!value.synonyms||Array.isArray(value.synonyms)||typeof value.synonyms!=='object'||!Array.isArray(value.rankingRules)||value.rankingRules.length>32||value.rankingRules.some(rule=>typeof rule!=='string'||rule.length>80))throw new ServiceError('discovery_engine_response_invalid',503);
 const synonyms={};if(Object.keys(value.synonyms).length>1000)throw new ServiceError('discovery_engine_response_invalid',503);
 for(const[term,alternatives]of Object.entries(value.synonyms)){const key=normalizeSearchTerm(term);if(!key||term.length>200||['__proto__','constructor','prototype'].includes(key)||Object.hasOwn(synonyms,key)||!Array.isArray(alternatives)||alternatives.length>100||alternatives.some(word=>typeof word!=='string'||!normalizeSearchTerm(word)||word.length>200))throw new ServiceError('discovery_engine_response_invalid',503);synonyms[key]=[...new Set(alternatives.map(normalizeSearchTerm))].sort((a,b)=>a<b?-1:a>b?1:0);}
 return {synonyms:Object.fromEntries(Object.entries(synonyms).sort(([a],[b])=>a.localeCompare(b))),rankingRules:value.rankingRules.map(rule=>rule==='attributeRank'?'attribute':rule)};
}
export function editableSearchSettings(native){
 const controlled=controlledNativeSettings(native),rankingMode=Object.keys(searchQualityRankingRules).find(mode=>JSON.stringify(searchQualityRankingRules[mode])===JSON.stringify(controlled.rankingRules));if(!rankingMode)return null;
 const value=searchQualitySettingsSchema.safeParse({synonyms:Object.entries(controlled.synonyms).map(([term,alternatives])=>({term,alternatives})),rankingMode,fixedConstraints:searchQualityFixedConstraints});return value.success?canonicalSearchSettings(value.data):null;
}
export function sameNativeSettings(a,b){return JSON.stringify(controlledNativeSettings(a))===JSON.stringify(controlledNativeSettings(b));}

