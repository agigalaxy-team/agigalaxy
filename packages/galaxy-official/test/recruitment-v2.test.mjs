import test from 'node:test';
import { verifyRecruitmentV2 } from './recruitment-v2-workflow.mjs';
test('long-term Recruitment stays distinct from Task, with current representative and real shared public-write quota',{timeout:120000},()=>verifyRecruitmentV2());
