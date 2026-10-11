import test from 'node:test';
import {verifyOrdinaryLateSave,verifyOrdinaryEntryRead,verifyOrdinaryOldPreview,verifyOrdinaryLocalReadAba,
 verifyOrdinaryOwnerSwitch,verifyOrdinarySourcesAwait,verifyOrdinaryPermissionReceipt} from './trust-package-client-continuity-workflow.mjs';
test('ordinary last-export completion reconnect withholds old private output and retains original artifact',verifyOrdinaryLateSave);
test('ordinary lease is captured before first device-material await',verifyOrdinaryEntryRead);
test('ordinary stale preview is rejected and one preview signs only once across queue',verifyOrdinaryOldPreview);
test('ordinary last-export null-binding ABA is fenced while disconnected local export remains supported',verifyOrdinaryLocalReadAba);
test('ordinary local read switches owner without returning or writing old owner package to new namespace',verifyOrdinaryOwnerSwitch);
test('ordinary source refresh reconnect cannot continue an old export',verifyOrdinarySourcesAwait);
test('ordinary permission lost ACK reconnect recovers exact original receipt without another submission',verifyOrdinaryPermissionReceipt);

