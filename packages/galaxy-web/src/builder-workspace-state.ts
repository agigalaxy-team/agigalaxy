import type {BuilderClient,BuilderDeclaration,BuilderEntry,BuilderEvent,BuilderExtensions,BuilderFormKind,BuilderLocator,BuilderMaintenance,BuilderRead,BuilderReport,BuilderType} from './builder-authoring-state';
import {isBuilderFormKind} from './builder-authoring-state';

/** Current registry projections consumed by the directory; no inferred capability. */
export type BuilderDirectoryEntry=BuilderEntry&{declaration:BuilderDeclaration;registration:{state:string};reachability:{state:string};nodeControl:{state:string};securityIssue:boolean;notices:(BuilderMaintenance&{revision:number;eventId?:string})[]};
export type BuilderDirectoryExtensions=BuilderExtensions&{
 support:BuilderExtensions['support']&{state:string;testedScopes?:{action:string;state:string;observations:{reportId:string;testClass:string;detail:string}[]}[]};
 pack:BuilderExtensions['pack']&{state:string};reports:(BuilderReport&{validity:string})[];delisted:boolean;securityIssue:boolean;
};
export type BuilderDirectoryRead=BuilderRead&{entry:BuilderDirectoryEntry;extensions:BuilderDirectoryExtensions};
export type BuilderManagement=Omit<BuilderEntry,'declaration'>&{declaration:BuilderDeclaration|null;declarationState:'readable'|'unavailable'};
export type BuilderDirectoryRow={builderId:string;type:BuilderType;revision:number;name:string|null;version?:string;scope?:string};
export type BuilderDirectoryPage={items:BuilderDirectoryRow[];nextAfter:string|null};
export type BuilderPending={event:BuilderEvent;payloadHash:string;blockedReason?:string|null;businessFailure?:{code:string;status:number|null}|null};
export type BuilderLocal={pending:BuilderPending|null;stoppedOperations?:BuilderLocator[]};
export type BuilderAcknowledged={state:'acknowledged';builderId:string;locator:BuilderLocator};
export type BuilderUnconfirmed={state:'none'|'unconfirmed'|'absent';reason?:string;locator?:BuilderLocator};
export type BuilderAuthorization={state:'reauthorization-required';locator:BuilderLocator;event:BuilderEvent;visibility:'Private'|'Public';viewers:string[];originalExpiresAt:number|null;expiresAt:number};
export type BuilderDirectoryClient=Omit<BuilderClient,'read'|'manage'>&{
 read:(builderId:string,authenticated:boolean)=>Promise<BuilderDirectoryRead>;
 manage:(builderId:string)=>Promise<BuilderManagement>;
 query:(input:{type?:BuilderType;after?:string;limit:number;query:string},authenticated:boolean)=>Promise<BuilderDirectoryPage>;
 owned:(input:{type?:BuilderType;after?:string;limit:number})=>Promise<BuilderDirectoryPage>;
 local:()=>Promise<BuilderLocal>;
 resumePending:(options?:{explicitRetry?:boolean})=>Promise<BuilderAcknowledged|BuilderUnconfirmed>;
 reviewAuthorization:()=>Promise<BuilderAuthorization|BuilderAcknowledged|BuilderUnconfirmed|{state:'ready'}>;
 reauthorize:(preview:BuilderAuthorization,options:{confirmed:true})=>Promise<BuilderAcknowledged|BuilderUnconfirmed>;
 discard:()=>Promise<{state:'none'|'stopped';remoteState?:string}>;
 queryStopped:(locator:BuilderLocator)=>Promise<{state:string}>;
 exportPack:(builderId:string,manifestId:string,authenticated:boolean)=>Promise<unknown>;
};
export type BuilderStoppedResult={state:string|undefined;error?:string};
export type BuilderStopPreview=Pick<BuilderLocator,'builderId'|'eventId'|'payloadHash'>;
export function builderDirectoryKind(value:string|null):BuilderFormKind{return value&&isBuilderFormKind(value)?value:'declare';}
export function builderDirectoryType(value:string):BuilderType|''{return value==='worker'||value==='bridge'||value==='hub'?value:'';}
export function builderFailureField(value:unknown,field:string):unknown{return typeof value==='object'&&value!==null?Reflect.get(value,field):undefined;}
export const builderReadingUnavailable=(error:unknown)=>[401,403,404].includes(Number(builderFailureField(error,'status')))||['builder_unavailable','consent_unavailable','consent_required'].includes(String(builderFailureField(error,'code')));
