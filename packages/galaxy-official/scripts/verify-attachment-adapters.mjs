import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {loadAttachmentConfiguration} from '../deploy/support/attachment-configuration.mjs';
// Explicit synthetic infrastructure verification: no account, room or message.
let config,key;
try {
 config=await loadAttachmentConfiguration();assert.ok(config,'Explicit configuration required');
 key='attachments/'+randomUUID();
 const bytes=Buffer.from('Galaxy private attachment synthetic adapter check.\n'),sha256=createHash('sha256').update(bytes).digest('hex');
 await config.store.put({key,bytes,sha256});
 assert.deepEqual(await config.store.head({key,keyId:config.store.keyId}),{size:bytes.length,sha256});
 assert.deepEqual(await config.store.get({key,keyId:config.store.keyId,size:bytes.length}),bytes);
 const clean=await config.scanner.scan(bytes);assert.equal(clean.state,'clean');
 // EICAR's harmless industry test string is generated in memory, never stored.
 const marker=Buffer.from('X5O!P%@AP[4'+String.fromCharCode(92)+'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
 const detected=await config.scanner.scan(marker);assert.equal(detected.state,'blocked');
 await config.store.erase({key});
 assert.equal(await config.store.head({key,keyId:config.store.keyId}),null);key=null;
 process.stdout.write(JSON.stringify({checkedAt:new Date().toISOString(),scope:'synthetic-private-storage-and-real-scanner; no-product-message',
  encryptedPutGetHeadDelete:true,cleanScan:clean.state,eicarScan:detected.state,engineVersion:clean.engineVersion,databaseVersion:clean.databaseVersion,
  objectRemoved:true,physicalBlockErasure:'storage-garbage-collection',roomAcceptanceVerified:false})+'\n');
} catch(error) {process.stderr.write(JSON.stringify({failed:true,code:typeof error?.code==='string'?error.code:'attachment_adapter_verification_failed'})+'\n');process.exitCode=1;}
finally {if(key&&config)await config.store.erase({key}).catch(()=>{process.exitCode=1;});config?.store.close();}
