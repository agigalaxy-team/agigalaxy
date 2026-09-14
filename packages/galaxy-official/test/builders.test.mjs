import test from 'node:test';
import assert from 'node:assert/strict';
import { builderDeclaration,verifyBuildersWorkflow } from './builders-workflow.mjs';
import { builderDeclarationSchema } from '../src/shared/builders-schema.mjs';
test('builder registry HTTP/client lifecycle preserves declarations, assessor provenance, maintenance and limited evidence',()=>verifyBuildersWorkflow());
test('builder declarations keep Bridge evidence ceilings and structured metadata separate from secret configuration',()=>{
  const owner='GUID'+'0'.repeat(28),worker=builderDeclaration('worker',owner),bridge=builderDeclaration('bridge',owner),hub=builderDeclaration('hub',owner);
  for(const value of [worker,bridge,hub])assert.ok(builderDeclarationSchema.safeParse(value).success);
  assert.equal(builderDeclarationSchema.safeParse({...worker,privatePrompt:'synthetic forbidden field'}).success,false);
  assert.equal(builderDeclarationSchema.safeParse({...bridge,mapping:{...bridge.mapping,strengthCeiling:'E4'}}).success,false);
  assert.equal(builderDeclarationSchema.safeParse({...hub,endpoint:'https://user:synthetic@example.org'}).success,false);
});
