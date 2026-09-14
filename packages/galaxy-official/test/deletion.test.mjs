import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeletionWorkflow } from './deletion-workflow.mjs';
import { deletionIntentSchema } from '../src/shared/deletion-schema.mjs';
test('signed deletion intake/client/host joins operator review, owner history, cancellation and export without erasing data',()=>verifyDeletionWorkflow());
test('deletion input has no arbitrary target subject override, table selection, future expiry or executable SQL',()=>{
  const value={version:1,id:'24ad3e5c-3120-4e30-8f13-acbf8f4b2762',endpoint:'https://official.example.org',subjectId:'GUID'+'A'.repeat(28),
    bindingId:'ae44ad01-347c-40f6-a1bf-054409c90567',issuedAt:2000000000,expiresAt:2000000300,action:'request',scope:'all-owned-service-data',reason:'privacy',takeout:'not-needed'};
  assert.equal(deletionIntentSchema.safeParse(value).success,true);
  assert.equal(deletionIntentSchema.safeParse({...value,sql:'DELETE FROM subjects'}).success,false);
  assert.equal(deletionIntentSchema.safeParse({...value,expiresAt:value.expiresAt+1}).success,false);
  assert.equal(deletionIntentSchema.safeParse({...value,exportManifestSha256:'a'.repeat(64)}).success,false);
});
