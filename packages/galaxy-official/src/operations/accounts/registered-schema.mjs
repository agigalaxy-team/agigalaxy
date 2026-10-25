import {z} from 'zod';
import {ServiceError} from '../../shared/service-error.mjs';
import {accountAvatarKeySchema,accountBioSchema} from '../../shared/account-profile-schema.mjs';

export const registeredUserIdSchema=z.uuid();
export const registeredUsersQuerySchema=z.strictObject({
 page:z.number().int().min(1).max(1000000).default(1),pageSize:z.union([z.literal(20),z.literal(50),z.literal(100)]).default(20),
 query:z.string().trim().min(1).max(320).optional(),source:z.enum(['all','registered','business-only']).default('all'),business:z.enum(['formed','not-formed']).optional(),
 subjectType:z.enum(['person','organization','agent','unknown']).optional(),login:z.enum(['enabled','disabled']).optional(),
 emailVerified:z.enum(['yes','no']).optional(),participation:z.enum(['restricted','unrestricted']).optional(),
 registeredFrom:z.iso.datetime({offset:true}).optional(),registeredTo:z.iso.datetime({offset:true}).optional(),
 sort:z.enum(['registered-desc','registered-asc']).default('registered-desc'),
}).refine(x=>!x.registeredFrom||!x.registeredTo||Date.parse(x.registeredFrom)<=Date.parse(x.registeredTo));
export const registeredCommandKinds=Object.freeze(['password-reset','login-disable','login-restore','sessions-revoke','profile-correct','profile-preset']);
export const registeredCommandActions=Object.freeze({'password-reset':'accounts.password.reset','login-disable':'accounts.login.disable','login-restore':'accounts.login.restore','sessions-revoke':'accounts.sessions.revoke','profile-correct':'accounts.profile.correct','profile-preset':'accounts.profile.correct'});
const base={operationId:z.uuid(),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(1).max(1000)};
export const registeredUserCommandSchema=z.discriminatedUnion('kind',[
 ...registeredCommandKinds.filter(kind=>!['profile-correct','profile-preset'].includes(kind)).map(kind=>z.strictObject({...base,kind:z.literal(kind)})),
 z.strictObject({...base,kind:z.literal('profile-correct'),displayName:z.string().trim().min(1).max(120),avatarKey:accountAvatarKeySchema.optional(),bio:accountBioSchema.optional(),basis:z.string().trim().min(1).max(1000),expectedProfileRevision:z.number().int().nonnegative()}),
 z.strictObject({...base,kind:z.literal('profile-preset'),displayName:z.string().trim().min(1).max(120).optional(),avatarKey:accountAvatarKeySchema.optional(),bio:accountBioSchema.optional(),basis:z.string().trim().min(1).max(1000),expectedPresetRevision:z.number().int().nonnegative()}),
]);
export const registeredUsersHistorySchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),limit:z.number().int().min(1).max(100).default(20)});
export const registeredUsersParse=(schema,input)=>{const x=schema.safeParse(input);if(!x.success)throw new ServiceError('invalid_registered_users_request',400);return x.data;};
export const registeredUsersContract=Object.freeze({base:'/v1/operations/registered-users',pageSizes:[20,50,100],commandKinds:registeredCommandKinds,
 listQuery:['page','pageSize','query','source','business','subjectType','login','emailVerified','participation','registeredFrom','registeredTo','sort'],
 readActions:['accounts.registered.read','accounts.identity.read'],commandActions:registeredCommandActions});
