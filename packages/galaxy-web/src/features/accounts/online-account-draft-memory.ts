import {accountAvatarKey} from "../../../../galaxy-official/src/shared/account-profile-presentation.mjs";

type PublicQuery={enabled:boolean;scope:'profile'|'profile-and-public-posts';showLinkedIds:boolean;showExternalCredentials:boolean};
export type AccountSettingsDraftSource={accountId:string;revision:number;displayName:string|null;avatarKey?:string|null;bio?:string;publicQuery:PublicQuery;archiveRetentionDays:number|null};
export type AccountSettingsDraftValues={displayName:string;avatarKey:string|null;bio:string;publicQuery:PublicQuery;retention:string};
export type AccountSettingsDraftDirty={displayName:boolean;avatarKey:boolean;bio:boolean;publicQuery:boolean;retention:boolean};
export type AccountSettingsDraftLease={client:object;accountId:string;csrfToken:string};
export type AccountFollowIntent={command:{operationId:string;targetAccountId:string;following:boolean;expectedRevision:number};payloadHash:string};
type AccountType='person'|'organization'|'agent'|null;
export type AccountTypeCorrectionSource={accountId:string;revision:number;subjectType:AccountType};
export type AccountTypeCorrectionValues={nextType:AccountType;reason:string;basis:string};
type AccountTypeCorrectionDraft={source:AccountTypeCorrectionSource;values:AccountTypeCorrectionValues;sourceChanged:boolean};
type AccountSettingsDraft={source:AccountSettingsDraftSource;values:AccountSettingsDraftValues;dirty:AccountSettingsDraftDirty;conflicted:boolean};
type CurrentAccount={phase:'loading'|'signed-in'|'signed-out'|'unavailable'|'offline';client:object|null;session:{account:{id:string|null};csrfToken:string;expiresAt:number}|null};
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const sameOwner=(left:AccountSettingsDraftLease|null,right:AccountSettingsDraftLease)=>!!left&&left.client===right.client&&left.accountId===right.accountId&&left.csrfToken===right.csrfToken;
const query=(value:PublicQuery):PublicQuery=>({enabled:value.enabled,scope:value.scope,showLinkedIds:value.showLinkedIds,showExternalCredentials:value.showExternalCredentials});
function source(value:AccountSettingsDraftSource):AccountSettingsDraftSource|null{
 if(!value||typeof value.accountId!=='string'||!value.accountId||!Number.isSafeInteger(value.revision)||value.revision<0||value.displayName!==null&&(typeof value.displayName!=='string'||value.displayName.length>120))return null;
 if(value.avatarKey!==undefined&&value.avatarKey!==null&&accountAvatarKey(value.avatarKey)!==value.avatarKey||value.bio!==undefined&&(typeof value.bio!=='string'||value.bio.length>500))return null;
 const q=value.publicQuery;
 if(!q||typeof q.enabled!=='boolean'||!['profile','profile-and-public-posts'].includes(q.scope)||typeof q.showLinkedIds!=='boolean'||typeof q.showExternalCredentials!=='boolean'||value.archiveRetentionDays!==null&&(!Number.isInteger(value.archiveRetentionDays)||value.archiveRetentionDays<1||value.archiveRetentionDays>36500))return null;
 return {accountId:value.accountId,revision:value.revision,displayName:value.displayName,avatarKey:value.avatarKey??null,bio:value.bio??'',publicQuery:query(q),archiveRetentionDays:value.archiveRetentionDays};
}
const currentValues=(value:AccountSettingsDraftSource):AccountSettingsDraftValues=>({displayName:value.displayName??'',avatarKey:value.avatarKey??null,bio:value.bio??'',publicQuery:query(value.publicQuery),retention:value.archiveRetentionDays===null?'':String(value.archiveRetentionDays)});
function copy(value:AccountSettingsDraft):AccountSettingsDraft{
 return {source:source(value.source)!,values:{displayName:value.values.displayName,avatarKey:value.values.avatarKey,bio:value.values.bio,publicQuery:query(value.values.publicQuery),retention:value.values.retention},dirty:{...value.dirty},conflicted:value.conflicted};
}
const accountType=(value:unknown):value is AccountType=>value===null||value==='person'||value==='organization'||value==='agent';
const followId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const followCursor=(value:unknown):value is string=>typeof value==='string'&&value.length<=512&&/^af1\.[A-Za-z0-9_-]+$/.test(value);
function followIntent(value:AccountFollowIntent):AccountFollowIntent|null{
 const command=value?.command;
 if(!command||Object.keys(command).sort().join(',')!=='expectedRevision,following,operationId,targetAccountId'||!followId(command.operationId)||!followId(command.targetAccountId)||typeof command.following!=='boolean'||!Number.isSafeInteger(command.expectedRevision)||command.expectedRevision<0||typeof value.payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(value.payloadHash))return null;
 return {command:{operationId:command.operationId,targetAccountId:command.targetAccountId,following:command.following,expectedRevision:command.expectedRevision},payloadHash:value.payloadHash};
}
function correctionSource(value:AccountTypeCorrectionSource):AccountTypeCorrectionSource|null{
 if(!value||typeof value.accountId!=='string'||!value.accountId||!Number.isSafeInteger(value.revision)||value.revision<0||!accountType(value.subjectType))return null;
 return {accountId:value.accountId,revision:value.revision,subjectType:value.subjectType};
}
function correctionValues(value:AccountTypeCorrectionValues):AccountTypeCorrectionValues|null{
 if(!value||!accountType(value.nextType)||typeof value.reason!=='string'||value.reason.length>2000||typeof value.basis!=='string'||value.basis.length>4000)return null;
 return {nextType:value.nextType,reason:value.reason,basis:value.basis};
}
/** Closed, non-secret drafts owned by the existing in-document account scope. */
export function createOnlineAccountDraftMemory(current:()=>CurrentAccount){
 let active=false,owner:AccountSettingsDraftLease|null=null,draft:AccountSettingsDraft|null=null;
 let typeCorrection:AccountTypeCorrectionDraft|null=null;
 const followIntents=new Map<string,AccountFollowIntent>(),followingPages=new Map<string,string|null>();
 const clear=()=>{owner=null;draft=null;typeCorrection=null;followIntents.clear();followingPages.clear();};
 function synchronize(){
  if(!active)return;
  const model=current();
  if(model.phase==='loading'||model.phase==='signed-out'){clear();return;}
  if(model.phase==='signed-in'){
   const session=model.session;
   if(!model.client||!session?.account.id||!session.csrfToken||session.expiresAt*1000<=Date.now()){clear();return;}
   const next={client:model.client,accountId:session.account.id,csrfToken:session.csrfToken};
   if(!sameOwner(owner,next)){clear();owner=next;}
  }else if(owner&&model.client&&owner.client!==model.client)clear();
 }
 function permitted(lease:AccountSettingsDraftLease,fresh:boolean){
  synchronize();
  if(!active||!sameOwner(owner,lease))return false;
  return !fresh||current().phase==='signed-in';
 }
 return {
  activate(){active=true;synchronize();},
  close(){active=false;clear();},
  synchronize,
  write(lease:AccountSettingsDraftLease,incoming:AccountSettingsDraftSource,values:AccountSettingsDraftValues,dirty:AccountSettingsDraftDirty,conflicted:boolean){
   if(!permitted(lease,false))return false;
   const base=source(incoming);
   if(!base||base.accountId!==lease.accountId||typeof values.displayName!=='string'||values.displayName.length>120||typeof values.retention!=='string'||values.retention.length>32||values.avatarKey!==null&&accountAvatarKey(values.avatarKey)!==values.avatarKey||typeof values.bio!=='string'||values.bio.length>500)return false;
   const checkedQuery=source({...base,publicQuery:values.publicQuery});if(!checkedQuery)return false;
   if(!Object.values(dirty).some(Boolean)){draft=null;return true;}
   draft={source:base,values:{displayName:values.displayName,avatarKey:values.avatarKey,bio:values.bio,publicQuery:query(checkedQuery.publicQuery),retention:values.retention},dirty:{displayName:dirty.displayName===true,avatarKey:dirty.avatarKey===true,bio:dirty.bio===true,publicQuery:dirty.publicQuery===true,retention:dirty.retention===true},conflicted:conflicted===true};
   return true;
  },
  restore(lease:AccountSettingsDraftLease,incoming:AccountSettingsDraftSource):AccountSettingsDraft|null{
   if(!permitted(lease,true))return null;
   const fresh=source(incoming);
   if(!fresh||fresh.accountId!==lease.accountId||!draft)return null;
   const old=draft,next=currentValues(fresh),dirty={...old.dirty};let conflicted=old.conflicted;
   const merge=(key:'displayName'|'avatarKey'|'bio'|'publicQuery'|'archiveRetentionDays',flag:keyof AccountSettingsDraftDirty,desired:unknown)=>{
    if(!dirty[flag])return;
    if(same(fresh[key],desired)){dirty[flag]=false;return;}
    if(!same(old.source[key],fresh[key]))conflicted=true;
   };
   merge('displayName','displayName',old.values.displayName.trim()||null);
   merge('avatarKey','avatarKey',old.values.avatarKey);merge('bio','bio',old.values.bio.trim());
   merge('publicQuery','publicQuery',old.values.publicQuery);
   const raw=old.values.retention.trim(),days=raw===''?null:Number(raw);
   merge('archiveRetentionDays','retention',days===null||Number.isInteger(days)&&days>=1&&days<=36500?days:undefined);
   if(dirty.displayName)next.displayName=old.values.displayName;
   if(dirty.avatarKey)next.avatarKey=old.values.avatarKey;if(dirty.bio)next.bio=old.values.bio;
   if(dirty.publicQuery)next.publicQuery=query(old.values.publicQuery);
   if(dirty.retention)next.retention=old.values.retention;
   const restored={source:fresh,values:next,dirty,conflicted:conflicted&&Object.values(dirty).some(Boolean)};
   draft=Object.values(dirty).some(Boolean)?copy(restored):null;
   return copy(restored);
  },
  writeTypeCorrection(lease:AccountSettingsDraftLease,incoming:AccountTypeCorrectionSource,values:AccountTypeCorrectionValues,sourceChanged=false){
   if(!permitted(lease,false))return false;
   const base=correctionSource(incoming),checked=correctionValues(values);
   if(!base||base.accountId!==lease.accountId||!checked)return false;
   typeCorrection=(checked.nextType===null||checked.nextType===base.subjectType)&&!checked.reason&&!checked.basis?null:{source:base,values:checked,sourceChanged:sourceChanged===true};
   return true;
  },
  restoreTypeCorrection(lease:AccountSettingsDraftLease,incoming:AccountTypeCorrectionSource):AccountTypeCorrectionDraft|null{
   if(!permitted(lease,true))return null;
   const fresh=correctionSource(incoming);
   if(!fresh||fresh.accountId!==lease.accountId||!typeCorrection)return null;
   const old=typeCorrection;
   typeCorrection={source:fresh,values:{...old.values},sourceChanged:old.sourceChanged||old.source.subjectType!==fresh.subjectType};
   return {source:{...typeCorrection.source},values:{...typeCorrection.values},sourceChanged:typeCorrection.sourceChanged};
  },
  clearTypeCorrection(lease:AccountSettingsDraftLease){
   if(!permitted(lease,false))return false;
   typeCorrection=null;return true;
  },
  readFollowIntent(lease:AccountSettingsDraftLease,targetAccountId:string):AccountFollowIntent|null{
   if(!permitted(lease,false))return null;
   const value=followIntents.get(targetAccountId);return value?followIntent(value):null;
  },
  listFollowIntents(lease:AccountSettingsDraftLease):AccountFollowIntent[]{
   return permitted(lease,false)?[...followIntents.values()].map(value=>followIntent(value)!):[];
  },
  writeFollowIntent(lease:AccountSettingsDraftLease,value:AccountFollowIntent){
   if(!permitted(lease,true))return false;
   const checked=followIntent(value);
   if(!checked||checked.command.targetAccountId===lease.accountId||followIntents.has(checked.command.targetAccountId)||followIntents.size>=20)return false;
   followIntents.set(checked.command.targetAccountId,checked);return true;
  },
  clearFollowIntent(lease:AccountSettingsDraftLease,targetAccountId:string,operationId:string){
   if(!permitted(lease,false)||followIntents.get(targetAccountId)?.command.operationId!==operationId)return false;
   followIntents.delete(targetAccountId);return true;
  },
  rememberFollowingPage(lease:AccountSettingsDraftLease,nextAfter:string,previousAfter:string|null){
   if(!permitted(lease,false)||!followCursor(nextAfter)||previousAfter!==null&&!followCursor(previousAfter))return false;
   followingPages.set(nextAfter,previousAfter);
   if(followingPages.size>200)followingPages.delete(followingPages.keys().next().value!);
   return true;
  },
  previousFollowingPage(lease:AccountSettingsDraftLease,after:string):string|null|undefined{
   return permitted(lease,false)?followingPages.get(after):undefined;
  }
 };
}
export type OnlineAccountDraftMemory=ReturnType<typeof createOnlineAccountDraftMemory>;
