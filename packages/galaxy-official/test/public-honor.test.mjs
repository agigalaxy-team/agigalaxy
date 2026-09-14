import test from 'node:test';
import { verifyPublicHonor } from './public-honor-workflow.mjs';
test('explicit public contribution events produce a scoped Honor ranking with live withdrawal',async()=>{
  console.log(JSON.stringify({event:'public_honor_workflow_verified',...await verifyPublicHonor()}));
});
