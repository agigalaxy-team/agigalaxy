import test from 'node:test';
import {verifyCapsuleV2Workflow,verifyCapsuleV2MultiParty,verifyCapsuleV2Redaction,verifyCapsuleV2VersionBoundaries} from './capsules-v2-workflow.mjs';
test('Capsule v2 HTTP, actual reference/apply/verification remains bounded and source revocation propagates',()=>verifyCapsuleV2Workflow(undefined,{testHttp:true}));
test('Capsule v2 requires actual author permission and reuses an existing covering grant',verifyCapsuleV2MultiParty);
test('Capsule v2 retained foreign use cannot recover a redacted source body',verifyCapsuleV2Redaction);
test('Capsule v2 versions never retarget actual reuse or fall back over a private latest version',verifyCapsuleV2VersionBoundaries);
