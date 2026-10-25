import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../package.json',import.meta.url));
const {buildSync}=require('esbuild');
async function model(name){const result=buildSync({entryPoints:[fileURLToPath(new URL('../src/lib/'+name+'.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));}
const overview=await model('analytics-view-model'),account=await model('account-usage-analysis-view-model');
test('session-dependent metrics require their known denominator while real and unknown zero values stay distinct',()=>{
 const accountId='00000000-0000-4000-8000-000000000001',checkedAt=1792799000,readExpiresAt=checkedAt+30;
 for(const sessions of [0,1,2,null,undefined]){
  const summary={unique_visitors:0,total_screen_views:0,total_sessions:sessions,bounce_rate:0,avg_session_duration:0,views_per_session:0};
  const parsed=overview.analyticsOverview({summary,series:[{date:'2026-10-23',unique_visitors:0,total_screen_views:0,total_sessions:0}]});
  assert.equal(parsed.summary.total_sessions,sessions??null);
  assert.equal(parsed.summary.total_screen_views,0);assert.equal(parsed.series[0].total_sessions,0);
  for(const key of ['bounce_rate','avg_session_duration','views_per_session'])assert.equal(parsed.summary[key],sessions===0?null:0,`overview ${sessions} ${key}`);
  assert.equal(overview.analyticsPercent(parsed.summary.bounce_rate),sessions===0?'—':'0%');
  const empty={availability:{state:'not-connected',code:null},checkedAt,readExpiresAt,basis:null,data:null};
  const data={sessions,screenViews:0,totalEvents:0,conversionEvents:0,uniqueDaysActive:0,avgSessionDurationMin:0,p90SessionDurationMin:0,avgEventsPerSession:0,avgTimeBetweenSessionsSec:0,bounceRate:0,firstSeen:null,lastSeen:null};
  const raw={accountId,source:'openpanel-native',purpose:'site-usage-analytics',historicalBackfill:false,metadataOnly:true,checkedAt,readExpiresAt,coverage:['account'],lifetime:{availability:{state:'available',code:null},checkedAt,readExpiresAt,basis:{window:'native-lifetime',accountId},data},paths:empty,retention:empty};
  const parsedAccount=account.accountUsageAnalysis(raw,accountId).lifetime.data;
  assert.equal(parsedAccount.sessions,sessions??null);assert.equal(parsedAccount.totalEvents,0);assert.equal(parsedAccount.screenViews,0);
  for(const key of ['avgSessionDurationMin','p90SessionDurationMin','avgEventsPerSession','bounceRate'])assert.equal(parsedAccount[key],sessions===0?null:0,`account ${sessions} ${key}`);
  assert.equal(parsedAccount.avgTimeBetweenSessionsSec,sessions===0||sessions===1?null:0);
  assert.equal(overview.analyticsDurationSeconds(parsedAccount.avgTimeBetweenSessionsSec),sessions===0||sessions===1?'—':'0 秒');
  assert.equal(data.avgTimeBetweenSessionsSec,0);assert.equal(summary.bounce_rate,0);
 }
 const measured=overview.analyticsOverview({summary:{total_sessions:2,bounce_rate:25,avg_session_duration:12,views_per_session:3},series:[]});
 assert.equal(measured.summary.bounce_rate,25);assert.equal(measured.summary.avg_session_duration,12);assert.equal(measured.summary.views_per_session,3);
 const noSessions=overview.analyticsOverview({summary:{total_sessions:0,bounce_rate:25,avg_session_duration:12,views_per_session:3},series:[]});
 assert.equal(noSessions.summary.bounce_rate,null);assert.equal(noSessions.summary.avg_session_duration,null);assert.equal(noSessions.summary.views_per_session,null);
});
