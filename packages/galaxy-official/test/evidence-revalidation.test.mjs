import test from 'node:test';
import { verifyEvidenceRevalidation } from './evidence-revalidation-workflow.mjs';
test('explicit Evidence revalidation preserves observations and decisions while refreshing Proof, History and eligibility',()=>verifyEvidenceRevalidation());
