import {z} from 'zod';
import {createHash} from 'node:crypto';
import {ServiceError} from '../../shared/service-error.mjs';
import {personDisplayName} from '../../shared/person-display-name.mjs';

export const managementDomains=Object.freeze(['overview','governance','messaging','discovery','maintenance']);
export const managementPhaseKinds=Object.freeze(['native-account','native-admission','local-principal','business-assignments','native-sessions','portal-sessions','email-verification']);
export const managementPhaseStates=Object.freeze(['accepted','confirmed','submitted','failed','unknown']);
export const managementStates=Object.freeze(['accepted','completed','partial','failed','unknown']);
export const managementCodes=Object.freeze(['management_identity_unavailable','management_identity_read_forbidden','management_identity_client_unavailable',
 'management_identity_response_invalid','management_identity_target_changed','management_identity_not_found','management_writer_not_configured',
 'management_identity_write_forbidden','management_identity_write_failed','management_identity_submission_unknown','management_password_policy_rejected',
 'management_username_conflict','management_root_protected','management_root_only','management_self_protected','management_sessions_unavailable',
 'management_directory_source_changed','management_command_unavailable','management_email_verification_not_configured','operations_permission_denied',
 'business_admin_denied','operations_authorization_unavailable']);
export const managementCommandActions=Object.freeze({'profile-update':'management.accounts.profile.write','login-disable':'management.accounts.login.disable',
 'login-restore':'management.accounts.login.restore','password-reset':'management.accounts.password.reset','sessions-revoke':'management.accounts.sessions.revoke',
 delete:'management.accounts.delete','admission-change':'management.accounts.read','email-change':'management.accounts.profile.write'});
export const managementOperatorIdSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const managementListSchema=z.strictObject({page:z.number().int().min(1).max(1000000).default(1),
 pageSize:z.union([z.literal(20),z.literal(50),z.literal(100)]).default(20),query:z.string().trim().max(200).default(''),
 enabled:z.enum(['true','false']).optional(),roleId:z.uuid().optional(),aiDomain:z.enum(managementDomains).optional(),
 sort:z.enum(['name-asc','created-desc','created-asc']).default('name-asc')});
export const managementHistorySchema=z.strictObject({after:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n).optional(),limit:z.number().int().min(1).max(100).default(30)});
const name=z.string().trim().max(100),note=z.string().trim().max(1000),reason=z.string().trim().max(1000).default('');
const roles=z.array(z.uuid()).max(100).refine(v=>new Set(v).size===v.length);
export const managementCreateSchema=z.strictObject({operationId:z.uuid(),username:z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
 firstName:name.default(''),lastName:name.default(''),note:note.default(''),temporaryPassword:z.string().min(1).max(4096),roleIds:roles.default([])});
const base={operationId:z.uuid(),expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),reason};
export const managementCommandSchema=z.discriminatedUnion('kind',[
 z.strictObject({...base,kind:z.literal('profile-update'),firstName:name.optional(),lastName:name.optional(),note:note.optional()})
  .refine(v=>['firstName','lastName','note'].some(k=>Object.hasOwn(v,k))),
 z.strictObject({...base,kind:z.literal('login-disable')}),z.strictObject({...base,kind:z.literal('login-restore')}),
 z.strictObject({...base,kind:z.literal('password-reset'),temporaryPassword:z.string().min(1).max(4096)}),
 z.strictObject({...base,kind:z.literal('sessions-revoke')}),z.strictObject({...base,kind:z.literal('delete')}),
 z.strictObject({...base,kind:z.literal('admission-change'),action:z.enum(['promote','demote'])}),
 z.strictObject({...base,kind:z.literal('email-change'),newEmail:z.email().max(320)})]);
export const managementAssignmentSchema=z.strictObject({operationId:z.uuid(),id:z.uuid().optional(),expectedVersion:z.number().int().min(0),roleId:z.uuid(),enabled:z.boolean()});
export const managementContract=Object.freeze({listQuery:['page','pageSize','query','enabled','roleId','aiDomain','sort'],historyQuery:['after','limit'],
 commandKinds:Object.keys(managementCommandActions),states:managementStates,phaseKinds:managementPhaseKinds,phaseStates:managementPhaseStates,codes:managementCodes});
export const managementParse=(schema,input)=>{const result=schema.safeParse(input);if(!result.success)throw new ServiceError('invalid_management_accounts_request',400);return result.data;};
export const managementId=(issuer,sub)=>createHash('sha256').update(issuer+'\0'+sub).digest('hex');
export const managementDisplay=user=>personDisplayName({firstName:user?.firstName,lastName:user?.lastName})||user?.username||'管理账户';
export const managementStamp=value=>value===null||value===undefined?null:new Date(value).toISOString();
export const managementTargetVersion=(user,meta)=>createHash('sha256').update(JSON.stringify([user,{version:meta?.version??0,loginBlocked:meta?.login_blocked??false,deletedAt:managementStamp(meta?.deleted_at)}])).digest('hex');
export const managementIntent=input=>{const {temporaryPassword,...safe}=input;return safe;};
export const managementSafeCode=error=>managementCodes.includes(error?.code)?error.code:'management_command_unavailable';

