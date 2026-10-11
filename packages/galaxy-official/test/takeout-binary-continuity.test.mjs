import test from 'node:test';
import {verifyTakeoutBinaryRead,verifyTakeoutBinarySourceValidity,verifyTakeoutBinaryTicketValidity}
 from './takeout-binary-continuity-workflow.mjs';

test('same signed export binary remains readable only within the declared takeout phase, with exact paths and hashes',
 {timeout:60000},()=>verifyTakeoutBinaryRead());
test('takeout binary never restores a revoked or expired independent source approval',
 {timeout:60000},()=>verifyTakeoutBinarySourceValidity());
test('takeout binary still rejects a revoked or expired ticket even while its source remains readable',
 {timeout:60000},()=>verifyTakeoutBinaryTicketValidity());

