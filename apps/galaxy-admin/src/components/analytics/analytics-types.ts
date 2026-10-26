export type AnalyticsKind='overview'|'retention'|'paths'|'account'|'business';
export type AnalyticsEnvelope<T=unknown>={kind:AnalyticsKind;data:T;basis:Record<string,unknown>;source:'openpanel-native';purpose:'site-usage-analytics';coverage:string[];checkedAt:number;historicalBackfill:false};
export type AnalyticsSeriesPoint={date:string;unique_visitors:number|null;total_screen_views:number|null;total_sessions:number|null};
export type AnalyticsOverviewData={
 summary:{unique_visitors:number|null;total_screen_views:number|null;total_sessions:number|null;bounce_rate:number|null;avg_session_duration:number|null;views_per_session:number|null};
 series:AnalyticsSeriesPoint[];interval?:'day';startDate?:string;endDate?:string;
};
export type AnalyticsLocation={days:number;scope?:'accounts';accountId?:string};
export type AnalyticsAudienceBasis={object:'all'|'accounts'|'account';timeZone:string|null;componentSourceUrl:string|null};
export type AnalyticsRetentionRow={cohort:string;size:number|null;average:boolean;cells:{week:number;count:number|null;ratio:number|null;state:'recorded'|'not-reached'|'unknown'}[]};
export type AnalyticsRetentionData={rows:AnalyticsRetentionRow[];weeks:number[]};
export type AnalyticsFlowNode={id:string;label:string;step:number;value:number|null;percentage:number|null};
export type AnalyticsFlowLink={source:string;target:string;value:number|null};
export type AnalyticsFlowData={nodes:AnalyticsFlowNode[];links:AnalyticsFlowLink[]};
export type AnalyticsBusinessKey='reads'|'searches'|'bookmarks'|'participations';
export type AnalyticsBusinessCounts=Record<AnalyticsBusinessKey,number|null>;
export type AnalyticsBusinessData={unit:'events';current:AnalyticsBusinessCounts;previous:AnalyticsBusinessCounts};
