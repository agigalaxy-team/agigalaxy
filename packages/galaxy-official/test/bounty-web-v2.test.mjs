import test from 'node:test';
import {verifyBountyWebV2} from './bounty-web-v2-workflow.mjs';
test('Bounty webpage actual signed HTTP publication, private quote, current qualification and counterpart consent',{timeout:120000},()=>verifyBountyWebV2());
