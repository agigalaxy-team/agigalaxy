import { compactVerify,importSPKI } from 'jose';
import canonicalize from 'canonicalize';
import { digest } from '../shared/digest.mjs';
import { ServiceError } from '../shared/service-error.mjs';

export const controlSignatureType='galaxy-identity-control-v2+jws';
export const controlCanonical=canonicalize;
export const controlKeyId=digest;
export async function verifyControlSignature(signature,publicKey,payloadText,{type=controlSignatureType}={}) {
  try {
    const checked=await compactVerify(signature,await importSPKI(publicKey,'Ed25519'),{algorithms:['Ed25519']});
    if(Object.keys(checked.protectedHeader).sort().join(',')!=='alg,typ'||checked.protectedHeader.typ!==type
      ||Buffer.from(checked.payload).toString('utf8')!==payloadText)throw new Error();
    return checked;
  }catch{throw new ServiceError('identity_control_proof_invalid',401);}
}
export function controlEventHash(event){return digest(canonicalize(event));}
