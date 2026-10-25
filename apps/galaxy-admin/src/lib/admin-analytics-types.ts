import type {AutonomyOverview,AutonomyTask} from '../components/autonomy-types';
export type OperationsPeriod = {from:string;to:string;timeZone:'Asia/Shanghai'};

export type OperationsUsageAnalytics = {
  available:false;
  state:'not-collected';
  reason:'usage-events-not-collected';
  visitors:null;
  pageViews:null;
  activeAccounts:null;
  returnRate:null;
  dailyActivity:[];
  retention:[];
};

export type PublicBusinessActivity = {
  available:boolean;
  state:'available'|'unavailable';
  reason:string|null;
  days:7|28;
  period:OperationsPeriod;
  basis:'current-public-content-by-first-publication-time';
  sourceTypes:('public-post'|'public-reply')[];
  totals:{posts:number|null;replies:number|null};
  daily:{date:string;posts:number;replies:number}[];
};

export type RecentOperation = {
  id:string;
  action:string;
  createdAt:string;
  operatorId:string;
  accountId:string|null;
  resourceId:string|null;
};

export type OperationsSummary = {
  communityReports:{pending:number;total:number}|null;
  chatReports:{pending:number;total:number}|null;
  sections:{active:number;archived:number}|null;
  resources:{projects:number;methods:number}|null;
  files:{scanPending:number;scanFailed:number;cleanupPending:number;cleanupFailed:null;cleanupResultUnknown:number}|null;
  jobs:{failed:number;byQueue:{queue:string;state:string;count:number}[]}|null;
  search:{failed:number}|null;
  feedback:{total:number;pending:number;processing:number;unclassified:number}|null;
  availability:Record<'communityReports'|'chatReports'|'sections'|'resources'|'files'|'jobs'|'search'|'feedback'|'recentOperations','available'|'not-authorized'>&{businessActivity:'available'|'not-authorized'|'not-requested';ai?:'available'|'not-authorized'|'unavailable'};
  operator:{id:string;role:'administrator'|'reader';businessAuthorization:{version:string;permissions:string[]}};
  analytics:OperationsUsageAnalytics;
  businessActivity:PublicBusinessActivity|null;
  recentOperations:RecentOperation[]|null;
  ai:{state:'connected'|'not-connected'|'not-configured'|'unavailable';logs:AutonomyTask[];recentProgress:{id:string;label:string;createdAt:string;href:string;source:string}[]}|null;
  autonomy?:AutonomyOverview|null;
  checkedAt:number;
  readExpiresAt:number;
};

export type SummaryDays = 7 | 28;
export type SummaryPeriod = {from:string;to:string;timeZone?:'Asia/Shanghai'};
export type ActivityDay = {date:string;count:number|null};
export type TopicSignal = 'views'|'clicks'|'bookmarks'|'participations'|'publicPosts'|'publicReplies'|'searches'|'notInterested';
export type RecommendationSignal = 'returnedCandidates'|'exposures'|'clicks'|'bookmarks'|'participations'|'notInterested';
export type SummaryTopic = {key?:string;label:string;summary?:string;method?:string;sourceTypes?:string[];
  signalCounts?:Partial<Record<TopicSignal,number|null>>;counts?:Partial<Record<RecommendationSignal,number|null>>;
  firstObservedAt?:string|null;lastObservedAt?:string|null};
export type AnalysisState = 'available' | 'not-analyzed' | 'insufficient-data';
export type ProfileAnalysisState = AnalysisState|'empty'|'partial'|'unavailable'|'not-connected';

export type AccountDirectorySummary = {
  checkedAt:number;
  days:SummaryDays;
  period:SummaryPeriod;
  coverage:'business-service-accounts';
  totals:{accounts:number;person:number;agent:number;organization:number;unknown:number;restricted:number;active:number|null};
};

export type AccountSummary = {
  accountId:string;
  checkedAt:number;
  days:SummaryDays;
  period:SummaryPeriod;
  usage:{
    activeDays:number|null;
    searches:number|null;
    bookmarks:number|null;
    publicContributions:number|null;
    participation:number|null;
    lastActivityAt:string|null;
    dailyActivity:ActivityDay[];
    basis:'current-public-content-by-first-publication-time';
    publicActivityState:'available'|'unavailable';
    publicActivityReason:string|null;
  };
  profile:{
    state:ProfileAnalysisState;
    interests:SummaryTopic[];
    needs:SummaryTopic[];
    sourceTypes:string[];
    updatedAt:string|null;
    validUntil:string|null;
    period?:SummaryPeriod;
  };
  predictions:{
    participation:{state:AnalysisState;label:string|null;summary:string|null};
    needs:{state:AnalysisState;label:string|null;summary:string|null};
  };
  recommendations:{state:ProfileAnalysisState|'not-authorized';categories:SummaryTopic[];updatedAt:string|null;period?:SummaryPeriod};
};
