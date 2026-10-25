import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsData,queryProjection} from '../src/operations-agentos-query-view.mjs';

test('AI analytics projection keeps count zero but clears only mathematically undefined zero/one-session metrics in overview and both lifetime paths',()=>{
 for(const sessions of [0,1,2,null]){
  const raw={sessions,screenViews:0,totalEvents:0,conversionEvents:0,uniqueDaysActive:0,avgSessionDurationMin:0,p90SessionDurationMin:0,avgEventsPerSession:0,avgTimeBetweenSessionsSec:0,bounceRate:0,firstSeen:null,lastSeen:null};
  const account=analyticsData(raw,'account');
  const summary=queryProjection.accountSummary({usageAnalysis:{source:'openpanel-native',purpose:'site-usage-analytics',lifetime:{availability:{state:'available',code:null},checkedAt:1000,readExpiresAt:1030,basis:{window:'native-lifetime'},data:raw},paths:null,retention:null}}).usageAnalysis.lifetime.data;
  for(const value of [account,summary]){
   assert.equal(value.sessions,sessions);
   for(const field of ['screenViews','totalEvents','conversionEvents','uniqueDaysActive'])assert.equal(value[field],0);
   for(const field of ['avgSessionDurationMin','p90SessionDurationMin','avgEventsPerSession','bounceRate'])assert.equal(value[field],sessions===0?null:0);
   assert.equal(value.avgTimeBetweenSessionsSec,sessions===0||sessions===1?null:0);
  }
  const overview=analyticsData({summary:{unique_visitors:0,total_screen_views:0,total_sessions:sessions,bounce_rate:0,avg_session_duration:0,views_per_session:0},series:[]},'overview');
  assert.equal(overview.summary.total_sessions,sessions);
  assert.equal(overview.summary.unique_visitors,0);assert.equal(overview.summary.total_screen_views,0);
  for(const field of ['bounce_rate','avg_session_duration','views_per_session'])assert.equal(overview.summary[field],sessions===0?null:0);
  assert.equal(raw.bounceRate,0);assert.equal(raw.avgTimeBetweenSessionsSec,0);
 }
 const valid=analyticsData({sessions:2,avgSessionDurationMin:3,p90SessionDurationMin:8,avgEventsPerSession:4,avgTimeBetweenSessionsSec:3600,bounceRate:50},'account');
 assert.equal(valid.avgSessionDurationMin,3);assert.equal(valid.p90SessionDurationMin,8);assert.equal(valid.avgEventsPerSession,4);assert.equal(valid.avgTimeBetweenSessionsSec,3600);assert.equal(valid.bounceRate,50);
});

