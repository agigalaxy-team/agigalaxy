import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRuntimeError} from '../src/node/runtime-diagnostics.mjs';

test('current SDK/platform source locations survive relocation without disclosing absolute paths or error text',()=>{
 const error=new Error('PRIVATE upstream and database detail');
 error.stack='Error: PRIVATE\n'+[
  '    at load (C:\\private-user\\project\\packages\\galaxy-client\\src\\node\\connection.mjs:12:3)',
  '    at verify (/opt/private/packages/galaxy-contracts/src/verification.mjs:22:5)',
  '    at service (/opt/private/packages/galaxy-official/deploy/maintenance-agent/runtime.mjs:32:7)',
  '    at unknown (https://private.invalid/secret?token=PRIVATE:9:1)',
  '    at escaped (/opt/packages/galaxy-client/src/../../private.mjs:8:1)',
 ].join('\n');
 const result=safeRuntimeError(error);
 assert.deepEqual(result.stackFrames,[
  {file:'packages/galaxy-client/src/node/connection.mjs',line:12,column:3},
  {file:'packages/galaxy-contracts/src/verification.mjs',line:22,column:5},
  {file:'packages/galaxy-official/deploy/maintenance-agent/runtime.mjs',line:32,column:7},
 ]);
 assert(!JSON.stringify(result).includes('PRIVATE'));
});
