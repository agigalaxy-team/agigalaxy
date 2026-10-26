import {compactVerify,createLocalJWKSet,decodeProtectedHeader} from 'jose';
import {ServiceError} from "../../shared/service-error.mjs";
import {fetchPublicJson} from "../../infrastructure/public-fetch.mjs";

const error=code=>new ServiceError(code,422);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const issuerId=value=>typeof value==='string'?value:object(value)&&typeof value.id==='string'?value.id:null;
const iso=seconds=>seconds===null?null:new Date(seconds*1000).toISOString();
function date(value) {
  if(value===undefined)return null;
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw error('external_credential_format_invalid');
  return Math.floor(Date.parse(value)/1000);
}
function numeric(value){if(value===undefined)return null;if(!Number.isSafeInteger(value)||value<0||value>253402300799)throw error('external_credential_format_invalid');return value;}
function decodePayload(token){try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(token.split('.')[1],'base64url')));if(!object(value))throw Error();return value;}catch{throw error('external_credential_format_invalid');}}
function string(value,max=2048){return typeof value==='string'&&value.length>0&&value.length<=max&&!/\p{Cc}/u.test(value);}
function credentialShape(payload,header) {
  const direct=header.typ==='vc+jwt',vc=direct?payload:payload.vc,format=direct?'vc+jwt-2.0':'vc-jwt-1.1';
  if(!object(vc)||!object(vc.credentialSubject)||!Array.isArray(vc['@context'])
    || !vc['@context'].includes(direct?'https://www.w3.org/ns/credentials/v2':'https://www.w3.org/2018/credentials/v1'))throw error('external_credential_format_unsupported');
  if(!direct&&header.typ!==undefined&&!['JWT','jwt'].includes(header.typ))throw error('external_credential_format_unsupported');
  if(!Array.isArray(vc.type)||!vc.type.includes('VerifiableCredential')||vc.type.length>32||vc.type.some(type=>!string(type,256)))throw error('external_credential_format_invalid');
  const issuer=issuerId(vc.issuer)??payload.iss;
  if(!string(issuer)||payload.iss!==undefined&&payload.iss!==issuer)throw error('external_credential_issuer_mismatch');
  const subjectId=vc.credentialSubject.id??payload.sub??null;
  if(subjectId!==null&&!string(subjectId)||payload.sub!==undefined&&subjectId!==payload.sub)throw error('external_credential_subject_invalid');
  const issued=date(vc.issuanceDate)??numeric(payload.iat),starts=[date(vc.validFrom),date(vc.issuanceDate),numeric(payload.nbf)].filter(value=>value!==null);
  const ends=[date(vc.validUntil),date(vc.expirationDate),numeric(payload.exp)].filter(value=>value!==null);
  const validFrom=starts.length?Math.max(...starts):issued,expiresAt=ends.length?Math.min(...ends):null;
  if(validFrom!==null&&expiresAt!==null&&expiresAt<=validFrom)throw error('external_credential_validity_invalid');
  const credentialId=vc.id??payload.jti??null;
  if(credentialId!==null&&!string(credentialId))throw error('external_credential_format_invalid');
  if(vc.id!==undefined&&payload.jti!==undefined&&vc.id!==payload.jti)throw error('external_credential_id_mismatch');
  const scope=vc.credentialSubject.scope??vc.scope;
  return {format,issuer,subjectId,credentialId,vc,types:vc.type,scope:typeof scope==='string'?[scope.slice(0,512)]:Array.isArray(scope)?scope.filter(value=>string(value,512)).slice(0,32):[],
    title:string(vc.name,200)?vc.name:vc.type.find(type=>type!=='VerifiableCredential')||'外部签名材料',issuedAt:iso(issued),validFrom:iso(validFrom),expiresAt:iso(expiresAt)};
}
function protectedHeader(token) {
  let header;try{header=decodeProtectedHeader(token);}catch{throw error('external_credential_format_invalid');}
  if(typeof header.alg!=='string'||typeof header.kid!=='string'||!header.kid||header.kid.length>200
    ||['jku','jwk','x5u','x5c','crit','b64'].some(key=>Object.hasOwn(header,key)))throw error('external_credential_signature_unsupported');
  return header;
}
export function createExternalCredentialVerifier({configuration,endpoint,now=()=>Math.floor(Date.now()/1000),fetchStatus=fetchPublicJson}) {
  const issuers=new Map(configuration.issuers.map(issuer=>[issuer.issuer,{...issuer,keySet:createLocalJWKSet({keys:issuer.keys})}]));
  const statuses=new Map(),loading=new Map(),failures=new Map();
  async function verifySignature(token,issuer,header) {
    if(!issuer.algorithms.includes(header.alg))throw error('external_credential_signature_invalid');
    try{await compactVerify(token,issuer.keySet,{algorithms:issuer.algorithms});}catch{throw error('external_credential_signature_invalid');}
  }
  async function verify(token) {
    if(typeof token!=='string'||Buffer.byteLength(token)>131072)throw error('external_credential_too_large');
    const header=protectedHeader(token),payload=decodePayload(token),metadata=credentialShape(payload,header),issuer=issuers.get(metadata.issuer);
    if(!issuer||!issuer.formats.includes(metadata.format))throw error('external_credential_issuer_unconfigured');
    await verifySignature(token,issuer,header);
    if(payload.aud!==undefined&&!(typeof payload.aud==='string'?payload.aud===endpoint:Array.isArray(payload.aud)&&payload.aud.every(value=>typeof value==='string')&&payload.aud.includes(endpoint)))
      throw error('external_credential_audience_mismatch');
    return {...metadata,issuerId:issuer.id,issuerName:issuer.name,algorithm:header.alg,kid:header.kid};
  }
  const unknownStatus=(issuer,reason)=>({state:'unknown',source:issuer?.revocation?.url??null,checkedAt:iso(now()),validUntil:null,reason});
  async function statusDocument(issuer,{force=false,signal}={}) {
    const prior=statuses.get(issuer.id);if(!force&&prior?.until>now())return prior;
    if(!force&&(failures.get(issuer.id)||0)>now())throw Error('Status source temporarily unavailable.');
    if(loading.has(issuer.id))return loading.get(issuer.id);
    const task=(async()=>{
      const document=await fetchStatus(issuer.revocation.url,{maxBytes:1048576,timeoutMs:5000,signal});
      if(!object(document)||Object.keys(document).join(',')!=='jwt'||typeof document.jwt!=='string'||Buffer.byteLength(document.jwt)>900000)throw Error();
      const header=protectedHeader(document.jwt),payload=decodePayload(document.jwt);
      if(header.typ!=='credential-status+jwt'||payload.iss!==issuer.issuer||payload.purpose!=='revocation'||payload.complete!==true
        ||!Number.isSafeInteger(payload.iat)||!Number.isSafeInteger(payload.exp)||payload.iat<0||payload.iat>now()+30||payload.exp<=now()||payload.exp<=payload.iat||payload.exp>253402300799
        ||payload.iat<now()-issuer.revocation.maxAgeSeconds||!Array.isArray(payload.revoked)||payload.revoked.length>20000||payload.revoked.some(value=>!string(value)))throw Error();
      await verifySignature(document.jwt,issuer,header);
      const status={payload,until:Math.min(payload.exp,payload.iat+issuer.revocation.maxAgeSeconds),key:issuer.keys.find(key=>key.kid===header.kid)};
      statuses.set(issuer.id,status);failures.delete(issuer.id);return status;
    })();
    loading.set(issuer.id,task);try{return await task;}catch(error){statuses.delete(issuer.id);failures.set(issuer.id,now()+10);throw error;}finally{loading.delete(issuer.id);}
  }
  async function revocation(metadata,{force=false,signal}={}) {
    const issuer=issuers.get(metadata.issuer);
    if(!issuer?.revocation||!metadata.credentialId)return unknownStatus(issuer,'status-source-unavailable');
    const declared=metadata.vc.credentialStatus;
    if(declared!==undefined&&(!object(declared)||declared.type!=='SignedCredentialStatusList'||declared.id!==issuer.revocation.url))
      return unknownStatus(issuer,'credential-status-format-unsupported');
    try {
      const status=await statusDocument(issuer,{force,signal}),payload=status.payload;
      return {state:payload.revoked.includes(metadata.credentialId)?'revoked':'not-revoked',source:issuer.revocation.url,checkedAt:iso(now()),
        issuedAt:iso(payload.iat),validUntil:iso(status.until),signingKey:status.key,reason:null};
    }catch{return unknownStatus(issuer,'status-not-confirmed');}
  }
  function validity(metadata) {
    if(metadata.validFrom&&Date.parse(metadata.validFrom)>now()*1000)return 'not-yet-valid';
    if(metadata.expiresAt&&Date.parse(metadata.expiresAt)<=now()*1000)return 'expired';
    return metadata.validFrom||metadata.issuedAt?'valid':'unknown';
  }
  return {verify,revocation,validity,issuer:id=>configuration.issuers.find(issuer=>issuer.id===id)??null};
}
