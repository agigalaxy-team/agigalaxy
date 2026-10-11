import type {createWebRuntime} from './runtime.mjs';

export type AccountRuntime=Awaited<ReturnType<typeof createWebRuntime>>;
// Fields consumed from profile-client's current overview and both Honor projections.
export type HonorBadge={id:string;title:string;ruleId:string;ruleVersion:string};
export type ProfileOverview={displayName:string|null;about:string|null;tags:string[];honors:HonorBadge[];honorsError:string|null};
export type HonorEvidence={id?:string;assistanceId?:string;title?:string;summary?:string;case?:{title?:string};eligible?:boolean;accepted?:boolean;participatedAt?:number;
  projections?:{projection?:{title?:string;summary?:string}}[];sourceEvents?:{kind:string}[]};
export type HonorResponse={card:{issuer:string;status:string;rule:{title:string;version:string};sourceFingerprint?:string};items?:HonorEvidence[];contributions?:HonorEvidence[];nextAfter?:string|null;pagination?:{contributions?:{nextAfter?:string|null}};sourceFingerprint?:string};
export type HonorDetail=HonorResponse&{items:HonorEvidence[];nextAfter:string|null};
export type WorkItem={taskId:string;state?:string;request?:{title?:string;summary?:string}};
export type HomeNotification={id:string;title:string;object:{type:string;id:string}};
type HomePage<T>={page?:{items:T[]};error?:string};
export type HomeContinuity={requested?:HomePage<WorkItem>;participating?:HomePage<WorkItem>;notifications?:HomePage<HomeNotification>};
