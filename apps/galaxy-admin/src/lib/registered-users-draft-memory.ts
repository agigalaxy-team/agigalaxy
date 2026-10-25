import {accountAvatarKey} from '../../../../packages/galaxy-official/src/shared/account-profile-presentation.mjs';
import {registeredProfileDraftFields} from './registered-users-view-model';
import type {RegisteredCommandKind,RegisteredCommandReceipt,RegisteredCommandResult,RegisteredEffect,RegisteredUserDetail} from '../components/registered-users-types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const version=/^[a-f0-9]{64}$/;
const kinds=['password-reset','login-disable','login-restore','sessions-revoke','profile-correct','profile-preset'] as const;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const text=(value:unknown,max:number)=>typeof value==='string'?value.slice(0,max):'';
const nonnegative=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const kind=(value:unknown):value is RegisteredCommandKind=>typeof value==='string'&&(kinds as readonly string[]).includes(value);

export type RegisteredUsersDraft={kind:RegisteredCommandKind|null;reason:string;basis:string;displayName:string;originalDisplayName:string;avatarKey:string|null;originalAvatarKey:string|null;bio:string;originalBio:string;targetVersion:string;profileRevision:number|null};
export type RegisteredUsersDraftSnapshot={drafts:Record<string,RegisteredUsersDraft>;selectedKinds:Record<string,RegisteredCommandKind>;positions:[string,number][]};
export type RegisteredUsersPendingReceipt={operationId:string;kind:RegisteredCommandKind;registrationId:string};

/** Rebase authored fields only after a current read and an explicit review.
 * Concurrent changes to the same profile field need the operator's choice. */
export function registeredUsersRebaseDraft(draft:RegisteredUsersDraft,current:RegisteredUserDetail,choice?:'mine'|'current'):RegisteredUsersDraft|null{
 const currentFields=registeredProfileDraftFields(current),fields={displayName:currentFields.displayName,avatarKey:currentFields.avatarKey,bio:current.websiteProfile?.state==='available'?currentFields.bio:draft.originalBio};
 const authored={displayName:draft.displayName,avatarKey:draft.avatarKey,bio:draft.bio},before={displayName:draft.originalDisplayName,avatarKey:draft.originalAvatarKey,bio:draft.originalBio};
 if((draft.kind==='profile-correct'||draft.kind==='profile-preset')&&!choice&&Object.keys(fields).some(raw=>{const key=raw as keyof typeof fields;return authored[key]!==before[key]&&fields[key]!==before[key]&&authored[key]!==fields[key];}))return null;
 const next={...authored};if((draft.kind==='profile-correct'||draft.kind==='profile-preset'))for(const key of ['displayName','avatarKey','bio'] as const){if(choice==='current'||authored[key]===before[key])Object.assign(next,{[key]:fields[key]});}
 return{...draft,...next,originalDisplayName:fields.displayName,originalAvatarKey:fields.avatarKey,originalBio:fields.bio,targetVersion:current.targetVersion,profileRevision:currentFields.revision};
}

/** Only the operator's authored fields and their original base; never a server
 * response, credential, request body or authorization snapshot. */
export function registeredUsersDraftSnapshot(input:unknown):RegisteredUsersDraftSnapshot{
 const visit=(node:unknown)=>{if(!node||typeof node!=='object')return;for(const[key,child]of Object.entries(node)){if(/password|credential|^(?:body|requestBody|rawBody|token|secret|authorization|cookie|csrfToken|storageState)$/i.test(key))throw Error('Excluded registered user draft field');visit(child);}};visit(input);
 const row=object(input),drafts:Record<string,RegisteredUsersDraft>={},selectedKinds:Record<string,RegisteredCommandKind>={};
 for(const[key,value]of Object.entries(object(row.drafts))){const split=key.indexOf(':'),id=key.slice(0,split),action=key.slice(split+1),draft=object(value);if(!uuid.test(id)||!kind(action)||draft.kind!==action||typeof draft.targetVersion!=='string'||!version.test(draft.targetVersion)||draft.profileRevision!==null&&!nonnegative(draft.profileRevision))continue;
  drafts[key]={kind:action,reason:text(draft.reason,1000),basis:text(draft.basis,1000),displayName:text(draft.displayName,120),originalDisplayName:text(draft.originalDisplayName,120),avatarKey:accountAvatarKey(draft.avatarKey),originalAvatarKey:accountAvatarKey(draft.originalAvatarKey),bio:text(draft.bio,500),originalBio:text(draft.originalBio,500),targetVersion:draft.targetVersion,profileRevision:draft.profileRevision===null?null:Number(draft.profileRevision)};
 }
 for(const[id,value]of Object.entries(object(row.selectedKinds)))if(uuid.test(id)&&kind(value)&&drafts[id+':'+value])selectedKinds[id]=value;
 const positions:[string,number][]=Array.isArray(row.positions)?row.positions.flatMap(value=>Array.isArray(value)&&typeof value[0]==='string'&&value[0].length<=4096&&/^(list:|detail:)/.test(value[0])&&typeof value[1]==='number'&&Number.isFinite(value[1])&&value[1]>=0?[[value[0],value[1]] as [string,number]]:[]):[];
 return{drafts,selectedKinds,positions};
}

export function registeredUsersPendingReceipt(input:unknown):RegisteredUsersPendingReceipt|null{
 const row=object(input);if(Object.keys(row).some(key=>!['operationId','kind','registrationId'].includes(key))||typeof row.operationId!=='string'||!uuid.test(row.operationId)||typeof row.registrationId!=='string'||!uuid.test(row.registrationId)||!kind(row.kind))return null;
 return{operationId:row.operationId,kind:row.kind,registrationId:row.registrationId};
}
export function registeredUsersReceiptPath(input:unknown):string|null{const value=registeredUsersPendingReceipt(input);return value?'/v1/operations/registered-users/operations/'+value.operationId:null;}

function result(input:unknown):RegisteredCommandResult|null|undefined{
 if(input===null)return null;const row=object(input);if(row.passwordChanged!==false&&row.passwordChanged!==null||row.participationChanged!==false||!row.effects||typeof row.effects!=='object'||Array.isArray(row.effects))return undefined;
 const effects:RegisteredCommandResult['effects']={};
 for(const key of ['identity','ssoSessions','websiteSessions','profile'] as const){const value=object(row.effects)[key];if(value===undefined)continue;const effect=object(value);if(!['confirmed','submitted','failed','unknown','not-required','not-configured'].includes(String(effect.state))||effect.code!==null&&typeof effect.code!=='string'||effect.revokedSessions!==undefined&&!nonnegative(effect.revokedSessions)||effect.revision!==undefined&&!nonnegative(effect.revision))return undefined;
  effects[key]={state:effect.state as RegisteredEffect['state'],code:effect.code as string|null,...(effect.revokedSessions!==undefined?{revokedSessions:Number(effect.revokedSessions)}:{}),...(effect.revision!==undefined?{revision:Number(effect.revision)}:{})};
 }
 const answer:RegisteredCommandResult={effects,passwordChanged:row.passwordChanged as false|null,participationChanged:false};
 if(row.correction!==undefined){const correction=object(row.correction);if(correction.field!=='displayName'||correction.before!==null&&typeof correction.before!=='string'||typeof correction.after!=='string')return undefined;answer.correction={field:'displayName',before:correction.before as string|null,after:correction.after};}
 if(row.changedFields!==undefined){if(!Array.isArray(row.changedFields)||new Set(row.changedFields).size!==row.changedFields.length||row.changedFields.some(key=>!['displayName','avatarKey','bio'].includes(String(key))))return undefined;answer.changedFields=row.changedFields as NonNullable<RegisteredCommandResult['changedFields']>;}
 if(row.preset!==undefined){const preset=object(row.preset);if(typeof preset.reservedAccountId!=='string'||!uuid.test(preset.reservedAccountId)||typeof preset.uid!=='string'||!/^G[A-Z0-9]{10}[0-9]$/.test(preset.uid)||!nonnegative(preset.revision)||Number(preset.revision)<1)return undefined;answer.preset={reservedAccountId:preset.reservedAccountId,uid:preset.uid,revision:Number(preset.revision)};}
 return answer;
}
/** GET is owner/endpoint scoped by the existing service. A restored locator has
 * no write body and can only accept this exact current original receipt. */
export function registeredUsersRestoredReceipt(input:unknown,locator:RegisteredUsersPendingReceipt,now=Math.floor(Date.now()/1000)):RegisteredCommandReceipt|null{
 const row=object(input);if(!registeredUsersPendingReceipt(locator)||row.operationId!==locator.operationId||row.registrationId!==locator.registrationId||row.kind!==locator.kind||!['accepted','submitted','completed','partial','failed','unknown'].includes(String(row.state))||row.metadataOnly!==true||typeof row.checkedAt!=='number'||!Number.isFinite(row.checkedAt)||typeof row.readExpiresAt!=='number'||!Number.isFinite(row.readExpiresAt)||row.checkedAt>now+5||row.checkedAt>row.readExpiresAt||row.readExpiresAt<=now||row.recordedAt!==null&&(typeof row.recordedAt!=='string'||!Number.isFinite(Date.parse(row.recordedAt)))||typeof row.replayed!=='boolean')return null;
 const value=result(row.result);if(value===undefined)return null;
 return{state:row.state as RegisteredCommandReceipt['state'],operationId:locator.operationId,registrationId:locator.registrationId,kind:locator.kind,result:value,recordedAt:row.recordedAt as string|null,checkedAt:row.checkedAt,readExpiresAt:row.readExpiresAt,metadataOnly:true,replayed:row.replayed};
}

