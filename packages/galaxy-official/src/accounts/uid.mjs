import {ServiceError} from "../shared/service-error.mjs";
import {reserveOfficialAccountWithin} from "./registration.mjs";
export {accountUidPattern,createAccountUid} from "./registration.mjs";

// Verified creation and registration-only profiles share immutable locators.
export async function upsertOfficialAccountWithin(db,{endpoint,issuer,externalSubject,verificationMethod,verifiedAt},options={}){
  const reserved=await reserveOfficialAccountWithin(db,{endpoint,issuer,externalSubject,now:verifiedAt},options),at=new Date(verifiedAt*1000).toISOString();
  const inserted=(await db.query(`INSERT INTO community_accounts(id,uid,endpoint,issuer,external_subject,verification_method,verified_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING id,uid`,
    [reserved.account_id,reserved.uid,endpoint,issuer,externalSubject,verificationMethod,at])).rows[0];
  if(inserted)return {...inserted,created:true};
  const existing=(await db.query(`UPDATE community_accounts SET verified_at=$4,verification_method=$5
    WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3 AND id=$6 AND uid=$7 RETURNING id,uid`,
    [endpoint,issuer,externalSubject,at,verificationMethod,reserved.account_id,reserved.uid])).rows[0];
  if(!existing)throw new ServiceError('official_account_unavailable',503);
  return {...existing,created:false};
}

export async function ensureOfficialAccountProfileWithin(db,accountId,{subjectType=null,now=Math.floor(Date.now()/1000)}={}){
  const account=(await db.query('SELECT endpoint,issuer,external_subject FROM community_accounts WHERE id=$1',[accountId])).rows[0];
  if(!account)throw new ServiceError('official_account_unavailable',503);
  await reserveOfficialAccountWithin(db,{endpoint:account.endpoint,issuer:account.issuer,externalSubject:account.external_subject,now});
  const preset=(await db.query('SELECT display_name,avatar_key,bio,preset_revision,adopted_at FROM official_account_registrations_v1 WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
  const adopt=preset?.preset_revision>0&&preset.adopted_at===null;
  const inserted=await db.query(`INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,avatar_key,bio,updated_at)
    SELECT id,$2::text,coalesce($4::text,uid),$5::text,$6::text,$3::timestamptz FROM community_accounts WHERE id=$1
    ON CONFLICT(account_id) DO NOTHING RETURNING account_id`,
    [accountId,subjectType,new Date(now*1000).toISOString(),adopt?preset.display_name:null,adopt?preset.avatar_key:null,adopt?preset.bio:'']);
  // Only a genuinely inserted first profile consumes this preset. Existing user
  // values are never overwritten; consumed data is not restored after deletion.
  if(adopt&&inserted.rows.length)await db.query(`UPDATE official_account_registrations_v1
    SET adopted_at=$2,display_name=NULL,avatar_key=NULL,bio='' WHERE account_id=$1`,[accountId,new Date(now*1000).toISOString()]);
  const row=(await db.query(`SELECT p.*,a.uid FROM official_account_profiles_v1 p
    JOIN community_accounts a ON a.id=p.account_id WHERE p.account_id=$1`,[accountId])).rows[0];
  if(!row)throw new ServiceError('official_account_unavailable',503);
  return row;
}
