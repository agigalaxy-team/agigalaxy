import test from 'node:test';
import {verifyCiV2} from './ci-observation-v2-workflow.mjs';
test('Native v2 CI observes actual scoped source contracts and invalidates public proofs on correction/revocation',()=>verifyCiV2());
