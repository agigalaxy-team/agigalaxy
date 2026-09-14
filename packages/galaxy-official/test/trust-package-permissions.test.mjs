import test from 'node:test';
import {verifyTrustPermissions} from './trust-package-permissions-workflow.mjs';
test('trust reproduction permission uses real authors, current source visibility, exact version and audience, with independent offline signature validity',()=>verifyTrustPermissions());
