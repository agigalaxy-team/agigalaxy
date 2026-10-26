import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurrentOfficialAccount,sameOfficialSession} from '../src/official-account-reading.mjs';

const session=(expiresAt=200)=>({state:'signed-in',account:{id:'account-a',uid:'GALAXY01',displayName:'成员',email:null,emailVerified:true},linkedIds:[],nextAfter:null,expiresAt,csrfToken:'synthetic-csrf',galaxyAuthorization:false});

test('a verified account reader uses the live renewed session without changing its owner',async()=>{
 const live=session(),seen=[];
 const client={call:async(_path,_input,options)=>{seen.push(options.session);return {items:['current']};}};
 let model={phase:'signed-in',session:live,client};
 const account=createCurrentOfficialAccount({client,accountId:'account-a',csrfToken:live.csrfToken,getCurrent:()=>model,now:()=>100000});
 assert.equal(sameOfficialSession(live,structuredClone(live)),true);
 const renewed={...live,expiresAt:400,account:{...live.account,displayName:'更新后的名称'}};
 assert.equal(sameOfficialSession(live,renewed),false);
 model={...model,session:renewed};
 assert.deepEqual(await account.call('/current',{}, {session:{...live,account:{id:'forged'}}}),{items:['current']});
 assert.equal(seen[0],renewed);
 model={...model,phase:'offline'};
 await assert.rejects(account.call('/current'),{code:'official_account_unavailable'});
 assert.equal(seen.length,1);
});

test('late account JSON and bytes are rejected after logout, replacement, expiry or client change',async()=>{
 for(const method of ['call','transfer'])for(const change of ['logout','account','csrf','expired','client']){
  let finish;
  const live=session(),client={[method]:async()=>new Promise(resolve=>{finish=resolve;})};
  let model={phase:'signed-in',session:live,client};
  const account=createCurrentOfficialAccount({client,accountId:live.account.id,csrfToken:live.csrfToken,getCurrent:()=>model,now:()=>100000});
  const pending=account[method]('/private',{});
  if(change==='logout')model={...model,phase:'signed-out',session:null};
  if(change==='account')model={...model,session:{...live,account:{...live.account,id:'account-b'}}};
  if(change==='csrf')model={...model,session:{...live,csrfToken:'replacement'}};
  if(change==='expired')model={...model,session:{...live,expiresAt:100}};
  if(change==='client')model={...model,client:{}};
  finish(method==='call'?{body:'must-not-return'}:new Response('must-not-return'));
  await assert.rejects(pending,{code:'official_account_changed'},method+':'+change);
 }
});
