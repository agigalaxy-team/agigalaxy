export type AiWorkPromptSource='saved-configuration'|'empty-default';
export const aiWorkPromptSourceLabel=(source:AiWorkPromptSource)=>source==='saved-configuration'?'岗位已保存配置':'当前岗位版本未填写';

export type WorkbenchAiPromptReview={kind:'ai-work-prompt';aiAccountId:string;domain:'governance'|'messaging'|'discovery'|'maintenance';name:string;configId:string;expectedRevision:number;promptVersion:number;nextPromptVersion:number;scope:'role-work-requirements';source:AiWorkPromptSource;before:string;after:string;effect:'new-rounds-only'};
export type WorkbenchAiPromptReceipt={operationId:string;aiAccountId:string;configId:string;revision:number;promptVersion:number;delegationVersion:number;replayed:boolean};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const version=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
export function workbenchAiPromptReview(value:unknown):WorkbenchAiPromptReview|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const row=value as Record<string,unknown>;
 if(row.kind!=='ai-work-prompt'||!uuid(row.aiAccountId)||!uuid(row.configId)||(typeof row.domain!=='string'||!['governance','messaging','discovery','maintenance'].includes(row.domain))||typeof row.name!=='string'||row.name.length>100||!version(row.expectedRevision)||!version(row.promptVersion)||!version(row.nextPromptVersion)||row.scope!=='role-work-requirements'||(typeof row.source!=='string'||!['saved-configuration','empty-default'].includes(row.source))||typeof row.before!=='string'||row.before.length>16000||typeof row.after!=='string'||row.after.length>16000||row.effect!=='new-rounds-only')return null;
 return {kind:'ai-work-prompt',aiAccountId:row.aiAccountId,domain:row.domain as WorkbenchAiPromptReview['domain'],name:row.name,configId:row.configId,expectedRevision:row.expectedRevision,promptVersion:row.promptVersion,nextPromptVersion:row.nextPromptVersion,scope:'role-work-requirements',source:row.source as AiWorkPromptSource,before:row.before,after:row.after,effect:'new-rounds-only'};
}
export function workbenchAiPromptReceipt(value:unknown,operationId:string,review:WorkbenchAiPromptReview|null):WorkbenchAiPromptReceipt|null{
 if(!value||typeof value!=='object'||Array.isArray(value)||!review)return null;
 const row=value as Record<string,unknown>;
 if(row.operationId!==operationId||row.aiAccountId!==review.aiAccountId||row.configId!==review.configId||!version(row.revision)||!version(row.promptVersion)||!version(row.delegationVersion)||typeof row.replayed!=='boolean')return null;
 return {operationId,aiAccountId:row.aiAccountId as string,configId:row.configId as string,revision:row.revision,promptVersion:row.promptVersion,delegationVersion:row.delegationVersion,replayed:row.replayed};
}
