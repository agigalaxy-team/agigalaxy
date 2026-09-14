import test from 'node:test';
import {verifyBuilderSupportV2Workflow} from './builder-support-v2-workflow.mjs';
test('Builder support/Pack scopes use actual signed HTTP events and preserve old report semantics',()=>verifyBuilderSupportV2Workflow());
