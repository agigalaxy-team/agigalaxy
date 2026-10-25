export type ModelSettingsDomain='overview'|'governance'|'messaging'|'discovery'|'maintenance';
export type ModelSettingsFormat='openai-chat'|'openai-responses'|'anthropic'|'gemini';
export type ModelSettingsEffort='none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export type ModelSettingsTab='models'|'scenarios'|'usage';
export type ModelSettingsLocation={tab:ModelSettingsTab;id:string;days:7|30;historyAfter:string;historyTrail:string[]};
export type ModelSettingsModel={
 id:string;displayName:string;modelId:string|null;apiFormat:ModelSettingsFormat;baseUrl:string|null;credentialRef:string|null;
 contextWindow:number|null;maxOutputTokens:number|null;timeoutSeconds:number|null;
 reasoning:{mode:'default'|'effort';effort:ModelSettingsEffort|null;supportedEfforts:ModelSettingsEffort[];supportSource:'manual'};
 toolCalling:boolean;structuredOutput:boolean;enabled:boolean;
};
export type ModelSettingsBinding={modelId:string;dataPolicyApproved:boolean}|null;
export type ModelSettingsConfiguration={models:ModelSettingsModel[];scenarios:Record<ModelSettingsDomain,ModelSettingsBinding>};
export type ModelSettingsVersion={id:string;version:number;configuration:ModelSettingsConfiguration;operatorId:string;createdAt:string};
export type ModelSettingsPhase='prepared'|'submitting'|'pending'|'applied'|'failed'|'result-unknown';
export type ModelSettingsOperation={operationId:string;kind:'draft'|'apply'|'credential-provision';phase:ModelSettingsPhase;versionId:string|null;modelRecordId:string|null;credentialRef:string|null;errorCode:string|null;replayed:boolean;recordedAt:string;updatedAt:string;revision?:number};
export type ModelSettingsEnvelope={checkedAt:number;readExpiresAt:number;metadataOnly:true};
export type ModelSettingsEngineState='available'|'ready'|'running'|'configured'|'not-configured'|'unavailable'|'unknown';
export type ModelSettingsNative={
 availability:{state:'available'|'unavailable'};configurationVersion:string|null;appliedVersionId:string|null;
 engines:{gateway:{state:ModelSettingsEngineState;configurationVersion:string|null;modelCount:number|null};agentos:{state:ModelSettingsEngineState;configurationVersion:string|null;configuredScenarios:ModelSettingsDomain[]}};
 credentials:{reference:string;modelRecordId:string;configured:boolean}[];
 operation?:{id:string;kind:'models-apply'|'models-credential-provision';state:'accepted'|'running'|'completed'|'failed'|'unknown';code:string|null;credentialRef?:string;startedAt:string|null;finishedAt:string|null};
};
export type ModelSettingsOverview=ModelSettingsEnvelope&{
 revision:number;active:ModelSettingsVersion|null;draft:ModelSettingsVersion|null;pending:ModelSettingsOperation|null;native:ModelSettingsNative|null;
 capabilities:{canConfigure:boolean;canProvisionCredentials:boolean;canApply:boolean};formats:ModelSettingsFormat[];domains:ModelSettingsDomain[];
 basis:{management:'human-only';providerSecrets:'protected-native-only';modelContact:'not-checked';capabilitySource:'manual-declaration';temperature:'not-configurable';billing:'not-provided'};
};
export type ModelSettingsOperationResult=ModelSettingsOperation&ModelSettingsEnvelope;
export type ModelSettingsHistoryItem=ModelSettingsOperation&{
 sequence:string;operatorId:string;operatorDisplayName:string|null;version:number|null;reason:string|null;
 changes:{models:{id:string;kind:'added'|'removed'|'changed';fields:{field:string;before:unknown;after:unknown}[]}[];scenarios:{domain:ModelSettingsDomain;before:ModelSettingsBinding;after:ModelSettingsBinding}[]};
};
export type ModelSettingsHistory=ModelSettingsEnvelope&{items:ModelSettingsHistoryItem[];nextAfter:string|null};
export type ModelSettingsCalls={total:number|null;completed:number|null;failed:number|null;unknown:number|null};
export type ModelSettingsTokens={input:number|null;output:number|null;total:number|null;cachedInput:number|null;reasoning:number|null};
export type ModelSettingsUsage=ModelSettingsEnvelope&{
 availability:{state:'available'|'unavailable'};days:7|30;from:string|null;to:string|null;coverageFrom:string|null;coversWholeWindow:boolean|null;
 calls:ModelSettingsCalls;tokens:ModelSettingsTokens;unknownUsageCalls:number|null;
 byScenario:{domain:ModelSettingsDomain;calls:ModelSettingsCalls;tokens:ModelSettingsTokens;unknownUsageCalls:number|null}[];
 byModel:{modelRecordId:string;calls:ModelSettingsCalls;tokens:ModelSettingsTokens;unknownUsageCalls:number|null}[];
 basis:{source:'native-model-gateway-ledger'|'not-connected';billing:'not-provided'};
};
