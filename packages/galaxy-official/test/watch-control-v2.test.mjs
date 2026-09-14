import test from 'node:test';
import {verifyWatchControlV2} from './watch-control-v2-workflow.mjs';
test('Watch same-ID transfer uses exact current device control and server ACK',verifyWatchControlV2);
