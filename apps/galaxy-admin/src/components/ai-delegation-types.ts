import type {PermissionAction} from './permissions-types';
export type AiDelegationAction='read'|'create'|'update'|'assign'|'revoke';
export type AiDelegationFields={enabled:boolean;targetAiAccountIds:string[];grantablePermissions:string[];allowedManagementActions:AiDelegationAction[]};
export type AiDelegation=AiDelegationFields&{id:string;sourceAiAccountId:string;version:number;updatedAt:string};
export type AiDelegationDraft=AiDelegationFields&{baseVersion:number;baseline:AiDelegationFields};
export type AiDelegationRead={delegation:AiDelegation|null;sourceAiAccount:{id:string;domain:string;name:string;enabled:boolean};targetAiAccounts:{id:string;domain:string;name:string;enabled:boolean}[];checkedAt:number;readExpiresAt:number};
export type AiDelegationSave={operationId:string;delegationVersion:number;delegation:AiDelegation;recordedAt:string;replayed:boolean};
export type AiDelegationOperation={state:'not-recorded';operationId:string}|{state:'recorded';operationId:string;result:AiDelegationSave};
export type AiDelegationCatalog={items:PermissionAction[];checkedAt:number;readExpiresAt:number};
