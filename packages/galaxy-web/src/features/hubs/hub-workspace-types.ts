import type * as z from 'zod/v4';
import type {createWebRuntime} from "../../runtime.mjs";
import type {hubCharterSchema,hubEventSchema} from "../../../../galaxy-official/src/shared/hubs-v2-schema.mjs";
import type {peeringEventSchema} from "../../../../galaxy-official/src/shared/hub-peering-v2-schema.mjs";
import type {builderExtensionEventSchema} from "../../../../galaxy-official/src/shared/builder-support-v2-schema.mjs";
import type {PeeringApi} from './hub-peering-state';

export type HubRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
export type HubCharter=z.infer<typeof hubCharterSchema>;
export type HubClause=HubCharter['scope'];
export type HubClauseKey={ [K in keyof HubCharter]:HubCharter[K] extends HubClause?K:never }[keyof HubCharter];
export type HubEvent=z.infer<typeof hubEventSchema>;
export type HubClientEvent=HubEvent|z.infer<typeof peeringEventSchema>;
export type HubVisibility='Private'|'Public';
export type HubFamily='hub'|'peering';
export type HubReport=Extract<z.infer<typeof builderExtensionEventSchema>,{kind:'scope-report'}>&{
 validity:string;payloadHash:string;publiclyReadable:boolean;canReferenceInCharter:boolean;
};
export type HubClaims=Partial<Record<HubClauseKey,{currentState:string}>>;
export type HubView={
 hubId:string;ownerId:string;version:number;latestVersion:number;state:string;availableActions:string[];
 charter:HubCharter;claims:HubClaims;reports:HubReport[];
 charterEventId:string;charterHash:string;declarationId:string;declarationHash:string;
};
export type HubDeclaration={
 declarationId:string;declarationHash:string;declaration:{name:string};
 disclosure:{visibility:HubVisibility;viewers:string[]};
};
export type HubManagement={
 hubId:string;ownerId:string;latestVersion:number;current:HubView|null;declaration:HubDeclaration;
 availableActions:string[];reports:HubReport[];
};
export type HubMember={
 membershipId:string;memberId:string;version:number;charterVersion:number;state:string;authorization:string;
 expiresAt:number;scopes:string[];availableActions:string[];
};
export type HubIntake={
 threadId:string;hubId:string;version:number;state:string;expiresAt:number;availableActions:string[];
 messages:{id:string;kind:string;authorId:string;version:number;contentAvailable:boolean;receivedAt:number;title?:string;text?:string}[];
};
export type HubOwnedBuilder={builderId:string;name:string;delisted:boolean;securityIssue:boolean};
export type HubDirectoryItem=HubView|HubOwnedBuilder;
export type HubLocator={
 endpoint:string;ownerId:string;operationId:string;hubId:string;payloadHash:string;family:HubFamily;
};
export type HubAcknowledged={
 state:'acknowledged';operationId:string;hubId:string;payloadHash:string;kind?:string;objectId?:string|null;locator?:HubLocator;reason?:string;
};
export type HubResult=HubAcknowledged|{
 state:'none'|'absent'|'blocked'|'ready'|'recorded'|'unknown';reason?:string;locator?:HubLocator;
 operationId?:string;hubId?:string;payloadHash?:string;
};
export type HubActionView={
 event:HubClientEvent;visibility:HubVisibility;viewers:string[];family?:HubFamily;locator?:HubLocator;
};
export type HubPending=HubActionView&{
 payloadHash:string;blockedReason?:string|null;businessFailure?:{code:string;status:number|null}|null;
};
export type HubAuthorizationReview=HubActionView&{
 state:'reauthorization-required';locator:HubLocator;originalExpiresAt:number|null;expiresAt:number;reason:string;
};
export type HubLocal={
 pending:HubPending|null;stoppedOperations?:HubLocator[];lastReceipt?:HubResult;
};
export type HubSelection={event:unknown;viewers?:string[];visibility?:HubVisibility};
export type HubClient={
 query:(input:{view:string;limit:number;after?:string},authenticated?:boolean)=>Promise<{items:HubView[];nextCursor:string|null}>;
 ownedBuilders:(input:{type:'hub';limit:number;after?:string})=>Promise<{items:HubOwnedBuilder[];nextAfter:string|null}>;
 local:()=>Promise<HubLocal>;
 read:(input:{hubId:string;version?:number},authenticated?:boolean)=>Promise<HubView>;
 manage:(input:{hubId:string})=>Promise<HubManagement>;
 members:(input:{hubId:string;limit?:number;after?:string})=>Promise<{items:HubMember[];nextCursor?:string|null}>;
 intake:(input:{hubId:string;threadId?:string;limit?:number;after?:string})=>Promise<{items:HubIntake[];nextCursor:string|null}>;
 peering:PeeringApi;
 receiptFor:(locator:unknown)=>Promise<HubResult>;
 submit:(event:unknown,options:{confirmed:boolean;visibility?:HubVisibility;viewers?:string[];family?:HubFamily;onJournal?:(locator:HubLocator)=>unknown})=>Promise<HubAcknowledged>;
 resumePending:(options?:{explicitRetry?:boolean})=>Promise<HubResult>;
 reviewAuthorization:()=>Promise<HubResult|HubAuthorizationReview>;
 reauthorize:(preview:HubAuthorizationReview,options:{confirmed:boolean})=>Promise<HubResult>;
 queryStopped:(locator:HubLocator)=>Promise<HubResult>;
 discard:()=>Promise<unknown>;
};

export function hubErrorField(error:unknown,field:'code'|'message'){
 if(typeof error!=='object'||error===null||!(field in error))return '';
 const value:unknown=Reflect.get(error,field);return typeof value==='string'?value:'';
}
