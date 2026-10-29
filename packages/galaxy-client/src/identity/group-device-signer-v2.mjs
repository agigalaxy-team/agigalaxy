import {identityGroupProofSchema,identityGroupSignatureType} from "../../../galaxy-contracts/src/identity-group-v2-schema.mjs";
import {identityKeyId,signIdentityPayload} from "../../../galaxy-contracts/src/identity/identity-material.mjs";
const fail=()=>Object.assign(new Error('identity_group_control_changed'),{code:'identity_group_control_changed'});
// A separate signature purpose, backed by the existing verified current
// control reader. Do not extend the Trust Package signature whitelist.
export function createIdentityGroupDeviceSignerV2({endpoint,current,getMaterial}) {
  return async(text,type,expected)=>{
    if(type!==identityGroupSignatureType)throw fail();
    const proof=identityGroupProofSchema.parse(JSON.parse(text));
    if(proof.endpoint!==endpoint||!expected||['subjectId','keyId','epoch'].some(k=>proof[k]!==expected[k]))throw fail();
    const before=await current(),material=await getMaterial();
    if(before.identity.subjectId!==expected.subjectId||before.keyId!==expected.keyId||before.epoch!==expected.epoch||await identityKeyId(material.publicKeyPem)!==expected.keyId)throw fail();
    const signature=await signIdentityPayload(text,material.privateKey,{type});
    const after=await getMaterial();if(after.publicKeyPem!==material.publicKeyPem)throw fail();
    return signature;
  };
}
