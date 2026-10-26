import type {z} from 'zod/v4';
import {qualificationCalculationSchema} from "../../../../galaxy-official/src/shared/qualification-calculation-schema.mjs";
import type {qualificationSourceGrantRef} from "../../../../galaxy-official/src/shared/qualification-calculation-schema.mjs";
import {qualificationRequestEventSchema} from "../../../../galaxy-official/src/shared/qualification-requests-v2-schema.mjs";
import type {qualificationPlanSchema} from "../../../../galaxy-official/src/shared/qualification-requests-v2-schema.mjs";
import type {qualificationEvidenceV2Schema} from "../../../../galaxy-official/src/shared/qualification-v2-schema.mjs";
import type {ToolJournalClient,ToolPrepared,ToolReceipt,ToolRuntime} from "../tools/tool-workspace-state";
import {checkedToolPrepared} from "../tools/tool-workspace-state";
import {createQualificationPermissionClient} from './qualification-permission-client.mjs';

export type QualificationCalculation=z.infer<typeof qualificationCalculationSchema>;
export type QualificationRequestEvent=z.infer<typeof qualificationRequestEventSchema>;
export type QualificationPayload=QualificationCalculation|QualificationRequestEvent;
export type QualificationSourceRef=z.infer<typeof qualificationSourceGrantRef>;
export type QualificationMaterial={id?:string;ref?:QualificationSourceRef;eventVersion?:number;version?:number;title?:string|null;label?:string;available?:boolean;summary?:string|null};
export type QualificationDetails={target:{title:string|null;taskId?:string}|null;materials:QualificationMaterial[]};
export type QualificationRequest={requestId:string;version:number;state:string;role:'candidate'|'source-author';expiresAt?:string;candidateId?:string;sourceAuthorId?:string;recipientId?:string;taskId?:string;target?:QualificationDetails['target'];materials?:QualificationMaterial[];sourceRefs?:QualificationSourceRef[];history?:{eventId:string;kind:QualificationRequestEvent['kind'];reason:string|null}[];permission?:{state:string}|null;grant?:Omit<Extract<QualificationCalculation,{kind:'source-permission'}>,'id'>|null};
export type QualificationGrant={id:string;state:string;kind:QualificationCalculation['kind']|null;createdAt:string;expiresAt:string|null;payload:Exclude<QualificationCalculation,{kind:'revoke'}>|null;details?:QualificationDetails};
export type QualificationAuthor={sourceAuthorId:string;sourceRefs:QualificationSourceRef[];materials:QualificationMaterial[];permission:{id:string;expiresAt:string}|null;request:QualificationRequest|null};
export type QualificationPlan={taskId:string;recipientId:string;expiresAt:string;ownMaterials:QualificationMaterial[];authors:QualificationAuthor[];ready:boolean;compute:Omit<Extract<QualificationCalculation,{kind:'compute'}>,'id'>};
export type QualificationReceipt=ToolReceipt&{grantId?:string};
export type QualificationPrepared=ToolPrepared<QualificationPayload>;
export type QualificationClient=Omit<ToolJournalClient<QualificationPayload>,'prepare'|'execute'>&{
 execute:(preview:QualificationPrepared,options:{confirmed:true})=>Promise<QualificationReceipt>;
 plan:(input:z.infer<typeof qualificationPlanSchema>)=>Promise<QualificationPlan>;
 requests:(input:{view:'sent'|'received';after?:string})=>Promise<{items:QualificationRequest[];nextAfter:string|null}>;
 request:(requestId:string)=>Promise<QualificationRequest>;
 grants:(input:{after?:string})=>Promise<{items:QualificationGrant[];nextAfter:string|null}>;
 grantDetails:(grant:QualificationGrant)=>Promise<QualificationDetails>;
 prepareRequest:(plan:QualificationPlan,author:QualificationAuthor)=>Promise<QualificationPrepared>;
 prepareResponse:(request:QualificationRequest,kind:'record-permission'|'cancel'|'decline',extra:{grantId:string}|{reason:string})=>Promise<QualificationPrepared>;
 preparePermission:(request:QualificationRequest)=>Promise<QualificationPrepared>;
 prepareCompute:(plan:QualificationPlan)=>Promise<QualificationPrepared>;
 prepareRevoke:(grant:QualificationGrant,reason:string)=>Promise<QualificationPrepared>;
};
export type QualificationSelection={id:string;kind:string;version?:number};
export type QualificationComputeSelection={id:string;kind:'calculation';label:string;sourceStatus:string;evidence:z.infer<typeof qualificationEvidenceV2Schema>};
export type QualificationView='received'|'sent'|'granted';
export function qualificationDisplay(payload:QualificationPayload){return{
 kind:payload.kind,sourceAuthorId:'sourceAuthorId'in payload?payload.sourceAuthorId:undefined,
 candidateId:'candidateId'in payload?payload.candidateId:undefined,recipientId:'recipientId'in payload?payload.recipientId:undefined,
 expiresAt:'expiresAt'in payload?payload.expiresAt:undefined,sourceRefs:'sourceRefs'in payload?payload.sourceRefs:undefined,
 reason:'reason'in payload?payload.reason:undefined,
};}
export const qualificationPersonIds=(ids:(string|null|undefined)[])=>ids.filter((value):value is string=>typeof value==='string'&&value.length>0);
export function qualificationExternalSelections(selected:QualificationSelection[]){return selected.filter((value):value is QualificationSelection&{version:number}=>value.kind==='external-review'&&typeof value.version==='number').map(value=>({id:value.id,version:value.version})).sort((a,b)=>a.id.localeCompare(b.id)||a.version-b.version);}
function qualificationPrepared(value:unknown){return checkedToolPrepared(value,(payload):payload is QualificationPayload=>qualificationCalculationSchema.safeParse(payload).success||qualificationRequestEventSchema.safeParse(payload).success);}
export function createTypedQualificationClient(runtime:ToolRuntime,subjectId:string):QualificationClient{
 const client=createQualificationPermissionClient({runtime,subjectId});
 return {...client,
  prepareRequest:async(plan,author)=>qualificationPrepared(await client.prepareRequest(plan,author)),
  prepareResponse:async(request,kind,extra)=>qualificationPrepared(await client.prepareResponse(request,kind,extra)),
  preparePermission:async(request)=>qualificationPrepared(await client.preparePermission(request)),
  prepareCompute:async(plan)=>qualificationPrepared(await client.prepareCompute(plan)),
  prepareRevoke:async(grant,reason)=>qualificationPrepared(await client.prepareRevoke(grant,reason)),
 };
}
