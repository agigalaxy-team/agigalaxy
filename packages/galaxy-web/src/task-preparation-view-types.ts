import type {useMemberNames} from './conversation-ui';
import type {SearchRequest,SearchType} from './help-contact-view-types';

type Contribution={actorId?:string;summary?:string;strategy?:string};
type Verification={reportedBy?:string;summary?:string;record?:{reportedBy?:string;summary?:string}};
/** Only the fields rendered here; source objects and exact references remain intact. */
export type PreparationSource={item:{type:SearchType;title:string;summary?:string|null;ref:{id:string;version:string};record?:{synthetic?:boolean;attempts?:Contribution[];interventions?:Contribution[];verificationRecords?:Verification[]}};search:SearchRequest};
export type PreparationCandidate={subjectId:string;displayName?:string;willingness?:string;sources:PreparationSource[]};
export type PreparationView={input:{keyword:string;functions:string[];capabilityId?:string};selected:string[];candidates:PreparationCandidate[];pages:{type:SearchType;error?:string|null;sourceState?:string;nextCursor?:string|null}[];unavailable?:string[]};
export type PreparationProps={runtime:Parameters<typeof useMemberNames>[0];subjectId?:string;connected:boolean;value:PreparationView|null;selected:string[];busy:boolean;disabled?:boolean;error:string;onChange:(selected:string[])=>void;onRetry:()=>void};
