import { CompactSign,compactVerify,importSPKI } from 'jose';
import { createPublicKey } from 'node:crypto';
import { readFile,writeFile,lstat,mkdir } from 'node:fs/promises';
import { isAbsolute,join } from 'node:path';
import { z } from 'zod';
import { governanceConfigSchema,loadGovernanceConfig } from '../governance-config.mjs';
import { digest } from '../shared/digest.mjs';

const normalized=value=>Array.isArray(value)?value.map(normalized):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalized(value[key])])):value;
export const governanceConfigurationHash=config=>digest(JSON.stringify(normalized(governanceConfigSchema.parse(config))));
const sha=z.string().regex(/^[a-f0-9]{64}$/),ref=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),time=z.number().int().nonnegative();
const endpointSchema=z.url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password;});
export const governanceChangeSchema=z.object({version:z.literal(1),changeId:z.uuid(),endpoint:endpointSchema,revision:z.number().int().positive(),
  previousConfigurationSha256:sha.nullable(),configurationSha256:sha,requesterKid:ref,reviewerKid:ref,issuedAt:time,expiresAt:time}).strict()
  .refine(value=>value.requesterKid!==value.reviewerKid&&value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=30*86400);
const pin=z.object({kid:ref,publicKeyPem:z.string().min(1).max(4096),notBefore:time,notAfter:time,revoked:z.boolean()}).strict();
export const governanceAuthoritiesSchema=z.object({version:z.literal(1),endpoint:endpointSchema,requesters:z.array(pin).min(1).max(16),reviewers:z.array(pin).min(1).max(16)}).strict()
  .refine(value=>[value.requesters,value.reviewers].every(keys=>new Set(keys.map(key=>key.kid)).size===keys.length));
const envelopeSchema=z.object({version:z.literal(1),requestSignature:z.string().min(1).max(16384),reviewSignature:z.string().min(1).max(16384)}).strict();
export const governanceReviewRecordSchema=governanceChangeSchema.safeExtend({authoritiesSha256:sha,requestSignatureSha256:sha,reviewSignatureSha256:sha});

export async function signGovernanceChange(change,{privateKey,kid}){
  const payload=governanceChangeSchema.parse(change);ref.parse(kid);
  if(![payload.requesterKid,payload.reviewerKid].includes(kid))throw new Error('Governance signer mismatch');
  return new CompactSign(Buffer.from(JSON.stringify(payload))).setProtectedHeader({alg:'EdDSA',typ:'galaxy-governance-change+jws',kid}).sign(privateKey);
}
export async function verifyGovernanceReview(configuration,input,authorityInput,{endpoint,now=Math.floor(Date.now()/1000)}={}){
  const envelope=envelopeSchema.parse(input),authorities=governanceAuthoritiesSchema.parse(authorityInput);endpointSchema.parse(endpoint);time.parse(now);
  if(authorities.endpoint!==endpoint)throw new Error('Governance authority endpoint mismatch');
  const checked=[];
  for(const [signature,keys,field] of [[envelope.requestSignature,authorities.requesters,'requesterKid'],[envelope.reviewSignature,authorities.reviewers,'reviewerKid']]){
    let selected;
    const verified=await compactVerify(signature,async header=>{
      if(header.alg!=='EdDSA'||header.typ!=='galaxy-governance-change+jws'||Object.keys(header).sort().join(',')!=='alg,kid,typ')throw new Error('Governance signature header mismatch');
      selected=keys.find(key=>key.kid===header.kid);
      if(!selected||selected.revoked||now<selected.notBefore||now>=selected.notAfter)throw new Error('Governance signing key unavailable');
      const publicKey=createPublicKey(selected.publicKeyPem);if(publicKey.asymmetricKeyType!=='ed25519')throw new Error('Governance key type mismatch');
      return importSPKI(selected.publicKeyPem,'EdDSA');
    },{algorithms:['EdDSA']});
    const text=new TextDecoder('utf-8',{fatal:true}).decode(verified.payload),change=governanceChangeSchema.parse(JSON.parse(text));
    if(change[field]!==selected.kid||change.endpoint!==endpoint||now<change.issuedAt||now>=change.expiresAt||change.issuedAt<selected.notBefore||change.expiresAt>selected.notAfter)throw new Error('Governance change scope or validity mismatch');
    checked.push({text,change,fingerprint:digest(createPublicKey(selected.publicKeyPem).export({type:'spki',format:'der'}))});
  }
  if(checked[0].text!==checked[1].text||checked[0].fingerprint===checked[1].fingerprint)throw new Error('Independent identical governance review required');
  const change=checked[0].change;
  if(change.configurationSha256!==governanceConfigurationHash(configuration))throw new Error('Governance configuration digest mismatch');
  return {...change,authoritiesSha256:digest(JSON.stringify(normalized(authorities))),requestSignatureSha256:digest(envelope.requestSignature),reviewSignatureSha256:digest(envelope.reviewSignature)};
}
async function jsonFile(path,maximum){
  if(typeof path!=='string'||!isAbsolute(path))throw new Error('Absolute governance configuration path required');
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maximum)throw new Error('Invalid governance file');
  return JSON.parse(await readFile(path,'utf8'));
}
export async function loadGovernanceForRuntime({configurationPath,reviewPath,authoritiesPath,environment,endpoint,now}){
  const configuration=await loadGovernanceConfig(configurationPath);
  if(Boolean(reviewPath)!==Boolean(authoritiesPath))throw new Error('Both governance review and separate authority pins required');
  if(!reviewPath){
    if(environment==='pilot'&&Object.values(configuration).some(values=>values.length))throw new Error('Pilot governance configuration requires independent review');
    return {configuration,review:null};
  }
  if(!configurationPath)throw new Error('Reviewed governance configuration file required');
  const review=await verifyGovernanceReview(configuration,await jsonFile(reviewPath,32768),await jsonFile(authoritiesPath,131072),{endpoint,now});
  return {configuration,review};
}
export async function prepareGovernanceBundle({configurationPath,reviewPath,authoritiesPath,endpoint,directory,now}){
  if(typeof directory!=='string'||!isAbsolute(directory))throw new Error('New absolute governance bundle directory required');
  const configuration=governanceConfigSchema.parse(await jsonFile(configurationPath,65536)),envelope=await jsonFile(reviewPath,32768);
  const review=await verifyGovernanceReview(configuration,envelope,await jsonFile(authoritiesPath,131072),{endpoint,now});
  const configurationText=JSON.stringify(configuration,null,2)+'\n',reviewText=JSON.stringify(envelope,null,2)+'\n';
  if(Buffer.byteLength(configurationText)>65536||Buffer.byteLength(reviewText)>32768)throw new Error('Prepared governance file exceeds runtime size limit');
  await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'governance.json'),configurationText,{flag:'wx',mode:0o600});
  await writeFile(join(directory,'review.json'),reviewText,{flag:'wx',mode:0o600});
  const receipt={version:1,endpoint,changeId:review.changeId,revision:review.revision,configurationSha256:review.configurationSha256,
    authoritiesSha256:review.authoritiesSha256,prepared:true,activated:false};
  await writeFile(join(directory,'prepared.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return receipt;
}
