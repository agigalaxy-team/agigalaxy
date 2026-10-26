import type {AnalyticsFlowData,AnalyticsRetentionData} from "../analytics/analytics-types";

export type AccountUsageAvailability={state:'available'|'not-connected'|'unavailable';code:string|null};
export type AccountUsageTimeZone={source:'native-project-settings'|'native-clickhouse-default';name:string|null};
export type AccountUsagePart<T,B>={availability:AccountUsageAvailability;checkedAt:number;readExpiresAt:number;basis:B|null;data:T|null};
export type AccountLifetimeUsage={
 sessions:number|null;screenViews:number|null;totalEvents:number|null;conversionEvents:number|null;uniqueDaysActive:number|null;
 avgSessionDurationMin:number|null;p90SessionDurationMin:number|null;avgEventsPerSession:number|null;avgTimeBetweenSessionsSec:number|null;bounceRate:number|null;
 firstSeen:string|null;lastSeen:string|null;
};
export type AccountLifetimeBasis={window:'native-lifetime';accountId:string};
export type AccountUsageIdentityBasis={identityScope:'accounts';population:'single-account-profile';accountOnly:true;accountId:string;timezone:AccountUsageTimeZone|null};
export type AccountUsagePathsBasis=AccountUsageIdentityBasis&{from:string;to:string;unit:'account-session-path-transitions';scope:'native-top-paths';classification:'event-family'};
export type AccountUsageRetentionBasis=AccountUsageIdentityBasis&{window:'native-last-12-weeks';interval:'week';criteria:'on_or_after';activity:'any-event';cohortEntry:'first-qualified-activity-in-window';accountPrefixFilterSupported:true};
export type AccountUsageAnalysisValue={
 accountId:string;source:'openpanel-native';purpose:'site-usage-analytics';coverage:string[];historicalBackfill:false;metadataOnly:true;checkedAt:number;readExpiresAt:number;
 lifetime:AccountUsagePart<AccountLifetimeUsage,AccountLifetimeBasis>;
 paths:AccountUsagePart<AnalyticsFlowData,AccountUsagePathsBasis>;
 retention:AccountUsagePart<AnalyticsRetentionData,AccountUsageRetentionBasis>;
};
