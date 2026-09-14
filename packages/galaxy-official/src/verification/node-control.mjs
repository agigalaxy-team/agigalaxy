import { compactVerify,importSPKI } from 'jose';
import { verifyEnvelope } from './envelope.mjs';
import { digest } from '../shared/digest.mjs';
import { verifyGalaxyGenesis } from '../../../galaxy-core/src/galaxy-guid.mjs';
import { nodeControlSnapshotSchema,nodeControlEventSchema,nodeProofClaimsSchema,nodeControlProofSchema } from '../shared/node-control-proof-schema.mjs';
import { verifyIdentityControlChain } from './identity-control.mjs';

export async function verifyNodeControlSnapshot(signed,{endpoint,trustedKeys,now=Math.floor(Date.now()/1000),builderId,controlId}){
  const envelope=await verifyEnvelope(signed,{type:'node-control',issuer:endpoint,audience:endpoint,trustedKeys,now,maxAge:300});
  const data=nodeControlSnapshotSchema.parse(envelope.data),control=data.control;
  if(data.id!==envelope.id||data.id!==controlId||data.builderId!==builderId||control.id!==data.id||control.builderId!==builderId
    ||control.ownerId!==data.ownerId||control.nodeId!==data.nodeId||control.declarationId!==data.declarationId||control.declarationHash!==data.declarationHash
    ||digest(data.controlPayloadJson)!==data.sourceEventHash||JSON.stringify(nodeControlEventSchema.parse(JSON.parse(data.controlPayloadJson)))!==JSON.stringify(control)
    ||data.checkedAt!==envelope.issuedAt||data.expiresAt!==envelope.expiresAt||control.expiresAt<data.expiresAt)
    throw new Error('Node control snapshot mismatch.');
  return {data,signed,source:data.authority,kid:envelope.kid,expiresAt:data.expiresAt,currentRevocationChecked:false,nodeSignatureVerified:false,capabilityVerified:false};
}

// This is a fresh Node countersignature of an exact registry snapshot, not the
// historical Consent signature (the service stores only its digest).
export async function verifyNodeControlProof(input,options){
  const proof=nodeControlProofSchema.parse(input),snapshot=await verifyNodeControlSnapshot(proof.registrySigned,options);
  if(!verifyGalaxyGenesis(snapshot.data.nodeId,proof.genesisProof))throw new Error('Node Genesis mismatch.');
  let publicKey=proof.genesisProof.publicKeyPem;
  if(proof.version===2){
    const chain=await verifyIdentityControlChain(proof.controlChain),device=chain.devices.find(item=>item.keyId===proof.signerKeyId);
    if(chain.subjectId!==snapshot.data.nodeId||chain.epoch!==proof.controlEpoch||!device
      ||!(device.scopes.includes('*')||device.scopes.includes('builders'))||JSON.stringify(proof.controlChain.genesisProof)!==JSON.stringify(proof.genesisProof))
      throw new Error('Node current-control chain mismatch.');
    publicKey=device.publicKey;
  }
  const signed=await compactVerify(proof.nodeSigned,await importSPKI(publicKey,'Ed25519'),{algorithms:['Ed25519']});
  if(Object.keys(signed.protectedHeader).sort().join(',')!=='alg,typ'||signed.protectedHeader.typ!=='galaxy-node-control-proof+jws')throw new Error('Invalid Node proof signature type.');
  const claims=nodeProofClaimsSchema.parse(JSON.parse(Buffer.from(signed.payload).toString('utf8'))),data=snapshot.data,time=options.now??Math.floor(Date.now()/1000);
  if(claims.endpoint!==options.endpoint||claims.registryHash!==digest(proof.registrySigned)||claims.controlId!==data.id||claims.builderId!==data.builderId
    ||claims.nodeId!==data.nodeId||claims.ownerId!==data.ownerId||claims.declarationId!==data.declarationId||claims.declarationHash!==data.declarationHash
    ||claims.issuedAt<data.checkedAt||claims.issuedAt>time||claims.expiresAt!==data.expiresAt||claims.expiresAt<=time||claims.expiresAt<=claims.issuedAt)
    throw new Error('Node proof context mismatch.');
  return {...snapshot,proof,claims,source:'node-and-registry-signed-authorization',nodeSignatureVerified:true,currentRevocationChecked:false};
}
