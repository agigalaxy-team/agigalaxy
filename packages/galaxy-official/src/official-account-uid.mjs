import {randomInt,randomUUID} from 'node:crypto';
import {ServiceError} from './shared/service-error.mjs';

// A public locator, never a login secret or an authorization principal.
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const accountUidPattern=/^G[A-Z0-9]{10}[0-9]$/;
export function createAccountUid(){
  return 'G'+Array.from({length:10},()=>alphabet[randomInt(alphabet.length)]).join('')+randomInt(10);
}

// DO NOTHING covers a generated UID collision without aborting a PostgreSQL
// transaction. An issuer/subject race returns the account already persisted by
// the other request; it never changes that account's public UID.
export async function upsertOfficialAccountWithin(db,{endpoint,issuer,externalSubject,verificationMethod,verifiedAt},
  {generateUid=createAccountUid}={}){
  const at=new Date(verifiedAt*1000).toISOString();
  for(let attempt=0;attempt<32;attempt++){
    const uid=generateUid();
    if(!accountUidPattern.test(uid))throw new ServiceError('official_account_unavailable',503);
    const inserted=(await db.query(`INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING id,uid`,
    [randomUUID(),uid,endpoint,issuer,externalSubject,verificationMethod,at])).rows[0];
    if(inserted)return {...inserted,created:true};
    const existing=(await db.query(`UPDATE community_accounts SET verified_at=$4,verification_method=$5
      WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3 RETURNING id,uid`,
    [endpoint,issuer,externalSubject,at,verificationMethod])).rows[0];
    if(existing)return {...existing,created:false};
  }
  throw new ServiceError('official_account_unavailable',503);
}

export async function ensureOfficialAccountProfileWithin(db,accountId,{subjectType=null,now=Math.floor(Date.now()/1000)}={}){
  await db.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at)
    SELECT id,$2::text,uid,$3::timestamptz FROM community_accounts WHERE id=$1
    ON CONFLICT(account_id) DO NOTHING`,[accountId,subjectType,new Date(now*1000).toISOString()]);
  const row=(await db.query(`SELECT p.*,a.uid FROM official_account_profiles_v1 p
    JOIN community_accounts a ON a.id=p.account_id WHERE p.account_id=$1`,[accountId])).rows[0];
  if(!row)throw new ServiceError('official_account_unavailable',503);
  return row;
}
