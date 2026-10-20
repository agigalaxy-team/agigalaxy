import * as z from 'zod/v4';
import {trustAudienceSchema,trustClaimSchema,trustSourceRefSchema,trustSourceSnapshotSchema,trustContainerSchema,trustPermissionSchema} from '../../galaxy-official/src/shared/trust-package-schema.mjs';
import type {createTrustPackageWorkspaceClient} from './trust-package-workspace-client.mjs';
import type {verifyTrustPackage} from '../../galaxy-official/src/trust-package.mjs';

export type TrustRef=z.infer<typeof trustSourceRefSchema>;
export type TrustAudience=z.infer<typeof trustAudienceSchema>;
export type TrustContainer=z.infer<typeof trustContainerSchema>;
export type TrustFiles=TrustContainer['files'];
export type TrustSource=z.infer<typeof trustSourceSnapshotSchema>&{authorId?:string;bodyText?:string};
export type TrustSelection={ref:TrustRef;mode:'reference'|'copy';permissionId?:string;permissionExpiresAt?:number};
export type ContentShareContext={kind:'profile'|'work'|'material';id:string;title:string;returnTo:string;href?:string;claim?:string;selections?:TrustSelection[];work?:TrustWork};
export type TrustCompose={claim:string;audienceKind:'subjects'|'public';recipients:string[];recipientQuery:string;days:number;selections:TrustSelection[]};
export type TrustPermissionForm={source:TrustRef|null;grantee:string;query:string;audienceKind:'subjects'|'public';recipients:string[];recipientQuery:string;days:number};
export type TrustReading={ref?:TrustRef;state:'available';snapshot:TrustSource;readExpiresAt?:number}|{ref?:TrustRef;state:'unavailable';reason?:string;readExpiresAt?:number};
export type TrustWork={caseId?:string;taskId?:string;title?:string;request?:{title?:string}};
export type TrustMaterial={ref:TrustRef;authorId:string;title:string;bodyText:string};
export type TrustLicense={id:string;subjectId:string;granteeId:string;source:TrustRef;audience:TrustAudience;expiresAt:number;status:string;reason?:string|null};
export type TrustPermissionStatus={status:string;reason?:string|null};
export type TrustPreparation={claims:z.infer<typeof trustClaimSchema>[];selections:Omit<TrustSelection,'permissionExpiresAt'>[];audience:TrustAudience;expiresAt:number};
export type TrustPrepared={state:string;files?:TrustFiles;items?:{ref:TrustRef;state:string}[]};
export type TrustReport=Awaited<ReturnType<typeof verifyTrustPackage>>;
export type TrustOnline={checkedAt:number;items:{ref:TrustRef;status:string}[];control?:{status:string};unavailable?:boolean};
export type TrustPending={operationId:string;id:string;kind:'grant'|'revoke';state:string};
export type TrustOperationResult={state:string;operationId?:string;revokeOperationId?:string;reason?:string|null};
export type TrustOriginal={operationId:string;signatureHash:string;state:string;source:TrustRef;grantee:string;audience:TrustAudience;expiresAt:number;reason?:string|null;canContinue:boolean;payload:z.infer<typeof trustPermissionSchema>};
export type TrustWorkspace=ReturnType<typeof createTrustPackageWorkspaceClient>;
export type TrustDraft=ReturnType<TrustWorkspace['draft']>;
export type TrustDraftHead=NonNullable<Awaited<ReturnType<TrustDraft['load']>>>['head'];
export type TrustDraftBinding={preview:TrustPrepared;head:TrustDraftHead;text:string};

const selectionSchema=z.object({ref:trustSourceRefSchema,mode:z.enum(['reference','copy']),permissionId:z.string().optional(),permissionExpiresAt:z.number().optional()});
export const trustMaterialsSchema=z.array(z.object({ref:trustSourceRefSchema,authorId:z.string(),title:z.string(),bodyText:z.string()}));
export function trustObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
export function trustField(value:unknown,field:string){return trustObject(value)?value[field]:undefined;}
export function trustErrorField(value:unknown,field:string){const fieldValue=trustField(value,field);return typeof fieldValue==='string'?fieldValue:'';}
export function trustTextBody(text:string){
 try{const value:unknown=JSON.parse(text),body=trustField(value,'event')??trustField(value,'data')??value;return trustObject(body)?body:null;}catch{return null;}
}
export function initialCompose(subjectId?:string):TrustCompose{return{claim:'',audienceKind:'subjects',recipients:subjectId?[subjectId]:[],recipientQuery:'',days:1,selections:[]};}
/** A source supplies context only. Preparation still reads the original service permissions. */
export function contextualCompose(subjectId:string|undefined,context?:ContentShareContext):TrustCompose{
 const initial=initialCompose(subjectId);return context?{...initial,claim:context.claim?.slice(0,4000)??'',selections:(context.selections??[]).map(selection=>({...selection,ref:{...selection.ref}}))}:initial;
}
export function contentShareDraftKey(context?:ContentShareContext){return context?'trust-package:compose-draft:'+JSON.stringify([context.kind,context.id]):'trust-package:compose-draft';}
export function initialPermission(subjectId?:string):TrustPermissionForm{return{source:null,grantee:subjectId??'',query:'',audienceKind:'subjects',recipients:subjectId?[subjectId]:[],recipientQuery:'',days:1};}
function recipients(value:unknown,fallback:string[]){return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'):typeof value==='string'?value.split(/[\s,，、]+/).filter(Boolean):fallback;}
export function restoredCompose(value:unknown,subjectId?:string):TrustCompose{
 const initial=initialCompose(subjectId),source=trustObject(value)?value:{};
 return{...initial,claim:typeof source.claim==='string'?source.claim:'',audienceKind:source.audienceKind==='public'?'public':'subjects',recipients:recipients(source.recipients,initial.recipients),recipientQuery:typeof source.recipientQuery==='string'?source.recipientQuery:'',days:typeof source.days==='number'&&[1,7,30].includes(source.days)?source.days:1,selections:Array.isArray(source.selections)?source.selections.flatMap(value=>{const parsed=selectionSchema.safeParse(value);return parsed.success?[parsed.data]:[];}):[]};
}
export function restoredPermission(value:unknown,subjectId?:string):TrustPermissionForm{
 const initial=initialPermission(subjectId),source=trustObject(value)?value:{},ref=trustSourceRefSchema.safeParse(source.source);
 return{...initial,source:ref.success?ref.data:null,grantee:typeof source.grantee==='string'?source.grantee:initial.grantee,query:typeof source.query==='string'?source.query:'',audienceKind:source.audienceKind==='public'?'public':'subjects',recipients:recipients(source.recipients,initial.recipients),recipientQuery:typeof source.recipientQuery==='string'?source.recipientQuery:'',days:typeof source.days==='number'&&[1,7,30].includes(source.days)?source.days:1};
}
const objectsSchema=z.object({audience:trustAudienceSchema,expiresAt:z.number(),claims:z.array(trustClaimSchema),sources:z.array(trustSourceSnapshotSchema)});
export function trustPackageObjects(files?:Readonly<Record<string,string>>){try{const value:unknown=JSON.parse(files?.['objects.json']??'null'),parsed=objectsSchema.safeParse(value);return parsed.success?parsed.data:null;}catch{return null;}}
export function trustReadingSnapshot(read?:TrustReading|null):TrustSource|null{return read?.state==='available'?read.snapshot:null;}
export function currentTrustReading(read:TrustReading|null,now:number):TrustReading|null{return read?.readExpiresAt!==undefined&&read.readExpiresAt<=now?{ref:read.ref,state:'unavailable',reason:'trust_permission_expired'}:read;}
export function trustChoiceExpiry(value:TrustCompose|TrustPermissionForm,now:number){return now+value.days*86400;}
export function trustPackageExpiry(value:TrustCompose,now:number){return Math.min(trustChoiceExpiry(value,now),...value.selections.filter(selection=>selection.mode==='copy').map(selection=>selection.permissionExpiresAt??Infinity));}
