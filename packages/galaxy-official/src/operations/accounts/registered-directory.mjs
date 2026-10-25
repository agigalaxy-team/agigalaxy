import {randomUUID} from 'node:crypto';
import {transaction} from '../../database.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {reserveOfficialAccountWithin} from '../../official-account-registration.mjs';

const stamp=value=>value?new Date(value).toISOString():null;
const safeCode=error=>['registered_identity_read_forbidden','registered_identity_client_unavailable','registered_identity_response_invalid','registered_directory_source_changed'].includes(error?.code)?error.code:'registered_identity_unavailable';

// A complete, explicitly dated derived generation supports SQL joins/counts.
// Source pagination is not a native transactional snapshot; failures never
// publish partial rows as a complete registration directory.
export class RegisteredDirectory{
 constructor({db,endpoint,directory,now=()=>Math.floor(Date.now()/1000)}){Object.assign(this,{db,endpoint,directory,now});}
 async source(db=this.db){
  const row=(await db.query('SELECT d.*,g.observed_count FROM operations_registered_directory_v1 d LEFT JOIN operations_registered_generations_v1 g ON g.id=d.generation_id WHERE d.endpoint=$1',[this.endpoint])).rows[0];
  const configured=!!this.directory,matching=configured&&row?.issuer===this.directory.issuer,ready=matching&&!!row.generation_id;
  return {state:!configured?'not-configured':matching&&row.sync_id&&Date.parse(row.lease_until)>this.now()*1000?'syncing':ready&&!row.last_error?'ready':'unavailable',
   generationId:ready?row.generation_id:null,registeredAsOf:ready?stamp(row.last_completed_at):null,syncStartedAt:matching?stamp(row.last_started_at):null,
   lastError:matching?row.last_error??null:null,coverage:ready?'complete-generation':'not-ready',atomicSourceSnapshot:false,registeredCount:ready?Number(row.observed_count):null};
 }
 async sync(){
  if(!this.directory)return {state:'not-configured'};
  const id=randomUUID(),issuer=this.directory.issuer,at=stamp(this.now()*1000);
  const started=await transaction(this.db,async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912451))',[this.endpoint]);
   const old=(await db.query('SELECT * FROM operations_registered_directory_v1 WHERE endpoint=$1 FOR UPDATE',[this.endpoint])).rows[0];
   if(old?.sync_id&&Date.parse(old.lease_until)>this.now()*1000)return false;
   await db.query(`INSERT INTO operations_registered_directory_v1(endpoint,issuer,sync_id,lease_until,last_started_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(endpoint) DO UPDATE SET issuer=$2,generation_id=CASE WHEN operations_registered_directory_v1.issuer=$2 THEN operations_registered_directory_v1.generation_id ELSE NULL END,
    sync_id=$3,lease_until=$4,last_started_at=$5,last_error=NULL`,[this.endpoint,issuer,id,stamp((this.now()+60)*1000),at]);
   await db.query(`INSERT INTO operations_registered_generations_v1(id,endpoint,issuer,state,started_at) VALUES($1,$2,$3,'building',$4)`,[id,this.endpoint,issuer,at]);return true;
  });
  if(!started)return {state:'syncing'};
  let observed=0,raw=0;
  try{
   const before=await this.directory.count();
   for(let first=0;;first+=100){
    if(first>before+100)throw new ServiceError('registered_directory_source_changed',503);
    const page=await this.directory.page({first,max:100});raw+=page.rawCount;
    await transaction(this.db,async db=>{
     const lease=(await db.query('SELECT sync_id FROM operations_registered_directory_v1 WHERE endpoint=$1 FOR UPDATE',[this.endpoint])).rows[0];
     if(lease?.sync_id!==id)throw new ServiceError('registered_directory_source_changed',503);
     for(const user of page.items){
      const target=(await db.query(`INSERT INTO operations_registered_subjects_v1(id,endpoint,issuer,external_subject) VALUES($1,$2,$3,$4)
       ON CONFLICT(endpoint,issuer,external_subject) DO UPDATE SET external_subject=EXCLUDED.external_subject RETURNING id`,[randomUUID(),this.endpoint,issuer,user.externalSubject])).rows[0];
      // Only a public locator, not a business account or login.
      await reserveOfficialAccountWithin(db,{endpoint:this.endpoint,issuer,externalSubject:user.externalSubject,now:this.now()});
      const inserted=await db.query(`INSERT INTO operations_registered_entries_v1(generation_id,registration_id,present,email,email_verified,enabled,registered_at,identity_display_name,observed_at)
       VALUES($1,$2,true,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING registration_id`,[id,target.id,user.email,user.emailVerified,user.enabled,user.registeredAt,user.displayName??null,stamp(this.now()*1000)]);
      if(!inserted.rows.length)throw new ServiceError('registered_directory_source_changed',503);observed++;
     }
     await db.query('UPDATE operations_registered_directory_v1 SET lease_until=$3 WHERE endpoint=$1 AND sync_id=$2',[this.endpoint,id,stamp((this.now()+60)*1000)]);
    });
    if(page.rawCount<100)break;
   }
   const after=await this.directory.count();if(before!==after||raw!==before)throw new ServiceError('registered_directory_source_changed',503);
   await transaction(this.db,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,734912451))',[this.endpoint]);
    const head=(await db.query('SELECT * FROM operations_registered_directory_v1 WHERE endpoint=$1 FOR UPDATE',[this.endpoint])).rows[0];
    if(head?.sync_id!==id)throw new ServiceError('registered_directory_source_changed',503);
    // Historical business rows remain findable, but never become registered
    // users merely because a local profile or associated ID exists.
    await db.query(`INSERT INTO operations_registered_subjects_v1(id,endpoint,issuer,external_subject)
     SELECT a.id,a.endpoint,a.issuer,a.external_subject FROM community_accounts a WHERE a.endpoint=$1
     ON CONFLICT(endpoint,issuer,external_subject) DO NOTHING`,[this.endpoint]);
    await db.query(`INSERT INTO operations_registered_entries_v1(generation_id,registration_id,present,observed_at)
     SELECT $1,s.id,false,$3 FROM operations_registered_subjects_v1 s JOIN community_accounts a ON a.endpoint=s.endpoint AND a.issuer=s.issuer AND a.external_subject=s.external_subject
     WHERE s.endpoint=$2 ON CONFLICT DO NOTHING`,[id,this.endpoint,stamp(this.now()*1000)]);
    const done=stamp(this.now()*1000);
    await db.query(`UPDATE operations_registered_generations_v1 SET state='complete',completed_at=$2,source_count_before=$3,source_count_after=$4,observed_count=$5 WHERE id=$1`,[id,done,before,after,observed]);
    await db.query('UPDATE operations_registered_directory_v1 SET generation_id=$2,last_completed_at=$3,sync_id=NULL,lease_until=NULL,last_error=NULL WHERE endpoint=$1',[this.endpoint,id,done]);
    // This is a rebuildable two-phase index, not a user-data retention store.
    // Only the current complete generation remains readable after publication.
    await db.query('DELETE FROM operations_registered_generations_v1 WHERE endpoint=$1 AND id<>$2',[this.endpoint,id]);
   });
   return {state:'complete',generationId:id,observedCount:observed};
  }catch(error){
   const code=safeCode(error);
   await transaction(this.db,async db=>{
    await db.query("UPDATE operations_registered_generations_v1 SET state='failed',code=$2 WHERE id=$1",[id,code]);
    await db.query('UPDATE operations_registered_directory_v1 SET sync_id=NULL,lease_until=NULL,last_error=$3 WHERE endpoint=$1 AND sync_id=$2',[this.endpoint,id,code]);
   });return {state:'failed',code};
  }
 }
}
