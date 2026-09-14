import test from 'node:test';
import { verifyCapsuleWorkflow } from './capsule-workflow.mjs';
test('Capsule versions, explicit reuse and CI rechecks preserve failure history, visibility and notices',async()=>{
  console.log(JSON.stringify({event:'capsule_reuse_acceptance',...await verifyCapsuleWorkflow()}));
});
