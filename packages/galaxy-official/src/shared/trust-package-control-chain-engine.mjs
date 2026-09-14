// Shared existing identity traversal; crypto/encoding validators are supplied by Node or WebCrypto.
export async function verifyControlChainWith({subjectId,genesisProof,events}, {verifyGalaxyGenesis,controlOperationSchema,controlKeyId,controlEventHash,verifyControlSignature}){
  if(!await verifyGalaxyGenesis(subjectId,genesisProof)||!Array.isArray(events)||!events.length||events.length>10000)throw new Error('Invalid identity chain.');
  let epoch=0,sequence=0,head=null,recovery=null;const devices=new Map(),recoveryKeys=new Set(),deviceIds=new Set();
  for(const row of events){
    const event={id:row.id,subjectId:row.subject_id,sequence:row.sequence,epoch:row.epoch,kind:row.kind,
      previousEventHash:row.previous_event_hash,payloadText:row.payload_text,controllerSignature:row.controller_signature,
      newDeviceProof:row.new_device_proof,signerKeyId:row.signer_key_id,acceptedAt:new Date(row.accepted_at).toISOString()};
    const envelope=JSON.parse(event.payloadText),request=controlOperationSchema.parse(envelope.request);
    if(envelope.version!==2||envelope.type!=='identity-control'||!envelope.audience||request.subjectId!==subjectId
      ||event.subjectId!==subjectId||event.id!==request.operationId||event.kind!==request.kind||request.expectedEpoch!==epoch
      ||request.previousEventHash!==head||event.previousEventHash!==head||event.sequence!==sequence+1||await controlEventHash(event)!==row.event_hash)
      throw new Error('Identity chain continuity mismatch.');
    let signer;
    if(request.kind==='bootstrap'){
      if(sequence||!await verifyGalaxyGenesis(subjectId,request.genesisProof)||request.genesisProof.nonce!==genesisProof.nonce
        ||request.genesisProof.publicKeyPem!==genesisProof.publicKeyPem||request.newDevice.publicKeyPem!==genesisProof.publicKeyPem)
        throw new Error('Invalid genesis upgrade.');
      signer={publicKey:genesisProof.publicKeyPem,scopes:['*']};epoch=1;
    }else if(request.kind==='recover'){
      if(!recovery||recovery.generation!==request.recoveryGeneration)throw new Error('Invalid recovery generation.');
      signer={publicKey:recovery.publicKey,scopes:['*']};
    }else{
      signer=devices.get(request.signerKeyId);
      if(!signer||!signer.scopes.includes('manage-identity'))throw new Error('Invalid current controller.');
    }
    if(await controlKeyId(signer.publicKey)!==request.signerKeyId||event.signerKeyId!==request.signerKeyId)throw new Error('Wrong identity signer.');
    await verifyControlSignature(event.controllerSignature,signer.publicKey,event.payloadText);
    if(request.kind==='recover'){epoch++;devices.clear();}
    if(event.epoch!==epoch)throw new Error('Invalid control epoch.');
    if(request.newDevice){
      await verifyControlSignature(event.newDeviceProof,request.newDevice.publicKeyPem,event.payloadText);
      if(['bootstrap','recover'].includes(request.kind)&&!request.newDevice.scopes.includes('manage-identity'))throw new Error('Identity manager required.');
      if(request.kind!=='bootstrap'&&request.newDevice.scopes.includes('*'))throw new Error('Explicit device scopes required.');
      if(deviceIds.has(request.newDevice.deviceId)||devices.has(await controlKeyId(request.newDevice.publicKeyPem))
        ||request.newDevice.scopes.some(scope=>!signer.scopes.includes('*')&&!signer.scopes.includes(scope)))throw new Error('Invalid device authorization.');
      deviceIds.add(request.newDevice.deviceId);
      devices.set(await controlKeyId(request.newDevice.publicKeyPem),{publicKey:request.newDevice.publicKeyPem,
        deviceId:request.newDevice.deviceId,scopes:request.newDevice.scopes,epoch});
    }
    if(request.kind==='revoke-device'){
      const entry=[...devices.entries()].find(([,device])=>device.deviceId===request.deviceId);
      if(!entry)throw new Error('Unknown device revocation.');devices.delete(entry[0]);
      if(!recovery&&![...devices.values()].some(device=>device.scopes.includes('manage-identity')))throw new Error('Last controller revoked without recovery.');
    }
    if(request.nextRecoveryPublicKey){
      if(request.recoveryGeneration!==(recovery?.generation??0)||recoveryKeys.has(request.nextRecoveryPublicKey)
        ||request.nextRecoveryPublicKey===signer.publicKey||request.nextRecoveryPublicKey===request.newDevice?.publicKeyPem)throw new Error('Recovery continuity mismatch.');
      recovery={publicKey:request.nextRecoveryPublicKey,generation:(recovery?.generation??0)+1};recoveryKeys.add(recovery.publicKey);
    }
    if(request.kind==='declare-recovery-saved'&&request.recoveryGeneration!==recovery?.generation)throw new Error('Invalid recovery declaration.');
    sequence++;head=row.event_hash;
  }
  return {subjectId,epoch,sequence,chainHead:head,devices:[...devices.entries()].map(([keyId,value])=>({keyId,...value})),
    recovery,historySignaturesVerified:true,currentRevocationChecked:false};
}
