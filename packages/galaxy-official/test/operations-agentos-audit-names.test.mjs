import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {auditItem} from "../src/operations/agentos/query-view.mjs";

test('AI audit projection uses the resolved human name, preserves unknown and never names a program as a person',()=>{
 const operatorId='a'.repeat(64),base={id:randomUUID(),sequence:'1',action:'feedback-update',actorKind:'business-operator',operatorId,operatorRole:'administrator',
  createdAt:'2026-10-24T00:00:00.000Z',selection:{state:'processing',reason:'PRIVATE_REASON'},result:{revision:2,note:'PRIVATE_NOTE'}};
 const known=auditItem({...base,operatorDisplayName:' 合成运营负责人 '});
 assert.equal(known.operatorDisplayName,'合成运营负责人');assert.equal(known.actorKind,'business-operator');assert(!JSON.stringify(known).includes(operatorId));
 for(const operatorDisplayName of [null,undefined,'  '])assert.equal(auditItem({...base,operatorDisplayName}).operatorDisplayName,null);
 const execution=auditItem({...base,actorKind:'operations-executor',executionId:randomUUID(),grantId:randomUUID(),operatorDisplayName:'不得归给人工的程序名称'});
 assert.equal(execution.actorKind,'operations-executor');assert.equal(execution.operatorDisplayName,null);
 assert(!JSON.stringify([known,execution]).includes('PRIVATE_'));assert(!JSON.stringify(execution).includes('不得归给人工'));
});
