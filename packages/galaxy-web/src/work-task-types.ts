import type {z} from 'zod/v4';
import type {taskRequestV2Schema,taskEventV2Schema,participationProposalV2Schema} from '../../galaxy-official/src/shared/task-schema-v2.mjs';
import type {createWebRuntime} from './runtime.mjs';
import type {FeedbackParticipant} from './task-operation-state';
import type {FactReference} from './work-fact-presentation-types';

export type WorkRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
export type WorkSignedRequest=z.infer<typeof taskRequestV2Schema>;
// Task reads contain the service's current permission-aware projection. The
// signed root request remains a separate typed value and is never render text.
export type WorkRequest=Omit<WorkSignedRequest,'title'|'summary'|'workContext'|'expectedOutcome'>&{
 title:string;summary:string;workContext:Omit<WorkSignedRequest['workContext'],'goal'|'currentSituation'>&{goal:string;currentSituation:string};expectedOutcome?:string;
};
type TaskEvent=z.infer<typeof taskEventV2Schema>;
export type WorkRole=z.infer<typeof participationProposalV2Schema>['role'];
export type WorkApplication=Pick<Extract<TaskEvent,{kind:'apply'}>,'proposal'|'scope'|'qualificationEvidence'>&{applicationId:string;subjectId:string;state:string;quote?:WorkRequest['budget']|null};
export type WorkInvitation={invitationId:string;recipientId:string;note:string;state:string};
export type WorkDelivery={deliveryId:string;summary?:string;resultRef?:FactReference;interventionRefs?:FactReference[];evidenceRefs?:(FactReference|string)[];acceptance?:{eventId:string;summary:string}|null};
export type WorkParticipation=FeedbackParticipant&{
 role:WorkRole;scopeVersion:number;agreedScope:string|null;deliveries?:WorkDelivery[];
 pendingScope?:{eventId:string;agreedScope:string;reason:string}|null;
 dispute?:{eventId:string;reason:string}|null;
 disputeResolution?:{eventId:string;actorId:string;summary:string;outcome:'close'|'resume-work'}|null;
};
export type WorkTask={schemaVersion:number;taskId:string;caseId:string|null;requesterId:string;version:number;state:string;enrollmentOpen?:boolean;request:WorkRequest;participations?:WorkParticipation[];contacts?:{suggestions:{items:Extract<TaskEvent,{kind:'suggest-contacts'}>['items']};responses:{applications:WorkApplication[];invitations:WorkInvitation[]}}};
export type WorkProps={task:WorkTask;runtime:WorkRuntime;subjectId?:string;connected:boolean;navigate:(path:string)=>void;refresh:()=>Promise<unknown>};
