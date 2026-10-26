import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationOperationReceipts} from "../src/operations/agentos/operation-receipts.mjs";

test('all card kinds use same-owner original receipt reads without any action replay',async()=>{
 const kinds=['search-apply','search-restore','recommendation-direction','rule-publish','rule-restore','content-visibility','account-restriction','message-draft-save','file-access'];
 const rows=kinds.map((kind,i)=>({id:'card-'+i,operation_id:'operation-'+i,state:'completed',proposal:{kind},result:{state:'completed'}}));
 const queries=[],recoveries=[];
 const tools={endpoint:'e',now:()=>100,db:{async query(sql,args){queries.push({sql,args});return {rows:sql.startsWith('SELECT created_at')?[{created_at:new Date()}]:rows};}},conversations:{async current(){return {row:{domain:'overview',ai_account_id:'fixed-ai'}};}},async cardActor(actor){return actor;},actions:{async recoverPrepared(actor,proposal,id){recoveries.push(id);return {operationId:id,state:'completed',summary:'Recorded',receipt:{operationId:id,enabled:false,version:5,rawPrivate:'CANARY'}};}}};
 const result=await conversationOperationReceipts(tools,{operatorId:'owner'},'overview',{conversationId:'c',turnId:'t'});
 assert.equal(result.items.length,kinds.length);assert.equal(recoveries.length,kinds.length);assert.equal(result.valuesCurrent,false);
 assert.deepEqual(queries[1].args.slice(0,4),['e','owner','overview','fixed-ai']);assert.doesNotMatch(JSON.stringify(result),/CANARY|rawPrivate/);
 assert.deepEqual(result.items.find(x=>x.kind==='search-apply').currentRead,{module:'search',view:'overview'});
 assert.equal(result.items.find(x=>x.kind==='recommendation-direction').recordedEffect.enabled,false);
});

test('denied cards are excluded; unknown receipts never become completed',async()=>{
 const rows=[{id:'denied',operation_id:'op1',state:'completed',proposal:{kind:'search-apply'}},{id:'unknown',operation_id:'op2',state:'unknown',proposal:{kind:'search-apply'}}];
 const tools={endpoint:'e',now:()=>100,db:{async query(sql){return {rows:sql.startsWith('SELECT created_at')?[{created_at:new Date()}]:rows};}},conversations:{async current(){return {row:{domain:'overview',ai_account_id:'fixed'}};}},async cardActor(actor,row){if(row.id==='denied')throw Error('denied');return actor;},actions:{async recoverPrepared(a,p,id){return {operationId:id,state:'unknown',summary:'Unknown',receipt:null};}}};
 const result=await conversationOperationReceipts(tools,{operatorId:'owner'},'overview',{conversationId:'c',turnId:'t'});
 assert.equal(result.availability,'partial');assert.equal(result.items.length,1);assert.equal(result.items[0].state,'unknown');assert.notEqual(result.items[0].effectExecuted,true);
});
