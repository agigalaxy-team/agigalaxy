import test from 'node:test';
import { verifyBuilderWorkEvidence } from './builder-work-evidence-workflow.mjs';

test('Node-signed exact Case/Attempt/Proof associations retain live sources, independent identities, visibility and revocation',()=>verifyBuilderWorkEvidence());
