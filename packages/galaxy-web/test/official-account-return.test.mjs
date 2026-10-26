import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberOfficialAccountReturn,restoredOfficialAccountReturn} from "../src/features/accounts/official-account-return.mjs";
const website='https://galaxy.example.org',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',target='/app/settings/identity?section=account';
const storage=()=>{const rows=new Map();return{getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),rows};};

test('a tab-local navigation reference preserves the exact original page across successful and failed account login',()=>{
 const store=storage(),options={website,storage:store,now:()=>1000,randomUUID:()=>id};
 const returned=rememberOfficialAccountReturn(target,'/app/bookmarks?kind=project#saved',options),url=new URL(returned,website);
 assert.equal(url.searchParams.get('accountReturn'),id);
 assert.equal(restoredOfficialAccountReturn(url,{storage:store,now:()=>2000}),'/app/bookmarks?kind=project#saved');
 url.searchParams.set('accountLogin','failed');assert.equal(restoredOfficialAccountReturn(url,{storage:store,now:()=>2000}),'/app/bookmarks?kind=project#saved');
 assert.equal(Object.keys(JSON.parse([...store.rows.values()][0])).sort().join(','),'expiresAt,returnTo,target,version');
});

test('missing, expired, changed-page and external navigation references never select an original destination',()=>{
 const store=storage(),options={website,storage:store,now:()=>1000,randomUUID:()=>id};
 const returned=rememberOfficialAccountReturn(target,'/app/publish',options),url=new URL(returned,website);
 assert.equal(restoredOfficialAccountReturn(url,{storage:storage(),now:()=>2000}),null);
 assert.equal(restoredOfficialAccountReturn(url,{storage:store,now:()=>601001}),null);
 url.searchParams.set('section','other');assert.equal(restoredOfficialAccountReturn(url,{storage:store,now:()=>2000}),null);
 for(const value of ['//other.invalid/app/work','https://other.invalid/app/work','/app/%0aother','/app/settings/identity'])assert.equal(rememberOfficialAccountReturn(target,value,options),target);
});
