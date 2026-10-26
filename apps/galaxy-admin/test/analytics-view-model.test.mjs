import assert from 'node:assert/strict';
import test from 'node:test';
import {analyticsBusiness,analyticsDate,analyticsDurationSeconds,analyticsFlow,analyticsHref,analyticsLocation,analyticsNumber,analyticsOverview,analyticsPath,analyticsPercent,analyticsRetention} from "../src/lib/analytics/analytics-view-model.ts";

test('analytics uses the one discovery endpoint and preserves only the supported period context',()=>{
 const location=analyticsLocation({days:'14',kind:'account',accountId:'secret',query:'private',view:'extra'});
 assert.deepEqual(location,{days:14});
 assert.equal(analyticsHref(location),'/admin/operations/analytics?days=14');
 assert.equal(analyticsLocation(Object.fromEntries(new URL(analyticsHref(location,{days:90}),'https://admin.invalid').searchParams)).days,90);
 assert.equal(analyticsLocation({days:'91'}).days,7);assert.equal(analyticsLocation({days:'0'}).days,7);assert.equal(analyticsLocation({days:'-1'}).days,7);
 const accountId='00256f3b-63a7-4419-9a80-68ed83b31231';
 for(const kind of ['overview','retention','paths','business']){const url=new URL(analyticsPath(kind,14,accountId),'https://admin.invalid');assert.equal(url.pathname,'/v1/operations/discovery/analytics');assert.deepEqual([...url.searchParams.keys()],['kind','days']);assert.equal(url.searchParams.get('days'),'14');}
 const account=new URL(analyticsPath('account',90,accountId),'https://admin.invalid');assert.equal(account.searchParams.get('accountId'),accountId);
 assert.equal(analyticsPath('account',7,'../private'),null);assert.equal(analyticsPath('unknown',7),null);assert.equal(analyticsPath('overview',91),null);
});

test('native overview displays the actual summary without adding daily uniques or inventing missing metrics',()=>{
 const data=analyticsOverview({summary:{unique_visitors:7,total_screen_views:0,total_sessions:12,bounce_rate:25,avg_session_duration:null,views_per_session:1.5,total_revenue:9876,activeAccounts:9},series:[{date:'2026-10-21T00:00:00Z',unique_visitors:6,total_screen_views:0,total_sessions:null},{date:'2026-10-22T00:00:00Z',unique_visitors:6,total_screen_views:8,total_sessions:5},{date:'bad-date',unique_visitors:100}],interval:'day'});
 assert.equal(data.summary.unique_visitors,7);assert.equal(data.series.reduce((sum,row)=>sum+row.unique_visitors,0),12);
 assert.equal(data.summary.total_screen_views,0);assert.equal(data.summary.avg_session_duration,null);assert.equal(data.series[0].total_sessions,null);assert.equal(data.series.length,2);
 assert.equal(JSON.stringify(data).includes('revenue'),false);assert.equal(JSON.stringify(data).includes('activeAccounts'),false);
 const unknown=analyticsOverview({summary:{unique_visitors:'12',total_sessions:-1,total_screen_views:Number.NaN,bounce_rate:101},series:[]});
 assert.equal(unknown.summary.unique_visitors,null);assert.equal(unknown.summary.total_sessions,null);assert.equal(unknown.summary.total_screen_views,null);assert.equal(unknown.summary.bounce_rate,null);
 assert.equal(analyticsOverview({summary:{},series:null}),null);
});

test('native percent and time units distinguish unknowns, zero and recorded values',()=>{
 assert.equal(analyticsNumber(null),'—');assert.equal(analyticsNumber(undefined),'—');assert.equal(analyticsNumber(0),'0');assert.equal(analyticsNumber(Number.POSITIVE_INFINITY),'—');
 assert.equal(analyticsPercent(25),'25%');assert.equal(analyticsPercent(.25,'ratio'),'25%');assert.equal(analyticsPercent(0),'0%');assert.equal(analyticsPercent(null),'—');assert.equal(analyticsPercent(1.5,'ratio'),'—');
 assert.equal(analyticsDurationSeconds(null),'—');assert.equal(analyticsDurationSeconds(0),'0 秒');assert.equal(analyticsDurationSeconds(60),'1 分 0 秒');assert.equal(analyticsDurationSeconds(119.8),'2 分 0 秒');
 assert.equal(analyticsDate('2026-10-22T23:00:00Z'),'10/22');assert.equal(analyticsDate('bad'),'未记录');
});

test('weekly retention keeps native ratios and weights while masking periods not yet reached',()=>{
 const checkedAt=Date.parse('2026-10-23T06:00:00Z')/1000;
 const value=[{cohort_interval:'2026-10-18',sum:4,values:[4,0,0],percentages:[1,0,0]},{cohort_interval:'Weighted Average',sum:10,values:[10,4,0],percentages:[1,.41,0]},{cohort_interval:'2026-10-04',sum:20,values:[20,0,0],percentages:[1,0,null]}];
 const retention=analyticsRetention(value,checkedAt);
 assert.deepEqual(retention.rows.map(row=>row.cohort),['Weighted Average','2026-10-04','2026-10-18']);
 assert.deepEqual(retention.weeks,[0,1,2]);
 assert.deepEqual(retention.rows[0].cells[1],{week:1,count:4,ratio:.41,state:'recorded'});
 assert.deepEqual(retention.rows[1].cells[1],{week:1,count:0,ratio:0,state:'recorded'});
 assert.equal(retention.rows[1].cells[2].state,'unknown');
 assert.deepEqual(retention.rows[2].cells[1],{week:1,count:null,ratio:null,state:'not-reached'});
 assert.deepEqual(analyticsRetention([],checkedAt),{rows:[],weeks:[]});assert.equal(analyticsRetention(value,Number.NaN),null);
 const zeroSize=analyticsRetention([{cohort_interval:'2026-10-04',sum:0,values:[0],percentages:[0]}],checkedAt);assert.equal(zeroSize.rows[0].cells[0].ratio,null);
});

test('native paths retain branched transitions without deriving a funnel or exposing arbitrary event labels',()=>{
 const value={nodes:[{id:'search-2',label:'search',step:2,value:3,percentage:30},{id:'entry-1',label:'screen_view',step:1,value:10,percentage:100},{id:'read-2',label:'content-view',step:2,value:6,percentage:60},{id:'bookmark-3',label:'content-bookmark',step:3,value:null,percentage:null}],links:[{source:'entry-1',target:'read-2',value:6},{source:'entry-1',target:'search-2',value:3},{source:'read-2',target:'bookmark-3',value:null},{source:'search-2',target:'bookmark-3',value:0},{source:'bookmark-3',target:'entry-1',value:50},{source:'entry-1',target:'absent',value:50}],totalAccounts:500,conversionRate:.4};
 const flow=analyticsFlow(value);
 assert.equal(flow.nodes[0].label,'页面访问');assert.equal(flow.nodes.length,4);assert.equal(flow.links.length,4);assert.equal(flow.links[2].value,null);assert.equal(flow.links[3].value,0);
 assert.equal(JSON.stringify(flow).includes('conversionRate'),false);assert.equal(JSON.stringify(flow).includes('totalAccounts'),false);
 assert.deepEqual(analyticsFlow({nodes:[],links:[]}),{nodes:[],links:[]});
 assert.equal(analyticsFlow({nodes:[{id:'private',label:'private query body',step:1,value:1}],links:[]}),null);
});

test('business volumes use four explicit full-window event sums and never replace missing counts with zero',()=>{
 const data=analyticsBusiness({unit:'events',current:{reads:1000,searches:0,bookmarks:null,participations:7,extra:888},previous:{reads:900,searches:5,bookmarks:3,participations:NaN},items:[{count:2}],revenue:22});
 assert.deepEqual(data,{unit:'events',current:{reads:1000,searches:0,bookmarks:null,participations:7},previous:{reads:900,searches:5,bookmarks:3,participations:null}});
 assert.equal(analyticsBusiness({unit:'users',current:{reads:1},previous:{}}),null);assert.equal(analyticsBusiness({unit:'events',current:{},previous:null}),null);
 assert.deepEqual(analyticsBusiness({unit:'events',current:{},previous:{}}).current,{reads:null,searches:null,bookmarks:null,participations:null});
});
