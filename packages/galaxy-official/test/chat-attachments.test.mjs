import test from 'node:test';
import {verifyAttachments} from './chat-attachments-workflow.mjs';
test('temporary room attachments retain original identity, real HTTP authorization and independent lifecycles',{timeout:90000},async()=>{console.log(JSON.stringify(await verifyAttachments()));});
