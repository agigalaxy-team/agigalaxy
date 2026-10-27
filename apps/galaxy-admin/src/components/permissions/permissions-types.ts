export type PermissionAction={code:string;label:string;group:string;groupLabel:string;sensitive:boolean;humanOnly:boolean;description?:string};
export type PermissionCapabilities={canManageRoles:boolean;canManageAssignments:boolean;canManageAutomation:boolean};
export type PermissionRead={checkedAt:number;readExpiresAt:number;metadataOnly:true;permissions:PermissionCapabilities};
export type PermissionCatalog=PermissionRead&{items:PermissionAction[];sourceVersion?:string};
export type BusinessAuthorization={version:string;permissions:string[]};
export type BusinessRole={id:string;name:string;description:string;enabled:boolean;version:number;permissions:string[];createdAt:string;updatedAt:string;subjectScope?:'shared'|'ai-only';usage?:{humanAssignments:number;aiAssignments:number;aiAccounts:{id:string;domain:AutomationAiDomain;name:string;enabled:boolean}[]};impact?:{affectsPeople:boolean;affectsAi:boolean;assignmentCount:number}};
export type BusinessAssignment={id:string;operatorId:string;roleId:string;enabled:boolean;version:number;createdAt:string;updatedAt:string};
export type BusinessRoles=PermissionRead&{items:BusinessRole[];nextAfter:null;permissions:PermissionCapabilities};
export type PermissionRoleDetail=PermissionRead&{role:BusinessRole};
export type ManagementPerson={operatorId:string;displayName:string;identityState:'known-management-principal';assignments:BusinessAssignment[];authorizationState:'available'|'unknown'|'not-eligible';managementEligibility?:'qualified'|'unqualified'|'unknown';effective:null|{version:string;permissions:string[];source:'preconfigured-root'|'business-roles'|'upstream-administrator'}};
export type ManagementPersonnel=PermissionRead&{items:ManagementPerson[];nextAfter:null};
export type AutomationExecutionState='not-connected'|'model-not-configured'|'awaiting-trigger'|'connected'|'unavailable';
export type AutomationResourceScope={kind:'selected';resourceIds:string[]}|{kind:'eligible'}|{kind:'unresolved'};
export type AutomationAiDomain='overview'|'governance'|'messaging'|'discovery'|'maintenance';
export type AutomationAiAccount={id:string;domain:AutomationAiDomain;name:string;enabled:boolean};
export type PermissionConditionReason=string|{code:string;message:string};
export type AutomationActionReadiness={permission:string;permissionAllowed:boolean;humanRequired:boolean;humanConditions?:string[];conditions?:string[];handlerReady:boolean;ready:boolean;reasons:PermissionConditionReason[]};
export type AutomationAiAccountOption=AutomationAiAccount&{executablePermissions:string[];permissions?:string[];rolePermissions?:string[];canSave?:boolean;canEnable:boolean;readiness?:AutomationActionReadiness[];unavailableReason?:'account-disabled'|'execution-not-connected'|'role-missing'|'assignment-denied'|'exceeds-permissions'|null};
export type AutomationAiAccountOptions={state:'available'|'unavailable';items:AutomationAiAccountOption[]};
export type AutomationAiBindingState='not-applicable'|'unassigned'|'bound'|'disabled'|'role-exceeded'|'unsupported'|'unavailable';
export type AutomationGrant={id:string;name:string;executorKind:'program'|'ai';mode:'assisted'|'automatic';enabled:boolean;version:number;permissions:string[];resourceIds:string[];resourceScope?:AutomationResourceScope;scopeCapability?:{state:'eligible'|'selected'|'unresolved';canBindObjects:boolean;reason:string|null;supportedActions:string[]};aiAccountId:string|null;bindingState:AutomationAiBindingState;aiAccount:AutomationAiAccount|null;executionState:AutomationExecutionState;executionAvailable:boolean;createdAt:string;updatedAt:string;authorization?:{saved:true;effective:boolean;reasons:PermissionConditionReason[]};readiness?:{ready:boolean;reasons:PermissionConditionReason[];actions:AutomationActionReadiness[]}};
export type AutomationGrants=PermissionRead&{items:AutomationGrant[];nextAfter:null;aiAccountOptions:AutomationAiAccountOptions;execution:{state:'not-connected'|'not-configured'|'connected'|'unavailable';available:boolean;modelState?:'configured'|'not-configured'|'unknown';automaticTriggers?:'not-connected'}};
type EnabledDelta={before:boolean|null;after:boolean};
type ActionDelta={added:string[];removed:string[]};
export type PermissionHistoryDelta=
 |{kind:'role';permissions:ActionDelta;enabled:EnabledDelta}
 |{kind:'assignment';operatorId:string;roleId:string;enabled:EnabledDelta}
 |{kind:'automation';permissions:ActionDelta;enabled:EnabledDelta;scope:{before:string[]|AutomationResourceScope|null;after:string[]|AutomationResourceScope};mode:{before:'assisted'|'automatic'|null;after:'assisted'|'automatic'};executorKind:{before:'program'|'ai'|null;after:'program'|'ai'};aiAccountId?:{before:string|null;after:string|null}};
export type PermissionHistoryItem={id:string;sequence:string;kind:'role-save'|'assignment-save'|'automation-save';operatorId:string;operatorDisplayName:string|null;assignmentOperatorDisplayName:string|null;resourceId:string;version:number;changedFields:string[];createdAt:string;delta?:PermissionHistoryDelta|null};
export type PermissionHistory=PermissionRead&{items:PermissionHistoryItem[];nextAfter:string|null;metadataOnly:true};
export type RoleSave={role:BusinessRole;operationId:string;recordedAt:string;replayed:boolean};
export type AssignmentSave={assignment:BusinessAssignment;operationId:string;recordedAt:string;replayed:boolean};
export type AutomationSave={automation:AutomationGrant;operationId:string;recordedAt:string;replayed:boolean};
export type PermissionSave=RoleSave|AssignmentSave|AutomationSave;
export type PermissionOperationRead=PermissionRead&({state:'not-recorded';operationId:string}|{state:'recorded';operationId:string;operatorId:string;kind:'role-save'|'assignment-save'|'automation-save';selection:Record<string,unknown>;result:PermissionSave});
