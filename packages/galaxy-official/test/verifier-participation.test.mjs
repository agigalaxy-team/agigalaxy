import test from 'node:test';
import { verifyVerifierParticipation } from './verifier-participation-workflow.mjs';
test('verifier participation uses signed invitations and voluntary reviews while preserving source access, appeal and original facts',()=>verifyVerifierParticipation());
