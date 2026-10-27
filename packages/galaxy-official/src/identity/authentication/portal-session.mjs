import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {ServiceError} from '../../shared/service-error.mjs';

export async function loadPortalSessionPolicy(value){
 if(value===undefined)return null;
 if(!value||Object.keys(value).some(key=>!['keyFile','idleSeconds','maximumSeconds','refreshBeforeSeconds'].includes(key))||!isAbsolute(value.keyFile??''))throw Error('Invalid portal session policy.');
 const info=await lstat(value.keyFile);
 if(!info.isFile()||info.isSymbolicLink()||info.size>256)throw Error('Invalid portal session encryption key file.');
 const encoded=(await readFile(value.keyFile,'utf8')).trim();
 if(!/^[A-Za-z0-9_-]{43}$/.test(encoded))throw Error('A 32-byte base64url portal session key is required.');
 return validatePortalSessionPolicy({...value,key:Buffer.from(encoded,'base64url')});
}
export function validatePortalSessionPolicy({key,idleSeconds=604800,maximumSeconds=2592000,refreshBeforeSeconds=60}){
 if(!Buffer.isBuffer(key)||key.length!==32||![idleSeconds,maximumSeconds,refreshBeforeSeconds].every(Number.isSafeInteger)
  ||idleSeconds<60||maximumSeconds<idleSeconds||maximumSeconds>31536000||refreshBeforeSeconds<0||refreshBeforeSeconds>300)throw Error('Invalid portal session policy.');
 return {key,idleSeconds,maximumSeconds,refreshBeforeSeconds};
}
// This helper adds no second session authority: all claims, expiry and logout
// fences live on the portal's original session row, addressed by its stable key.
export class PortalSessions {
 constructor({db,kind,scope,policy,provider,now=()=>Math.floor(Date.now()/1000)}){
  if(!['account','operator'].includes(kind))throw Error('Invalid portal kind.');
  Object.assign(this,{db,kind,scope,policy:validatePortalSessionPolicy(policy),provider,now});
  this.table=kind==='account'?'official_account_sessions_v1':'operations_operator_sessions_v1';
  this.where=kind==='account'?'scope_hash=$1 AND token_hash=$2':'endpoint=$1 AND configuration_id=$2 AND token_hash=$3';
 }
 crypt(value,tokenHash){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.policy.key,iv);
  cipher.setAAD(Buffer.from(JSON.stringify([this.kind,...this.scope,tokenHash])));
  return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64url');
 }
 decrypt(value,tokenHash){
  const bytes=Buffer.from(value,'base64url'),cipher=createDecipheriv('aes-256-gcm',this.policy.key,bytes.subarray(0,12));
  cipher.setAAD(Buffer.from(JSON.stringify([this.kind,...this.scope,tokenHash])));cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString('utf8');
 }
 async create(db,tokenHash,identity){
  if(!identity.portalTokens?.refreshToken)return false;
  const at=this.now(),max=at+this.policy.maximumSeconds,p=[...this.scope,tokenHash],n=p.length;
  await db.query(`UPDATE ${this.table} SET refresh_cipher=$${n+1},upstream_expires_at=$${n+2},idle_expires_at=$${n+3},max_expires_at=$${n+4} WHERE ${this.where}`,
   [...p,this.crypt(identity.portalTokens.refreshToken,tokenHash),identity.portalTokens.expiresAt,Math.min(max,at+this.policy.idleSeconds),max]);
  return true;
 }
 async current(row,{activity=false}={}){
  if(!row.refresh_cipher)return undefined; // Nonrenewable sessions keep their original deadline.
  const p=[...this.scope,row.token_hash],n=p.length,at=this.now(),where=this.where;
  const live=this.kind==='account'?' AND revoked_at IS NULL':'';
  if(row.refresh_state==='revoked'||Number(row.idle_expires_at)<=at||Number(row.max_expires_at)<=at)return null;
  if(activity){row=(await this.db.query(`UPDATE ${this.table} SET idle_expires_at=LEAST(max_expires_at,$${n+1})
   WHERE ${where}${live} AND refresh_state<>'revoked' AND idle_expires_at>$${n+2} AND max_expires_at>$${n+2} RETURNING *`,[...p,at+this.policy.idleSeconds,at])).rows[0];if(!row)return null;}
  if(Number(row.upstream_expires_at)>at+this.policy.refreshBeforeSeconds)return {expiresAt:Math.min(Number(row.idle_expires_at),Number(row.max_expires_at))};
  if(row.refresh_state!=='ready')throw new ServiceError('portal_session_refresh_unconfirmed',503);
  // A committed compare-and-set precedes the AS call. A lost token response or
  // dead claimant stays unconfirmed; no worker may exchange that token again.
  const claim=(await this.db.query(`UPDATE ${this.table} SET refresh_state='refreshing',refresh_version=refresh_version+1
   WHERE ${where}${live} AND refresh_version=$${n+1} AND refresh_state='ready' AND idle_expires_at>$${n+2} AND max_expires_at>$${n+2} RETURNING *`,[...p,row.refresh_version,at])).rows[0];
  if(!claim)throw new ServiceError('portal_session_refresh_unconfirmed',503);
  let refreshed;
  try{refreshed=await this.provider.refresh({refreshToken:this.decrypt(claim.refresh_cipher,row.token_hash),issuer:claim.issuer,externalSubject:claim.external_subject});}
  catch(error){
   await this.db.query(`UPDATE ${this.table} SET refresh_state=$${n+2} WHERE ${where}${live} AND refresh_version=$${n+1} AND refresh_state='refreshing'`,[...p,claim.refresh_version,error?.code==='portal_refresh_rejected'?'revoked':'unknown']);
   if(error?.code==='portal_refresh_rejected'){
    if(this.kind==='account')await this.db.query(`UPDATE ${this.table} SET revoked_at=$${n+1} WHERE ${where} AND refresh_state='revoked'`,[...p,this.now()]);
    else await this.db.query(`DELETE FROM ${this.table} WHERE ${where} AND refresh_state='revoked'`,p);
    return null;
   }
   throw new ServiceError('portal_session_refresh_unconfirmed',503);
  }
  const updated=(await this.db.query(`UPDATE ${this.table} SET refresh_state='ready',refresh_cipher=$${n+2},upstream_expires_at=$${n+3}
   WHERE ${where}${live} AND refresh_version=$${n+1} AND refresh_state='refreshing' AND idle_expires_at>$${n+4} AND max_expires_at>$${n+4} RETURNING *`,[...p,claim.refresh_version,this.crypt(refreshed.refreshToken,row.token_hash),refreshed.expiresAt,this.now()])).rows[0];
  return updated?{expiresAt:Math.min(Number(updated.idle_expires_at),Number(updated.max_expires_at))}:null;
 }
}
