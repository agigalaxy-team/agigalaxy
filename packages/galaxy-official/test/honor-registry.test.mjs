import test from 'node:test';
import { verifyHonorRegistry } from './honor-registry-workflow.mjs';
test('Honor rule versions survive configuration replacement and restart while current cards follow revocation',async()=>{
  console.log(JSON.stringify({event:'honor_rule_registry_verified',...await verifyHonorRegistry()}));
});
