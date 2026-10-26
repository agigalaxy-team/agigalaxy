import {randomInt,randomUUID} from 'node:crypto';
import {ServiceError} from "../shared/service-error.mjs";

// Public locators confer no login, verification, membership or participation.
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const accountUidPattern=/^G[A-Z0-9]{10}[0-9]$/;
export function createAccountUid(){return 'G'+Array.from({length:10},()=>alphabet[randomInt(alphabet.length)]).join('')+randomInt(10);}
const bindingColumns='account_id,uid,endpoint,issuer,external_subject,created_at';

/** Caller supplies one transaction, held through verified creation or preset. */
export async function reserveOfficialAccountWithin(db,{endpoint,issuer,externalSubject,now=Math.floor(Date.now()/1000)},
 {generateUid=createAccountUid,generateId=randomUUID}={}){
 if(![endpoint,issuer,externalSubject].every(value=>typeof value==='string'&&value.length>0&&value.length<=4096)||!Number.isFinite(now))throw new ServiceError('official_account_unavailable',503);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912467))',[JSON.stringify([endpoint,issuer,externalSubject])]);
 const values=[endpoint,issuer,externalSubject];
 let existing=(await db.query('SELECT '+bindingColumns+' FROM official_account_registrations_v1 WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3',values)).rows[0];
 if(existing)return existing;
 for(let attempt=0;attempt<32;attempt++){
  const uid=generateUid(),id=generateId();if(!accountUidPattern.test(uid))throw new ServiceError('official_account_unavailable',503);
  const inserted=(await db.query(`INSERT INTO official_account_registrations_v1(account_id,uid,endpoint,issuer,external_subject,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING RETURNING ${bindingColumns}`,
   [id,uid,...values,new Date(now*1000).toISOString()])).rows[0];
  if(inserted)return inserted;
  existing=(await db.query('SELECT '+bindingColumns+' FROM official_account_registrations_v1 WHERE endpoint=$1 AND issuer=$2 AND external_subject=$3',values)).rows[0];
  if(existing)return existing;
 }
 throw new ServiceError('official_account_unavailable',503);
}
