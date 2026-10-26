import assert from 'node:assert/strict';
import test from 'node:test';
import {analyticsAudienceBasis,analyticsHref,analyticsLocation,analyticsPath,analyticsRetention} from "../src/lib/analytics/analytics-view-model.ts";

const accountId='00256f3b-63a7-4419-9a80-68ed83b31231';
const sourceUrl='https://agigalaxy.org/open-source/openpanel-public2-galaxy-accounts-20261023/source.tar.gz';
const mixedRetention={window:'native-last-12-weeks',interval:'week',criteria:'on_or_after',activity:'any-event',population:'mixed-account-and-visitor-profiles',accountOnly:false,accountPrefixFilterSupported:false};
const accountBasis=kind=>({... (kind==='retention'?mixedRetention:{scope:'native-top-paths',unit:'account-session-path-transitions'}),identityScope:'accounts',population:'account-profiles',accountOnly:true,...(kind==='retention'?{accountPrefixFilterSupported:true,cohortEntry:'first-qualified-activity-in-window'}:{}),timezone:{source:'native-clickhouse-default',name:null},componentSourceUrl:sourceUrl});

test('account object and days continue through links and only scope the two supported native requests',()=>{
 const location=analyticsLocation({days:'14',scope:'accounts',accountId:accountId.toUpperCase(),query:'private',view:'unrelated'});
 assert.deepEqual(location,{days:14,scope:'accounts',accountId});
 const next=analyticsHref(location,{days:30});
 assert.deepEqual(analyticsLocation(Object.fromEntries(new URL(next,'https://admin.invalid').searchParams)),{days:30,scope:'accounts',accountId});
 assert.equal(analyticsHref(location,{scope:undefined}),'/admin/operations/analytics?days=14');
 assert.equal(analyticsHref(location,{accountId:undefined}),'/admin/operations/analytics?days=14&scope=accounts');
 assert.deepEqual(analyticsLocation({days:'14',accountId}),{days:14});
 assert.deepEqual(analyticsLocation({days:'14',scope:'accounts',accountId:'../private'}),{days:14,scope:'accounts'});
 for(const kind of ['retention','paths']){
  const query=new URL(analyticsPath(kind,kind==='retention'?7:14,accountId,'accounts'),'https://admin.invalid').searchParams;
  assert.deepEqual([...query.keys()],['kind','days','scope','accountId']);assert.equal(query.get('scope'),'accounts');assert.equal(query.get('accountId'),accountId);
 }
 for(const kind of ['overview','business']){assert.equal(analyticsPath(kind,14,accountId,'accounts'),null);assert.deepEqual([...new URL(analyticsPath(kind,14),'https://admin.invalid').searchParams.keys()],['kind','days']);}
 assert.equal(analyticsPath('retention',7,'bad','accounts'),null);
 assert.equal(new URL(analyticsPath('account',14,accountId),'https://admin.invalid').searchParams.get('accountId'),accountId);
});

test('account graphs require matching closed basis and never relabel mixed or another account as this account',()=>{
 const all={days:14},accounts={days:14,scope:'accounts'},single={...accounts,accountId};
 assert.deepEqual(analyticsAudienceBasis(mixedRetention,'retention',all),{object:'all',timeZone:null,componentSourceUrl:null});
 for(const kind of ['retention','paths']){
  const basis=accountBasis(kind);
  assert.deepEqual(analyticsAudienceBasis(basis,kind,accounts),{object:'accounts',timeZone:null,componentSourceUrl:sourceUrl});
  assert.equal(analyticsAudienceBasis(basis,kind,all),null);
  assert.equal(analyticsAudienceBasis(basis,kind,single),null);
  const scoped={...basis,population:'single-account-profile',accountId};
  assert.equal(analyticsAudienceBasis(scoped,kind,single).object,'account');
  assert.equal(analyticsAudienceBasis({...scoped,accountId:'00256f3b-63a7-4419-9a80-68ed83b31232'},kind,single),null);
  assert.equal(analyticsAudienceBasis({...basis,accountOnly:false},kind,accounts),null);
  assert.equal(analyticsAudienceBasis({...basis,componentSourceUrl:'https://unapproved.invalid/private'},kind,accounts).componentSourceUrl,null);
 }
 assert.equal(analyticsAudienceBasis(mixedRetention,'retention',accounts),null);
 assert.equal(analyticsAudienceBasis({...accountBasis('retention'),cohortEntry:'registration'},'retention',accounts),null);
 assert.equal(analyticsAudienceBasis({...accountBasis('paths'),unit:'session-path-transitions'},'paths',accounts),null);
 const zone=analyticsAudienceBasis({...accountBasis('paths'),timezone:{source:'native-project-settings',name:'Asia/Shanghai'}},'paths',accounts);
 assert.equal(zone.timeZone,'Asia/Shanghai');
 assert.equal(analyticsAudienceBasis({...accountBasis('paths'),timezone:{source:'unapproved',name:'Asia/Shanghai'}},'paths',accounts).timeZone,null);
 assert.equal(analyticsAudienceBasis({...accountBasis('paths'),timezone:{source:'native-project-settings',name:'arbitrary private text'}},'paths',accounts).timeZone,null);
});

test('cohort maturity follows a supplied native calendar and keeps an unknown timezone boundary unknown',()=>{
 const checkedAt=Date.parse('2026-10-25T00:30:00Z')/1000;
 const raw=[{cohort_interval:'2026-10-18',sum:1,values:[1,0,0],percentages:[1,0,0]}];
 const east=analyticsRetention(raw,checkedAt,'Asia/Shanghai').rows[0];
 const west=analyticsRetention(raw,checkedAt,'America/Los_Angeles').rows[0];
 const unknown=analyticsRetention(raw,checkedAt,null).rows[0];
 assert.equal(east.cells[1].state,'recorded');assert.equal(east.cells[1].ratio,0);
 assert.equal(west.cells[1].state,'not-reached');assert.equal(west.cells[1].ratio,null);
 assert.deepEqual(unknown.cells[1],{week:1,count:null,ratio:null,state:'unknown'});
 assert.equal(unknown.cells[0].state,'recorded');assert.equal(unknown.cells[2].state,'not-reached');
});
