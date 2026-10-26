export type RegisteredPageSize=20|50|100;
export type RegisteredSource='all'|'registered'|'business-only';
export type RegisteredTab='overview'|'profile'|'security'|'restrictions'|'history';
export type RegisteredUsersLocation={page:number;pageSize:RegisteredPageSize;query:string;source:RegisteredSource;business:''|'formed'|'not-formed';subjectType:''|'person'|'organization'|'agent'|'unknown';login:''|'enabled'|'disabled';emailVerified:''|'yes'|'no';participation:''|'restricted'|'unrestricted';registeredFrom:string;registeredTo:string;sort:'registered-desc'|'registered-asc';registration:string;view:'directory'|'detail';tab:RegisteredTab;days:7|28;historyAfter:string;linksAfter:string;typeHistoryAfter:string;auditAfter:string};
export type RegisteredUser={
  registrationId:string;
  identity:{source:'keycloak-website';issuer:string|null;subject:string|null;displayName:string|null;email:string|null;emailVerified:boolean|null;enabled:boolean|null;registeredAt:string|null;presence:'present'|'not-found'|'outside-configured-issuer'|'not-configured'|'unavailable';readState?:'available'|'not-authorized'};
  business:null|{accountId:string;uid:string|null;displayName:string|null;avatarKey?:string|null;subjectType:'person'|'organization'|'agent'|null;profileRevision:number;businessCreatedAt:string;verifiedAt:string|null;restriction:{scope:'community-participation';active:boolean;until:string|null;reason:string|null;revision:number}};
  registrationProfile?:null|{state:'reserved'|'preset';reservedAccountId:string;uid:string;displayName:string;avatarKey:string|null;revision:number;updatedAt:string|null};
  stage:{state:'registered'|'completion-required'|'unknown';basis:string|null};
  observedAt:string;
};
export type RegisteredUsersPage={
  items:RegisteredUser[];
  pagination:{page:number;pageSize:RegisteredPageSize;total:number|null;matchingTotal:number|null;totalPages:number|null};
  source:{state:'ready'|'syncing'|'not-configured'|'unavailable';generationId:string|null;registeredCount:number|null;registeredAsOf:string|null;syncStartedAt:string|null;lastError:string|null;coverage:'complete-generation'|'not-ready';atomicSourceSnapshot:false};
  permissions:{canReadIdentity:boolean;canReadProfile?:boolean};
  checkedAt:number;readExpiresAt:number;metadataOnly:true;
};
export type RegisteredUserDetail={
  item:RegisteredUser;
  businessRef:null|{accountId:string;href:string};
  websiteProfile?:{state:'available'|'not-authorized'|'not-formed';source?:'business-profile'|'registration-preset';avatarKey:string|null;bio:string|null};
  targetVersion:string;
  versionBasis:'observed-current-source';
  capabilities:{canResetPassword:boolean;canDisableLogin:boolean;canRestoreLogin:boolean;canRevokeSessions:boolean;canCorrectProfile:boolean;canPresetProfile?:boolean};
  permissions:{canReadIdentity:boolean;canReadProfile?:boolean};
  security:{identityManagement:'available'|'not-configured'|'forbidden'|'unavailable';registrationEvidence:{state:'available'|'unavailable';hasCredentials:boolean|null;hasFederatedIdentities:boolean|null};sessions:{sso:{state:'available'|'unavailable';activeCount:number|null;scope:'keycloak-user-sso'};website:{state:'available'|'unavailable';activeCount:number|null;scope:'website-portal'}}};
  history:{items:RegisteredUserHistory[];nextAfter:string|null};
  checkedAt:number;readExpiresAt:number;metadataOnly:true;
};
export type RegisteredCommandKind='password-reset'|'login-disable'|'login-restore'|'sessions-revoke'|'profile-correct'|'profile-preset';
export type RegisteredEffect={state:'confirmed'|'submitted'|'failed'|'unknown'|'not-required'|'not-configured';code:string|null;revokedSessions?:number;revision?:number};
export type RegisteredCommandResult={effects:Partial<Record<'identity'|'ssoSessions'|'websiteSessions'|'profile',RegisteredEffect>>;passwordChanged:false|null;participationChanged:false;changedFields?:('displayName'|'avatarKey'|'bio')[];preset?:{reservedAccountId:string;uid:string;revision:number};correction?:{field:'displayName';before:string|null;after:string}};
export type RegisteredCommandReceipt={state:'accepted'|'submitted'|'completed'|'partial'|'failed'|'unknown'|'not-recorded';operationId:string;registrationId:string|null;kind:RegisteredCommandKind|null;result:RegisteredCommandResult|null;recordedAt:string|null;checkedAt:number;readExpiresAt:number;metadataOnly:true;replayed:boolean};
export type RegisteredUserHistory={sequence:string;operationId:string;operatorId:string;operatorDisplayName?:string|null;kind:RegisteredCommandKind;state:RegisteredCommandReceipt['state'];result:RegisteredCommandResult;reason?:string|null;basis?:string|null;createdAt:string;updatedAt:string};
