// Browser-compatible identity transport. Signing and durable storage stay with
// the caller's local key store; recovery codes are never accepted as requests.
const common=['version','operationId','subjectId','kind','expectedEpoch','previousEventHash','signerKeyId'];
const fields={bootstrap:['genesisProof','newDevice'],'authorize-device':['newDevice'],'revoke-device':['deviceId'],
  'set-recovery':['recoveryGeneration','nextRecoveryPublicKey','saveDeclaration'],
  recover:['recoveryGeneration','newDevice','nextRecoveryPublicKey'],'declare-recovery-saved':['recoveryGeneration','saveDeclaration']};
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort((left,right)=>left<right?-1:left>right?1:0).join(',');
function publicRequest(input){
  const request={...input,version:input.version??2};
  if(!fields[request.kind]||!exact(request,[...common,...fields[request.kind]])||request.version!==2)throw new Error('Unsupported public identity request.');
  if(request.newDevice&&!exact(request.newDevice,['deviceId','publicKeyPem','scopes']))throw new Error('Only public device material can be sent.');
  if(request.genesisProof&&!exact(request.genesisProof,['version','publicKeyPem','nonce']))throw new Error('Only public Genesis material can be sent.');
  // Reject accidental secret material before invoking any transport.
  if(/PRIVATE KEY|galaxy-recovery-v1:/.test(JSON.stringify(request)))throw new Error('Private identity material cannot leave the client.');
  return JSON.parse(JSON.stringify(request));
}
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

export function createIdentityControlClient({endpoint,send,store,signController,signNewDevice,now=()=>Math.floor(Date.now()/1000)}){
  const url=new URL(endpoint);
  if(url.protocol!=='https:'||url.origin!==endpoint||url.username||url.password)throw new Error('An exact HTTPS identity authority is required.');
  if(typeof send!=='function'||typeof store?.get!=='function'||typeof store?.put!=='function'||typeof signController!=='function')throw new Error('Identity transport, local operation storage and signing adapter are required.');
  const pending=new WeakMap(),key=id=>`identity-operation:${endpoint}:${id}`;
  const call=(action,input)=>send(`${endpoint}/v2/identity/control/${action}`,{method:'POST',bodyJson:JSON.stringify(input)});
  function checkReceipt(receipt,request){
    if(receipt?.operationId!==request.operationId||receipt.subjectId!==request.subjectId||!['committed','requested','expired','canceled'].includes(receipt.state))throw new Error('Mismatched identity operation result.');
    if(receipt.state==='committed'&&(!Number.isSafeInteger(receipt.epoch)||receipt.epoch<1||!/^[a-f0-9]{64}$/.test(receipt.chainHead)))throw new Error('Incomplete identity operation receipt.');
    return receipt;
  }
  async function prepare(input){
    const request=publicRequest(input),previous=await store.get(key(request.operationId));
    if(previous&&stable(previous.request)!==stable(request))throw new Error('Operation ID already belongs to a different identity change.');
    const response=await call('challenges',request);let challenge;
    try{challenge=JSON.parse(response.challenge);}catch{throw new Error('Invalid identity challenge.');}
    if(!exact(challenge,['version','type','audience','request','nonce','expiresAt'])||challenge.version!==2||challenge.type!=='identity-control'
      ||challenge.audience!==endpoint||stable(challenge.request)!==stable(request)||response.operationId!==request.operationId
      ||typeof challenge.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)||!Number.isSafeInteger(challenge.expiresAt)
      ||challenge.expiresAt<=now()||challenge.expiresAt>now()+180||response.expiresAt!==challenge.expiresAt)throw new Error('Identity challenge changed the requested operation or expired.');
    const record=previous??{request,challenge:response.challenge,expiresAt:challenge.expiresAt,state:'prepared'};
    if(record.challenge!==response.challenge)throw new Error('Identity operation challenge changed.');
    await store.put(key(request.operationId),record);
    const preview=freeze({endpoint,request,expiresAt:challenge.expiresAt,
      effect:request.kind==='recover'?'replace-all-devices-and-consume-recovery-material':request.kind,
      dataRecovery:'separate/not-performed'});
    pending.set(preview,record);return preview;
  }
  async function signed(record){
    if(record.commit)return record.commit;
    if(record.state==='signing')throw new Error('Identity confirmation is already being signed.');
    if(record.expiresAt<=now())throw new Error('Identity challenge expired; prepare a new operation.');
    record.state='signing';
    const commit={operationId:record.request.operationId,controllerSignature:await signController(record.challenge,record.request)};
    if(record.state==='canceled')throw new Error('Identity confirmation canceled.');
    if(record.request.newDevice){if(typeof signNewDevice!=='function')throw new Error('New device possession proof is required.');commit.newDeviceProof=await signNewDevice(record.challenge,record.request);}
    if(record.state==='canceled')throw new Error('Identity confirmation canceled.');
    if(typeof commit.controllerSignature!=='string'||(record.request.newDevice&&typeof commit.newDeviceProof!=='string'))throw new Error('Identity signing adapter returned an invalid proof.');
    record.commit=commit;record.state='signed-awaiting-result';await store.put(key(commit.operationId),record);return commit;
  }
  async function confirm(preview,{confirmed=false}={}){
    const record=pending.get(preview);if(!record||!confirmed||record.state==='canceled')throw new Error('Confirm this identity change before signing.');
    let commit;
    try{commit=await signed(record);}catch(error){if(record.state==='signing')record.state='prepared';await store.put(key(record.request.operationId),record);throw error;}
    try{const receipt=checkReceipt(await call('commit',commit),record.request);record.receipt=receipt;record.state=receipt.state;await store.put(key(commit.operationId),record);return receipt;}
    catch(error){if(record.state!=='canceled')record.state='result-unknown';await store.put(key(commit.operationId),record);throw error;}
  }
  async function status(operationId){
    const record=await store.get(key(operationId));if(!record)throw new Error('Local identity operation not found.');
    if(!record.commit)return{operationId,subjectId:record.request.subjectId,state:record.state,registered:false};
    const receipt=checkReceipt(await call('status',record.commit),record.request);record.receipt=receipt;record.state=receipt.state;await store.put(key(operationId),record);return receipt;
  }
  async function retry(operationId,{confirmed=false}={}){
    const record=await store.get(key(operationId));if(!record?.commit||!confirmed||record.state==='canceled')throw new Error('Confirm retry of the saved identity operation.');
    const receipt=checkReceipt(await call('commit',record.commit),record.request);record.receipt=receipt;record.state=receipt.state;await store.put(key(operationId),record);return receipt;
  }
  async function cancel(preview){
    const record=pending.get(preview);if(!record)throw new Error('Unknown identity preview.');
    if(record.commit){const receipt=checkReceipt(await call('cancel',record.commit),record.request);record.receipt=receipt;record.state=receipt.state;await store.put(key(record.request.operationId),record);return receipt;}
    record.state='canceled';await store.put(key(record.request.operationId),record);return{operationId:record.request.operationId,subjectId:record.request.subjectId,state:'canceled',localOnly:true};
  }
  return Object.freeze({prepare,confirm,status,retry,cancel});
}
