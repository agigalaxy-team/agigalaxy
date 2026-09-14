import test from 'node:test';
import { verifyChatOwnerMetadataExport } from './chat-owner-export-workflow.mjs';
test('owner export includes chat metadata and byte reservations without shared bodies or others votes', {timeout:60000},()=>verifyChatOwnerMetadataExport());
