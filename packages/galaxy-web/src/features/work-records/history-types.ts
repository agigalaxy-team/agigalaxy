import type {useMemberNames} from "../../shared/people/conversation-ui";
import type {InterventionOpinionsView,ResolutionDecision} from "./presentation-types";

/** Only the display contract; the original authorized object is kept for export. */
export type HistoryFactBody={
 [key:string]:unknown;
 title?:string;strategy?:string;description?:string;summary?:string;kind?:string;role?:string;types?:string[];
 observation?:string;observedEffect?:string;failureReason?:string;reportedOutcome?:string;conclusion?:string;
 actorId?:string;reportedBy?:string;observedAt?:string|number;endedAt?:string|number;startedAt?:string|number;
};
export type HistoryFactItem=HistoryFactBody&{id?:string;eventId?:string;version?:number;record?:HistoryFactBody;payload?:HistoryFactBody;recordedAt?:string|number;at?:string|number;supersededInVisibleHistory?:boolean;applicationStatus?:string};
export type HistoryParticipation={participationId?:string;taskId?:string;subjectId?:string;requesterId?:string;title?:string;request?:{title?:string};role?:string;agreedScope?:string|{summary?:string;description?:string};participation?:HistoryParticipation[];deliveries?:{deliveryId?:string;summary?:string;acceptance?:{at?:string|number}}[]};
export type HistoryFactsRecord={
 key?:string;kind?:string;synthetic?:boolean;subjectRoles?:string[];
 attempts?:HistoryFactItem[];interventions?:(HistoryFactItem&Partial<InterventionOpinionsView>)[];results?:HistoryFactItem[];
 verificationRecords?:HistoryFactItem[];capsuleReuse?:{items?:HistoryFactItem[]};
 participation?:HistoryParticipation[];collaborations?:HistoryParticipation[];
 resolution?:ResolutionDecision;resolutions?:ResolutionDecision[];proofs?:{proofId?:string;status?:string}[];
 publication?:{recordedAt?:string|number};matchReasons?:{kind:string;term?:string;capabilityId?:string;requestedEnvironment?:string}[];
 events?:HistoryFactItem[];taskIds?:string[];
};
export type HistoryPeopleRuntime=Parameters<typeof useMemberNames>[0];
function isObject(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
export function historyObject(value:unknown):Record<string,unknown>|null{return isObject(value)?value:null;}
