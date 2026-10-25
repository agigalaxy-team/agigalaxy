import {z} from 'zod';
import {ServiceError} from '../shared/service-error.mjs';

export const discoveryEventNames=Object.freeze(['pageview','content-view','content-click','content-exposure','content-bookmark','content-participate','search','search-click','not-interested']);
export const discoveryPagePaths=Object.freeze({home:'/app/',community:'/app/community',find:'/app/find',account:'/app/account',help:'/help',download:'/download'});
const reference=z.strictObject({kind:z.enum(['post','reply']),id:z.uuid(),version:z.union([z.uuid(),z.string().regex(/^[1-9][0-9]{0,9}$/)])});
export const discoveryEventSchema=z.strictObject({eventId:z.uuid(),name:z.enum(discoveryEventNames),pageKey:z.enum(Object.keys(discoveryPagePaths)),content:reference.optional(),query:z.string().trim().max(160).optional(),exposureId:z.uuid().optional(),recommendation:z.strictObject({requestId:z.uuid()}).optional(),search:z.strictObject({requestId:z.uuid()}).optional()});
export const discoverySearchSchema=z.strictObject({query:z.string().trim().min(1).max(160),topic:z.enum(['technology','arts','learning','life','galaxy','unclassified']).optional(),after:z.number().int().min(0).max(10000).default(0),limit:z.number().int().min(1).max(30).default(20)});
export const discoveryRecommendationSchema=z.strictObject({mode:z.enum(['personalized','latest']).default('personalized'),limit:z.number().int().min(1).max(30).default(12),topic:z.enum(['technology','arts','learning','life','galaxy','unclassified']).optional()});
export function discoveryParse(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_discovery_request',400);return parsed.data;}
export function discoveryEvent(input){
 const event=discoveryParse(discoveryEventSchema,input);
 const content=event.name.startsWith('content-')||['search-click','not-interested'].includes(event.name);
 const contentPages={'content-view':['community'],'content-click':['home','community','find'],'content-exposure':['home','community','find'],'content-bookmark':['community'],'content-participate':['community'],'search-click':['find'],'not-interested':['home','community','find']};
 if(content!==!!event.content||(event.name==='search')!==Object.hasOwn(event,'query')||event.name==='search'&&event.pageKey!=='find'||event.content&&!contentPages[event.name]?.includes(event.pageKey)||event.exposureId&&!['content-exposure','content-click','search-click','not-interested'].includes(event.name)||event.recommendation&&!['content-exposure','content-click','content-bookmark','content-participate','not-interested'].includes(event.name))throw new ServiceError('discovery_purpose_denied',400);
 if(event.search&&(!['search','search-click','content-bookmark','content-participate'].includes(event.name)||event.recommendation))throw new ServiceError('discovery_purpose_denied',400);
 // A closed schema is intentional: arbitrary URLs, bodies, titles, messages,
 // case material, official notices/mail and caller-supplied account IDs never
 // reach analytics or recommendation adapters, including derived features.
 return {...event,purpose:'site-usage-analytics',...(['content-view','content-click','content-bookmark','content-participate','search-click','not-interested'].includes(event.name)?{recommendationPurpose:'public-community-recommendation'}:{})};
}
export function discoveryDeliveryTargets(event){
 // General page visits and analytics are never implicitly recommendation
 // training. Only the explicitly qualified public-object actions reach Gorse.
 return event.recommendationPurpose==='public-community-recommendation'&&event.itemKey?['openpanel','gorse']:['openpanel'];
}
export function discoveryItemKey(kind,id){if(!['post','reply'].includes(kind)||!z.uuid().safeParse(id).success)throw new ServiceError('invalid_discovery_request',400);return kind+'_'+id.toLowerCase();}
export function discoveryItemReference(key){const match=/^(post|reply)_([0-9a-f-]{36})$/.exec(key??'');return match&&z.uuid().safeParse(match[2]).success?{kind:match[1],id:match[2]}:null;}
export function discoveryIdentity({accountId=null,visitorId}){
 if(accountId!==null&&!z.uuid().safeParse(accountId).success||!z.uuid().safeParse(visitorId).success)throw new ServiceError('discovery_identity_required',401);
 return {accountId,visitorId,profileId:accountId?'account:'+accountId:'visitor:'+visitorId};
}
