import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction} from './database.mjs';
import {ServiceError} from './shared/service-error.mjs';
import {createExternalCredentialVerifier} from './external-credentials-verifier.mjs';
import {validateExternalCredentialsConfiguration} from './external-credentials-config.mjs';
import {externalCredentialImportSchema,externalCredentialListSchema,externalCredentialPublicListSchema,externalCredentialIdSchema,parseExternalCredentialInput} from './shared/external-credentials-schema.mjs';

const iso=value=>new Date(value).toISOString();
const accountUri=(endpoint,id)=>`${endpoint}/v1/account/public/${id}`;
const same=(a,b)=>a===b;
function claimAt(value,path){for(const part of path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'))){
  if(!value||typeof value!=='object'||!Object.hasOwn(value,part))return undefined;value=value[part];}return value;}

// Private account-owned material. Imported signatures do not create a Galaxy
// identity, certify the holder, issue a qualification or publish the credential.
export function createExternalCredentialsService({db,endpoint,configuration={version:1,issuers:[]},now=()=>Math.floor(Date.now()/1000),accountPrincipalReader,fetchStatus}={}) {
  configuration=validateExternalCredentialsConfiguration(configuration);
  const verifier=createExternalCredentialVerifier({configuration,endpoint,now,...(fetchStatus?{fetchStatus}:{})});
  function owner(actor){if(actor?.kind!=='official-account'||actor.endpoint!==endpoint||!externalCredentialIdSchema.safeParse(actor.accountId).success)
    throw new ServiceError('official_account_login_required',401);return actor.accountId;}
  async function principal(connection,accountId) {
    const row=(await connection.query('SELECT id,issuer,external_subject FROM community_accounts WHERE id=$1 AND endpoint=$2',[accountId,endpoint])).rows[0];
    if(!row)throw new ServiceError('official_account_login_required',401);
    // A custom reader may add only server-verified external account references.
    // No fields from an imported VC or HTTP request are promoted into this set.
    const additional=accountPrincipalReader?await accountPrincipalReader({db:connection,accountId,endpoint}):null;
    return {accountId,uri:accountUri(endpoint,accountId),verifiedAccounts:[{issuer:row.issuer,subject:row.external_subject},...(Array.isArray(additional?.verifiedAccounts)?additional.verifiedAccounts:[])]};
  }
  function binding(metadata,identity,issuer) {
    if(metadata.subjectId===identity.uri)return {id:metadata.subjectId,binding:'bound',basis:'official-account-uri'};
    if(metadata.subjectId?.startsWith(endpoint+'/v1/account/public/'))return {id:metadata.subjectId,binding:'mismatch',basis:null};
    if(issuer?.subjectBinding?.kind==='verified-external-account') {
      const references=identity.verifiedAccounts.filter(reference=>reference?.issuer===issuer.subjectBinding.accountIssuer&&typeof reference.subject==='string');
      if(references.some(reference=>reference.subject===metadata.subjectId))return {id:metadata.subjectId,binding:'bound',basis:'verified-external-account'};
      if(references.length&&metadata.subjectId)return {id:metadata.subjectId,binding:'mismatch',basis:null};
    }
    return {id:metadata.subjectId,binding:'unconfirmed',basis:null};
  }
  function statusWithin(row,issuer) {
    const saved=row.revocation;
    if(!issuer?.revocation||saved?.source!==issuer.revocation.url||!saved.validUntil||Date.parse(saved.validUntil)<=now()*1000
      ||!saved.issuedAt||Date.parse(saved.issuedAt)+issuer.revocation.maxAgeSeconds*1000<=now()*1000
      ||!issuer.keys.some(key=>isDeepStrictEqual(key,saved.signingKey)))
      return {state:'unknown',source:issuer?.revocation?.url??null,checkedAt:saved?.checkedAt??null,validUntil:saved?.validUntil??null,reason:'status-not-current',lastKnownState:saved?.state??null};
    const {signingKey,...visible}=saved;return visible;
  }
  function conditionIds(metadata,issuer){return (issuer?.conditions||[]).filter(condition=>metadata.types.includes(condition.type)
    &&(!condition.claim||same(claimAt(metadata.vc,condition.claim.path),condition.claim.equals))).map(condition=>condition.id);}
  async function view(row,identity) {
    let metadata=row.metadata,signatureState='valid';
    const issuer=verifier.issuer(row.issuer_id);
    if(!issuer||issuer.issuer!==row.issuer_uri)signatureState='issuer-unconfigured';
    else if(row.credential_jws) {try{metadata=await verifier.verify(row.credential_jws);}catch{signatureState='invalid';}}
    const subject=binding(metadata,identity,issuer),validity=verifier.validity(metadata),revocation=statusWithin(row,issuer);
    const usable=!row.withdrawn_at&&signatureState==='valid'&&subject.binding==='bound'&&validity==='valid'&&revocation.state==='not-revoked';
    const conditions=usable?conditionIds(metadata,issuer):[];
    return {id:row.id,title:metadata.title,issuer:{id:row.issuer_id,name:issuer?.name??row.issuer_name,uri:row.issuer_uri},subject,
      types:metadata.types,scope:metadata.scope,issuedAt:metadata.issuedAt,validFrom:metadata.validFrom,expiresAt:metadata.expiresAt,
      importedAt:iso(row.imported_at),checkedAt:iso(row.checked_at),withdrawnAt:row.withdrawn_at?iso(row.withdrawn_at):null,
      source:{format:metadata.format,credentialId:metadata.credentialId,issuer:row.issuer_uri,checkedAt:iso(row.checked_at)},
      signature:{state:signatureState,algorithm:metadata.algorithm,kid:metadata.kid,checkedAt:row.credential_jws?iso(now()*1000):iso(row.checked_at)},
      validity:{state:validity},revocation,eligibility:{conditionIds:conditions,usable:conditions.length>0},galaxyIssued:false};
  }
  function capabilities(){return {available:configuration.issuers.length>0,issuers:configuration.issuers.map(issuer=>({id:issuer.id,name:issuer.name,issuer:issuer.issuer,
    formats:issuer.formats,conditions:issuer.revocation?issuer.conditions.map(condition=>({id:condition.id,label:condition.label})):[]}))};}
  function supportedConditions(){return configuration.issuers.flatMap(issuer=>issuer.revocation?issuer.conditions.map(condition=>({kind:'external-credential',issuerId:issuer.id,conditionId:condition.id,label:condition.label,issuerName:issuer.name})):[]);}
  async function list(actor,input={}) {
    const id=owner(actor),data=parseExternalCredentialInput(externalCredentialListSchema,input),identity=await principal(db,id);
    let after=null;if(data.after){after=(await db.query('SELECT imported_at,id FROM account_external_credentials_v1 WHERE account_id=$1 AND id=$2',[id,data.after])).rows[0];if(!after)throw new ServiceError('invalid_external_credential_cursor');}
    const rows=(await db.query(`SELECT * FROM account_external_credentials_v1 WHERE account_id=$1
      AND ($2::timestamptz IS NULL OR (imported_at,id)<($2::timestamptz,$3::uuid)) ORDER BY imported_at DESC,id DESC LIMIT 51`,[id,after?.imported_at??null,after?.id??null])).rows;
    return {...capabilities(),items:await Promise.all(rows.slice(0,50).map(row=>view(row,identity))),nextAfter:rows.length>50?rows[49].id:null};
  }
  async function publicForAccount(accountId,input={}) {
    parseExternalCredentialInput(externalCredentialIdSchema,accountId);
    const page=parseExternalCredentialInput(externalCredentialPublicListSchema,input);
    const enabled=(await db.query(`SELECT p.account_id FROM official_account_profiles_v1 p JOIN community_accounts a ON a.id=p.account_id
      WHERE p.account_id=$1 AND a.endpoint=$2 AND p.query_enabled=true AND p.query_external_credentials=true`,[accountId,endpoint])).rows[0];
    if(!enabled)throw new ServiceError('not_found',404);
    const identity=await principal(db,accountId),references=configuration.issuers.flatMap(issuer=>issuer.subjectBinding?.kind==='verified-external-account'?
      identity.verifiedAccounts.filter(reference=>reference?.issuer===issuer.subjectBinding.accountIssuer&&typeof reference.subject==='string')
        .map(reference=>({issuerId:issuer.id,subjectId:reference.subject})):[]);
    // Selecting public credential metadata does not publish imported documents
    // about other people, including signed material whose holder is unconfirmed.
    const rows=(await db.query(`SELECT * FROM account_external_credentials_v1 c WHERE account_id=$1 AND withdrawn_at IS NULL
      AND ($2::uuid IS NULL OR id>$2) AND (metadata->>'subjectId'=$3 OR EXISTS
       (SELECT 1 FROM jsonb_array_elements($4::jsonb) reference WHERE reference->>'issuerId'=c.issuer_id AND reference->>'subjectId'=c.metadata->>'subjectId'))
      ORDER BY id LIMIT $5`,[accountId,page.after??null,identity.uri,JSON.stringify(references),page.limit+1])).rows;
    const items=[];
    for(const row of rows.slice(0,page.limit)){
      const current=await view(row,identity);if(current.subject.binding!=='bound')continue;
      const {id,title,issuer,subject,types,scope,issuedAt,validFrom,expiresAt,importedAt,checkedAt,source,signature,validity,revocation,galaxyIssued}=current;
      items.push({id,title,issuer,subject,types,scope,issuedAt,validFrom,expiresAt,importedAt,checkedAt,source,signature,validity,revocation,galaxyIssued});
    }
    return {accountId,items,nextAfter:rows.length>page.limit?rows[page.limit-1].id:null,checkedAt:now()};
  }
  async function ownRow(connection,accountId,id,{lock=false}={}){parseExternalCredentialInput(externalCredentialIdSchema,id);
    const row=(await connection.query('SELECT * FROM account_external_credentials_v1 WHERE account_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[accountId,id])).rows[0];
    if(!row)throw new ServiceError('not_found',404);return row;}
  async function get(actor,id) {
    const accountId=owner(actor),row=await ownRow(db,accountId,id),identity=await principal(db,accountId),credential=await view(row,identity);
    return {credential,issuerClaims:row.withdrawn_at?null:row.metadata.vc,rawMaterialReturned:false};
  }
  async function importCredential(actor,input) {
    const accountId=owner(actor),data=parseExternalCredentialInput(externalCredentialImportSchema,input);
    if(!configuration.issuers.length)throw new ServiceError('external_credentials_unavailable',503);
    const metadata=await verifier.verify(data.credential),revocation=await verifier.revocation(metadata),identity=await principal(db,accountId),at=iso(now()*1000);
    const row=await transaction(db,async connection=>{
      // Serialize only imports for this existing account; exact JWS comparison
      // makes retries idempotent without a material fingerprint or large index.
      if(!(await connection.query('SELECT id FROM community_accounts WHERE id=$1 AND endpoint=$2 FOR UPDATE',[accountId,endpoint])).rows.length)
        throw new ServiceError('official_account_login_required',401);
      const existing=(await connection.query('SELECT * FROM account_external_credentials_v1 WHERE account_id=$1 AND credential_jws=$2 AND withdrawn_at IS NULL',[accountId,data.credential])).rows[0];
      if(existing)return existing;
      if(Number((await connection.query('SELECT count(*) AS count FROM account_external_credentials_v1 WHERE account_id=$1 AND withdrawn_at IS NULL',[accountId])).rows[0].count)>=200)
        throw new ServiceError('external_credential_storage_limit',409);
      return (await connection.query(`INSERT INTO account_external_credentials_v1(id,account_id,issuer_id,issuer_uri,issuer_name,credential_jws,metadata,revocation,imported_at,checked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,[randomUUID(),accountId,metadata.issuerId,metadata.issuer,metadata.issuerName,data.credential,JSON.stringify(metadata),JSON.stringify(revocation),at])).rows[0];
    });
    return view(row,identity);
  }
  async function recheckRow(row,{force=false,signal}={}) {
    if(row.withdrawn_at||!row.credential_jws)return row;
    let metadata;try{metadata=await verifier.verify(row.credential_jws);}catch{
      return (await db.query('UPDATE account_external_credentials_v1 SET checked_at=$3,revocation=$4 WHERE id=$1 AND account_id=$2 AND withdrawn_at IS NULL RETURNING *',
        [row.id,row.account_id,iso(now()*1000),JSON.stringify({state:'unknown',source:null,checkedAt:iso(now()*1000),validUntil:null,reason:'signature-not-current'})])).rows[0]??ownRow(db,row.account_id,row.id);
    }
    const revocation=await verifier.revocation(metadata,{force,signal});
    return (await db.query(`UPDATE account_external_credentials_v1 SET metadata=$3,revocation=$4,checked_at=$5
      WHERE id=$1 AND account_id=$2 AND withdrawn_at IS NULL RETURNING *`,[row.id,row.account_id,JSON.stringify(metadata),JSON.stringify(revocation),iso(now()*1000)])).rows[0]
      ?? ownRow(db,row.account_id,row.id);
  }
  async function recheck(actor,id){const accountId=owner(actor),row=await ownRow(db,accountId,id);return view(await recheckRow(row,{force:true}),await principal(db,accountId));}
  async function withdraw(actor,id) {
    const accountId=owner(actor);await ownRow(db,accountId,id);
    await db.query(`UPDATE account_external_credentials_v1 SET credential_jws=NULL,metadata=metadata-'vc',withdrawn_at=COALESCE(withdrawn_at,$3)
      WHERE account_id=$1 AND id=$2`,[accountId,id,iso(now()*1000)]);
    return {id,withdrawn:true,issuerRevoked:false};
  }
  async function hasConditionWithin(connection,{accountId,issuerId,conditionId}) {
    if(!externalCredentialIdSchema.safeParse(accountId).success)return false;
    const issuer=verifier.issuer(issuerId);if(!issuer?.revocation||!issuer.conditions.some(condition=>condition.id===conditionId))return false;
    const identity=await principal(connection,accountId);
    const rows=(await connection.query('SELECT * FROM account_external_credentials_v1 WHERE account_id=$1 AND issuer_id=$2 AND withdrawn_at IS NULL FOR SHARE',[accountId,issuerId])).rows;
    for(const row of rows){const current=await view(row,identity);if(current.eligibility.conditionIds.includes(conditionId))return true;}return false;
  }
  async function refreshDue({limit=32,signal}={}) {
    const rows=(await db.query(`SELECT * FROM account_external_credentials_v1 WHERE withdrawn_at IS NULL AND checked_at<$1 ORDER BY checked_at,id LIMIT $2`,[iso((now()-60)*1000),Math.max(1,Math.min(100,limit))])).rows;
    let checked=0;for(const row of rows){if(signal?.aborted)break;await recheckRow(row,{signal});checked++;}return {checked};
  }
  return Object.freeze({capabilities,supportedConditions,list,publicForAccount,get,importCredential,recheck,withdraw,hasConditionWithin,refreshDue});
}
