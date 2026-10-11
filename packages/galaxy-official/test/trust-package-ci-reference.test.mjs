import test from 'node:test';
import {verifyCiReferenceExport,verifyCiReferenceScope,verifyCiReferenceExpiry,verifyCiReferenceRevocation,verifyCiReferenceLateExpiry} from './trust-package-ci-reference-workflow.mjs';
test('CI issuer reference uses actual current signed HTTP source and serial ordinary package imports without copying or issuing Proof', {timeout:60000},()=>verifyCiReferenceExport());
test('CI reference preserves issuer versus subject and rejects copy, foreign association, stale version and unknown extensions', {timeout:60000},()=>verifyCiReferenceScope());
test('CI reference clamps the validated inner JWT expiry and stops expired source export without changing old signed bytes', {timeout:60000},()=>verifyCiReferenceExpiry());
test('CI source Consent withdrawal stops new export but offline package integrity never asserts current rights', {timeout:60000},()=>verifyCiReferenceRevocation());
test('CI signed expiry crossing during the canonical reread gives an unavailable item with no late metadata export', {timeout:60000},()=>verifyCiReferenceLateExpiry());
