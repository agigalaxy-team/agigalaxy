import type {AccountType,BusinessUserOperationAction,BusinessUserOperationReceipt,BusinessUserOperationSelection,BusinessUserWriteResult,UserDetail} from "../../components/business-types";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max?value:'';
const type=(value:unknown):value is AccountType=>value===null||['person','organization','agent'].includes(String(value));
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&/([zZ]|[+-]\d\d:\d\d)$/.test(value);
const exact=(row:Record<string,unknown>,keys:string[])=>Object.keys(row).length===keys.length&&Object.keys(row).every(key=>keys.includes(key));
const actions=['type-change','restriction-set','restriction-release'] as const;
export type BusinessUserDraft={typeReason:string;basis:string;nextType:AccountType;typeBase:AccountType;profileRevision:number;restrictionReason:string;days:'1'|'7'|'30';restrictionRevision:number;restrictionActive:boolean};
export type BusinessUsersDraftSnapshot={drafts:Record<string,BusinessUserDraft>};
export type BusinessUserPendingReceipt={operationId:string;kind:BusinessUserOperationAction;accountId:string;registrationId?:string};
export function businessUserEmptyDraft(current:UserDetail):BusinessUserDraft{return{typeReason:'',basis:'',nextType:current.account.subjectType,typeBase:current.account.subjectType,profileRevision:current.profile.revision,restrictionReason:'',days:'1',restrictionRevision:current.account.restriction.revision,restrictionActive:current.account.restriction.active};}
export const businessUserTypeDirty=(value:BusinessUserDraft)=>!!(value.typeReason||value.basis||value.nextType!==value.typeBase);
export const businessUserRestrictionDirty=(value:BusinessUserDraft)=>!!(value.restrictionReason||value.days!=='1');
export function businessUserReviewType(value:BusinessUserDraft,current:UserDetail,choice?:'mine'|'current'):BusinessUserDraft|null{
 const old=value.typeBase,source=current.account.subjectType,local=value.nextType,localChanged=local!==old,sourceChanged=source!==old;
 if(localChanged&&sourceChanged&&local!==source&&!choice)return null;
 return{...value,typeBase:source,nextType:choice==='current'||!localChanged?source:local,profileRevision:current.profile.revision};
}
export function businessUsersDraftSnapshot(input:unknown):BusinessUsersDraftSnapshot{
 const visit=(node:unknown)=>{if(!node||typeof node!=='object')return;for(const[key,value]of Object.entries(node)){if(/password|credential|^(?:body|requestBody|rawBody|token|secret|authorization|cookie|csrfToken|storageState)$/i.test(key))throw Error('Excluded business-user draft field');visit(value);}};visit(input);
 const drafts:Record<string,BusinessUserDraft>={};for(const[id,item]of Object.entries(object(object(input).drafts))){const row=object(item);if(!uuid.test(id)||!type(row.nextType)||!type(row.typeBase)||!integer(row.profileRevision)||!integer(row.restrictionRevision)||typeof row.restrictionActive!=='boolean'||!['1','7','30'].includes(String(row.days)))continue;
  drafts[id]={typeReason:text(row.typeReason,2000),basis:text(row.basis,4000),nextType:row.nextType,typeBase:row.typeBase,profileRevision:row.profileRevision,restrictionReason:text(row.restrictionReason,2000),days:row.days as BusinessUserDraft['days'],restrictionRevision:row.restrictionRevision,restrictionActive:row.restrictionActive};
 }return{drafts};
}
export function businessUserPendingReceipt(input:unknown):BusinessUserPendingReceipt|null{
 const row=object(input);if(Object.keys(row).some(key=>!['operationId','kind','accountId','registrationId'].includes(key))||typeof row.operationId!=='string'||!uuid.test(row.operationId)||typeof row.accountId!=='string'||!uuid.test(row.accountId)||!actions.includes(row.kind as BusinessUserOperationAction)||row.registrationId!==undefined&&(typeof row.registrationId!=='string'||!uuid.test(row.registrationId)))return null;
 return{operationId:row.operationId,kind:row.kind as BusinessUserOperationAction,accountId:row.accountId,...(typeof row.registrationId==='string'?{registrationId:row.registrationId}:{})};
}
export function businessUserReceiptPath(input:unknown):string|null{const row=businessUserPendingReceipt(input);return row?'/v1/operations/users/'+row.accountId+'/operations/'+row.operationId:null;}
export function businessUserCommandPath(accountId:string,action:BusinessUserOperationAction){return'/v1/operations/users/'+accountId+'/'+(action==='restriction-set'?'restriction':action==='restriction-release'?'restriction/release':'type-change');}
function selection(input:unknown,action:BusinessUserOperationAction):BusinessUserOperationSelection|null{
 const row=object(input),common=['operationId','expectedRevision','reason'],keys=action==='type-change'?[...common,'subjectType','basis','preserveHistory']:action==='restriction-set'?[...common,'until']:common;
 if(!exact(row,keys)||typeof row.operationId!=='string'||!uuid.test(row.operationId)||!integer(row.expectedRevision)||typeof row.reason!=='string'||row.reason!==row.reason.trim()||row.reason.length<(action==='type-change'?8:3)||row.reason.length>2000)return null;
 if(action==='type-change'&&(!type(row.subjectType)||row.subjectType===null||typeof row.basis!=='string'||row.basis!==row.basis.trim()||row.basis.length<8||row.basis.length>4000||row.preserveHistory!==true))return null;
 if(action==='restriction-set'&&!timestamp(row.until))return null;
 return{...row} as BusinessUserOperationSelection;
}
function restriction(input:unknown){const row=object(input);if(!exact(row,['scope','active','until','reason','revision'])||row.scope!=='community-participation'||typeof row.active!=='boolean'||!integer(row.revision)||row.until!==null&&!timestamp(row.until)||row.reason!==null&&(typeof row.reason!=='string'||row.reason.length>2000))return null;return{scope:'community-participation' as const,active:row.active,until:row.until as string|null,reason:row.reason as string|null,revision:row.revision};}
export function businessUserWriteResult(input:unknown,locator:BusinessUserPendingReceipt,expected:unknown):BusinessUserWriteResult|null{
 const row=object(input),chosen=selection(expected,locator.kind),common=['accountId','operationId','recordedAt'],allowed=locator.kind==='type-change'?[...common,'previousType','subjectType','revision','basisKind','permissionsChanged']:[...common,'before','restriction'];
 if(!chosen||Object.keys(row).some(key=>!allowed.includes(key)&&key!=='replayed')||!allowed.every(key=>Object.hasOwn(row,key))||row.replayed!==undefined&&typeof row.replayed!=='boolean'||row.accountId!==locator.accountId||row.operationId!==locator.operationId||chosen.operationId!==locator.operationId||!timestamp(row.recordedAt))return null;
 if(locator.kind==='type-change'){
  if(!type(row.previousType)||!type(row.subjectType)||row.subjectType===null||row.subjectType!==object(chosen).subjectType||row.revision!==chosen.expectedRevision+1||row.basisKind!=='operator-recorded-statement'||row.permissionsChanged!==false)return null;
  return{accountId:locator.accountId,operationId:locator.operationId,recordedAt:row.recordedAt,previousType:row.previousType,subjectType:row.subjectType,revision:Number(row.revision),basisKind:'operator-recorded-statement',permissionsChanged:false,...(row.replayed!==undefined?{replayed:row.replayed as boolean}:{})};
 }
 const before=restriction(row.before),after=restriction(row.restriction);if(!before||!after||before.revision!==chosen.expectedRevision||after.revision!==chosen.expectedRevision+1)return null;
 if(locator.kind==='restriction-set'?(Date.parse(after.until!)!==Date.parse(String(object(chosen).until))||after.reason!==chosen.reason||after.active!==true):(after.until!==null||after.reason!==null||after.active!==false))return null;
 return{accountId:locator.accountId,operationId:locator.operationId,recordedAt:row.recordedAt,before,restriction:after,...(row.replayed!==undefined?{replayed:row.replayed as boolean}:{})};
}
export function businessUserOriginalReceipt(input:unknown,locator:BusinessUserPendingReceipt,expected?:unknown,now=Math.floor(Date.now()/1000)):BusinessUserOperationReceipt|null{
 const row=object(input);if(!businessUserPendingReceipt(locator)||row.state!=='recorded'||row.operationId!==locator.operationId||row.accountId!==locator.accountId||row.action!==locator.kind||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.checkedAt>now+5||row.checkedAt>row.readExpiresAt||row.readExpiresAt<=now||!timestamp(row.recordedAt))return null;
 const chosen=selection(row.selection,locator.kind);if(!chosen||expected!==undefined&&(!selection(expected,locator.kind)||Object.keys(chosen).some(key=>object(chosen)[key]!==object(expected)[key])||Object.keys(object(expected)).length!==Object.keys(chosen).length))return null;
 const result=businessUserWriteResult(row.result,locator,chosen);if(!result||row.recordedAt!==result.recordedAt)return null;
 return{state:'recorded',operationId:locator.operationId,accountId:locator.accountId,action:locator.kind,selection:chosen,result,recordedAt:row.recordedAt,checkedAt:row.checkedAt,readExpiresAt:row.readExpiresAt,metadataOnly:true};
}

