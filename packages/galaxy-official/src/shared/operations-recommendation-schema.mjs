import {z} from 'zod';
import {ServiceError} from './service-error.mjs';
import {forumReadTopicSchema} from './community-forum-topics-v1.mjs';

const unique=items=>new Set(items).size===items.length;
const version=z.number().int().min(0).max(2147483646);
const uuid=z.uuid().transform(value=>value.toLowerCase());
export const recommendationDirectionSchema=z.enum(['increase','keep','decrease']);
export const recommendationThemeKeySchema=z.string().max(80).refine(value=>{
 const [kind,id,...rest]=value.split(':');return !rest.length&&(kind==='category'?forumReadTopicSchema.safeParse(id).success:['tag','theme'].includes(kind)&&z.uuid().safeParse(id).success);
}).transform(value=>value.toLowerCase());
export const recommendationMappingSchema=z.strictObject({
 categories:z.array(forumReadTopicSchema).max(6).refine(unique),
 tagIds:z.array(uuid).max(32).refine(unique),
 queryTerms:z.array(z.string().trim().min(1).max(80)).max(24).refine(unique),
}).refine(value=>value.categories.length+value.tagIds.length+value.queryTerms.length>0);
export const recommendationControlsSchema=z.strictObject({avoidRepetition:z.boolean(),avoidConcentration:z.boolean()});
export const recommendationOverviewSchema=z.strictObject({days:z.union([z.literal(7),z.literal(30),z.literal(90)]).default(30),query:z.string().trim().max(160).default('')});
export const recommendationHistorySchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(50).default(20)});
export const recommendationPolicySaveSchema=z.strictObject({operationId:uuid,expectedVersion:version,enabled:z.boolean(),themeKey:recommendationThemeKeySchema,direction:recommendationDirectionSchema,controls:recommendationControlsSchema,reason:z.string().trim().min(1).max(500)});
export const recommendationThemeSaveSchema=z.strictObject({operationId:uuid,themeId:uuid.optional(),expectedVersion:version,label:z.string().trim().min(1).max(80),enabled:z.boolean(),mapping:recommendationMappingSchema,reason:z.string().trim().min(1).max(500)});
export function parseRecommendation(schema,input){const parsed=schema.safeParse(input);if(!parsed.success)throw new ServiceError('invalid_recommendation_request',400);return parsed.data;}
export const normalizeRecommendationTerm=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ');
