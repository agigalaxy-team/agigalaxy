import { digest } from './shared/digest.mjs';
import { nodeProofClaimsSchema } from './shared/node-control-proof-schema.mjs';
import { verifyNodeControlProof } from './verification/node-control.mjs';

export function createNodeControlProofFlow({endpoint,sessions,builders,trustedKeys,signProof,saveProof,now=()=>Math.floor(Date.now()/1000)}){
  const pending=new WeakMap(),signing=new Set();
  async function prepare(input){
    const authorization=await sessions.readAuthorization(endpoint);
    if(!authorization?.scopes.includes('builders'))throw new Error('Node authorization required.');
    const snapshot=await builders.exportNodeControl(input),data=snapshot.data;
    if(data.nodeId!==authorization.subjectId)throw new Error('Node key holder required for direct proof.');
    const payloadJson=JSON.stringify(nodeProofClaimsSchema.parse({version:1,purpose:'node-control-portable-proof',endpoint,builderId:data.builderId,controlId:data.id,
      ownerId:data.ownerId,nodeId:data.nodeId,declarationId:data.declarationId,declarationHash:data.declarationHash,registryHash:digest(snapshot.signed),issuedAt:now(),expiresAt:data.expiresAt}));
    const preview=Object.freeze({endpoint,builderId:data.builderId,controlId:data.id,payloadJson,registrySigned:snapshot.signed,
      confirmation:`CONFIRM NODE PROOF ${data.id} ${digest(payloadJson)}`});
    pending.set(preview,{authorization,snapshot,state:'prepared',controller:new AbortController()});return preview;
  }
  function cancel(preview){const operation=pending.get(preview);if(!operation)throw new Error('Unknown Node proof preview.');operation.state='canceled';operation.controller.abort();signing.delete(preview.payloadJson);}
  async function execute(preview,confirmation){
    const operation=pending.get(preview);if(!operation||operation.state!=='prepared'||confirmation!==preview.confirmation)throw new Error('Exact Node proof confirmation required.');
    operation.state='executing';
    const check=async()=>{operation.controller.signal.throwIfAborted();if(!await sessions.isAuthorizationCurrent(operation.authorization)||!sessions.matchesAuthorization(operation.authorization))throw new Error('Node proof authorization changed.');operation.controller.signal.throwIfAborted();};
    try{
      await check();
      const current=await builders.exportNodeControl({builderId:preview.builderId,controlId:preview.controlId},{signal:operation.controller.signal});
      if(current.data.sourceEventHash!==operation.snapshot.data.sourceEventHash||current.data.declarationHash!==operation.snapshot.data.declarationHash
        ||JSON.stringify(current.data.maintenance)!==JSON.stringify(operation.snapshot.data.maintenance)||now()>=operation.snapshot.expiresAt)throw new Error('Node authorization changed; prepare a new proof.');
      await check();signing.add(preview.payloadJson);
      const node=await signProof(preview.payloadJson,'galaxy-node-control-proof+jws');signing.delete(preview.payloadJson);await check();
      const proof={version:node.controlChain?2:1,registrySigned:preview.registrySigned,nodeSigned:node.signed,genesisProof:node.genesisProof,
        ...(node.controlChain?{controlChain:node.controlChain,signerKeyId:node.signerKeyId,controlEpoch:node.controlEpoch}:{})};
      const verified=await verifyNodeControlProof(proof,{endpoint,trustedKeys,now:now(),builderId:preview.builderId,controlId:preview.controlId});
      await check();const path=saveProof?await saveProof(proof,{subjectId:operation.authorization.subjectId,assertCurrent:()=>operation.state==='executing'&&sessions.matchesAuthorization(operation.authorization)}):null;
      await check();operation.state='completed';return {proof,path,nodeSignatureVerified:verified.nodeSignatureVerified,currentRevocationChecked:false,checkedAt:verified.data.checkedAt,expiresAt:verified.expiresAt,capabilityVerified:false};
    }catch(error){if(operation.state!=='canceled')operation.state='failed';throw error;}finally{signing.delete(preview.payloadJson);}
  }
  return Object.freeze({prepare,execute,cancel,isSigningProof:payload=>signing.has(payload)});
}
