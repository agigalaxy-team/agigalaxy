import test from 'node:test';
import { verifyQualificationPolicyRegistry } from './qualification-policy-registry-workflow.mjs';
test('qualification versions retain their meaning through removal, restart and concurrent configuration changes',async()=>{
  console.log(JSON.stringify(await verifyQualificationPolicyRegistry()));
});
