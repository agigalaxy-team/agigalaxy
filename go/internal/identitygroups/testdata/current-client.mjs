import {readFile} from 'node:fs/promises';
import {createPrivateKey,randomUUID,webcrypto} from 'node:crypto';
import {identityGroupIntentSchema,identityGroupProofSchema,identityGroupSignatureType} from '../../../../packages/galaxy-contracts/src/identity-group-v2-schema.mjs';
import {signIdentityPayload} from '../../../../packages/galaxy-contracts/src/identity/identity-material.mjs';
import {createIdentityGroupDeviceSignerV2} from '../../../../packages/galaxy-client/src/identity/group-device-signer-v2.mjs';
import {digest} from '../../../../packages/galaxy-contracts/src/digest.mjs';
let raw='';for await(const c of process.stdin)raw+=c;const q=JSON.parse(raw),material=JSON.parse(await readFile(q.materialPath,'utf8'));
const payloadJson=JSON.stringify(identityGroupIntentSchema.parse(q.intent)),intent=JSON.parse(payloadJson),proof=identityGroupProofSchema.parse({schemaVersion:2,id:randomUUID(),operationId:intent.operationId,groupId:intent.groupId,payloadHash:digest(payloadJson),endpoint:intent.endpoint,subjectId:q.current.subjectId,keyId:q.current.keyId,epoch:q.current.epoch,decision:q.decision,issuedAt:q.clock,expiresAt:intent.expiresAt}),proofJson=JSON.stringify(proof),privateKey=await webcrypto.subtle.importKey('pkcs8',createPrivateKey(material.ownerPrivate).export({format:'der',type:'pkcs8'}),'Ed25519',false,['sign']);
let signature;if(q.badSigner)signature=await signIdentityPayload(proofJson,privateKey,{type:identityGroupSignatureType});else{const signer=createIdentityGroupDeviceSignerV2({endpoint:intent.endpoint,current:async()=>({identity:{subjectId:q.current.subjectId},keyId:q.current.keyId,epoch:q.current.epoch}),getMaterial:async()=>({publicKeyPem:material.publicKeyPem,privateKey})});signature=await signer(proofJson,identityGroupSignatureType,{subjectId:q.current.subjectId,keyId:q.current.keyId,epoch:q.current.epoch})}
console.log(JSON.stringify({payloadJson,proofJson,signature}));
