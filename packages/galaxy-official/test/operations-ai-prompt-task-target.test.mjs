import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {AutonomyReadModel} from '../src/operations/autonomy/views.mjs';
import {proposalTargetTypeSql} from '../src/operations/autonomy/sources.mjs';
import {originalOperationTarget} from "../src/operations/agentos/duty-receipts.mjs";

test('prompt card and receipt use one real SQL source kind and current metadata permission',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 const target={kind:'ai-work-prompt',id:'22222222-2222-4222-8222-222222222222'};
 const sql=(await db.query('SELECT '+proposalTargetTypeSql('$1::jsonb')+' AS kind',[JSON.stringify({target})])).rows[0].kind;
 const receipt=originalOperationTarget(target,{});assert.equal(sql,'ai-work-account');assert.equal(receipt.targetType,sql);
 const read=new AutonomyReadModel(),calls=[];
 read.businessAdmin={authorizeAction:async(actor,permission)=>{calls.push(permission);if(!actor.businessAuthorization.permissions.includes(permission))throw Object.assign(Error('current permission denied'),{status:403});return actor;}};
 read.queryTools={read:async()=>assert.fail('Task metadata cannot fetch prompt text')};
 const row={target_type:sql,target_id:target.id},actor={businessAuthorization:{permissions:['autonomy.read','ai.accounts.read']}};
 await read.checkTarget(actor,row,{includeReceipts:false});assert.deepEqual(calls,['ai.accounts.read']);
 await assert.rejects(read.checkTarget({businessAuthorization:{permissions:['autonomy.read']}},row,{includeReceipts:false}),{status:403});
});
