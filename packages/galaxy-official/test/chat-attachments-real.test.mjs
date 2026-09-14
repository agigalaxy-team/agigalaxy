import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadAttachmentConfiguration} from '../src/infrastructure/attachment-configuration.mjs';
import {ProsodyChatTransport} from '../src/infrastructure/prosody-chat.mjs';
import {verifyAttachments} from './chat-attachments-workflow.mjs';
test('isolated real Prosody plus private encrypted S3 and ClamAV complete temporary file lifecycle',{timeout:180000},async()=>{
 assert.equal(process.env.GALAXY_TEST_CHAT_ISOLATED,'1','Dedicated synthetic Prosody component required; do not displace a running API component');
 const storage=await loadAttachmentConfiguration();assert.ok(storage,'Explicit private storage configuration required');
 const transport=new ProsodyChatTransport({service:process.env.GALAXY_TEST_CHAT_SERVICE??'xmpp://127.0.0.1:5347',domain:'gateway.galaxy.internal',roomsDomain:'rooms.galaxy.internal',
  secret:(await readFile(process.env.GALAXY_TEST_CHAT_SECRET_FILE,'utf8')).trim()});
 try{await transport.start();const result=await verifyAttachments({store:storage.store,scanner:storage.scanner,transport});console.log(JSON.stringify({checkedAt:new Date().toISOString(),...result,metadataDatabase:'isolated-PGlite',transport:'real-Prosody',websiteVisualAcceptance:false}));}
 finally{await transport.stop();storage.store.close();}
});
