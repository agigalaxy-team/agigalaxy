export type ManagementAiDomain='overview'|'governance'|'messaging'|'discovery'|'maintenance';
export type ManagementAccountTab='overview'|'roles'|'ai'|'history';
export type ManagementAccountPageSize=20|50|100;
export type ManagementAccountsLocation={
 page:number;pageSize:ManagementAccountPageSize;query:string;enabled:''|'true'|'false';roleId:string;aiDomain:''|ManagementAiDomain;sort:'name-asc'|'created-desc'|'created-asc';
 operator:string;creating:boolean;tab:ManagementAccountTab;historyAfter:string;
};

/** Authored, non-secret fields only. Temporary passwords belong to the
 * current form's private memory and must never become an ordinary draft. */
export type ManagementProfileDraft={firstName:string;lastName:string;note:string;reason:string;targetVersion:string;baseFirstName:string;baseLastName:string;baseNote:string};
export type ManagementCreateDraft={username:string;firstName:string;lastName:string;note:string;roleIds:string[]};
export type ManagementAdmission='administrator'|'reader'|'none';
export type ManagementRoleSummary={id:string;name:string;description:string;version:number;enabled:boolean;permissions:string[];assignmentId:string;assignmentVersion:number;assignmentEnabled:boolean};
export type ManagementAiUse={domains:ManagementAiDomain[];source:'preconfigured-root'|'business-roles'};
export type ManagementAccount={
 operatorId:string;displayName:string|null;username:string|null;email:string|null;emailVerified:boolean|null;enabled:boolean|null;createdAt:string|null;
 admission:ManagementAdmission|null;rootAdministrator:boolean;lifecycle:'present'|'deleted';deletedAt:string|null;businessRoles:ManagementRoleSummary[];aiUse:ManagementAiUse;
};
export type ManagementCommandKind='create'|'profile-update'|'login-disable'|'login-restore'|'password-reset'|'sessions-revoke'|'delete'|'admission-change'|'email-change';
export type ManagementActionDraft={kind:Exclude<ManagementCommandKind,'create'|'profile-update'>;reason:string;targetVersion:string;newEmail:string;action:'promote'|'demote';confirmed:boolean};
export type ManagementRead={checkedAt:number;readExpiresAt:number;metadataOnly:true};
export type ManagementAccountsPage=ManagementRead&{
 items:ManagementAccount[];
 pagination:{page:number;pageSize:ManagementAccountPageSize;matchingTotal:number|null;totalPages:number|null};
 source:{state:'ready'|'syncing'|'not-configured'|'unavailable';coverage:'complete-generation'|'not-ready';asOf:string|null;generationId:string|null;lastError:string|null};
 capabilities:{canCreate:boolean};
 roles:ManagementAssignableRole[];
};
export type ManagementCapabilities={canEditProfile:boolean;canDisableLogin:boolean;canRestoreLogin:boolean;canResetPassword:boolean;canRevokeSessions:boolean;canDelete:boolean;canAssignRoles:boolean;canChangeAdmission:boolean;canChangeEmail:boolean};
export type ManagementPhaseKind='native-account'|'native-admission'|'local-principal'|'business-assignments'|'native-sessions'|'portal-sessions'|'email-verification';
export type ManagementPhase={kind:ManagementPhaseKind;state:'accepted'|'confirmed'|'submitted'|'failed'|'unknown';code:string|null;revokedSessions?:number;inflightBlocked?:boolean};
export type ManagementCommandState='accepted'|'completed'|'partial'|'failed'|'unknown';
export type ManagementCommandResult={phases:ManagementPhase[];revision:number|null};
export type ManagementCommandReceipt=ManagementRead&{state:ManagementCommandState|'not-recorded';operationId:string;targetOperatorId:string|null;kind:ManagementCommandKind|null;result:ManagementCommandResult|null;recordedAt:string|null;replayed:boolean};
export type ManagementHistoryItem={sequence:string;operationId:string;operatorId:string;operatorDisplayName:string|null;targetOperatorId:string|null;kind:ManagementCommandKind;state:ManagementCommandState;result:ManagementCommandResult;reason:string|null;recordedAt:string;updatedAt:string};
export type ManagementHistory=ManagementRead&{items:ManagementHistoryItem[];nextAfter:string|null};
export type ManagementAssignableRole={id:string;name:string;description:string;enabled:boolean;version:number;permissions:string[];canAssign:boolean};
export type ManagementAssignment={id:string;operatorId:string;roleId:string;enabled:boolean;version:number};
export type ManagementPermissionSource={kind:'preconfigured-root'|'business-role';roleId:string|null;label:string;permissions:string[]};
export type ManagementAccountDetail=ManagementRead&{
 item:ManagementAccount;
 identity:{state:'available'|'not-found'|'unavailable'|'not-configured';issuer:string;externalSubject:string;firstName:string|null;lastName:string|null;requiredActions:string[]};
 profile:{note:string;revision:number};targetVersion:string;versionBasis:'observed-current-source';
 effective:{state:'available'|'not-eligible';permissions:string[];sources:ManagementPermissionSource[]};aiUse:ManagementAiUse;roles:ManagementAssignableRole[];capabilities:ManagementCapabilities;
 security:{identityManagement:'configured'|'not-configured';sessions:{sso:{state:'available'|'unavailable';activeCount:number|null;scope:'keycloak-management-sso'};portal:{state:'available'|'unavailable';activeCount:number|null;scope:'management-portal'}}};
 history:{items:ManagementHistoryItem[];nextAfter:string|null};
};
