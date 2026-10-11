import type {AccountRuntime} from './account-workspace-types';

export type DeviceRuntime=AccountRuntime;
export type PublicApproval={challenge:string;[field:string]:unknown};
export type DeviceInput={tab:'invite'|'approve';identity:string;request:string;approval:string;scopes:string[];approved:PublicApproval|null};
export const initialDeviceInput:DeviceInput={tab:'invite',identity:'',request:'',approval:'',scopes:[],approved:null};
export type DeviceOffer={version:number;type:string;endpoint:string;subjectId:string;operationId:string;deviceId:string;publicKeyPem:string;scopes:string[];fingerprint?:string};
export type OfferPreview=DeviceOffer&{fingerprint:string};
export type ApprovalPreview={subjectId:string;deviceId:string;endpoint:string;scopes:string[];fingerprint:string;expiresAt:number;operationId:string;packet:unknown};
export type DeviceReceipt={operationId?:string;subjectId?:string;state:string;registered?:boolean};
export type DeviceResult={activated?:boolean;identity?:{subjectId:string;deviceId:string};needsReview?:boolean;receipt?:DeviceReceipt};
export type DevicePending={operationId:string;offer:DeviceOffer;state:string;approval:unknown;receipt:DeviceReceipt|null;needsReview?:boolean;fingerprint?:string};
export type DraftText={title?:string;goal?:string;summary?:string;situation?:string};
export type VisitorDraftPreview={subjectId:string;visitorDraft:DraftText|null;existingDraft:DraftText|null;sourceRetained:boolean};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const approval=(value:unknown):value is PublicApproval=>record(value)&&typeof value.challenge==='string';
export function savedDeviceInput(value:unknown):DeviceInput|null{
 if(!record(value)||typeof value.identity!=='string'||value.identity.length>48000||typeof value.request!=='string'||value.request.length>48000||typeof value.approval!=='string'||value.approval.length>48000
  ||!Array.isArray(value.scopes)||!value.scopes.every((item:unknown)=>typeof item==='string')||value.approved!=null&&!approval(value.approved))return null;
 return {tab:value.tab==='approve'?'approve':'invite',identity:value.identity,request:value.request,approval:value.approval,scopes:value.scopes,approved:value.approved??null};
}
export function approvalDeadline(value:PublicApproval|null):number{
 if(!value)return 0;
 try{const parsed:unknown=JSON.parse(value.challenge);return record(parsed)&&typeof parsed.expiresAt==='number'&&Number.isFinite(parsed.expiresAt)?parsed.expiresAt:0;}catch{return 0;}
}

