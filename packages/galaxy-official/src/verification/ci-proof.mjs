import { verifyEnvelope } from './envelope.mjs';
import { ciProofDataSchema,describeCiProof,summarizeCiProofViews } from '../shared/ci-provenance.mjs';
import { validatePublicUrl } from '../public-fetch.mjs';

export async function verifyCiProof(signed,{endpoint,trustedKeys,now=Math.floor(Date.now()/1000)}){
  if(validatePublicUrl(endpoint).origin!==endpoint)throw new Error('Canonical issuer endpoint required.');
  const opened=await verifyEnvelope(signed,{type:'proof',issuer:endpoint,audience:endpoint,trustedKeys,now,maxAge:3600});
  const data=ciProofDataSchema.parse(opened.data);
  if(data.issuer!==endpoint||data.id!==opened.id||data.statusPath!==`/v1/proofs/${data.id}/status`
    ||data.observedAt>data.preparedAt||data.preparedAt>opened.issuedAt||data.expiresAt<=now||data.expiresAt-data.observedAt>3600)
    throw new Error('CI Proof context mismatch.');
  return {state:'verified-signature',data,provenance:describeCiProof(data),expiresAt:Math.min(opened.expiresAt,data.expiresAt),
    revocationChecked:false,sourceFreshnessChecked:false,capabilityVerified:false,independentExecutionVerified:false};
}
export async function verifyCiProofCollection(documents,{trustedEndpoints,now=Math.floor(Date.now()/1000)}){
  if(!Array.isArray(documents)||documents.length>200||!(trustedEndpoints instanceof Map))throw new Error('Invalid bounded CI Proof collection.');
  const verified=[],rejected=[];
  for(const [index,document] of documents.entries()){
    try{
      if(!document||Object.keys(document).sort().join(',')!=='endpoint,signed')throw new Error('Invalid supplied Proof document.');
      const result=await verifyCiProof(document.signed,{endpoint:document.endpoint,trustedKeys:trustedEndpoints.get(document.endpoint),now});
      verified.push({index,...result});
    }catch(error){rejected.push({index,state:error.code==='ERR_JWT_EXPIRED'?'expired':'unverified'});}
  }
  return {verified,rejected,summary:summarizeCiProofViews(verified),revocationChecked:false,sourceFreshnessChecked:false,
    strength:'issuer-attested-repository-controlled-ci',capabilityVerified:false};
}
