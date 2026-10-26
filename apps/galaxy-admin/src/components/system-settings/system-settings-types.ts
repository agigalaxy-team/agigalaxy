export const systemSettingsTabIds=['general','mail','service-connections','advanced'] as const;
export type SystemSettingsTab=typeof systemSettingsTabIds[number];
export type SystemSettingsLocation={tab:SystemSettingsTab;operation?:SystemSettingsOperationLocator|null};
export type SystemSettingsLease={checkedAt:number;readExpiresAt:number;metadataOnly:true};
export type SystemSettingsOperationState='accepted'|'completed'|'partial'|'failed'|'unknown';
export type SystemSettingsMailPurpose='operations'|'account-authentication'|'runtime-alerts';
export type SystemSettingsSection='mail'|'service-connections';
export type SystemSettingsCommandSection=SystemSettingsSection|'general';
export type SystemSettingsOperationLocator={operationId:string;section:SystemSettingsCommandSection;kind:'save'|'test'|'apply';versionId:string;revision:number};
export type SystemSettingsCheck={kind:'transport'|'authentication'|'index'|'reader-authentication'|'writer-authentication'|'scanner-signatures'|'runtime'|'execution-signature';state:'passed'|'failed'|'not-tested'};
export type SystemSettingsPhase={target:string;state:'pending'|'running'|'completed'|'failed'|'unknown';code:string|null;adoptedVersionId:string|null;checks?:SystemSettingsCheck[]};
export type SystemSettingsOperation={operationId:string;section:SystemSettingsCommandSection;kind:'save'|'test'|'apply'|'credential';state:SystemSettingsOperationState;versionId:string|null;revision:number;credentialRef?:string;phases:SystemSettingsPhase[];startedAt?:string;finishedAt?:string|null};
export type SystemSettingsVersion<T>={id:string;revision:number;configuration:T;createdAt:string};
export type SystemSettingsCapabilities={canRead:boolean;canSave:boolean;canTest:boolean;canApply:boolean;canWriteCredential:boolean};
export type SystemSettingsMailConnection={id:string;name:string;host:string|null;port:number|null;tls:'implicit'|'starttls'|null;credentialRef:string|null;connectionTimeoutMs:number|null;greetingTimeoutMs:number|null;socketTimeoutMs:number|null;maxConnections:number|null;rateLimit:number|null;rateWindowSeconds:number|null;dkimSelector:string|null};
export type SystemSettingsMailConfiguration={connections:SystemSettingsMailConnection[];bindings:Record<SystemSettingsMailPurpose,string|null>};
export type SystemSettingsServiceKind='analysis'|'recommendation'|'search'|'ai-execution'|'file-scanning';
export type SystemSettingsServiceConnection=
 |{id:string;kind:'analysis';url:string;projectId:string;clientId:string;readClientId:string;credentialRef:string|null}
 |{id:string;kind:'recommendation';url:string;credentialRef:string|null}
 |{id:string;kind:'search';url:string;index:string;credentialRef:string|null}
 |{id:string;kind:'ai-execution';url:string;credentialRef:string|null}
 |{id:string;kind:'file-scanning';host:'127.0.0.1'|'::1'|'localhost';port:number;timeoutMs:number};
export type SystemSettingsServiceConfiguration={connections:SystemSettingsServiceConnection[]};
export type SystemSettingsMailDraftConnection=Omit<SystemSettingsMailConnection,'port'|'connectionTimeoutMs'|'greetingTimeoutMs'|'socketTimeoutMs'|'maxConnections'|'rateLimit'|'rateWindowSeconds'|'host'|'tls'|'dkimSelector'>&{host:string;port:string;tls:''|'implicit'|'starttls';connectionTimeoutMs:string;greetingTimeoutMs:string;socketTimeoutMs:string;maxConnections:string;rateLimit:string;rateWindowSeconds:string;dkimSelector:string};
export type SystemSettingsMailDraft={connections:SystemSettingsMailDraftConnection[];bindings:Record<SystemSettingsMailPurpose,string|null>};
export type SystemSettingsServiceDraftConnection={id:string;kind:SystemSettingsServiceKind;url:string;projectId:string;clientId:string;readClientId:string;credentialRef:string|null;index:string;host:string;port:string;timeoutMs:string};
export type SystemSettingsServiceDraft={connections:SystemSettingsServiceDraftConnection[]};
export type SystemSettingsDraftMap={mail:SystemSettingsMailDraft;'service-connections':SystemSettingsServiceDraft};
export type SystemSettingsConsumer={target:string;state:'configured'|'not-configured'|'unavailable'|'unknown';adoptedVersionId:string|null;connectionId:string|null;source:'operations-database'|'native-keycloak'|'native-alertmanager'|'protected-runtime'|'consumer-ack'|'not-connected';configured:boolean|null};
export type SystemSettingsCredential={reference:string;connectionId:string;configured:boolean};
export type SystemSettingsSectionValue<K extends SystemSettingsSection>=SystemSettingsLease&{
 section:K;revision:number;version:SystemSettingsVersion<K extends 'mail'?SystemSettingsMailConfiguration:SystemSettingsServiceConfiguration>|null;
 configuration:K extends 'mail'?SystemSettingsMailConfiguration:SystemSettingsServiceConfiguration;
 configurationBasis:'saved-version'|'observed-current'|'empty';availability:{state:'available'|'unavailable'|'not-configured'};
 current:SystemSettingsConsumer[];credentials:SystemSettingsCredential[];pending:SystemSettingsOperation|null;capabilities:SystemSettingsCapabilities;
};
export type SystemSettingsMail=SystemSettingsSectionValue<'mail'>;
export type SystemSettingsServices=SystemSettingsSectionValue<'service-connections'>;
export type SystemSettingsOverview=SystemSettingsLease&{sections:{mail:SystemSettingsMail;'service-connections':SystemSettingsServices}};
export type SystemSettingsDraftEntry<T>={revision:number;base:T;draft:T};
export type AutonomyRuntimeFields={concurrency:string;healthSeconds:string;startGraceSeconds:string;roundSeconds:string;eventCoalesceSeconds:string};
export type AutonomyRuntimeChoices={revision:number;fields:Partial<Record<keyof AutonomyRuntimeFields,'mine'|'current'>>};
export type SystemSettingsGeneralConfiguration={siteTitle:string;description:string;footerLinks:{label:string;href:string}[]};
export type SystemSettingsGeneral=SystemSettingsLease&{section:'general';revision:number;configuration:SystemSettingsGeneralConfiguration;version:SystemSettingsVersion<SystemSettingsGeneralConfiguration>|null;publication:{id:string|null;state:'available'|'unavailable'};capabilities:{canRead:boolean;canSave:boolean;canApply:boolean;canReplaceLogo:false};logo?:{href:string;source:'fixed-brand-asset';canReplace:false};favicon?:{href:string;source:'fixed-brand-asset';canReplace:false}};
export type SystemSettingsMemorySnapshot={
 general:SystemSettingsDraftEntry<SystemSettingsGeneralConfiguration>|null;
 runtime?:SystemSettingsDraftEntry<AutonomyRuntimeFields>|null;runtimeChoices?:AutonomyRuntimeChoices|null;
 entries:{mail:SystemSettingsDraftEntry<SystemSettingsMailDraft>|null;'service-connections':SystemSettingsDraftEntry<SystemSettingsServiceDraft>|null};
 choices:Partial<Record<SystemSettingsCommandSection,{revision:number;fields:Record<string,'mine'|'current'>}>>;
 selectedMail:string;selectedService:SystemSettingsServiceKind;positions:Partial<Record<SystemSettingsTab,{left:number;right:number}>>;
};
