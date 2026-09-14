import { ServiceError } from '../shared/service-error.mjs';
import { digest } from '../shared/digest.mjs';

// Every authorization transaction locks the subject before bindings/credentials.
// Recovery takes the exclusive lock, so no stale authorization can commit after it.
export async function lockSubjectControl(db,subjectId,{exclusive=false}={}) {
  return (await db.query('SELECT * FROM public.galaxy_api_lock_subject_control($1,$2)',[subjectId,exclusive])).rows[0];
}
export async function currentControlKey(db,subjectId,{deviceId,keyId,epoch,scope}={}) {
  const subject=await lockSubjectControl(db,subjectId);
  if(!subject)throw new ServiceError('access_denied',401);
  const head=(await db.query('SELECT * FROM subject_control_heads WHERE subject_id=$1',[subjectId])).rows[0];
  if(!head){
    if(deviceId||epoch)throw new ServiceError('identity_control_upgrade_required',409);
    return {publicKey:subject.public_key,keyId:digest(subject.public_key),deviceId:null,epoch:0,chainHead:null,scopes:['*']};
  }
  const row=(await db.query(`SELECT * FROM device_authorizations WHERE subject_id=$1 AND epoch=$2 AND status='active'
    AND ($3::uuid IS NULL OR device_id=$3) AND key_id=$4`,[subjectId,head.epoch,deviceId??null,keyId??digest(subject.public_key)])).rows[0];
  if(!row || (epoch!==undefined&&epoch!==head.epoch) || (scope&&!row.scopes.includes('*')&&!row.scopes.includes(scope)))
    throw new ServiceError('identity_control_stale',401);
  return {publicKey:row.public_key,keyId:row.key_id,deviceId:row.device_id,epoch:row.epoch,chainHead:head.event_hash,scopes:row.scopes};
}
export async function bindingControl(db,binding,{scope}={}) {
  if(!binding)return null;
  try {
    const control=await currentControlKey(db,binding.subject_id,{deviceId:binding.device_id??undefined,
      keyId:binding.key_id??undefined,epoch:binding.control_epoch??undefined,scope});
    return {...binding,public_key:control.publicKey,control,
      ...(binding.scopes?{scopes:binding.scopes.filter(s=>control.scopes.includes('*')||control.scopes.includes(s))}:{})};
  } catch(error){if(error instanceof ServiceError)return null;throw error;}
}
export async function captureIdentityControlChain(db,subjectId){
  const subject=await lockSubjectControl(db,subjectId);
  const events=(await db.query('SELECT * FROM subject_control_events WHERE subject_id=$1 ORDER BY sequence',[subjectId])).rows;
  return events.length?{subjectId,genesisProof:subject.genesis_proof,events}:null;
}
