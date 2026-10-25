import type {SystemSettingsMemorySnapshot} from '../components/system-settings-types';
import {systemSettingsMemorySnapshot} from './system-settings-view-model';
import {permissionDraftSnapshot,permissionPendingReceipt} from './permissions-draft-memory';
import type {PermissionDraftSnapshot} from './permissions-draft-memory';
import {registeredUsersDraftSnapshot,registeredUsersPendingReceipt} from './registered-users-draft-memory';
import type {RegisteredUsersDraftSnapshot} from './registered-users-draft-memory';
import {businessUsersDraftSnapshot,businessUserPendingReceipt} from './business-users-draft-memory';
import type {BusinessUsersDraftSnapshot} from './business-users-draft-memory';
import {feedbackDraftSnapshot,feedbackPendingReceipt} from './feedback-draft-memory';
import type {FeedbackDraftSnapshot} from './feedback-draft-memory';
import type {ModelSettingsConfiguration} from '../components/model-settings-types';
import type {StrategiesDraft,StrategyConfiguration} from '../components/strategies-types';
import type {SmtpDraft,SmtpMergeChoices} from './smtp-view-model';
import type {SmtpCredential} from '../components/smtp-types';
import type {RecommendationThemePolicyDraft,RecommendationGlobalPolicyDraft} from './recommendation-view-model';
import type {RecommendationThemeDraft} from '../components/recommendation-types';
import type {SearchQualityDraft} from '../components/search-quality-types';
import type {RulesDraft,RulesKey} from '../components/rules-types';
import type {MessageDraft} from '../components/messaging-types';
import type {ManagementActionDraft,ManagementCreateDraft,ManagementProfileDraft} from '../components/management-accounts-types';
import type {AiWorkDomain,AiWorkProfileDraft} from '../components/ai-work-accounts-types';
import type {AiDelegationDraft,AiDelegationFields} from '../components/ai-delegation-types';
import {aiDelegationActionKeys} from '../components/ai-delegation-types';
import type {AutonomyConfig,AutonomyDutyDraft} from '../components/autonomy-types';

export const settingsDraftScopes=['models','strategies','smtp','recommendation','rules','search','messaging','maintenance','management','ai-work','system-settings','permissions','registered-users','business-users','feedback'] as const;
export type SettingsDraftScope=typeof settingsDraftScopes[number];
/** Only authored state and its base. No API response, component tree, key input,
 * receipt body or authentication value is a page snapshot. */
export type SettingsDraftSnapshots={
 models:{configuration:ModelSettingsConfiguration;baseConfiguration:ModelSettingsConfiguration;baseRevision:number|null;selected:string;positions:Record<string,number>};
 strategies:{draft:StrategiesDraft|null;base:StrategyConfiguration|null;reasons:Record<string,string>;positions:[string,[number,number]][]};
 smtp:{draft:SmtpDraft|null;base:{version:number;draft:SmtpDraft;credentials:SmtpCredential[]}|null;choices:SmtpMergeChoices;positions:Record<string,{main:number;aside:number}>};
 recommendation:{policies:Record<string,RecommendationThemePolicyDraft>;global:RecommendationGlobalPolicyDraft|null;themes:Record<string,RecommendationThemeDraft>;mappingOpen:Record<string,boolean>;positions:[string,[number,number]][];tablePositions:[string,number][]};
 search:{draft:SearchQualityDraft|null;reasons:Record<string,string>;positions:[string,[number,number]][]};
 rules:{drafts:Partial<Record<RulesKey,RulesDraft>>;positions:Record<string,number>};
 messaging:{drafts:Record<string,MessageDraft>;bases:Record<string,MessageDraft>;editing:Record<string,boolean>};
 maintenance:{drafts:Record<string,{scope:'whole-site'|'selected-modules';moduleIds:string[]}>;positions:Record<string,number>};
 management:{createDraft:ManagementCreateDraft;profileDrafts:Record<string,ManagementProfileDraft>;actionDrafts:Record<string,ManagementActionDraft>;editing:Record<string,boolean>;roleChoice:Record<string,string>;mergeChoices:Record<string,{version:string;fields:Partial<Record<'firstName'|'lastName'|'note','mine'|'current'>>}>;tablePositions:[string,number][];detailPositions:[string,number][]};
 'system-settings':SystemSettingsMemorySnapshot;
 permissions:PermissionDraftSnapshot;
 'registered-users':RegisteredUsersDraftSnapshot;
 'business-users':BusinessUsersDraftSnapshot;
 feedback:FeedbackDraftSnapshot;
 'ai-work':{drafts:Partial<Record<AiWorkDomain,AiWorkProfileDraft>>;dutyDrafts?:Partial<Record<AiWorkDomain,AutonomyDutyDraft>>;delegationDraft?:AiDelegationDraft|null;editing:Partial<Record<AiWorkDomain,boolean>>;roleChoice:Partial<Record<AiWorkDomain,string>>;positions:[string,number][]};
};
const pendingKinds={models:['credential-provision','draft','apply'],strategies:['draft','rehearsal','publish','control','run','continue'],smtp:['settings','test.connection','test.delivery'],recommendation:['policy','theme'],rules:['draft','publish','restore'],search:['draft','apply','restore'],messaging:['create','save','activate','pause','resume','stop','withdraw','retry'],maintenance:['create','verify','plan','approve','execute','cancel'],management:['create','profile-update','login-disable','login-restore','password-reset','sessions-revoke','delete','admission-change','email-change','assignment-save'],'ai-work':['profile-save','state-save','assignment-save','config-save','delegation-save'],'system-settings':['autonomy.settings','general.save','general.apply','mail.save','mail.test','mail.apply','mail.credential','service-connections.save','service-connections.test','service-connections.apply','service-connections.credential'],permissions:['role-save','assignment-save','automation-save'],'registered-users':['password-reset','login-disable','login-restore','sessions-revoke','profile-correct','profile-preset'],'business-users':['type-change','restriction-set','restriction-release'],feedback:['event']} as const;
const snapshotFields={models:['configuration','baseConfiguration','baseRevision','selected','positions'],strategies:['draft','base','reasons','positions'],smtp:['draft','base','choices','positions'],recommendation:['policies','global','themes','mappingOpen','positions','tablePositions'],search:['draft','reasons','positions'],rules:['drafts','positions'],messaging:['drafts','bases','editing'],maintenance:['drafts','positions'],management:['createDraft','profileDrafts','actionDrafts','editing','roleChoice','mergeChoices','tablePositions','detailPositions'],'ai-work':['drafts','dutyDrafts','delegationDraft','editing','roleChoice','positions'],'system-settings':['general','runtime','runtimeChoices','entries','choices','selectedMail','selectedService','positions']} as const;
export type SettingsPendingReceipt={operationId:string;kind:string;targetOperatorId?:string|null;domain?:AiWorkDomain;versionId?:string;expectedRevision?:number;connectionId?:string;resourceId?:string|null;expectedVersion?:number;draftKey?:string;roleId?:string;registrationId?:string;accountId?:string;feedbackId?:string};
type Entry={draft?:unknown;pending?:SettingsPendingReceipt};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const managementId=/^[a-f0-9]{64}$/;
const aiDomains=['overview','governance','messaging','discovery','maintenance'] as const;
export function settingsSystemReceiptPath(value:SettingsPendingReceipt):string|null{
 if(!uuid.test(value.operationId)||!(pendingKinds['system-settings'] as readonly string[]).includes(value.kind)
  ||value.versionId!==undefined&&!uuid.test(value.versionId)
  ||value.connectionId!==undefined&&(!value.kind.endsWith('.credential')||!uuid.test(value.connectionId))
  ||value.expectedRevision!==undefined&&(!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0||value.expectedRevision>2147483646))return null;
 if(value.kind==='autonomy.settings'&&(value.versionId!==undefined||value.connectionId!==undefined||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<1))return null;
 return (value.kind==='autonomy.settings'?'/v1/operations/autonomy/operations/':value.kind.startsWith('general.')?'/api/system-settings/general/operations/':'/v1/operations/system-settings/operations/')+value.operationId;
}
function aiWorkSnapshot(value:Record<string,unknown>):SettingsDraftSnapshots['ai-work']{
 const object=(input:unknown):Record<string,unknown>=>input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
 const visit=(node:unknown)=>{if(!node||typeof node!=='object')return;for(const[key,child]of Object.entries(node)){if(/password|credential|^(?:body|requestBody|rawBody|token|secret)$/i.test(key))throw Error('Excluded AI work snapshot field');visit(child);}};visit(value);
 const text=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):'',drafts:SettingsDraftSnapshots['ai-work']['drafts']={},editing:SettingsDraftSnapshots['ai-work']['editing']={},roleChoice:SettingsDraftSnapshots['ai-work']['roleChoice']={};
 for(const domain of aiDomains){
  const row=object(object(value.drafts)[domain]);if(Number.isSafeInteger(row.baseVersion)&&Number(row.baseVersion)>=1)drafts[domain]={name:text(row.name,100),description:text(row.description,1000),reason:text(row.reason,1000),baseName:text(row.baseName,100),baseDescription:text(row.baseDescription,1000),baseVersion:Number(row.baseVersion)};
  const flag=object(value.editing)[domain];if(typeof flag==='boolean')editing[domain]=flag;
  const choice=object(value.roleChoice)[domain];if(typeof choice==='string'&&(choice===''||uuid.test(choice)))roleChoice[domain]=choice;
 }
 const positions:[string,number][]=Array.isArray(value.positions)?value.positions.flatMap(row=>Array.isArray(row)&&typeof row[0]==='string'&&row[0].length<=100&&typeof row[1]==='number'&&Number.isFinite(row[1])&&row[1]>=0?[[row[0],row[1]] as [string,number]]:[]):[];
 const dutyDrafts:Partial<Record<AiWorkDomain,AutonomyDutyDraft>>={};
 const configuration=(input:unknown,domain:AiWorkDomain):AutonomyConfig|null=>{
  const row=object(input),schedule=object(row.schedule),plan=object(row.plan);
  if(row.domain!==domain||typeof row.id!=='string'||!uuid.test(row.id)||!Number.isSafeInteger(row.revision)||Number(row.revision)<0||typeof row.enabled!=='boolean'||!['code','ai','ai-human','human-ai'].includes(String(row.mode))||!['interval','daily'].includes(String(schedule.kind)))return null;
  if(schedule.kind==='interval'&&(!Number.isFinite(schedule.minutes)||Number(schedule.minutes)<0)||schedule.kind==='daily'&&schedule.at!==null&&!(typeof schedule.at==='string'&&/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(schedule.at)))return null;
  const ids=(input:unknown)=>Array.isArray(input)?[...new Set(input.filter((id):id is string=>typeof id==='string'&&uuid.test(id)))].slice(0,200):[];
  const codes=(input:unknown)=>Array.isArray(input)?[...new Set(input.filter((id):id is string=>typeof id==='string'&&/^[a-z][a-z0-9_.:-]{0,159}$/.test(id)))].slice(0,200):[];
  return {id:row.id,domain,revision:Number(row.revision),enabled:row.enabled,mode:row.mode as AutonomyConfig['mode'],schedule:schedule.kind==='interval'?{kind:'interval',minutes:Number(schedule.minutes),timezone:'Asia/Shanghai'}:{kind:'daily',at:schedule.at as string|null,timezone:'Asia/Shanghai'},purpose:text(row.purpose,2400),goal:text(row.goal,4000),prompt:text(row.prompt,16000),promptVersion:Number(row.promptVersion)||0,planVersion:Number(row.planVersion)||0,delegationVersion:typeof row.delegationVersion==='number'?row.delegationVersion:null,nextDueAt:null,plan:{strategyIds:ids(plan.strategyIds),grantIds:ids(plan.grantIds),actions:codes(plan.actions),resourceIds:ids(plan.resourceIds),eventTypes:codes(plan.eventTypes)}};
 };
 for(const domain of aiDomains){const row=object(object(value.dutyDrafts)[domain]),local=configuration(row.configuration,domain),base=configuration(row.base,domain);if(local&&base)dutyDrafts[domain]={configuration:local,base};}
 const delegationFields=(input:unknown):AiDelegationFields=>{const row=object(input);return {enabled:row.enabled===true,targetAiAccountIds:Array.isArray(row.targetAiAccountIds)?row.targetAiAccountIds.filter((id):id is string=>typeof id==='string'&&uuid.test(id)).slice(0,4):[],grantablePermissions:Array.isArray(row.grantablePermissions)?row.grantablePermissions.filter((code):code is string=>typeof code==='string'&&/^[a-z][a-z0-9_.:-]{0,159}$/.test(code)).slice(0,500):[],allowedManagementActions:Array.isArray(row.allowedManagementActions)?row.allowedManagementActions.filter((kind):kind is AiDelegationFields['allowedManagementActions'][number]=>typeof kind==='string'&&(aiDelegationActionKeys as readonly string[]).includes(kind)):[]};};
 const delegationValue=object(value.delegationDraft),delegationDraft=Number.isSafeInteger(delegationValue.baseVersion)&&Number(delegationValue.baseVersion)>=0?{...delegationFields(delegationValue),baseVersion:Number(delegationValue.baseVersion),baseline:delegationFields(delegationValue.baseline)}:null;
 return{drafts,editing,roleChoice,positions,...(Object.hasOwn(value,'dutyDrafts')?{dutyDrafts}:{}),...(Object.hasOwn(value,'delegationDraft')?{delegationDraft}:{})};
}
export function settingsAiWorkReceiptPath(value:SettingsPendingReceipt):string|null{
 return uuid.test(value.operationId)&&(pendingKinds['ai-work'] as readonly string[]).includes(value.kind)&&aiDomains.some(domain=>domain===value.domain)?(value.kind==='config-save'?'/v1/operations/autonomy/operations/':value.kind==='delegation-save'?'/v1/operations/permissions/ai-delegation/operations/':'/v1/operations/ai-work-accounts/operations/')+value.operationId:null;
}
function managementSnapshot(value:Record<string,unknown>):SettingsDraftSnapshots['management']{
 const visit=(node:unknown)=>{if(!node||typeof node!=='object')return;for(const[key,child]of Object.entries(node)){if(/^(?:.*password.*|.*credential.*|apiKeys?|authorization|cookie|csrfToken|storageState|rawBody|requestBody|body)$/i.test(key))throw Error('Excluded management snapshot field');visit(child);}};visit(value);
 const object=(input:unknown):Record<string,unknown>=>input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
 const text=(input:unknown,max:number)=>typeof input==='string'?input.slice(0,max):'';
 const records=<T>(input:unknown,project:(row:Record<string,unknown>)=>T|null):Record<string,T>=>{const result:Record<string,T>={};for(const[id,row]of Object.entries(object(input)))if(managementId.test(id)){const next=project(object(row));if(next!==null)result[id]=next;}return result;};
 const create=object(value.createDraft),createDraft={username:text(create.username,100),firstName:text(create.firstName,100),lastName:text(create.lastName,100),note:text(create.note,1000),roleIds:Array.isArray(create.roleIds)?[...new Set(create.roleIds.filter((id):id is string=>typeof id==='string'&&uuid.test(id)))].slice(0,100):[]};
 const profileDrafts=records<ManagementProfileDraft>(value.profileDrafts,row=>typeof row.targetVersion==='string'&&managementId.test(row.targetVersion)?{firstName:text(row.firstName,100),lastName:text(row.lastName,100),note:text(row.note,1000),reason:text(row.reason,1000),targetVersion:row.targetVersion,baseFirstName:text(row.baseFirstName,100),baseLastName:text(row.baseLastName,100),baseNote:text(row.baseNote,1000)}:null);
 const actionKinds=['login-disable','login-restore','password-reset','sessions-revoke','delete','admission-change','email-change'];
 const actionDrafts=records<ManagementActionDraft>(value.actionDrafts,row=>actionKinds.includes(text(row.kind,40))&&typeof row.targetVersion==='string'&&managementId.test(row.targetVersion)?{kind:row.kind as ManagementActionDraft['kind'],reason:text(row.reason,1000),targetVersion:row.targetVersion,newEmail:text(row.newEmail,320),action:row.action==='demote'?'demote':'promote',confirmed:row.confirmed===true}:null);
 const editing:Record<string,boolean>={};
 for(const[id,flag]of Object.entries(object(value.editing)))if(managementId.test(id)&&typeof flag==='boolean')editing[id]=flag;
 const roleChoice:Record<string,string>={};for(const[id,role]of Object.entries(object(value.roleChoice)))if(managementId.test(id)&&typeof role==='string'&&(role===''||uuid.test(role)))roleChoice[id]=role;
 const mergeChoices=records<SettingsDraftSnapshots['management']['mergeChoices'][string]>(value.mergeChoices,row=>{
  if(typeof row.version!=='string'||!managementId.test(row.version))return null;const fields:Partial<Record<'firstName'|'lastName'|'note','mine'|'current'>>={};for(const[field,choice]of Object.entries(object(row.fields)))if(['firstName','lastName','note'].includes(field)&&(choice==='mine'||choice==='current'))fields[field as keyof typeof fields]=choice;return {version:row.version,fields};
 });
 const positions=(input:unknown):[string,number][]=>Array.isArray(input)?input.flatMap(row=>Array.isArray(row)&&typeof row[0]==='string'&&row[0].length<=2048&&typeof row[1]==='number'&&Number.isFinite(row[1])&&row[1]>=0?[[row[0],row[1]] as [string,number]]:[]):[];
 return {createDraft,profileDrafts,actionDrafts,editing,roleChoice,mergeChoices,tablePositions:positions(value.tablePositions),detailPositions:positions(value.detailPositions)};
}
export function settingsManagementReceiptPath(value:SettingsPendingReceipt):string|null{
 if(!uuid.test(value.operationId)||!(pendingKinds.management as readonly string[]).includes(value.kind))return null;
 if(value.kind==='create'?value.targetOperatorId!==null:typeof value.targetOperatorId!=='string'||!managementId.test(value.targetOperatorId))return null;
 return value.kind==='assignment-save'?'/v1/operations/management-accounts/'+value.targetOperatorId+'/assignments/operations/'+value.operationId:'/v1/operations/management-accounts/operations/'+value.operationId;
}
function snapshotCopy(scope:SettingsDraftScope,value:unknown){
 const visit=(node:unknown)=>{if(!node||typeof node!=='object')return;for(const[key,child]of Object.entries(node)){if(/^(?:apiKeys?|authorization|cookie|csrfToken|storageState)$/i.test(key))throw Error('Excluded settings snapshot field');visit(child);}};
 visit(value);if(!value||typeof value!=='object')throw Error('Invalid settings snapshot');
 const row=value as Record<string,unknown>;if(scope==='feedback')return feedbackDraftSnapshot(row);if(scope==='business-users')return businessUsersDraftSnapshot(row);if(scope==='registered-users')return registeredUsersDraftSnapshot(row);if(scope==='permissions')return permissionDraftSnapshot(row);if(scope==='system-settings')return systemSettingsMemorySnapshot(row);if(scope==='ai-work')return aiWorkSnapshot(row);if(scope==='management')return managementSnapshot(row);return structuredClone(Object.fromEntries(snapshotFields[scope].map(key=>[key,row[key]])));
}
export function settingsOperatorId(user:unknown):string|null{
 if(!user||typeof user!=='object')return null;const row=user as Record<string,unknown>;
 // The SSR principal has a verified marker; Payload me keeps the authenticated
 // strategy instead of non-stored fields. Neither a CMS id nor an unmarked
 // same-shaped object identifies the owner of a settings memory session.
 const authenticated=row._strategy==='galaxy-operations-session'||row._strategy===undefined&&row.verifiedOperator===true;
 return row.collection==='operators'&&authenticated&&typeof row.externalId==='string'&&row.externalId?row.externalId:null;
}
export type SettingsDraftSession={
 generation:number;current:()=>boolean;
 read:<K extends SettingsDraftScope>(scope:K)=>SettingsDraftSnapshots[K]|null;
 write:<K extends SettingsDraftScope>(scope:K,value:SettingsDraftSnapshots[K])=>void;
 clear:(scope:SettingsDraftScope)=>void;
 pending:(scope:SettingsDraftScope)=>SettingsPendingReceipt|null;
 setPending:(scope:SettingsDraftScope,value:SettingsPendingReceipt|null)=>void;
};
/** A single login's closed page memory. Nothing touches storage, files,
 * network or history. Old handles cannot repopulate memory after logout/reset. */
export function createSettingsDraftMemory(){
 let identity:string|null=null,token:string|null=null,generation=0,handle:SettingsDraftSession|null=null;
 const pages=new Map<SettingsDraftScope,Entry>();
 const clearAll=()=>{pages.clear();token=null;handle=null;generation++;};
 function observeIdentity(next:string|null){if(next!==identity){clearAll();identity=next;}else if(!next)clearAll();}
 function open(operatorId:string,csrfToken:string):SettingsDraftSession|null{
  if(!operatorId||!csrfToken)return null;observeIdentity(operatorId);
  if(token!==csrfToken){clearAll();token=csrfToken;}
  if(handle)return handle;
  const captured=generation,current=()=>captured===generation&&identity===operatorId&&token===csrfToken;
  function entry(scope:SettingsDraftScope){if(!settingsDraftScopes.includes(scope))throw Error('Unknown settings draft scope');return pages.get(scope)??{};}
  handle={generation:captured,current,
   read:scope=>{if(!current())return null;const value=entry(scope).draft;return value===undefined?null:structuredClone(value) as SettingsDraftSnapshots[typeof scope];},
   write:(scope,value)=>{if(!current())return;const old=entry(scope),copy=snapshotCopy(scope,value);if(JSON.stringify(old.draft)!==JSON.stringify(copy))pages.set(scope,{...old,draft:copy});},
   clear:scope=>{if(!current())return;const old=entry(scope);if(old.pending)pages.set(scope,{pending:old.pending});else pages.delete(scope);},
   pending:scope=>current()?structuredClone(entry(scope).pending??null):null,
   setPending:(scope,value)=>{if(!current())return;const old=entry(scope);if(value){if(!uuid.test(value.operationId)||!(pendingKinds[scope] as readonly string[]).includes(value.kind))throw Error('Invalid settings pending receipt');
    if(scope==='system-settings'&&(!settingsSystemReceiptPath(value)||Object.keys(value).some(key=>!['operationId','kind','versionId','expectedRevision','connectionId'].includes(key))))throw Error('Invalid system settings receipt');
    if(scope==='management'&&(!settingsManagementReceiptPath(value)||Object.keys(value).some(key=>!['operationId','kind','targetOperatorId'].includes(key))))throw Error('Invalid management pending receipt');
    if(scope==='ai-work'&&(!settingsAiWorkReceiptPath(value)||Object.keys(value).some(key=>!['operationId','kind','domain'].includes(key))))throw Error('Invalid AI work pending receipt');
    if(scope==='feedback'){const locator=feedbackPendingReceipt(value);if(!locator)throw Error('Invalid feedback pending receipt');pages.set(scope,{...old,pending:locator});return;}
    if(scope==='business-users'){const locator=businessUserPendingReceipt(value);if(!locator)throw Error('Invalid business-user pending receipt');pages.set(scope,{...old,pending:locator});return;}
    if(scope==='registered-users'){const locator=registeredUsersPendingReceipt(value);if(!locator)throw Error('Invalid registered user pending receipt');pages.set(scope,{...old,pending:locator});return;}
    if(scope==='permissions'){const locator=permissionPendingReceipt(value);if(!locator)throw Error('Invalid permissions pending receipt');pages.set(scope,{...old,pending:locator});return;}
    pages.set(scope,{...old,pending:{operationId:value.operationId.toLowerCase(),kind:value.kind,...(scope==='management'?{targetOperatorId:value.targetOperatorId}:scope==='ai-work'?{domain:value.domain}: {}),...(scope==='system-settings'?{...(value.versionId?{versionId:value.versionId}:{}),...(value.expectedRevision!==undefined?{expectedRevision:value.expectedRevision}:{}),...(value.connectionId?{connectionId:value.connectionId}:{})}:{})}});
   }else if(old.draft!==undefined)pages.set(scope,{draft:old.draft});else pages.delete(scope);}
  };
  return handle;
 }
 return {open,observeIdentity,clear:()=>{clearAll();identity=null;}};
}
export const settingsDraftMemory=createSettingsDraftMemory();
